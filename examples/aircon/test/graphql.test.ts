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
import { until } from "../../../test-support/until.ts";
import type { Waiter } from "../../../test-support/until.ts";

const GraphQLResponse = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string(), extensions: z.looseObject({ code: z.string() }) })).optional(),
});

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

test("the HTTP surface is at /api, and a foreign origin is rejected", async () => {
  const api = graphqlApi({ unit: new Unit() });
  const listed = CapabilityList.parse(await (await api(new Request("http://localhost/api/capabilities"))).json());
  assert.deepEqual(listed.map((entry) => entry.id), ["aircon.status.get", "aircon.power.set", "aircon.mode.set", "aircon.temperature.set", "aircon.fan.set", "aircon.schedule.set"]);
  assert.equal((await post(api, "{ status { power } }", { Origin: "https://example.com" })).status, 403);
});


const StatusChanged = z.object({ data: z.object({ statusChanged: z.object({ power: z.boolean(), fan: z.string() }) }) });

async function followThenEnd(t: Waiter, unit: Unit, api: (request: Request) => Promise<Response>, subscription: AsyncIterableIterator<unknown>) {
  const before = unit.statusListeners;
  const first = subscription.next();
  await until(t, () => unit.statusListeners > before, Boolean, { what: "the subscription listens to the unit" });
  await post(api, "mutation { setPower(on: true) { __typename } }");
  const result = await first;
  assert.equal(result.done, false);
  assert.deepEqual(StatusChanged.parse(result.value).data.statusChanged, { power: true, fan: "auto" });
  await subscription.return?.();
  await until(t, () => unit.statusListeners === before, Boolean, { what: "the subscription stops listening to the unit" });
}

const SUBSCRIPTION = "subscription { statusChanged { power fan } }";

async function webSocketServer() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/graphql" });
  await once(server, "listening");
  const address = server.address();
  return { server, port: typeof address === "object" && address !== null ? address.port : 0 };
}

test("a subscription through server-sent events, with the graphql-sse client, gets the new status and ends", async (t) => {
  const unit = new Unit();
  const api = graphqlApi({ unit });
  await using served = await serve({ "/graphql": api }, { port: 0 });
  const client = createSseClient({ url: `${served.url}/graphql` });
  try {
    await followThenEnd(t, unit, api, client.iterate({ query: SUBSCRIPTION }));
  } finally {
    client.dispose();
  }
});

test("when the client cancels a stream of server-sent events, Yoga ends the subscription, and the session stays open", async (t) => {
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
    await until(t, () => unit.statusListeners > before, Boolean, { what: "the subscription listens to the unit" });
    const waiting = reader.read();
    await reader.cancel();
    assert.equal((await waiting).done, true);
    await until(t, () => unit.statusListeners === before, Boolean, { what: "the subscription stops listening to the unit" });
    const status = await session.call(statusGet, {});
    assert.equal(status.ok, true);
  } finally {
    await session.dispose();
  }
});

test("a subscription through WebSockets, with the graphql-ws client, gets the new status and ends, and the connection is one session", async (t) => {
  const unit = new Unit();
  const api = graphqlApi({ unit });
  const { server, port } = await webSocketServer();
  const graphql = graphqlWebSocket({ unit }, server);
  const client = createWsClient({ url: `ws://127.0.0.1:${port}/graphql`, webSocketImpl: WebSocket, lazy: true, retryAttempts: 0 });
  try {
    await followThenEnd(t, unit, api, client.iterate({ query: SUBSCRIPTION }));
    const failed = await client.iterate({ query: "mutation { setTemperature(celsius: 40) { __typename } }" }).next();
    assert.equal(GraphQLResponse.parse(failed.value).errors?.[0]?.extensions.code, "invalid-input");
    const before = unit.statusListeners;
    const [first, second] = [client.iterate({ query: SUBSCRIPTION }), client.iterate({ query: SUBSCRIPTION })];
    const pending = [first.next(), second.next()];
    await until(t, () => unit.statusListeners === before + 2, Boolean, { what: "both subscriptions listen to the unit" });
    await client.dispose();
    await until(t, () => unit.statusListeners === before, Boolean, { what: "closing the connection ends both subscriptions" });
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
