import assert from "node:assert/strict";
import { test } from "node:test";

import { isJsonObject } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { defineApp, mcpHandler, mcpHandshake, ok, defineCapability, runMcpStdio } from "../src/index.ts";
import { sensorOptions, Sensors, sensorsApp, toJsonSchema } from "./sensors.ts";
import { sseReader } from "./sse.ts";
import { until } from "./until.ts";

const VERSION = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": VERSION };
const SERVER_INFO = { "io.modelcontextprotocol/serverInfo": { name: "sensors", version: "0.0.0" } };
const sub = (id: number | string) => ({ "io.modelcontextprotocol/subscriptionId": id });

function objectOf(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("The message is not an object.");
  return value;
}

function member(value: unknown, key: string): JsonObject {
  const inner = isJsonObject(value) ? value[key] : undefined;
  if (!isJsonObject(inner)) throw new Error(`The member ${key} is not an object.`);
  return inner;
}

function httpServer(sensors = new Sensors(), heartbeatMs?: number) {
  const handler = mcpHandler(sensorsApp, { name: "sensors", version: "0.0.0", allowedOrigins: [], ...sensorOptions(sensors), ...(heartbeatMs === undefined ? {} : { heartbeatMs }) });
  const request = (method: string, params: object = {}, signal?: AbortSignal, id: number | string = 1) =>
    new Request("https://sensors.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Method": method, "MCP-Protocol-Version": VERSION },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }),
      ...(signal === undefined ? {} : { signal }),
    });
  const rpc = async (method: string, params: object = {}) => objectOf(await (await handler(request(method, params))).text());
  return { handler, request, rpc, sensors };
}

test("MCP through HTTP: events/list bundles the payload schema of a $ref, and an event with no payload schema has an object schema", async () => {
  const { rpc } = httpServer();
  const listed = member(await rpc("events/list"), "result");
  const events = Array.isArray(listed["events"]) ? listed["events"] : [];
  const payloadOf = (name: string) => member(events.find((entry) => isJsonObject(entry) && entry["name"] === name), "payloadSchema");
  assert.deepEqual(payloadOf("sensor.reading.changed"), { type: "object", properties: { room: { type: "string" }, celsius: { type: "number" } }, required: ["room", "celsius"], additionalProperties: false });
  assert.deepEqual(payloadOf("sensor.ticks"), { type: "object" });
});

test("MCP through HTTP: events/subscribe and events/unsubscribe are Unsupported when webhook delivery is off", async () => {
  const { rpc } = httpServer();
  assert.deepEqual((await rpc("events/subscribe", { name: "sensor.ticks" }))["error"], { code: -32026, message: "Unsupported", data: { feature: "deliveryMode", value: "webhook" } });
  assert.deepEqual((await rpc("events/unsubscribe", { name: "sensor.ticks" }))["error"], { code: -32026, message: "Unsupported", data: { feature: "deliveryMode", value: "webhook" } });
});

test("MCP through HTTP: a server whose view has no events serves no events methods and no extension", async () => {
  const app = defineApp({
    targets: { mcp: { bindings: ["mcp"] } },
    capabilities: [defineCapability({ id: "probe.ping", description: "Ping.", audience: ["mcp"], run: () => ok(null) })],
  });
  const handler = mcpHandler(app, { name: "probe", version: "0.0.0", allowedOrigins: [], toJsonSchema, context: undefined });
  const rpc = async (method: string) =>
    objectOf(
      await (
        await handler(
          new Request("https://probe.example/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json", "MCP-Protocol-Version": VERSION },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name: "probe.x", _meta: META } }),
          }),
        )
      ).text(),
    );
  assert.deepEqual(member(member(await rpc("server/discover"), "result"), "capabilities"), { tools: { listChanged: false } });
  for (const method of ["events/list", "events/stream", "events/poll"]) assert.equal(member(await rpc(method), "error")["code"], -32601);
});

test("MCP through HTTP: a cursor that is not a string, or a maxAgeMs that is not an integer of 0 or more, is -32602, after an unknown event", async () => {
  const { rpc, sensors } = httpServer();
  assert.equal(member(await rpc("events/stream", { name: "sensor.ticks", cursor: 5 }), "error")["code"], -32602);
  for (const maxAgeMs of [1.5, -1, "soon"]) {
    assert.equal(member(await rpc("events/stream", { name: "sensor.reading.changed", maxAgeMs }), "error")["code"], -32602, String(maxAgeMs));
    assert.equal(member(await rpc("events/stream", { name: "sensor.hidden", maxAgeMs }), "error")["code"], -32023, String(maxAgeMs));
  }
  assert.equal(sensors.listeners, 0);
});

test("MCP through HTTP: maxAgeMs reaches the provider, and an idle stream gets heartbeats", async () => {
  const sensors = new Sensors();
  const old = new Date(Date.now() - 60_000).toISOString();
  sensors.emit("hall", 1, old);
  sensors.emit("hall", 2, old);
  sensors.emit("hall", 3);
  const { handler, request } = httpServer(sensors, 20);
  const reader = sseReader(await handler(request("events/stream", { name: "sensor.reading.changed", cursor: "0", maxAgeMs: 1000 })));
  const read = async () => objectOf((await reader.next())?.data ?? "null");
  assert.equal(member(await read(), "params")["truncated"], false);
  assert.deepEqual(await read(), { jsonrpc: "2.0", method: "notifications/events/active", params: { truncated: true, cursor: "2", heartbeatMs: 20, _meta: sub(1) } });
  await read();
  assert.deepEqual(await read(), { jsonrpc: "2.0", method: "notifications/events/heartbeat", params: { cursor: "2", _meta: sub(1) } });
  await reader.cancel();
});

test("MCP through HTTP: notifications/events/active grants the heartbeatMs that the request suggests, between 1000 and 60000, or the heartbeatMs of the deployment", async () => {
  const { handler, request, rpc } = httpServer(new Sensors(), 15_000);
  const grant = async (heartbeatMs?: number) => {
    const reader = sseReader(await handler(request("events/stream", { name: "sensor.reading.changed", ...(heartbeatMs === undefined ? {} : { heartbeatMs }) })));
    try {
      return objectOf((await reader.next())?.data ?? "null");
    } finally {
      await reader.cancel();
    }
  };
  assert.deepEqual(await grant(), { jsonrpc: "2.0", method: "notifications/events/active", params: { truncated: false, heartbeatMs: 15_000, _meta: sub(1) } });
  for (const [suggested, granted] of [[5, 1000], [999_999, 60_000], [2500, 2500]] as const) {
    assert.equal(member(await grant(suggested), "params")["heartbeatMs"], granted, String(suggested));
  }
  for (const heartbeatMs of [0, -1, 1.5, "x"]) {
    assert.equal(member(await rpc("events/stream", { name: "sensor.reading.changed", heartbeatMs }), "error")["code"], -32602, String(heartbeatMs));
  }
});

test("MCP through HTTP: a client with the initialize handshake gets no events", async () => {
  const { handler } = httpServer();
  const wrapped = mcpHandshake(handler);
  const post = async (body: object) =>
    objectOf(await (await wrapped(new Request("https://sensors.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) }))).text());
  await post({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  assert.equal(member(await post({ id: 2, method: "events/list", params: {} }), "error")["code"], -32601);
});

function stdio(sensors = new Sensors(), heartbeatMs?: number) {
  const queue: string[] = [];
  let ended = false;
  let wake = () => {};
  async function* input(): AsyncGenerator<string> {
    for (;;) {
      const line = queue.shift();
      if (line !== undefined) {
        yield `${line}\n`;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  const written: JsonObject[] = [];
  const served = runMcpStdio(sensorsApp, { name: "sensors", version: "0.0.0", ...sensorOptions(sensors), ...(heartbeatMs === undefined ? {} : { heartbeatMs }) }, {
    input: input(),
    write: (text) => written.push(objectOf(text)),
  });
  return {
    written,
    served,
    send: (message: object) => {
      queue.push(JSON.stringify({ jsonrpc: "2.0", ...message }));
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
    of: (id: number | string) =>
      written.filter((message) => message["id"] === id || (isJsonObject(message["params"]) && isJsonObject(message["params"]["_meta"]) && message["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"] === id)),
  };
}

test("MCP through stdio: the end of standard input completes each open stream, and its provider stops", async () => {
  const sensors = new Sensors();
  const io = stdio(sensors);
  io.send({ id: 1, method: "events/stream", params: { name: "sensor.reading.changed", _meta: META } });
  await until(() => sensors.listeners === 1);
  io.end();
  await io.served;
  assert.deepEqual(io.of(1).at(-1), { jsonrpc: "2.0", id: 1, result: { resultType: "complete", _meta: { ...SERVER_INFO, ...sub(1) } } });
  assert.equal(sensors.listeners, 0);
});

test("MCP through stdio: an idle stream gets heartbeats", async () => {
  const io = stdio(new Sensors(), 20);
  io.send({ id: 1, method: "events/stream", params: { name: "sensor.reading.changed", _meta: META } });
  const heartbeat = () => io.of(1).find((message) => message["method"] === "notifications/events/heartbeat");
  try {
    await until(() => heartbeat() !== undefined);
    assert.deepEqual(io.of(1)[0], { jsonrpc: "2.0", method: "notifications/events/active", params: { truncated: false, heartbeatMs: 20, _meta: sub(1) } });
    assert.deepEqual(heartbeat(), { jsonrpc: "2.0", method: "notifications/events/heartbeat", params: { cursor: null, _meta: sub(1) } });
  } finally {
    io.end();
    await io.served;
  }
});

test("MCP through stdio: a request with no _meta is -32601, and initialize gives no events extension", async () => {
  const io = stdio();
  io.send({ id: 1, method: "events/stream", params: { name: "sensor.reading.changed" } });
  io.send({ id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  await until(() => io.of(1).length === 1 && io.of(2).length === 1);
  assert.equal(member(io.of(1)[0], "error")["code"], -32601);
  assert.deepEqual(member(member(io.of(2)[0], "result"), "capabilities"), { tools: { listChanged: true } });
  io.end();
  await io.served;
});

