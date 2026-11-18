import assert from "node:assert/strict";
import { test } from "node:test";

import { isJsonObject } from "@acid-cat/spec-ts";

import { httpHandler } from "../src/index.ts";
import { serve } from "../src/node.ts";
import { sensorOptions, Sensors, sensorsApp } from "./sensors.ts";
import { sseReader } from "./sse.ts";
import { until } from "./until.ts";

function memberOf(text: string, key: string): unknown {
  const value: unknown = JSON.parse(text);
  return isJsonObject(value) ? value[key] : undefined;
}

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

test("a message of an occurrence with no cursor has no id line", async () => {
  const { server, subscribe } = await served();
  await using _ = server;
  const ticks = sseReader(await subscribe("sensor.ticks"));
  for (let tick = 0; tick < 3; tick += 1) {
    const next = await ticks.next();
    assert.equal(next?.event, "next");
    assert.equal(next.id, undefined);
  }
  await ticks.cancel();
});

test("maxAgeMs that is not an integer of 0 or more is invalid-input, but an unknown event or a malformed escape comes first", async () => {
  const { server, sensors, subscribe } = await served();
  await using _ = server;
  for (const query of ["?maxAgeMs=soon", "?maxAgeMs=1.5", "?maxAgeMs=-1", "?maxAgeMs=", "?maxAgeMs=%20", "?maxAgeMs=1e3"]) {
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

test("maxAgeMs reaches the provider", async () => {
  const sensors = new Sensors();
  const old = new Date(Date.now() - 60_000).toISOString();
  sensors.emit("hall", 1, old);
  sensors.emit("hall", 2, old);
  sensors.emit("hall", 3);
  const { server, subscribe } = await served(sensors);
  await using _ = server;
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

test("the handler alone gives a stream that the client can cancel", async () => {
  const sensors = new Sensors();
  const handler = httpHandler(sensorsApp, { allowedOrigins: [], ...sensorOptions(sensors) });
  const response = await handler(new Request("http://localhost/events/sensor.reading.changed", { method: "POST", headers: { "Content-Type": "application/json" }, body: "" }));
  assert.equal(response.status, 200);
  await until(() => sensors.listeners === 1);
  await response.body?.cancel();
  await until(() => sensors.listeners === 0);
});
