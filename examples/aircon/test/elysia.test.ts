import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";

import { serve } from "@acid-cat/core-ts/node";
import { node } from "@elysiajs/node";
import { WebSocket } from "ws";
import { z } from "zod";

import { Status, Unit } from "../core-ts/aircon.ts";
import { elysiaApi } from "../apis/elysia.ts";
import { until } from "./until.ts";

const request = (path: string, init: { method?: string; body?: unknown; origin?: string } = {}) =>
  new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(init.origin === undefined ? {} : { Origin: init.origin }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

test("the routes of the application call the capabilities", async () => {
  const unit = new Unit();
  const app = elysiaApi({ unit });
  const changed = await app.handle(request("/status", { method: "PATCH", body: { power: true, mode: "heat", targetCelsius: 24 } }));
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { power: true, mode: "heat", fan: "auto", targetCelsius: 24, roomCelsius: 25 });
  assert.deepEqual(await (await app.handle(request("/status"))).json(), unit.status.getSnapshot());
});

test("a failure gives 409, a call failure its status, and a bad body 422", async () => {
  const unit = new Unit();
  const app = elysiaApi({ unit });
  const poweredOff = await app.handle(request("/status", { method: "PATCH", body: { mode: "heat", fan: "high" } }));
  assert.equal(poweredOff.status, 409);
  assert.deepEqual(await poweredOff.json(), { _tag: "PoweredOff" });
  assert.equal(unit.state.fan, "auto", "the failure stops the settings after it");
  const invalid = await app.handle(request("/status", { method: "PATCH", body: { targetCelsius: 40 } }));
  assert.equal(invalid.status, 422);
  const { kind } = z.object({ kind: z.string(), message: z.string() }).parse(await invalid.json());
  assert.equal(kind, "invalid-input");
  assert.equal((await app.handle(request("/status", { method: "PATCH", body: { mode: "warm" } }))).status, 422);
});

test("the HTTP surface is mounted at /api, and a foreign origin is rejected", async () => {
  const unit = new Unit();
  const app = elysiaApi({ unit });
  const response = await app.handle(request("/api/capabilities/aircon.power.set", { method: "POST", body: { on: true } }));
  assert.deepEqual(await response.json(), { ok: true, value: null });
  assert.equal(unit.state.power, true);
  assert.equal((await app.handle(request("/status", { origin: "https://example.com" }))).status, 403);
});


function sseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return async (): Promise<Map<string, string>> => {
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the stream ended before the next event");
      text += decoder.decode(chunk.value, { stream: true });
    }
    const end = text.indexOf("\n\n");
    const lines = text.slice(0, end).split("\n");
    text = text.slice(end + 2);
    return new Map(lines.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
  };
}

test("GET /status/changes streams each new status as a server-sent event, and a client that goes away ends the subscription", async (t) => {
  const unit = new Unit();
  const app = elysiaApi({ unit });
  await using served = await serve({ "/status": async (incoming) => app.handle(incoming) }, { port: 0 });
  const before = unit.statusListeners;
  const disconnect = new AbortController();
  const response = await fetch(`${served.url}/status/changes`, { signal: disconnect.signal });
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.ok(response.body !== null);
  assert.equal(unit.statusListeners, before + 1, "the subscription has started when the response arrives");
  const next = sseEvents(response.body);
  assert.equal((await next()).get("retry"), "1000");
  await app.handle(request("/status", { method: "PATCH", body: { power: true, fan: "high" } }));
  const changes = [await next(), await next()];
  assert.deepEqual(changes.map((event) => event.get("event")), ["aircon.status.changed", "aircon.status.changed"]);
  const last = Status.parse(JSON.parse(changes[1]?.get("data") ?? "null"));
  assert.deepEqual({ power: last.power, fan: last.fan }, { power: true, fan: "high" });
  disconnect.abort();
  await until(t, () => unit.statusListeners === before, Boolean, { what: "the subscription stops listening to the unit" });
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * `@elysiajs/node` 1.4.5 takes `stop` from the web standard adapter of Elysia. That `stop` reads `app.server`, but the
 * `listen` of `@elysiajs/node` does not set `app.server`. Thus `app.server` stays `null`, and `app.stop()` throws
 * "Elysia isn't running" for a server that runs. The adapter gives its server to the callback of `listen`, and that
 * server has its own `stop`: the function stops that server. When a release of `@elysiajs/node` sets `app.server` in
 * `listen`, use `app.stop()`, and remove the callback and `isStoppable`.
 *
 * The adapter starts to listen a short time after `listen` returns. The server of the callback holds the srvx server in
 * `raw`, and its `ready()` resolves when the port listens.
 */
async function listenOnNode(app: ReturnType<typeof elysiaApi>): Promise<{ readonly port: number; readonly stop: () => Promise<void> }> {
  const port = await freePort();
  let served: unknown;
  app.listen({ hostname: "127.0.0.1", port }, (server: unknown) => {
    served = server;
  });
  const server = served;
  if (!isStoppable(server) || !hasRawServer(server)) throw new Error("The adapter gave no srvx server to the callback of listen.");
  await server.raw.ready();
  return {
    port,
    stop: async () => {
      await server.stop();
    },
  };
}

const hasRawServer = (server: unknown): server is { raw: { ready(): unknown } } =>
  typeof server === "object" &&
  server !== null &&
  "raw" in server &&
  typeof server.raw === "object" &&
  server.raw !== null &&
  "ready" in server.raw &&
  typeof server.raw.ready === "function";

const isStoppable = (server: unknown): server is { stop(): unknown } =>
  typeof server === "object" && server !== null && "stop" in server && typeof server.stop === "function";

const textOf = (data: Buffer | ArrayBuffer | Buffer[]): string =>
  Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : data.toString("utf8");

const Message = z.object({ event: z.string(), data: Status.optional() });

test("the WebSocket /status/follow, on the Node.js adapter of Elysia, gets each change, and closing it ends the subscription", async (t) => {
  const unit = new Unit();
  const { port, stop } = await listenOnNode(elysiaApi({ unit }, node()));
  const socket = new WebSocket(`ws://127.0.0.1:${port}/status/follow`);
  try {
    const messages: z.infer<typeof Message>[] = [];
    socket.on("message", (data) => messages.push(Message.parse(JSON.parse(textOf(data)))));
    await until(t, () => messages.some((message) => message.event === "following"), Boolean, { what: "the subscription has started" });
    assert.equal(unit.statusListeners, 1);
    const changed = await fetch(`http://127.0.0.1:${port}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: true }),
    });
    assert.equal(changed.status, 200);
    await until(t, () => messages.some((message) => message.event === "aircon.status.changed"), Boolean, { what: "the change arrives" });
    assert.equal(messages.find((message) => message.event === "aircon.status.changed")?.data?.power, true);
    socket.close();
    await until(t, () => unit.statusListeners === 0, Boolean, { what: "closing the WebSocket ends the subscription" });
  } finally {
    socket.close();
    await stop();
  }
});

test("the WebSocket /status/follow refuses the upgrade of a foreign origin with 403", async () => {
  const unit = new Unit();
  const { port, stop } = await listenOnNode(elysiaApi({ unit, allowedOrigins: [] }, node()));
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/status/follow`, { origin: "https://example.com" });
    const status = await new Promise<number | undefined>((resolve) => {
      socket.on("unexpected-response", (upgrade, response) => {
        // With a listener of "unexpected-response", the client ends the request itself.
        upgrade.destroy();
        resolve(response.statusCode);
      });
    });
    assert.equal(status, 403);
    assert.equal(unit.statusListeners, 0);
  } finally {
    await stop();
  }
});
