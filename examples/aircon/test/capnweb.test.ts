import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";

import { serve } from "@acid-cat/cli";
import type { Served } from "@acid-cat/cli";
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import type { z } from "zod";

import { Unit } from "../core-ts/aircon.ts";
import type { Status } from "../core-ts/aircon.ts";
import { capnwebApi, capnwebWebSocket } from "../apis/capnweb.ts";
import type { AirconApi } from "../apis/capnweb.ts";

const unit = new Unit();
let served: Served;
before(async () => {
  const api = capnwebApi({ unit });
  served = await serve({ "/rpc": api, "/api": api });
});
after(() => served.close());

/** A batch: the calls that a client makes before it waits go in one request. */
const client = () => newHttpBatchRpcSession<AirconApi>(`${served.url}/rpc`);

test("methods give the results of the capabilities", async () => {
  assert.deepEqual(await client().setMode("heat"), { ok: false, error: { _tag: "PoweredOff" } });
  const batch = client();
  const [power, status] = await Promise.all([batch.setPower(true), batch.status()]);
  assert.deepEqual(power, { ok: true, value: null });
  assert.equal(status.ok, true);
  assert.deepEqual(await client().setMode("heat"), { ok: true, value: null });
  assert.equal(unit.state.mode, "heat");
});

test("a call failure rejects", async () => {
  await assert.rejects(async () => await client().setTemperature(40), (error: Error) => error.message.includes("celsius"));
});

test("the HTTP binding is at /api", async () => {
  const response = await fetch(`${served.url}/api/capabilities/aircon.fan.set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speed: "high" }),
  });
  assert.deepEqual(await response.json(), { ok: true, value: null });
  assert.equal(unit.state.fan, "high");
});

/** Wait until a condition is true, or fail after five seconds. */
async function until(what: string, condition: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A `ws` server on a free port that serves the API through WebSockets, for one unit. */
async function webSocketServer(unit: Unit, allowedOrigins: readonly string[] = []) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/rpc" });
  await once(server, "listening");
  capnwebWebSocket({ unit, allowedOrigins }, server);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `ws://127.0.0.1:${port}/rpc`, [Symbol.dispose]: () => server.close() };
}

test("followStatus calls the listener with each new status, and disposing its result ends the subscription", async () => {
  const unit = new Unit();
  using ws = await webSocketServer(unit);
  using api = newWebSocketRpcSession<AirconApi>(ws.url);
  const before = unit.statusListeners;
  const statuses: z.infer<typeof Status>[] = [];
  const following = await api.followStatus((status) => void statuses.push(status));
  assert.equal(unit.statusListeners, before + 1, "the subscription has started when followStatus resolves");
  assert.deepEqual(await api.setPower(true), { ok: true, value: null });
  await until("the listener gets the new status", () => statuses.length === 1);
  assert.equal(statuses[0]?.power, true);
  following[Symbol.dispose]();
  await until("the subscription stops listening to the unit", () => unit.statusListeners === before);
  // The connection stays open: its session still calls the capabilities.
  assert.equal((await api.status()).ok, true);
});

test("when the listener of the client throws, the subscription ends", async () => {
  const unit = new Unit();
  using ws = await webSocketServer(unit);
  using api = newWebSocketRpcSession<AirconApi>(ws.url);
  const before = unit.statusListeners;
  using _following = await api.followStatus(() => {
    throw new Error("The listener failed.");
  });
  await api.setPower(true);
  await until("the subscription stops listening to the unit", () => unit.statusListeners === before);
});

test("closing the connection closes its session, which ends each subscription of the connection", async () => {
  const unit = new Unit();
  using ws = await webSocketServer(unit);
  const api = newWebSocketRpcSession<AirconApi>(ws.url);
  const before = unit.statusListeners;
  await Promise.all([api.followStatus(() => undefined), api.followStatus(() => undefined)]);
  assert.equal(unit.statusListeners, before + 2);
  api[Symbol.dispose]();
  await until("closing the connection ends both subscriptions", () => unit.statusListeners === before);
});

test("a WebSocket connection from an origin that the API does not allow is closed", async () => {
  using ws = await webSocketServer(new Unit());
  const socket = new NodeWebSocket(ws.url, { origin: "https://example.com" });
  const closed: unknown[] = await once(socket, "close");
  assert.equal(closed[0], 4403);
});
