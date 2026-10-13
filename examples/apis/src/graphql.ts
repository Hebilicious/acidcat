/**
 * A GraphQL API for the air conditioner, with Pothos and GraphQL Yoga, next to the HTTP binding at `/api`.
 *
 * The schema is application code: its types and fields are a design choice. Each mutation calls a capability and
 * returns the new status. A failure becomes a GraphQL error whose `code` is the tag of the failure, or the kind of
 * the call failure. Yoga masks all other errors.
 */
import SchemaBuilder from "@pothos/core";
import { CallFailureError } from "@acid-cat/core-ts";
import type { Session } from "@acid-cat/core-ts";
import { GraphQLError } from "graphql";
import { createYoga } from "graphql-yoga";

import { apiSession, Failure, FanSpeed, forbidden, foreignOrigin, httpBinding, Mode, value } from "./aircon.ts";
import type { ApiOptions, StatusValue } from "./aircon.ts";

/** Call a capability. A failure or a call failure becomes a GraphQL error, with its tag or its kind as `code`. */
async function call(session: Session, id: string, input: object): Promise<unknown> {
  try {
    return await value(session, id, input);
  } catch (error) {
    if (error instanceof Failure) {
      throw new GraphQLError(error.message, { extensions: { code: error.failure._tag, failure: error.failure } });
    }
    if (error instanceof CallFailureError) throw new GraphQLError(error.message, { extensions: { code: error.kind } });
    throw error;
  }
}

const status = async (session: Session) => (await call(session, "aircon.status.get", {})) as StatusValue;

const builder = new SchemaBuilder<{ Context: { readonly session: Session } }>({});

const ModeType = builder.enumType("Mode", { values: Mode.options });
const FanSpeedType = builder.enumType("FanSpeed", { values: FanSpeed.options });

const StatusType = builder.objectRef<StatusValue>("Status").implement({
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

/** Call a capability, then give the new status. */
const change = async (session: Session, id: string, input: object) => {
  await call(session, id, input);
  return status(session);
};

builder.mutationType({
  fields: (t) => ({
    setPower: t.field({
      type: StatusType,
      args: { on: t.arg.boolean({ required: true }) },
      resolve: (_, args, { session }) => change(session, "aircon.power.set", args),
    }),
    setMode: t.field({
      type: StatusType,
      args: { mode: t.arg({ type: ModeType, required: true }) },
      resolve: (_, args, { session }) => change(session, "aircon.mode.set", args),
    }),
    setFan: t.field({
      type: StatusType,
      args: { speed: t.arg({ type: FanSpeedType, required: true }) },
      resolve: (_, args, { session }) => change(session, "aircon.fan.set", args),
    }),
    setTemperature: t.field({
      type: StatusType,
      args: { celsius: t.arg.float({ required: true }) },
      resolve: (_, args, { session }) => change(session, "aircon.temperature.set", args),
    }),
  }),
});

export const schema = builder.toSchema();

/** A web request handler: GraphQL at `/graphql`, and the HTTP binding at `/api`. */
export function graphqlApi(options: ApiOptions): (request: Request) => Promise<Response> {
  const session = apiSession(options);
  const http = httpBinding(options, "/api");
  const yoga = createYoga({ schema, context: { session }, graphiql: false });
  return async (request) => {
    if (foreignOrigin(request, options)) return forbidden();
    return new URL(request.url).pathname.startsWith("/api/") ? http(request) : yoga.fetch(request);
  };
}
