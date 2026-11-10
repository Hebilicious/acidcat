import assert from "node:assert/strict";
import { test } from "node:test";

import { serve } from "@acid-cat/core-ts/node";
import { z } from "zod";

import { Status, Unit } from "../core-ts/aircon.ts";
import { elysiaApi } from "../apis/elysia.ts";

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

test("the HTTP binding is mounted at /api, and a foreign origin is rejected", async () => {
  const unit = new Unit();
  const app = elysiaApi({ unit });
  const response = await app.handle(request("/api/capabilities/aircon.power.set", { method: "POST", body: { on: true } }));
  assert.deepEqual(await response.json(), { ok: true, value: null });
  assert.equal(unit.state.power, true);
  assert.equal((await app.handle(request("/status", { origin: "https://example.com" }))).status, 403);
});

/** Wait until a condition is true, or fail after five seconds. */
async function until(what: string, condition: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Read the events of a stream of server-sent events, one at a time. Each event is a map from field to value. */
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

test("GET /status/changes streams each new status as a server-sent event, and a client that goes away ends the subscription", async () => {
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
  await until("the subscription stops listening to the unit", () => unit.statusListeners === before);
});

test("when the signal of the request aborts, the stream ends and the subscription with it", async () => {
  const unit = new Unit();
  const app = elysiaApi({ unit });
  const before = unit.statusListeners;
  const abort = new AbortController();
  const response = await app.handle(new Request("http://localhost/status/changes", { signal: abort.signal }));
  assert.ok(response.body !== null);
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(unit.statusListeners, before + 1);
  const waiting = reader.read();
  abort.abort();
  assert.equal((await waiting).done, true);
  await until("the subscription stops listening to the unit", () => unit.statusListeners === before);
});
