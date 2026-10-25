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
 */
import SchemaBuilder from "@pothos/core";
import { CallFailureError } from "@acid-cat/core-ts";
import type { Session } from "@acid-cat/core-ts";
import { GraphQLError } from "graphql";
import { createYoga } from "graphql-yoga";
import type { z } from "zod";

import { fanSet, FanSpeed, Mode, modeSet, powerSet, statusGet, temperatureSet } from "../core-ts/aircon.ts";
import type { Context as AirconContext, Offline, PoweredOff, Status } from "../core-ts/aircon.ts";
import { forbidden, foreignOrigin, httpBinding, openSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

interface Context {
  readonly session: Session<AirconContext>;
}

const builder = new SchemaBuilder<{ Context: Context }>({});

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

const StatusResult = builder.unionType("StatusResult", { types: [StatusType, OfflineType], resolveType: typeOf });
const SetModeResult = builder.unionType("SetModeResult", { types: [StatusType, OfflineType, PoweredOffType], resolveType: typeOf });

/** The status of the unit, or the failure that stops the read. */
async function statusOf(session: Session<AirconContext>) {
  const result = await session.call(statusGet, {});
  return result.ok ? result.value : result.error;
}

builder.queryType({
  fields: (t) => ({
    status: t.field({ type: StatusResult, resolve: (_, __, { session }) => statusOf(session) }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    setPower: t.field({
      type: StatusResult,
      args: { on: t.arg.boolean({ required: true }) },
      resolve: async (_, args, { session }) => {
        const result = await session.call(powerSet, args);
        return result.ok ? statusOf(session) : result.error;
      },
    }),
    setMode: t.field({
      type: SetModeResult,
      args: { mode: t.arg({ type: ModeType, required: true }) },
      resolve: async (_, args, { session }) => {
        const result = await session.call(modeSet, args);
        return result.ok ? statusOf(session) : result.error;
      },
    }),
    setFan: t.field({
      type: StatusResult,
      args: { speed: t.arg({ type: FanSpeedType, required: true }) },
      resolve: async (_, args, { session }) => {
        const result = await session.call(fanSet, args);
        return result.ok ? statusOf(session) : result.error;
      },
    }),
    setTemperature: t.field({
      type: StatusResult,
      args: { celsius: t.arg.float({ required: true }) },
      resolve: async (_, args, { session }) => {
        const result = await session.call(temperatureSet, args);
        return result.ok ? statusOf(session) : result.error;
      },
    }),
  }),
});

export const schema = builder.toSchema();

/** A call failure becomes a GraphQL error with its kind as `code`. Yoga masks all other errors. */
function maskError(error: unknown, message: string): Error {
  const cause = error instanceof GraphQLError ? error.originalError : error;
  if (!(cause instanceof CallFailureError)) return new GraphQLError(message);
  return new GraphQLError(cause.message, {
    ...(error instanceof GraphQLError ? { nodes: error.nodes, path: error.path } : {}),
    extensions: { code: cause.kind },
  });
}

/** A web request handler: GraphQL at `/graphql`, and the HTTP binding at `/api`. */
export function graphqlApi(options: ApiOptions): (request: Request) => Promise<Response> {
  const http = httpBinding(options, "/api");
  const yoga = createYoga<Context>({ schema, graphiql: false, maskedErrors: { maskError } });
  return async (request) => {
    if (foreignOrigin(request, options)) return forbidden();
    if (new URL(request.url).pathname.startsWith("/api/")) return http(request);
    await using session = openSession(options);
    return await yoga.fetch(request, { session });
  };
}
