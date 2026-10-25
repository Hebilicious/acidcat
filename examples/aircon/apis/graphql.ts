/**
 * A GraphQL API for the air conditioner, with Pothos and GraphQL Yoga, next to the HTTP binding at `/api`.
 *
 * The schema is application code: its types and fields are a design choice. Each request has its own session. Each
 * mutation checks its arguments with the input schema of its capability, makes a typed call, and returns the new
 * status. A failure becomes a GraphQL error whose `code` is the tag of the failure, or the kind of the call failure.
 * Yoga masks all other errors.
 */
import SchemaBuilder from "@pothos/core";
import { CallFailureError, getHandle } from "@acid-cat/core-ts";
import type { Result, Session } from "@acid-cat/core-ts";
import { GraphQLError } from "graphql";
import { createYoga } from "graphql-yoga";
import type { z } from "zod";

import { FanInput, fanSet, FanSpeed, Mode, ModeInput, modeSet, PowerInput, powerSet, statusGet, TemperatureInput, temperatureSet } from "../core-ts/aircon.ts";
import type { Context as AirconContext, Status } from "../core-ts/aircon.ts";
import { decode, Failure, forbidden, foreignOrigin, httpBinding, value, withSession } from "./shared.ts";
import type { ApiOptions, TaggedFailure } from "./shared.ts";

interface Context {
  readonly session: Session<AirconContext>;
}

/** The value of a call. A failure or a call failure becomes a GraphQL error, with its tag or its kind as `code`. */
async function call<Value, Tagged extends TaggedFailure>(run: () => Promise<Result<Value, Tagged>>): Promise<Value> {
  try {
    return await value(run());
  } catch (error) {
    if (error instanceof Failure) {
      throw new GraphQLError(error.message, { extensions: { code: error.failure._tag, failure: error.failure } });
    }
    if (error instanceof CallFailureError) throw new GraphQLError(error.message, { extensions: { code: error.kind } });
    throw error;
  }
}

const status = (session: Session<AirconContext>) => call(() => getHandle(session.handles, statusGet).execute({}));

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

builder.queryType({
  fields: (t) => ({
    status: t.field({ type: StatusType, resolve: (_, __, { session }) => status(session) }),
  }),
});

/** Make a call, then give the new status. */
const change = async <Value, Tagged extends TaggedFailure>(session: Session<AirconContext>, run: () => Promise<Result<Value, Tagged>>) => {
  await call(run);
  return status(session);
};

builder.mutationType({
  fields: (t) => ({
    setPower: t.field({
      type: StatusType,
      args: { on: t.arg.boolean({ required: true }) },
      resolve: (_, args, { session }) => change(session, () => getHandle(session.handles, powerSet).execute(decode(PowerInput, args))),
    }),
    setMode: t.field({
      type: StatusType,
      args: { mode: t.arg({ type: ModeType, required: true }) },
      resolve: (_, args, { session }) => change(session, () => getHandle(session.handles, modeSet).execute(decode(ModeInput, args))),
    }),
    setFan: t.field({
      type: StatusType,
      args: { speed: t.arg({ type: FanSpeedType, required: true }) },
      resolve: (_, args, { session }) => change(session, () => getHandle(session.handles, fanSet).execute(decode(FanInput, args))),
    }),
    setTemperature: t.field({
      type: StatusType,
      args: { celsius: t.arg.float({ required: true }) },
      resolve: (_, args, { session }) =>
        change(session, () => getHandle(session.handles, temperatureSet).execute(decode(TemperatureInput, args))),
    }),
  }),
});

export const schema = builder.toSchema();

/** A web request handler: GraphQL at `/graphql`, and the HTTP binding at `/api`. */
export function graphqlApi(options: ApiOptions): (request: Request) => Promise<Response> {
  const http = httpBinding(options, "/api");
  const yoga = createYoga<Context>({ schema, graphiql: false });
  return async (request) => {
    if (foreignOrigin(request, options)) return forbidden();
    if (new URL(request.url).pathname.startsWith("/api/")) return http(request);
    return withSession(options, (session) => Promise.resolve(yoga.fetch(request, { session })));
  };
}
