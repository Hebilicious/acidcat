import assert from "node:assert/strict";
import { test } from "node:test";

import { isJsonObject } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { createSession, defineApp, mcpHandler, mcpHandshake, ok, defineCapability, runMcpStdio } from "../src/index.ts";
import { serve } from "../src/node.ts";
import { sensorOptions, Sensors, sensorsApp, toJsonSchema } from "./sensors.ts";
import { sseReader } from "./sse.ts";

/** Wait until a condition is true, or fail after one second. */
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("The condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const VERSION = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": VERSION };
const SERVER_INFO = { "io.modelcontextprotocol/serverInfo": { name: "sensors", version: "0.0.0" } };
const sub = (id: number | string) => ({ "io.modelcontextprotocol/subscriptionId": id });

/** A JSON object from text. */
function objectOf(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("The message is not an object.");
  return value;
}

/** A member of a JSON object that is itself an object. */
function member(value: unknown, key: string): JsonObject {
  const inner = isJsonObject(value) ? value[key] : undefined;
  if (!isJsonObject(inner)) throw new Error(`The member ${key} is not an object.`);
  return inner;
}

// --- Through HTTP ----------------------------------------------------------------------------------------------------

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

test("MCP through HTTP: server/discover gives the events extension, and events/list gives each event", async () => {
  const { rpc } = httpServer();
  const discovered = member(await rpc("server/discover"), "result");
  assert.deepEqual(discovered["capabilities"], { tools: { listChanged: false }, extensions: { "io.modelcontextprotocol/events": {} } });
  const listed = member(await rpc("events/list"), "result");
  assert.equal(listed["nextCursor"], undefined);
  const events = Array.isArray(listed["events"]) ? listed["events"] : [];
  assert.deepEqual(
    events.find((entry) => isJsonObject(entry) && entry["name"] === "sensor.reading.changed"),
    {
      name: "sensor.reading.changed",
      description: "A sensor gave a new reading. The occurrence gives the room and the temperature.",
      delivery: ["push", "poll"],
      inputSchema: { type: "object", properties: { room: { type: "string" } }, additionalProperties: false },
      payloadSchema: { type: "object", properties: { room: { type: "string" }, celsius: { type: "number" } }, required: ["room", "celsius"], additionalProperties: false },
    },
  );
  assert.deepEqual(member(events.find((entry) => isJsonObject(entry) && entry["name"] === "sensor.ticks"), "payloadSchema"), { type: "object" });
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

test("MCP through HTTP: events/stream is a stream of server-sent events with active, the occurrences, and the result", async () => {
  const { handler, request } = httpServer();
  const response = await handler(request("events/stream", { name: "sensor.ticks" }, undefined, 7));
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  const reader = sseReader(response);
  const read = async () => {
    const message = await reader.next();
    assert.ok(message !== undefined);
    assert.equal(message.event, undefined);
    return objectOf(message.data);
  };
  assert.deepEqual(await read(), { jsonrpc: "2.0", method: "notifications/events/active", params: { truncated: false, _meta: sub(7) } });
  for (let tick = 0; tick < 3; tick += 1) {
    const event = await read();
    assert.equal(event["method"], "notifications/events/event");
    const params = member(event, "params");
    assert.equal(params["name"], "sensor.ticks");
    assert.deepEqual(params["data"], {});
    assert.deepEqual(params["_meta"], sub(7));
  }
  assert.deepEqual(await read(), { jsonrpc: "2.0", id: 7, result: { resultType: "complete", _meta: { ...SERVER_INFO, ...sub(7) } } });
  assert.equal(await reader.next(), undefined);
});

test("MCP through HTTP: an internal failure sends terminated, then the result", async () => {
  const { handler, request } = httpServer();
  const reader = sseReader(await handler(request("events/stream", { name: "sensor.broken" }, undefined, "s")));
  const messages: JsonObject[] = [];
  for (let message = await reader.next(); message !== undefined; message = await reader.next()) messages.push(objectOf(message.data));
  assert.deepEqual(
    messages.map((message) => message["method"] ?? "result"),
    ["notifications/events/active", "notifications/events/event", "notifications/events/terminated", "result"],
  );
  assert.deepEqual(messages[2], { jsonrpc: "2.0", method: "notifications/events/terminated", params: { error: { code: -32603, message: "The event failed." }, _meta: sub("s") } });
});

test("MCP through HTTP: failures before the first occurrence are JSON-RPC errors", async () => {
  const { rpc } = httpServer();
  assert.deepEqual((await rpc("events/stream", { name: "sensor.hidden" }))["error"], { code: -32023, message: "There is no event sensor.hidden.", data: { kind: "event" } });
  assert.equal(member(await rpc("events/stream", { name: "sensor.reading.changed", arguments: { room: 7 } }), "error")["code"], -32602);
  assert.equal(member(await rpc("events/stream", { name: "sensor.ticks", cursor: 5 }), "error")["code"], -32602);
});

test("MCP through HTTP: maxAgeMs that is not an integer of 0 or more is -32602, after an unknown event", async () => {
  const { rpc, sensors } = httpServer();
  for (const maxAgeMs of [1.5, -1, "soon"]) {
    assert.equal(member(await rpc("events/stream", { name: "sensor.reading.changed", maxAgeMs }), "error")["code"], -32602, String(maxAgeMs));
    assert.equal(member(await rpc("events/stream", { name: "sensor.hidden", maxAgeMs }), "error")["code"], -32023, String(maxAgeMs));
  }
  assert.equal(sensors.listeners, 0);
});

test("MCP through HTTP: heartbeats, a truncated occurrence, and the cursor", async () => {
  const sensors = new Sensors();
  const old = new Date(Date.now() - 60_000).toISOString();
  sensors.emit("hall", 1, old);
  sensors.emit("hall", 2, old);
  sensors.emit("hall", 3);
  const { handler, request } = httpServer(sensors, 20);
  const reader = sseReader(await handler(request("events/stream", { name: "sensor.reading.changed", cursor: "0", maxAgeMs: 1000 })));
  const read = async () => objectOf((await reader.next())?.data ?? "null");
  assert.equal(member(await read(), "params")["truncated"], false);
  // maxAgeMs skips the two old readings, so the stream says that it is truncated before the last reading.
  assert.deepEqual(await read(), { jsonrpc: "2.0", method: "notifications/events/active", params: { truncated: true, cursor: "2", _meta: sub(1) } });
  const event = member(await read(), "params");
  assert.equal(event["cursor"], "2");
  assert.equal(event["truncated"], undefined);
  assert.deepEqual(await read(), { jsonrpc: "2.0", method: "notifications/events/heartbeat", params: { cursor: "2", _meta: sub(1) } });
  await reader.cancel();
});

test("MCP through HTTP: when the client closes the request, the subscription is cancelled", async () => {
  const { handler, sensors } = httpServer();
  await using server = await serve(handler, { port: 0 });
  const controller = new AbortController();
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "MCP-Protocol-Version": VERSION },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/stream", params: { name: "sensor.reading.changed", _meta: META } }),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  await until(() => sensors.listeners === 1);
  controller.abort();
  await until(() => sensors.listeners === 0);
});

test("MCP through HTTP: a client with the initialize handshake gets no events", async () => {
  const { handler } = httpServer();
  const wrapped = mcpHandshake(handler);
  const post = async (body: object) =>
    objectOf(await (await wrapped(new Request("https://sensors.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) }))).text());
  const initialized = await post({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  assert.deepEqual(member(member(initialized, "result"), "capabilities"), { tools: { listChanged: false } });
  assert.equal(member(await post({ id: 2, method: "events/list", params: {} }), "error")["code"], -32601);
});

// --- Through stdio ---------------------------------------------------------------------------------------------------

/** Standard input that the test writes line by line, and the lines of standard output. */
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
    /** The messages of one subscription, by its id in `_meta`, or the response with that id. */
    of: (id: number | string) =>
      written.filter((message) => message["id"] === id || (isJsonObject(message["params"]) && isJsonObject(message["params"]["_meta"]) && message["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"] === id)),
  };
}

test("MCP through stdio: events/stream writes its messages to standard output, and two streams have their own ids", async () => {
  const sensors = new Sensors();
  const io = stdio(sensors);
  io.send({ id: 1, method: "events/stream", params: { name: "sensor.reading.changed", arguments: { room: "kitchen" }, _meta: META } });
  io.send({ id: 2, method: "events/stream", params: { name: "sensor.reading.changed", _meta: META } });
  await until(() => sensors.listeners === 2);
  sensors.emit("kitchen", 21, "2026-11-10T09:00:00.000Z");
  sensors.emit("hall", 18, "2026-11-10T09:00:01.000Z");
  await until(() => io.of(2).length === 3);
  assert.deepEqual(io.of(1), [
    { jsonrpc: "2.0", method: "notifications/events/active", params: { truncated: false, _meta: sub(1) } },
    {
      jsonrpc: "2.0",
      method: "notifications/events/event",
      params: { eventId: "reading-0", name: "sensor.reading.changed", timestamp: "2026-11-10T09:00:00.000Z", data: { room: "kitchen", celsius: 21 }, cursor: "0", _meta: sub(1) },
    },
  ]);
  // notifications/cancelled cancels one stream. The server sends nothing more for it, and the other stream continues.
  io.send({ method: "notifications/cancelled", params: { requestId: 1 } });
  await until(() => sensors.listeners === 1);
  sensors.emit("kitchen", 22);
  await until(() => io.of(2).length === 4);
  assert.equal(io.of(1).length, 2);
  // The end of standard input closes the session: the open stream is complete.
  io.end();
  await io.served;
  assert.deepEqual(io.of(2).at(-1), { jsonrpc: "2.0", id: 2, result: { resultType: "complete", _meta: { ...SERVER_INFO, ...sub(2) } } });
  assert.equal(sensors.listeners, 0);
});

test("MCP through stdio: discover, list, heartbeat, Unsupported webhook delivery and the handshake", async () => {
  const io = stdio(new Sensors(), 20);
  io.send({ id: 1, method: "server/discover", params: { _meta: META } });
  io.send({ id: 2, method: "events/list", params: { _meta: META } });
  io.send({ id: 3, method: "events/subscribe", params: { name: "sensor.ticks", _meta: META } });
  io.send({ id: 4, method: "events/stream", params: { name: "sensor.reading.changed", _meta: META } });
  io.send({ id: 5, method: "events/stream", params: { name: "sensor.reading.changed" } });
  io.send({ id: 6, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  await until(() => io.of(4).some((message) => message["method"] === "notifications/events/heartbeat"));
  assert.deepEqual(member(member(io.of(1)[0], "result"), "capabilities"), { tools: { listChanged: true }, extensions: { "io.modelcontextprotocol/events": {} } });
  assert.equal(Array.isArray(member(io.of(2)[0], "result")["events"]), true);
  assert.equal(member(io.of(3)[0], "error")["code"], -32026);
  assert.deepEqual(io.of(4).find((message) => message["method"] === "notifications/events/heartbeat"), { jsonrpc: "2.0", method: "notifications/events/heartbeat", params: { cursor: null, _meta: sub(4) } });
  // A request with no revision in _meta is of a revision with a handshake: it gets no events.
  assert.equal(member(io.of(5)[0], "error")["code"], -32601);
  assert.deepEqual(member(member(io.of(6)[0], "result"), "capabilities"), { tools: { listChanged: true } });
  io.end();
  await io.served;
});

test("a session of the MCP target has the events of the view", () => {
  const session = createSession(sensorsApp, { target: "mcp", ...sensorOptions() });
  assert.equal(session.eventHandles.size, 6);
});
