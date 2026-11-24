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
import { forbidden, foreignOrigin, httpSurface, openSession } from "./shared.ts";
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

const statusOrOffline = (value: z.infer<typeof Status> | z.infer<typeof Offline>) => ("_tag" in value ? OfflineType : StatusType);

const statusOrFailure = (value: z.infer<typeof Status> | z.infer<typeof Offline> | z.infer<typeof PoweredOff>) => {
  if (!("_tag" in value)) return StatusType;
  return value._tag === "Offline" ? OfflineType : PoweredOffType;
};

const StatusResult = builder.unionType("StatusResult", {
  description: "The status of the unit, or the failure that stops the call.",
  types: [StatusType, OfflineType],
  resolveType: statusOrOffline,
});
const SetModeResult = builder.unionType("SetModeResult", {
  description: "The status of the unit, or the failure that stops the change of mode.",
  types: [StatusType, OfflineType, PoweredOffType],
  resolveType: statusOrFailure,
});

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
      // GraphQL calls `return()` of the iterator when the client ends the subscription.
      subscribe: (_, __, { session }) => session.eventHandle(statusChanged).subscribe({}),
      resolve: (occurrence) => occurrence.data,
    }),
  }),
});

export const schema = builder.toSchema();

function maskError(error: unknown, message: string): GraphQLError {
  const cause = error instanceof GraphQLError ? error.originalError : error;
  if (!(cause instanceof CallFailureError)) return new GraphQLError(message);
  return new GraphQLError(cause.message, {
    ...(error instanceof GraphQLError ? { nodes: error.nodes, path: error.path } : {}),
    extensions: { code: cause.kind },
  });
}

/** Yoga logs one line for each request at the level `info`. The level `warn` keeps the logs of masked errors. */
export const yoga = createYoga<Context>({ schema, graphiql: false, maskedErrors: { maskError }, logging: "warn" });

/** When the client cancels the stream, Yoga cancels the subscription first, then the session closes. */
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

export function graphqlApi(options: ApiOptions): (request: Request) => Promise<Response> {
  const http = httpSurface(options, "/api");
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
      onNext: (_context, _id, _payload, _args, { data, errors }) =>
        errors === undefined ? undefined : { data: data ?? null, errors: errors.map((error) => maskError(error, "Unexpected error.").toJSON()) },
    },
    server,
  );
}
