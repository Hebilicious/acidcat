import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { serve } from "@acid-cat/core-ts/node";
import { printSchema } from "graphql";
import { createClient as createSseClient } from "graphql-sse";
import { createClient as createWsClient } from "graphql-ws";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { statusGet, Unit } from "../core-ts/aircon.ts";
import { graphqlApi, graphqlWebSocket, schema, yoga } from "../apis/graphql.ts";
import { openSession } from "../apis/shared.ts";

/** A GraphQL response. Each error has the `code` of the call failure in its extensions. */
const GraphQLResponse = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string(), extensions: z.looseObject({ code: z.string() }) })).optional(),
});

/** The entries of the list of capabilities of the HTTP binding. */
const CapabilityList = z.array(z.looseObject({ id: z.string() }));

const post = async (handler: (request: Request) => Promise<Response>, query: string, headers: Record<string, string> = {}) => {
  const response = await handler(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query }),
    }),
  );
  return { status: response.status, body: response.ok ? GraphQLResponse.parse(await response.json()) : undefined };
};

/** The code of the first error of a GraphQL response. */
const errorCode = async (response: ReturnType<typeof post>) => (await response).body?.errors?.[0]?.extensions.code;

test("queries and mutations call the capabilities", async () => {
  const unit = new Unit();
  const api = graphqlApi({ unit });
  assert.deepEqual((await post(api, "{ status { ... on Status { power mode targetCelsius } } }")).body, {
    data: { status: { power: false, mode: "cool", targetCelsius: 22 } },
  });
  assert.deepEqual((await post(api, "mutation { setPower(on: true) { ... on Status { power } } }")).body, { data: { setPower: { power: true } } });
  assert.deepEqual((await post(api, "mutation { setMode(mode: heat) { ... on Status { mode } } }")).body, { data: { setMode: { mode: "heat" } } });
  assert.equal(unit.state.mode, "heat");
});

test("a failure is data with its type, and a call failure is an error with its kind", async () => {
  const unit = new Unit();
  const api = graphqlApi({ unit });
  const poweredOff = await post(api, "mutation { setMode(mode: heat) { __typename ... on PoweredOff { _tag } ... on Status { mode } } }");
  assert.deepEqual(poweredOff.body, { data: { setMode: { __typename: "PoweredOff", _tag: "PoweredOff" } } });
  assert.equal(await errorCode(post(api, "mutation { setTemperature(celsius: 40) { __typename } }")), "invalid-input");
  unit.change({ online: false });
  const offline = await post(api, "{ status { __typename ... on Offline { _tag since } } }");
  assert.deepEqual(offline.body, { data: { status: { __typename: "Offline", _tag: "Offline", since: null } } });
});

test("the HTTP binding is at /api, and a foreign origin is rejected", async () => {
  const api = graphqlApi({ unit: new Unit() });
  const listed = CapabilityList.parse(await (await api(new Request("http://localhost/api/capabilities"))).json());
  assert.deepEqual(listed.map((entry) => entry.id), ["aircon.status.get", "aircon.power.set", "aircon.mode.set", "aircon.temperature.set", "aircon.fan.set", "aircon.schedule.set"]);
  assert.equal((await post(api, "{ status { power } }", { Origin: "https://example.com" })).status, 403);
});

/** Wait until a condition is true, or fail after five seconds. */
async function until(what: string, condition: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The data of a subscription result: the status that the subscription gives. */
const StatusChanged = z.object({ data: z.object({ statusChanged: z.object({ power: z.boolean(), fan: z.string() }) }) });

/**
 * Subscribe through one transport, change the unit with a mutation, and read the new status. Then end the
 * subscription, and wait until the event stops listening to the unit.
 */
async function followThenEnd(unit: Unit, api: (request: Request) => Promise<Response>, subscription: AsyncIterableIterator<unknown>) {
  const before = unit.statusListeners;
  const first = subscription.next();
  await until("the subscription listens to the unit", () => unit.statusListeners > before);
  await post(api, "mutation { setPower(on: true) { __typename } }");
  const result = await first;
  assert.equal(result.done, false);
  assert.deepEqual(StatusChanged.parse(result.value).data.statusChanged, { power: true, fan: "auto" });
  await subscription.return?.();
  await until("the subscription stops listening to the unit", () => unit.statusListeners === before);
}

const SUBSCRIPTION = "subscription { statusChanged { power fan } }";

/** A `ws` server on a free port, for GraphQL at `/graphql`. */
async function webSocketServer() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/graphql" });
  await once(server, "listening");
  const address = server.address();
  return { server, port: typeof address === "object" && address !== null ? address.port : 0 };
}

test("a subscription through server-sent events, with the graphql-sse client, gets the new status and ends", async () => {
  const unit = new Unit();
  const api = graphqlApi({ unit });
  await using served = await serve({ "/graphql": api }, { port: 0 });
  const client = createSseClient({ url: `${served.url}/graphql` });
  try {
    await followThenEnd(unit, api, client.iterate({ query: SUBSCRIPTION }));
  } finally {
    client.dispose();
  }
});

test("when the client cancels a stream of server-sent events, Yoga ends the subscription, and the session stays open", async () => {
  const unit = new Unit();
  const session = openSession({ unit });
  try {
    const before = unit.statusListeners;
    const request = new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ query: SUBSCRIPTION }),
    });
    const response = await yoga.fetch(request, { session });
    assert.ok(response.body !== null);
    const reader = response.body.getReader();
    await reader.read();
    await until("the subscription listens to the unit", () => unit.statusListeners > before);
    const waiting = reader.read();
    await reader.cancel();
    assert.equal((await waiting).done, true);
    await until("the subscription stops listening to the unit", () => unit.statusListeners === before);
    const status = await session.call(statusGet, {});
    assert.equal(status.ok, true);
  } finally {
    await session.dispose();
  }
});

test("a subscription through WebSockets, with the graphql-ws client, gets the new status and ends, and the connection is one session", async () => {
  const unit = new Unit();
  const api = graphqlApi({ unit });
  const { server, port } = await webSocketServer();
  const graphql = graphqlWebSocket({ unit }, server);
  const client = createWsClient({ url: `ws://127.0.0.1:${port}/graphql`, webSocketImpl: WebSocket, lazy: true, retryAttempts: 0 });
  try {
    await followThenEnd(unit, api, client.iterate({ query: SUBSCRIPTION }));
    // A call failure has the same error as through HTTP.
    const failed = await client.iterate({ query: "mutation { setTemperature(celsius: 40) { __typename } }" }).next();
    assert.equal(GraphQLResponse.parse(failed.value).errors?.[0]?.extensions.code, "invalid-input");
    // Two subscriptions on one connection: closing the connection closes its session, and so ends both.
    const before = unit.statusListeners;
    const [first, second] = [client.iterate({ query: SUBSCRIPTION }), client.iterate({ query: SUBSCRIPTION })];
    const pending = [first.next(), second.next()];
    await until("both subscriptions listen to the unit", () => unit.statusListeners === before + 2);
    await client.dispose();
    await until("closing the connection ends both subscriptions", () => unit.statusListeners === before);
    for (const result of await Promise.allSettled(pending)) if (result.status === "fulfilled") assert.equal(result.value.done, true);
  } finally {
    await client.dispose();
    await graphql.dispose();
    server.close();
  }
});

test("a WebSocket connection from an origin that the API does not allow is refused", async () => {
  const { server, port } = await webSocketServer();
  const graphql = graphqlWebSocket({ unit: new Unit() }, server);
  const socket = new NodeWebSocket(`ws://127.0.0.1:${port}/graphql`, "graphql-transport-ws", { origin: "https://example.com" });
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "connection_init" }));
    const closed: unknown[] = await once(socket, "close");
    assert.equal(closed[0], 4403);
  } finally {
    await graphql.dispose();
    server.close();
  }
});

test("apis/schema.graphql is the schema of the API", () => {
  const committed = readFileSync(new URL("../apis/schema.graphql", import.meta.url), "utf-8");
  assert.equal(committed, `${printSchema(schema)}\n`, "apis/schema.graphql is stale: run `moon run examples`");
});
