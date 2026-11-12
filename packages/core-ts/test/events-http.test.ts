import assert from "node:assert/strict";
import { test } from "node:test";

import { isJsonObject, isOccurrence } from "@acid-cat/spec-ts";

import { httpHandler } from "../src/index.ts";
import { serve } from "../src/node.ts";
import { sensorOptions, Sensors, sensorsApp } from "./sensors.ts";
import { sseReader } from "./sse.ts";

/** Wait until a condition is true, or fail after one second. */
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("The condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The member `key` of a JSON text that is an object. */
function memberOf(text: string, key: string): unknown {
  const value: unknown = JSON.parse(text);
  return isJsonObject(value) ? value[key] : undefined;
}

/** Serve the sensors through HTTP on a free port. */
async function served(sensors = new Sensors(), keepaliveMs?: number) {
  const handler = httpHandler(sensorsApp, { allowedOrigins: [], target: "api", base: "/api", ...sensorOptions(sensors), ...(keepaliveMs === undefined ? {} : { keepaliveMs }) });
  const server = await serve({ "/api": handler }, { port: 0 });
  const subscribe = (id: string, input: unknown = {}, init: { headers?: Record<string, string>; query?: string; signal?: AbortSignal } = {}) =>
    fetch(`${server.url}/api/events/${id}${init.query ?? ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: JSON.stringify(input),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  return { server, sensors, subscribe };
}

test("GET /events lists the events of the view", async () => {
  const { server } = await served();
  await using _ = server;
  const response = await fetch(`${server.url}/api/events`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    { id: "sensor.reading.changed" },
    { id: "sensor.ticks" },
    { id: "sensor.clock" },
    { id: "sensor.broken" },
    { id: "sensor.failing" },
    { id: "sensor.threshold" },
  ]);
});

test("a subscription is a stream of server-sent events: next with the cursor as id, then complete", async () => {
  const { server, sensors, subscribe } = await served();
  await using _ = server;
  const response = await subscribe("sensor.reading.changed", { room: "kitchen" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const reader = sseReader(response);
  await until(() => sensors.listeners === 1);
  sensors.emit("kitchen", 21, "2026-11-10T09:00:00.000Z");
  const message = await reader.next();
  assert.equal(message?.raw, `event: next\nid: 0\ndata: {"eventId":"reading-0","name":"sensor.reading.changed","timestamp":"2026-11-10T09:00:00.000Z","data":{"room":"kitchen","celsius":21},"cursor":"0"}`);
  await reader.cancel();

  const ticks = sseReader(await subscribe("sensor.ticks"));
  for (let tick = 0; tick < 3; tick += 1) {
    const next = await ticks.next();
    assert.equal(next?.event, "next");
    assert.equal(next.id, undefined);
    assert.ok(isOccurrence(JSON.parse(next.data)));
  }
  assert.deepEqual(await ticks.next(), { event: "complete", data: "", raw: "event: complete\ndata:" });
  assert.equal(await ticks.next(), undefined);
});

test("an internal failure is an error message, then the stream closes, and it shows no internal data", async () => {
  const { server, subscribe } = await served();
  await using _ = server;
  const reader = sseReader(await subscribe("sensor.failing"));
  assert.equal((await reader.next())?.event, "next");
  assert.deepEqual(await reader.next(), {
    event: "error",
    data: '{"kind":"internal","message":"The event failed."}',
    raw: 'event: error\ndata: {"kind":"internal","message":"The event failed."}',
  });
  assert.equal(await reader.next(), undefined);
});

test("failures before the first occurrence are JSON call failures with their status", async () => {
  const { server, subscribe } = await served();
  await using _ = server;
  const unknown = await subscribe("sensor.hidden");
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { kind: "unknown-capability", message: "There is no event sensor.hidden." });
  const invalid = await subscribe("sensor.reading.changed", { room: 7 });
  assert.equal(invalid.status, 422);
  assert.equal(memberOf(await invalid.text(), "kind"), "invalid-input");
  const age = await subscribe("sensor.ticks", {}, { query: "?maxAgeMs=soon" });
  assert.equal(age.status, 422);
  const media = await fetch(`${server.url}/api/events/sensor.ticks`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(media.status, 415);
  const origin = await subscribe("sensor.ticks", {}, { headers: { Origin: "https://evil.example" } });
  assert.equal(origin.status, 403);
});

test("maxAgeMs that is not an integer of 0 or more is invalid-input, but an unknown event or a malformed escape comes first", async () => {
  const { server, sensors, subscribe } = await served();
  await using _ = server;
  for (const query of ["?maxAgeMs=1.5", "?maxAgeMs=-1", "?maxAgeMs=", "?maxAgeMs=%20", "?maxAgeMs=1e3"]) {
    const invalid = await subscribe("sensor.ticks", {}, { query });
    assert.equal(invalid.status, 422, query);
    assert.equal(memberOf(await invalid.text(), "kind"), "invalid-input", query);
    const unknown = await subscribe("sensor.hidden", {}, { query });
    assert.equal(unknown.status, 404, query);
    assert.equal(memberOf(await unknown.text(), "kind"), "unknown-capability", query);
  }
  const malformed = await subscribe("%E0");
  assert.equal(malformed.status, 404);
  assert.equal(memberOf(await malformed.text(), "kind"), "unknown-capability");
  const post = (id: string) => fetch(`${server.url}/api/events/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  const notJson = await post("sensor.ticks");
  assert.equal(notJson.status, 422);
  assert.equal(memberOf(await notJson.text(), "kind"), "invalid-input");
  const unknown = await post("sensor.hidden");
  assert.equal(unknown.status, 404);
  assert.equal(memberOf(await unknown.text(), "kind"), "unknown-capability");
  assert.equal(sensors.listeners, 0);
});

test("Last-Event-ID gives the cursor, and maxAgeMs reaches the provider", async () => {
  const sensors = new Sensors();
  const old = new Date(Date.now() - 60_000).toISOString();
  sensors.emit("hall", 1, old);
  sensors.emit("hall", 2, old);
  sensors.emit("hall", 3);
  const { server, subscribe } = await served(sensors);
  await using _ = server;
  const resumed = sseReader(await subscribe("sensor.reading.changed", {}, { headers: { "Last-Event-ID": "0" } }));
  assert.equal((await resumed.next())?.id, "1");
  await resumed.cancel();
  const recent = sseReader(await subscribe("sensor.reading.changed", {}, { headers: { "Last-Event-ID": "0" }, query: "?maxAgeMs=1000" }));
  const first = await recent.next();
  assert.equal(first?.id, "2");
  assert.equal(memberOf(first.data, "truncated"), true);
  await recent.cancel();
});

test("a comment line keeps an idle stream alive", async () => {
  const { server, subscribe } = await served(new Sensors(), 20);
  await using _ = server;
  const reader = sseReader(await subscribe("sensor.reading.changed"));
  assert.deepEqual(await reader.next(), { event: "comment", data: "", raw: ":" });
  await reader.cancel();
});

test("when the client closes the stream, the subscription is cancelled and the provider stops", async () => {
  const { server, sensors, subscribe } = await served();
  await using _ = server;
  const controller = new AbortController();
  const response = await subscribe("sensor.reading.changed", {}, { signal: controller.signal });
  assert.equal(response.status, 200);
  await until(() => sensors.listeners === 1);
  controller.abort();
  await until(() => sensors.listeners === 0);
});

test("the handler alone gives a stream that the client can cancel", async () => {
  const sensors = new Sensors();
  const handler = httpHandler(sensorsApp, { allowedOrigins: [], ...sensorOptions(sensors) });
  const response = await handler(new Request("http://localhost/events/sensor.reading.changed", { method: "POST", headers: { "Content-Type": "application/json" }, body: "" }));
  assert.equal(response.status, 200);
  await until(() => sensors.listeners === 1);
  await response.body?.cancel();
  await until(() => sensors.listeners === 0);
});
