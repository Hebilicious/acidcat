/**
 * A GraphQL API for the air conditioner, with Pothos and GraphQL Yoga, next to the HTTP binding at `/api`.
 *
 * The schema is application code: its types and fields are a design choice. It keeps the three outcomes of a call:
 *
 * - a value is data: the status of the unit;
 * - a failure is data too: each field returns a union of the status and the failures of its capability, so a client
 *   gets the failure with its type, for example `... on PoweredOff`;
 * - a call failure is a GraphQL error whose `code` is the kind of the call failure. Yoga masks all other errors.
 *
 * Each request has its own session. `session.call` checks the arguments with the input schema of the capability.
 *
 * The subscription `statusChanged` follows the event `aircon.status.changed`. Its `subscribe` resolver returns the
 * promise of `subscribe` of the event handle, and GraphQL calls `return()` of the iterator when the client ends the
 * subscription. It is served two ways, with one schema:
 *
 * - through server-sent events, by GraphQL Yoga at `/graphql` (the "distinct connections" mode of the GraphQL over
 *   server-sent events protocol, which the graphql-sse client uses). The session of the request stays open until the
 *   stream ends;
 * - through WebSockets, by graphql-ws on a `ws` server (`graphqlWebSocket`). Each connection is one session: it opens
 *   when the client connects, and closes when the connection closes. Its errors are masked as Yoga masks them.
 */
import SchemaBuilder from "@pothos/core";
import { CallFailureError } from "@acid-cat/core-ts";
import type { Session } from "@acid-cat/core-ts";
import { GraphQLError } from "graphql";
import { useServer } from "graphql-ws/use/ws";
import { createYoga } from "graphql-yoga";
import type { WebSocketServer } from "ws";
import type { z } from "zod";

import { fanSet, FanSpeed, Mode, modeSet, powerSet, statusChanged, statusGet, temperatureSet } from "../core-ts/aircon.ts";
import type { Context as AirconContext, Offline, PoweredOff, Status } from "../core-ts/aircon.ts";
import { forbidden, foreignOrigin, httpBinding, openSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

interface Context {
  readonly session: Session<AirconContext>;
}

const builder = new SchemaBuilder<{ Context: Context; DefaultFieldNullability: false }>({ defaultFieldNullability: false });

const ModeType = builder.enumType("Mode", { values: Mode.options });
const FanSpeedType = builder.enumType("FanSpeed", { values: FanSpeed.options });

const StatusType = builder.objectRef<z.infer<typeof Status>>("Status").implement({
  description: "The power, mode, fan speed, target temperature and room temperature of the unit.",
  fields: (t) => ({
    power: t.exposeBoolean("power"),
    mode: t.field({ type: ModeType, resolve: (unit) => unit.mode }),
    fan: t.field({ type: FanSpeedType, resolve: (unit) => unit.fan }),
    targetCelsius: t.exposeFloat("targetCelsius"),
    roomCelsius: t.exposeFloat("roomCelsius"),
  }),
});

const OfflineType = builder.objectRef<z.infer<typeof Offline>>("Offline").implement({
  description: "The unit is not on the network.",
  fields: (t) => ({
    _tag: t.exposeString("_tag"),
    since: t.exposeString("since", { nullable: true }),
  }),
});

const PoweredOffType = builder.objectRef<z.infer<typeof PoweredOff>>("PoweredOff").implement({
  description: "The unit is off, so it cannot change its mode.",
  fields: (t) => ({ _tag: t.exposeString("_tag") }),
});

/** The GraphQL type of a value or a failure: a failure has a `_tag`. */
const typeOf = (value: z.infer<typeof Status> | z.infer<typeof Offline> | z.infer<typeof PoweredOff>) => {
  if (!("_tag" in value)) return StatusType;
  return value._tag === "Offline" ? OfflineType : PoweredOffType;
};

const StatusResult = builder.unionType("StatusResult", {
  description: "The status of the unit, or the failure that stops the call.",
  types: [StatusType, OfflineType],
  resolveType: typeOf,
});
const SetModeResult = builder.unionType("SetModeResult", {
  description: "The status of the unit, or the failure that stops the change of mode.",
  types: [StatusType, OfflineType, PoweredOffType],
  resolveType: typeOf,
});

/** The status of the unit, or the failure that stops the read. */
async function statusOf(session: Session<AirconContext>) {
  const result = await session.call(statusGet, {});
  return result.ok ? result.value : result.error;
}

builder.queryType({
  fields: (t) => ({
    status: t.field({ type: StatusResult, description: statusGet.description, resolve: (_, __, { session }) => statusOf(session) }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    setPower: t.field({
      type: StatusResult,
      description: powerSet.description,
      args: { on: t.arg.boolean({ required: true }) },
      resolve: async (_, args, { session }) => {
        const result = await session.call(powerSet, args);
        return result.ok ? statusOf(session) : result.error;
      },
    }),
    setMode: t.field({
      type: SetModeResult,
      description: modeSet.description,
      args: { mode: t.arg({ type: ModeType, required: true }) },
      resolve: async (_, args, { session }) => {
        const result = await session.call(modeSet, args);
        return result.ok ? statusOf(session) : result.error;
      },
    }),
    setFan: t.field({
      type: StatusResult,
      description: fanSet.description,
      args: { speed: t.arg({ type: FanSpeedType, required: true }) },
      resolve: async (_, args, { session }) => {
        const result = await session.call(fanSet, args);
        return result.ok ? statusOf(session) : result.error;
      },
    }),
    setTemperature: t.field({
      type: StatusResult,
      description: temperatureSet.description,
      args: { celsius: t.arg.float({ required: true }) },
      resolve: async (_, args, { session }) => {
        const result = await session.call(temperatureSet, args);
        return result.ok ? statusOf(session) : result.error;
      },
    }),
  }),
});

builder.subscriptionType({
  fields: (t) => ({
    statusChanged: t.field({
      type: StatusType,
      description: statusChanged.description,
      subscribe: (_, __, { session }) => session.eventHandle(statusChanged).subscribe({}),
      resolve: (occurrence) => occurrence.data,
    }),
  }),
});

export const schema = builder.toSchema();

/** A call failure becomes a GraphQL error with its kind as `code`. Yoga masks all other errors. */
function maskError(error: unknown, message: string): GraphQLError {
  const cause = error instanceof GraphQLError ? error.originalError : error;
  if (!(cause instanceof CallFailureError)) return new GraphQLError(message);
  return new GraphQLError(cause.message, {
    ...(error instanceof GraphQLError ? { nodes: error.nodes, path: error.path } : {}),
    extensions: { code: cause.kind },
  });
}

/**
 * The web API of the platform. Yoga uses a ponyfill by default. When a client cancels a stream of the ponyfill while a
 * read waits, the ponyfill does not cancel the source, so Yoga does not stop the subscription. The web streams of the
 * platform cancel the source at once, and Yoga then calls `return()` of the iterator of the event handle.
 */
const fetchAPI = { Request, Response, Headers, ReadableStream, WritableStream, TransformStream, TextEncoder, TextDecoder, URL, URLSearchParams, fetch, FormData, Blob, File };

export const yoga = createYoga<Context>({ schema, graphiql: false, maskedErrors: { maskError }, fetchAPI });

/**
 * A response whose body closes the session when it ends: when the stream is done, or when the client cancels it. A
 * stream of server-sent events uses the session until its subscription ends. When the client cancels the stream, Yoga
 * cancels the subscription first, then the session closes.
 */
function closingSession(response: Response, session: Session<AirconContext>): Response {
  const body = response.body;
  if (body === null) return response;
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (!chunk.done) return controller.enqueue(chunk.value);
      controller.close();
      await session.dispose();
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await session.dispose();
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** A web request handler: GraphQL at `/graphql`, with subscriptions through server-sent events, and the HTTP binding at `/api`. */
export function graphqlApi(options: ApiOptions): (request: Request) => Promise<Response> {
  const http = httpBinding(options, "/api");
  return async (request) => {
    if (foreignOrigin(request, options)) return forbidden();
    if (new URL(request.url).pathname.startsWith("/api/")) return http(request);
    const session = openSession(options);
    let response: Response;
    try {
      response = await yoga.fetch(request, { session });
    } catch (error) {
      await session.dispose();
      throw error;
    }
    if (response.headers.get("Content-Type")?.startsWith("text/event-stream") === true) return closingSession(response, session);
    await session.dispose();
    return response;
  };
}

/**
 * Serve GraphQL through WebSockets on a `ws` server, with the graphql-ws protocol, the same schema, and the same masked
 * errors. Each connection is one session. A connection from an origin that the API does not allow is refused.
 * The result stops the server from taking new connections: call `dispose()` on it.
 */
export function graphqlWebSocket(options: ApiOptions, server: WebSocketServer) {
  return useServer<Record<string, unknown> | undefined, { session: Session<AirconContext> }>(
    {
      onConnect: (context) => {
        const origin = context.extra.request.headers.origin;
        if (origin !== undefined && !(options.allowedOrigins ?? []).includes(origin)) return false;
        context.extra.session = openSession(options);
        return true;
      },
      onClose: async (context) => {
        await context.extra.session?.dispose();
      },
      schema,
      context: (context): Context => {
        const session = context.extra.session;
        if (session === undefined) throw new GraphQLError("The connection has no session.");
        return { session };
      },
      // The errors of each result are masked as Yoga masks them.
      onNext: (_context, _id, _payload, _args, { data, errors }) =>
        errors === undefined ? undefined : { data: data ?? null, errors: errors.map((error) => maskError(error, "Unexpected error.").toJSON()) },
    },
    server,
  );
}
