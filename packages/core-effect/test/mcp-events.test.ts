import assert from "node:assert/strict";
import { test } from "node:test";

import { Cause, Effect, Exit, Fiber, Queue, Schema, Scope, Sink, Stdio, Stream } from "effect";

import { Mcp } from "../src/index.ts";
import * as NodeServer from "../src/NodeServer.ts";
import { events, feedForPromises, feedLayer, following, publish } from "./events-fixture.ts";
import { fixture, fixtureLayer } from "./fixture.ts";

const ORIGIN = "https://fixture.example";
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const EXTENSION = "io.modelcontextprotocol/events";

/** A JSON-RPC message, with the members that the tests read. */
const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String, data: Schema.optional(Schema.Unknown) })),
});
type Message = typeof Message.Type;
const decodeMessage = (text: string): Message => Schema.decodeUnknownSync(Schema.fromJsonString(Message))(text);

const Discovery = Schema.Struct({ capabilities: Schema.Struct({ extensions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }) });
const EventList = Schema.Struct({
  resultType: Schema.Literal("complete"),
  events: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.String, delivery: Schema.Array(Schema.String), inputSchema: Schema.Unknown, payloadSchema: Schema.Unknown }),
  ),
});

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

/** One MCP request of revision 2026-07-28 through HTTP, with the headers of the revision. */
function mcpRequest(method: string, params: Record<string, unknown> = {}, init: { readonly id?: string | number; readonly signal?: AbortSignal; readonly name?: string | null } = {}) {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Method": method,
    "MCP-Protocol-Version": "2026-07-28",
  });
  const name = init.name === undefined ? params.name : init.name;
  if (typeof name === "string") headers.set("Mcp-Name", name);
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: init.id ?? 1, method, params: { ...params, _meta: meta } }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });
}

/** The JSON-RPC messages in the `data:` fields of a stream of server-sent events, one at a time. */
function sseMessages(response: Response) {
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  return async (): Promise<Message | undefined> => {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data !== "") return decodeMessage(data);
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      buffered += chunk.value;
    }
  };
}

const json = async (response: Response) => decodeMessage(await response.text());

test("through HTTP, server/discover declares the extension only when the view has events", async () => {
  const handler = Mcp.toWebHandler(events, feedLayer, { name: "feed", version: "0.0.0", allowedOrigins: [ORIGIN] });
  const discovered = Schema.decodeUnknownSync(Discovery)((await json(await handler(mcpRequest("server/discover")))).result);
  assert.deepEqual(discovered.capabilities.extensions?.[EXTENSION], {});
  const without = Mcp.toWebHandler(fixture, fixtureLayer, { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN] });
  const plain = Schema.decodeUnknownSync(Discovery)((await json(await without(mcpRequest("server/discover")))).result);
  assert.equal(plain.capabilities.extensions?.[EXTENSION], undefined);
  const notFound = await without(mcpRequest("events/list"));
  assert.equal((await json(notFound)).error?.code, -32601);
});

test("through HTTP, events/list gives the events of the view, and poll and webhook are unsupported", async () => {
  const handler = Mcp.toWebHandler(events, feedLayer, { name: "feed", version: "0.0.0", allowedOrigins: [ORIGIN] });
  const list = Schema.decodeUnknownSync(EventList)((await json(await handler(mcpRequest("events/list")))).result);
  assert.deepEqual(list.events.map((each) => each.name).sort(), ["feed.counted", "feed.crashing", "feed.disagreeing", "feed.resumed", "feed.ticked", "feed.timed"]);
  const crashing = list.events.find((each) => each.name === "feed.crashing");
  assert.deepEqual(crashing?.delivery, ["push"]);
  assert.deepEqual(crashing?.payloadSchema, { type: "object" });
  const poll = await json(await handler(mcpRequest("events/poll", { name: "feed.ticked" })));
  assert.deepEqual(poll.error?.data, { feature: "deliveryMode", value: "poll" });
  assert.equal(poll.error?.code, -32026);
  const webhook = await json(await handler(mcpRequest("events/subscribe", { name: "feed.ticked" })));
  assert.deepEqual(webhook.error?.data, { feature: "deliveryMode", value: "webhook" });
});

test("through HTTP, a subscription that cannot start is a JSON-RPC error, and the headers must agree with the body", async () => {
  const handler = Mcp.toWebHandler(events, feedLayer, { name: "feed", version: "0.0.0", allowedOrigins: [ORIGIN] });
  const hidden = await json(await handler(mcpRequest("events/stream", { name: "feed.hidden" })));
  assert.equal(hidden.error?.code, -32023);
  assert.deepEqual(hidden.error?.data, { kind: "event" });
  const invalid = await json(await handler(mcpRequest("events/stream", { name: "feed.ticked", arguments: { room: 1 } })));
  assert.equal(invalid.error?.code, -32602);
  const noName = await json(await handler(mcpRequest("events/stream", {})));
  assert.equal(noName.error?.code, -32602);
  const mismatch = await handler(mcpRequest("events/stream", { name: "feed.ticked" }, { name: "feed.other" }));
  assert.equal(mismatch.status, 400);
  assert.equal((await json(mismatch)).error?.code, -32020);
});

test("through HTTP, events/stream is a stream of server-sent events, with the subscription id in each message", async () => {
  const handler = Mcp.toWebHandler(events, feedLayer, { name: "feed", version: "0.0.0", allowedOrigins: [ORIGIN] });
  const response = await handler(mcpRequest("events/stream", { name: "feed.counted", arguments: { a: 1 } }, { id: 7 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  const next = sseMessages(response);
  const active = await next();
  assert.equal(active?.method, "notifications/events/active");
  assert.deepEqual(active?.params, { truncated: false, _meta: { [SUBSCRIPTION_ID]: 7 } });
  const event = await next();
  assert.equal(event?.method, "notifications/events/event");
  assert.equal(event?.params?.name, "feed.counted");
  assert.equal(event?.params?.eventId, "a");
  assert.deepEqual(event?.params?.data, { key: "a", value: 1 });
  assert.deepEqual(event?.params?._meta, { [SUBSCRIPTION_ID]: 7 });
  const result = await next();
  assert.deepEqual(result, { id: 7, result: { resultType: "complete", _meta: { [SUBSCRIPTION_ID]: 7 } } });
  assert.equal(await next(), undefined);

  const crashed = sseMessages(await handler(mcpRequest("events/stream", { name: "feed.crashing" }, { id: "c" })));
  assert.equal((await crashed())?.method, "notifications/events/active");
  assert.equal((await crashed())?.method, "notifications/events/event");
  const terminated = await crashed();
  assert.equal(terminated?.method, "notifications/events/terminated");
  assert.deepEqual(terminated?.params, { error: { code: -32603, message: "The event failed." }, _meta: { [SUBSCRIPTION_ID]: "c" } });
  assert.deepEqual((await crashed())?.result, { resultType: "complete", _meta: { [SUBSCRIPTION_ID]: "c" } });
});

test("through HTTP, a stream with nothing to send gets heartbeats with the last cursor", async () => {
  const feed = feedForPromises();
  const handler = Mcp.toWebHandler(events, feed.layer, { name: "feed", version: "0.0.0", allowedOrigins: [ORIGIN], heartbeatMs: 30 });
  const controller = new AbortController();
  const next = sseMessages(await handler(mcpRequest("events/stream", { name: "feed.ticked" }, { signal: controller.signal })));
  assert.equal((await next())?.method, "notifications/events/active");
  await feed.following(1);
  await feed.publish({ room: "a", count: 4 });
  assert.equal((await next())?.params?.cursor, "4");
  const heartbeat = await next();
  assert.equal(heartbeat?.method, "notifications/events/heartbeat");
  assert.deepEqual(heartbeat?.params, { cursor: "4", _meta: { [SUBSCRIPTION_ID]: 1 } });
  controller.abort();
  await feed.following(0);
});

test("through a Node.js server, closing the request of events/stream cancels the subscription", async () => {
  const feed = feedForPromises();
  const handler = Mcp.toWebHandler(events, feed.layer, { name: "feed", version: "0.0.0", allowedOrigins: [ORIGIN] });
  const scope = Effect.runSync(Scope.make());
  try {
    const served = await Effect.runPromise(NodeServer.serve({ "/mcp": handler }, { port: 0 }).pipe(Scope.provide(scope)));
    const controller = new AbortController();
    const request = mcpRequest("events/stream", { name: "feed.ticked", arguments: { room: "a" } });
    const response = await fetch(`${served.url}/mcp`, { method: "POST", headers: request.headers, body: await request.text(), signal: controller.signal });
    const next = sseMessages(response);
    assert.equal((await next())?.method, "notifications/events/active");
    await feed.following(1);
    await feed.publish({ room: "a", count: 1 });
    assert.deepEqual((await next())?.params?.data, { room: "a", count: 1 });
    controller.abort();
    await feed.following(0);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

test("through stdio, events/stream sends its messages to standard output, and notifications/cancelled cancels it", async () => {
  const program = Effect.gen(function* () {
    const stdin = yield* Queue.unbounded<string, Cause.Done>();
    const stdout = yield* Queue.unbounded<string>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stdio = Stdio.layerTest({
      stdin: Stream.fromQueue(stdin).pipe(Stream.map((line) => encoder.encode(`${line}\n`))),
      stdout: () => Sink.forEach((chunk: string | Uint8Array) => Queue.offer(stdout, typeof chunk === "string" ? chunk : decoder.decode(chunk))),
    });
    const send = (message: object) => Queue.offer(stdin, JSON.stringify(message));
    const next = Effect.map(Queue.take(stdout), (line) => decodeMessage(line.trim()));

    const served = yield* Mcp.serveStdio(events, { name: "feed", version: "0.0.0" }).pipe(Effect.provide(stdio), Effect.forkChild({ startImmediately: true }));
    yield* send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } });
    const discovered = Schema.decodeUnknownSync(Discovery)((yield* next).result);
    yield* send({ jsonrpc: "2.0", id: 2, method: "events/stream", params: { name: "feed.ticked", arguments: { room: "a" }, _meta: meta } });
    const active = yield* next;
    yield* following(1);
    yield* publish({ room: "a", count: 1 });
    const event = yield* next;
    yield* send({ jsonrpc: "2.0", id: 3, method: "events/stream", params: { name: "feed.counted", arguments: { x: 1 }, _meta: meta } });
    const second = [yield* next, yield* next, yield* next];
    yield* send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    yield* following(0);
    yield* send({ jsonrpc: "2.0", id: 4, method: "events/stream", params: { name: "feed.hidden", _meta: meta } });
    const hidden = yield* next;
    yield* Queue.end(stdin);
    yield* Fiber.join(served);
    return { discovered, active, event, second, hidden, left: yield* Queue.size(stdout) };
  }).pipe(Effect.scoped, Effect.provide(feedLayer));
  const { discovered, active, event, second, hidden, left } = await Effect.runPromise(program);
  assert.deepEqual(discovered.capabilities.extensions?.[EXTENSION], {});
  assert.deepEqual(active.params, { truncated: false, _meta: { [SUBSCRIPTION_ID]: 2 } });
  assert.deepEqual(event.params?.data, { room: "a", count: 1 });
  assert.deepEqual(event.params?._meta, { [SUBSCRIPTION_ID]: 2 });
  assert.deepEqual(
    second.map((each) => each.method ?? each.result?.resultType),
    ["notifications/events/active", "notifications/events/event", "complete"],
  );
  assert.equal(hidden.id, 4);
  assert.equal(hidden.error?.code, -32023);
  assert.equal(left, 0);
});

test("through stdio, a client of the initialize handshake gets no events", async () => {
  const program = Effect.gen(function* () {
    const stdin = yield* Queue.unbounded<string, Cause.Done>();
    const stdout = yield* Queue.unbounded<string>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stdio = Stdio.layerTest({
      stdin: Stream.fromQueue(stdin).pipe(Stream.map((line) => encoder.encode(`${line}\n`))),
      stdout: () => Sink.forEach((chunk: string | Uint8Array) => Queue.offer(stdout, typeof chunk === "string" ? chunk : decoder.decode(chunk))),
    });
    const send = (message: object) => Queue.offer(stdin, JSON.stringify(message));
    const next = Effect.map(Queue.take(stdout), (line) => decodeMessage(line.trim()));
    const served = yield* Mcp.serveStdio(events, { name: "feed", version: "0.0.0" }).pipe(Effect.provide(stdio), Effect.forkChild({ startImmediately: true }));
    yield* send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    const initialized = yield* next;
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    yield* send({ jsonrpc: "2.0", id: 2, method: "events/list" });
    const listed = yield* next;
    yield* Queue.end(stdin);
    yield* Fiber.join(served);
    return { initialized, listed };
  }).pipe(Effect.scoped, Effect.provide(feedLayer));
  const { initialized, listed } = await Effect.runPromise(program);
  const capabilities = Schema.decodeUnknownSync(Discovery)(initialized.result).capabilities;
  assert.equal(capabilities.extensions?.[EXTENSION], undefined);
  assert.equal(listed.error?.code, -32601);
});
