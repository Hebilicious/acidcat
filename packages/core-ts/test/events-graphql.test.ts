import assert from "node:assert/strict";
import { test } from "node:test";

import { GraphQLFloat, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, parse, subscribe } from "graphql";

import { createSession } from "../src/index.ts";
import type { Occurrence } from "../src/index.ts";
import { readingChanged, sensorOptions, Sensors, sensorsApp } from "./sensors.ts";
import type { Reading } from "./sensors.ts";

/** Wait until a condition is true, or fail after one second. */
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("The condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const ReadingType = new GraphQLObjectType<Reading>({
  name: "Reading",
  fields: { room: { type: new GraphQLNonNull(GraphQLString) }, celsius: { type: new GraphQLNonNull(GraphQLFloat) } },
});

/** A GraphQL schema whose subscription field takes its source from an event handle. */
function schemaFor(sensors: Sensors) {
  const session = createSession(sensorsApp, { target: "app", ...sensorOptions(sensors) });
  const handle = session.eventHandle(readingChanged);
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: { ok: { type: GraphQLString, resolve: () => "ok" } } }),
    subscription: new GraphQLObjectType({
      name: "Subscription",
      fields: {
        reading: {
          type: new GraphQLNonNull(ReadingType),
          args: { room: { type: GraphQLString } },
          subscribe: (_source, args: { room?: string | null }) => handle.subscribe(typeof args.room === "string" ? { room: args.room } : {}),
          resolve: (occurrence: Occurrence<Reading>) => occurrence.data,
        },
      },
    }),
  });
  return { schema, session };
}

test("graphql-js subscribes through an event handle, and its return() ends the subscription while next() waits", async () => {
  const sensors = new Sensors();
  const { schema, session } = schemaFor(sensors);
  await using _ = session;
  const result = await subscribe({ schema, document: parse('subscription { reading(room: "kitchen") { room celsius } }') });
  assert.ok(Symbol.asyncIterator in result, "the subscription started");
  await until(() => sensors.listeners === 1);
  sensors.emit("kitchen", 21);
  const first = await result.next();
  assert.equal(JSON.stringify(first), JSON.stringify({ value: { data: { reading: { room: "kitchen", celsius: 21 } } }, done: false }));

  const waiting = result.next();
  await result.return();
  assert.deepEqual(await waiting, { done: true, value: undefined });
  await until(() => sensors.listeners === 0);
});

test("graphql-js gets the start failure of the event handle as an error", async () => {
  const sensors = new Sensors();
  const { schema, session } = schemaFor(sensors);
  await session.dispose();
  const result = await subscribe({ schema, document: parse("subscription { reading { room } }") });
  assert.ok(!(Symbol.asyncIterator in result));
  assert.equal(result.errors?.[0]?.message, "The subscription was cancelled.");
});
