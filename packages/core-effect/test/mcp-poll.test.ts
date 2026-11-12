import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePollCursor, encodePollCursor } from "@acid-cat/spec-ts";
import { Cause, Effect, Fiber, Layer, Option, Queue, Schema, Sink, Stdio, Stream } from "effect";
import { TestClock } from "effect/testing";

import { Mcp } from "../src/index.ts";
import { events, Feed, feedForPromises, feedLayer, following, publish } from "./events-fixture.ts";
import { decodeMessage, decodePollResult, eventually, json, mcpRequest, meta, ORIGIN } from "./mcp-client.ts";
import type { Message } from "./mcp-client.ts";

const base = { name: "feed", version: "0.0.0", allowedOrigins: [ORIGIN] };

/** A handler whose principal is the `X-User` header of each request. */
function pollHandler(feed: ReturnType<typeof feedForPromises>, poll: Mcp.PollOptions = {}) {
  return Mcp.toWebHandler(events, feed.layer, {
    ...base,
    poll,
    principal: (request) => Effect.succeed(Option.fromNullOr(request.headers.get("X-User"))),
  });
}

/** Poll, and give the JSON-RPC message of the answer. */
const pollMessage = async (handler: Mcp.WebHandler, params: Record<string, unknown>, user?: string) =>
  json(await handler(mcpRequest("events/poll", params, user === undefined ? {} : { headers: { "X-User": user } })));

/** Poll, and give the result. The answer must not be an error. */
async function poll(handler: Mcp.WebHandler, params: Record<string, unknown>, user?: string) {
  const answer = await pollMessage(handler, params, user);
  if (answer.error !== undefined) assert.fail(answer.error.message);
  return decodePollResult(answer.result);
}

const Deliveries = Schema.Struct({ events: Schema.NonEmptyArray(Schema.Struct({ delivery: Schema.Array(Schema.String) })) });

const positionOf = (cursor: string) => decodePollCursor(cursor)?.position;

test("through HTTP, events/list gives push and poll, and webhook delivery is off", async () => {
  const handler = Mcp.toWebHandler(events, feedLayer, base);
  try {
    const list = Schema.decodeUnknownSync(Deliveries)((await json(await handler(mcpRequest("events/list")))).result);
    assert.deepEqual(
      list.events.map((each) => each.delivery),
      list.events.map(() => ["push", "poll"]),
    );
    const subscribe = await json(await handler(mcpRequest("events/subscribe", { name: "feed.ticked" })));
    assert.equal(subscribe.error?.code, -32026);
    assert.deepEqual(subscribe.error?.data, { feature: "deliveryMode", value: "webhook" });
    const unsubscribe = await json(await handler(mcpRequest("events/unsubscribe", { name: "feed.ticked" })));
    assert.deepEqual(unsubscribe.error?.data, { feature: "deliveryMode", value: "webhook" });
  } finally {
    await handler.dispose();
  }
});

test("through HTTP, a poll with no cursor starts a lease, and the next polls read its occurrences in order", async () => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  try {
    const params = { name: "feed.ticked", arguments: { room: "a" } };
    const started = await poll(handler, params);
    assert.deepEqual({ ...started, cursor: positionOf(started.cursor) }, { resultType: "complete", events: [], cursor: 0, truncated: false, hasMore: false, nextPollMs: 2000 });
    await feed.following(1);
    // The same key reads the same lease: the arguments in another order are the same input.
    const again = await poll(handler, { arguments: { room: "a" }, name: "feed.ticked" });
    assert.equal(decodePollCursor(again.cursor)?.lease, decodePollCursor(started.cursor)?.lease);
    await feed.following(1);

    for (const count of [1, 2, 3]) await feed.publish({ room: "a", count });
    const read = await eventually(() => poll(handler, { ...params, cursor: started.cursor }), (result) => result.events.length === 3, "three occurrences");
    assert.deepEqual(read.events.map((each) => each.data), [1, 2, 3].map((count) => ({ room: "a", count })));
    assert.equal(read.events.every((each) => !("truncated" in each)), true);
    assert.deepEqual(decodePollCursor(read.cursor), { lease: decodePollCursor(started.cursor)?.lease, position: 3, provider: "3" });
    assert.equal(read.truncated, false);

    // A cursor at the newest position gives nothing, and the same cursor back.
    const nothing = await poll(handler, { ...params, cursor: read.cursor });
    assert.deepEqual(nothing.events, []);
    assert.equal(nothing.cursor, read.cursor);
    // No cursor, and a lease: the cursor of the newest position.
    const newest = await poll(handler, params);
    assert.deepEqual(newest.events, []);
    assert.equal(positionOf(newest.cursor), 3);

    // maxEvents limits the result, and hasMore tells that more occurrences are in the buffer.
    for (const count of [4, 5, 6]) await feed.publish({ room: "a", count });
    const first = await eventually(() => poll(handler, { ...params, cursor: read.cursor, maxEvents: 2 }), (result) => result.hasMore, "more occurrences");
    assert.deepEqual(first.events.map((each) => each.data), [4, 5].map((count) => ({ room: "a", count })));
    const second = await poll(handler, { ...params, cursor: first.cursor, maxEvents: 2 });
    assert.deepEqual(second.events.map((each) => each.data), [{ room: "a", count: 6 }]);
    assert.equal(second.hasMore, false);

    const invalid = await pollMessage(handler, { ...params, maxEvents: 0 });
    assert.equal(invalid.error?.code, -32602);
  } finally {
    await handler.dispose();
  }
  await feed.following(0);
});

test("through HTTP, a cursor older than the buffer gives the buffer and truncated", async () => {
  const feed = feedForPromises();
  const handler = pollHandler(feed, { bufferLimit: 3, maxEvents: 10, nextPollMs: 500 });
  try {
    const params = { name: "feed.ticked" };
    const started = await poll(handler, params);
    assert.equal(started.nextPollMs, 500);
    await feed.following(1);
    for (const count of [1, 2, 3, 4, 5]) await feed.publish({ room: "a", count });
    const newest = await eventually(() => poll(handler, params), (result) => positionOf(result.cursor) === 5, "five occurrences");
    assert.equal(newest.truncated, false);
    const read = await poll(handler, { ...params, cursor: started.cursor });
    assert.deepEqual(read.events.map((each) => each.cursor), ["3", "4", "5"]);
    assert.equal(read.truncated, true);
  } finally {
    await handler.dispose();
  }
});

test("through HTTP, a cursor of a lease that ended starts a new lease, which resumes after the cursor of the provider", async () => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  try {
    const resumed = await poll(handler, { name: "feed.resumed", cursor: encodePollCursor({ lease: "gone", position: 4, provider: "7" }), maxAgeMs: 1000 });
    assert.deepEqual(resumed.events, []);
    assert.equal(resumed.truncated, false);
    assert.deepEqual({ ...decodePollCursor(resumed.cursor), lease: "" }, { lease: "", position: 0, provider: "7" });
    const read = await eventually(() => poll(handler, { name: "feed.resumed", cursor: resumed.cursor }), (result) => result.events.length === 1, "the occurrence");
    assert.deepEqual(read.events[0]?.data, { cursor: "7", maxAgeMs: 1000 });
    // A complete subscription keeps its buffer until the lease ends.
    const later = await poll(handler, { name: "feed.resumed", cursor: resumed.cursor });
    assert.equal(later.events.length, 1);

    // With no cursor of the provider, the new lease starts now, and the result is truncated.
    for (const cursor of [encodePollCursor({ lease: "gone", position: 4 }), "not a poll cursor"]) {
      const fresh = await poll(handler, { name: "feed.ticked", arguments: { room: cursor }, cursor });
      assert.deepEqual(fresh.events, []);
      assert.equal(fresh.truncated, true);
      assert.equal(positionOf(fresh.cursor), 0);
    }
    await feed.following(2);
  } finally {
    await handler.dispose();
  }
  await feed.following(0);
});

test("through HTTP, each principal has its own leases", async () => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  try {
    const params = { name: "feed.ticked" };
    const alice = await poll(handler, params, "alice");
    const bob = await poll(handler, params, "bob");
    assert.notEqual(decodePollCursor(alice.cursor)?.lease, decodePollCursor(bob.cursor)?.lease);
    await feed.following(2);
    await feed.publish({ room: "a", count: 1 });
    await eventually(() => poll(handler, { ...params, cursor: alice.cursor }, "alice"), (result) => result.events.length === 1, "the occurrence of alice");
    // The cursor of alice is not a cursor of the lease of bob: bob reads nothing of the lease of alice.
    const stolen = await poll(handler, { ...params, cursor: alice.cursor }, "bob");
    assert.deepEqual(stolen.events, []);
    assert.equal(stolen.truncated, true);
    assert.equal(decodePollCursor(stolen.cursor)?.lease, decodePollCursor(bob.cursor)?.lease);
    // With no principal, the key has no identity: a third lease.
    await poll(handler, params);
    await feed.following(3);
  } finally {
    await handler.dispose();
  }
  await feed.following(0);
});

test("through HTTP, internal ends the lease: the next poll gets -32603, and the poll after it starts a new lease", async () => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  try {
    const started = await poll(handler, { name: "feed.crashing" });
    const failed = await eventually(() => pollMessage(handler, { name: "feed.crashing", cursor: started.cursor }), (answer) => answer.error !== undefined, "the failure");
    assert.deepEqual(failed.error, { code: -32603, message: "The event failed." });
    const next = await poll(handler, { name: "feed.crashing", cursor: started.cursor });
    assert.notEqual(decodePollCursor(next.cursor)?.lease, decodePollCursor(started.cursor)?.lease);
    assert.equal(next.truncated, true);
  } finally {
    await handler.dispose();
  }
});

test("through HTTP, a poll that cannot start its subscription starts no lease", async () => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  try {
    const hidden = await pollMessage(handler, { name: "feed.hidden" });
    assert.equal(hidden.error?.code, -32023);
    assert.deepEqual(hidden.error?.data, { kind: "event" });
    const invalid = await pollMessage(handler, { name: "feed.ticked", arguments: { room: 1 } });
    assert.equal(invalid.error?.code, -32602);
    assert.equal((await pollMessage(handler, { name: "feed.ticked", arguments: { room: 1 } })).error?.code, -32602);
  } finally {
    await handler.dispose();
  }
});

test("through HTTP, events/poll checks the name before maxAgeMs", async () => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  try {
    for (const maxAgeMs of [-1, 1.5, "60"]) {
      const unknown = await pollMessage(handler, { name: "no.such", maxAgeMs });
      assert.equal(unknown.error?.code, -32023, `maxAgeMs ${maxAgeMs}`);
      assert.deepEqual(unknown.error?.data, { kind: "event" });
      const invalid = await pollMessage(handler, { name: "feed.resumed", maxAgeMs });
      assert.equal(invalid.error?.code, -32602, `maxAgeMs ${maxAgeMs}`);
    }
    assert.deepEqual((await poll(handler, { name: "feed.resumed", maxAgeMs: null })).events, []);
  } finally {
    await handler.dispose();
  }
});

test("through HTTP, a lease with no poll for the lease time ends, and dispose ends the leases", async () => {
  const feed = feedForPromises();
  const handler = pollHandler(feed, { leaseMs: 150 });
  try {
    const started = await poll(handler, { name: "feed.ticked" });
    await feed.following(1);
    await feed.following(0);
    const after = await poll(handler, { name: "feed.ticked", cursor: started.cursor });
    assert.notEqual(decodePollCursor(after.cursor)?.lease, decodePollCursor(started.cursor)?.lease);
    await feed.following(1);
  } finally {
    await handler.dispose();
  }
  await feed.following(0);
});

test("through HTTP with per-request services, a lease keeps the services of its request until it ends", async () => {
  const feed = feedForPromises();
  let released = 0;
  const layer = Layer.effect(Feed, Effect.acquireRelease(Effect.service(Feed), () => Effect.sync(() => (released += 1)))).pipe(Layer.provide(feed.layer));
  const handler = Mcp.toWebHandler(events, layer, { ...base, services: "per-request", poll: { leaseMs: 200 } });
  try {
    await json(await handler(mcpRequest("events/list")));
    assert.equal(released, 1);
    await poll(handler, { name: "feed.ticked" });
    await feed.following(1);
    assert.equal(released, 1);
    await feed.following(0);
    await eventually(async () => released, (count) => count === 2, "the release of the services of the lease");
  } finally {
    await handler.dispose();
  }
});

test("Mcp.makeHandle keeps the leases in its scope, and they end when the scope closes", async () => {
  const program = Effect.gen(function* () {
    const ended = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Mcp.makeHandle(events, base);
        const answer = (request: Request) => Effect.flatMap(handle(request), (response) => Effect.promise(() => json(response)));
        const started = decodePollResult((yield* answer(mcpRequest("events/poll", { name: "feed.ticked" }))).result);
        yield* following(1);
        yield* publish({ room: "a", count: 1 });
        let read = decodePollResult((yield* answer(mcpRequest("events/poll", { name: "feed.ticked", cursor: started.cursor }))).result);
        while (read.events.length === 0) {
          yield* Effect.sleep(5);
          read = decodePollResult((yield* answer(mcpRequest("events/poll", { name: "feed.ticked", cursor: started.cursor }))).result);
        }
        return read;
      }),
    );
    yield* following(0);
    return ended;
  }).pipe(Effect.provide(feedLayer));
  const read = await Effect.runPromise(program);
  assert.deepEqual(read.events.map((each) => each.data), [{ room: "a", count: 1 }]);
});

/** Run the MCP server through stdio in a test, with a function that sends a message and one that takes the next message. */
const withStdio = <A, E, R>(options: Mcp.StdioOptions, body: (client: { readonly send: (message: object) => Effect.Effect<void>; readonly next: Effect.Effect<Message> }) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const stdin = yield* Queue.unbounded<string, Cause.Done>();
    const stdout = yield* Queue.unbounded<string>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stdio = Stdio.layerTest({
      stdin: Stream.fromQueue(stdin).pipe(Stream.map((line) => encoder.encode(`${line}\n`))),
      stdout: () => Sink.forEach((chunk: string | Uint8Array) => Queue.offer(stdout, typeof chunk === "string" ? chunk : decoder.decode(chunk))),
    });
    const served = yield* Mcp.serveStdio(events, options).pipe(Effect.provide(stdio), Effect.forkChild({ startImmediately: true }));
    const result = yield* body({
      send: (message) => Queue.offer(stdin, JSON.stringify(message)).pipe(Effect.asVoid),
      next: Effect.map(Queue.take(stdout), (line) => decodeMessage(line.trim())),
    });
    yield* Queue.end(stdin);
    yield* Fiber.join(served);
    return result;
  });

test("through stdio, events/poll reads a lease, webhooks are unsupported, and the lease ends after the lease time", async () => {
  const program = withStdio({ name: "feed", version: "0.0.0", poll: { leaseMs: 60_000 } }, ({ send, next }) =>
    Effect.gen(function* () {
      let id = 0;
      const request = (method: string, params: object) =>
        Effect.andThen(send({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: meta } }), next);
      const started = decodePollResult((yield* request("events/poll", { name: "feed.ticked" })).result);
      yield* following(1);
      yield* publish({ room: "a", count: 1 });
      let read = decodePollResult((yield* request("events/poll", { name: "feed.ticked", cursor: started.cursor })).result);
      while (read.events.length === 0) {
        yield* Effect.yieldNow;
        read = decodePollResult((yield* request("events/poll", { name: "feed.ticked", cursor: started.cursor })).result);
      }
      const webhook = yield* request("events/subscribe", { name: "feed.ticked" });
      const list = yield* request("events/list", {});
      // The lease gets no poll for the lease time: it ends, and its subscription is cancelled.
      yield* TestClock.adjust("59 seconds");
      const stillOne = yield* request("events/poll", { name: "feed.ticked", cursor: read.cursor });
      yield* TestClock.adjust("60001 millis");
      yield* following(0);
      const after = decodePollResult((yield* request("events/poll", { name: "feed.ticked", cursor: read.cursor })).result);
      return { read, webhook, list, stillOne, after, started };
    }),
  ).pipe(Effect.scoped, Effect.provide(feedLayer), Effect.provide(TestClock.layer()));
  const { read, webhook, list, stillOne, after, started } = await Effect.runPromise(program);
  assert.deepEqual(read.events.map((each) => each.data), [{ room: "a", count: 1 }]);
  assert.deepEqual(webhook.error?.data, { feature: "deliveryMode", value: "webhook" });
  assert.equal(Array.isArray(list.result?.events), true);
  assert.equal(decodePollResult(stillOne.result).cursor, read.cursor);
  assert.notEqual(decodePollCursor(after.cursor)?.lease, decodePollCursor(started.cursor)?.lease);
  assert.equal(after.truncated, false);
});
