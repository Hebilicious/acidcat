import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePollCursor, encodePollCursor } from "@acid-cat/spec-ts";
import { Cause, Effect, Fiber, Layer, Option, Queue, Sink, Stdio, Stream } from "effect";
import { TestClock } from "effect/testing";

import { Mcp } from "../src/index.ts";
import { events, Feed, feedForPromises, feedLayer, following, publish } from "./events-fixture.ts";
import { decodeMessage, decodePollResult, json, mcpRequest, meta, ORIGIN } from "./mcp-client.ts";
import { until } from "../../../test-support/until.ts";
import type { Message } from "./mcp-client.ts";

const base = { name: "feed", version: "0.0.0", allowedOrigins: [ORIGIN] };

function pollHandler(feed: ReturnType<typeof feedForPromises>, poll: Mcp.PollOptions = {}) {
  return Mcp.toWebHandler(events, feed.layer, {
    ...base,
    poll,
    principal: (request) => Effect.succeed(Option.fromNullOr(request.headers.get("X-User"))),
  });
}

const pollMessage = async (handler: Mcp.WebHandler, params: Record<string, unknown>, user?: string, signal?: AbortSignal) =>
  json(await handler(mcpRequest("events/poll", params, { ...(user === undefined ? {} : { headers: { "X-User": user } }), signal })));

async function poll(handler: Mcp.WebHandler, params: Record<string, unknown>, user?: string, signal?: AbortSignal) {
  const answer = await pollMessage(handler, params, user, signal);
  if (answer.error !== undefined) assert.fail(answer.error.message);
  return decodePollResult(answer.result);
}

test("through HTTP, the same arguments in another key order poll the same lease, nextPollMs is 2000 or the option, and a complete subscription keeps its buffer until the lease ends", async (t) => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  const paced = pollHandler(feed, { nextPollMs: 500 });
  try {
    const started = await poll(handler, { name: "feed.counted", arguments: { a: 1, b: 2 } });
    assert.equal(started.nextPollMs, 2000);
    const again = await poll(handler, { arguments: { b: 2, a: 1 }, name: "feed.counted" });
    assert.equal(decodePollCursor(again.cursor)?.lease, decodePollCursor(started.cursor)?.lease);
    const params = { name: "feed.counted", arguments: { a: 1, b: 2 } };
    const read = await until(t, (signal) => poll(handler, { ...params, cursor: started.cursor }, undefined, signal), (result) => result.events.length === 2);
    assert.deepEqual(read.events.map((each) => each.eventId), ["a", "b"]);
    const kept = await poll(handler, { ...params, cursor: read.cursor });
    assert.deepEqual(kept.events, []);
    assert.equal(kept.cursor, read.cursor);
    assert.equal(kept.truncated, false);
    assert.equal((await poll(paced, params)).nextPollMs, 500);
  } finally {
    await handler.dispose();
    await paced.dispose();
  }
});

test("through HTTP, a lease that resumes after the cursor of the provider gives it the cursor and maxAgeMs", async (t) => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  try {
    const resumed = await poll(handler, { name: "feed.resumed", cursor: encodePollCursor({ lease: "gone", position: 4, provider: "7" }), maxAgeMs: 1000 });
    const read = await until(t, (signal) => poll(handler, { name: "feed.resumed", cursor: resumed.cursor }, undefined, signal), (result) => result.events.length === 1);
    assert.deepEqual(read.events[0]?.data, { cursor: "7", maxAgeMs: 1000 });
  } finally {
    await handler.dispose();
  }
});

test("through HTTP, each principal has its own leases", async (t) => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  try {
    const params = { name: "feed.ticked" };
    const alice = await poll(handler, params, "alice");
    const bob = await poll(handler, params, "bob");
    assert.notEqual(decodePollCursor(alice.cursor)?.lease, decodePollCursor(bob.cursor)?.lease);
    await feed.following(2);
    await feed.publish({ room: "a", count: 1 });
    await until(t, (signal) => poll(handler, { ...params, cursor: alice.cursor }, "alice", signal), (result) => result.events.length === 1);
    const stolen = await poll(handler, { ...params, cursor: alice.cursor }, "bob");
    assert.deepEqual(stolen.events, []);
    assert.equal(stolen.truncated, true);
    assert.equal(decodePollCursor(stolen.cursor)?.lease, decodePollCursor(bob.cursor)?.lease);
    await poll(handler, params);
    await feed.following(3);
  } finally {
    await handler.dispose();
  }
  await feed.following(0);
});

test("through HTTP, dispose ends the leases", async () => {
  const feed = feedForPromises();
  const handler = pollHandler(feed);
  await poll(handler, { name: "feed.ticked" });
  await feed.following(1);
  await handler.dispose();
  await feed.following(0);
});

test("through HTTP with per-request services, a lease keeps the services of its request until it ends", async () => {
  const feed = feedForPromises();
  let released = 0;
  const layer = Layer.effect(Feed, Effect.acquireRelease(Effect.service(Feed), () => Effect.sync(() => (released += 1)))).pipe(Layer.provide(feed.layer));
  const handler = Mcp.toWebHandler(events, layer, { ...base, services: "per-request" });
  try {
    await json(await handler(mcpRequest("events/list")));
    assert.equal(released, 1);
    await poll(handler, { name: "feed.ticked" });
    await feed.following(1);
    assert.equal(released, 1);
  } finally {
    await handler.dispose();
  }
  await feed.following(0);
  assert.equal(released, 2);
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

test("through stdio, events/poll reads a lease, and the lease ends after the lease time with no poll", async () => {
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
      yield* TestClock.adjust("59 seconds");
      const stillOne = yield* request("events/poll", { name: "feed.ticked", cursor: read.cursor });
      yield* TestClock.adjust("60001 millis");
      yield* following(0);
      const after = decodePollResult((yield* request("events/poll", { name: "feed.ticked", cursor: read.cursor })).result);
      return { read, stillOne, after, started };
    }),
  ).pipe(Effect.scoped, Effect.provide(feedLayer), Effect.provide(TestClock.layer()));
  const { read, stillOne, after, started } = await Effect.runPromise(program);
  assert.deepEqual(read.events.map((each) => each.data), [{ room: "a", count: 1 }]);
  assert.equal(decodePollResult(stillOne.result).cursor, read.cursor);
  assert.notEqual(decodePollCursor(after.cursor)?.lease, decodePollCursor(started.cursor)?.lease);
  assert.equal(after.truncated, false);
});
