import assert from "node:assert/strict";
import { test } from "node:test";

import { CallFailureError, isOccurrence } from "@acid-cat/spec-ts";
import type { Occurrence } from "@acid-cat/spec-ts";
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { GraphQLInt, GraphQLObjectType, GraphQLSchema, GraphQLString, parse, subscribe } from "graphql";

import { App, Event, Handles, Session } from "../src/index.ts";
import { counted, events, Feed, feedForPromises, feedLayer, following, publish, ticked } from "./events-fixture.ts";

/** Run a program with the services of the fixture. */
const run = <A, E>(program: Effect.Effect<A, E, Feed | Scope.Scope>) => Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(feedLayer)));

/** The call failure that a subscription fails with before it starts. */
const startFailure = <A>(start: Effect.Effect<A, Session.CallFailed, Scope.Scope>) =>
  Effect.flip(start).pipe(Effect.map(({ kind, message }) => ({ kind, message })));

test("the catalog has the events, in canonical form, and the view of a target has only its events", () => {
  const document = App.document(events);
  assert.deepEqual(Object.keys(document.events ?? {}).sort(), ["feed.counted", "feed.crashing", "feed.disagreeing", "feed.hidden", "feed.resumed", "feed.ticked", "feed.timed"]);
  const tickedEntry = document.events?.["feed.ticked"];
  assert.equal(tickedEntry?.description, "A test published a tick. With a room, only the ticks of that room.");
  assert.deepEqual(tickedEntry?.audience, ["app", "mcp", "cli", "api"]);
  assert.deepEqual(Object.keys(tickedEntry?.input?.properties ?? {}), ["room"]);
  assert.equal(tickedEntry?.payload?.type, "object");
  assert.deepEqual(tickedEntry?.payload?.required, ["room", "count"]);
  assert.equal(document.events?.["feed.crashing"]?.payload, undefined);
  const text = App.render(events);
  assert.ok(text.indexOf('"capabilities"') < text.indexOf('"events"'));
  const view = Effect.runSync(Session.make(events, { target: "mcp" }).pipe(Effect.scoped, Effect.provide(feedLayer))).view;
  assert.equal(view.events?.["feed.hidden"], undefined);
  assert.deepEqual(view.events?.["feed.ticked"]?.audience, ["mcp"]);
});

test("an id that is both a capability and an event, and a payload that is not an object, stop the catalog", () => {
  const twice = App.make({
    targets: {},
    capabilities: [],
    events: [ticked, Event.make({ id: "feed.ticked", description: "Again.", audience: [], subscribe: () => Stream.empty })],
  });
  assert.throws(() => App.document(twice), /declared two times/);
  const scalar = App.make({
    targets: {},
    capabilities: [],
    events: [Event.make({ id: "feed.scalar", description: "A number.", audience: [], payload: Schema.Number, subscribe: () => Stream.empty })],
  });
  assert.throws(() => App.document(scalar), /must be an object/);
});

test("a subscription gives the occurrences of its input, with the members of an occurrence", async () => {
  const received = await run(
    Effect.gen(function* () {
      const session = yield* Session.make(events, { target: "app" });
      const kitchen = yield* session.subscribe("feed.ticked", { room: "kitchen" });
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(kitchen, 2)));
      yield* following(1);
      yield* publish({ room: "hall", count: 1 });
      yield* publish({ room: "kitchen", count: 2 });
      yield* publish({ room: "kitchen", count: 3 });
      return yield* Fiber.join(fiber);
    }),
  );
  assert.equal(received.length, 2);
  for (const occurrence of received) assert.ok(isOccurrence(occurrence), JSON.stringify(occurrence));
  assert.deepEqual(
    received.map(({ name, data, cursor }) => ({ name, data, cursor })),
    [
      { name: "feed.ticked", data: { room: "kitchen", count: 2 }, cursor: "2" },
      { name: "feed.ticked", data: { room: "kitchen", count: 3 }, cursor: "3" },
    ],
  );
  assert.notEqual(received[0]?.eventId, received[1]?.eventId);
  assert.equal(received.some((occurrence) => occurrence.truncated === true), false);
});

test("a subscription that cannot start fails with a call failure", async () => {
  const failures = await run(
    Effect.gen(function* () {
      const session = yield* Session.make(events, { target: "mcp" });
      return {
        unknown: yield* startFailure(session.subscribe("feed.nope", {})),
        hidden: yield* startFailure(session.subscribe("feed.hidden", {})),
        capability: yield* startFailure(session.subscribe("feed.publish", {})),
        invalid: yield* startFailure(session.subscribe("feed.ticked", { room: 1 })),
        other: yield* startFailure(session.follow(Event.make({ id: "feed.ticked", description: "", audience: ["mcp"], subscribe: () => Stream.never }), {})),
      };
    }),
  );
  assert.deepEqual(failures.unknown, { kind: "unknown-capability", message: "There is no event feed.nope." });
  assert.deepEqual(failures.hidden, { kind: "unknown-capability", message: "There is no event feed.hidden." });
  assert.equal(failures.capability.kind, "unknown-capability");
  assert.equal(failures.invalid.kind, "invalid-input");
  assert.equal(failures.other.kind, "unknown-capability");

  const closed = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const session = yield* Session.make(events, { target: "app" }).pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);
      return yield* startFailure(session.subscribe("feed.ticked", {}));
    }).pipe(Effect.scoped, Effect.provide(feedLayer)),
  );
  assert.equal(closed.kind, "cancelled");
});

test("concurrent subscriptions each get their own occurrences, and cancelling one leaves the other", async () => {
  const result = await run(
    Effect.gen(function* () {
      const session = yield* Session.make(events, { target: "app" });
      const a = yield* Effect.forkChild(
        Effect.scoped(Effect.flatMap(session.subscribe("feed.ticked", { room: "a" }), (stream) => Stream.runCollect(Stream.take(stream, 2)))),
      );
      const bScope = yield* Scope.make();
      const b = yield* session.subscribe("feed.ticked", { room: "b" }).pipe(Scope.provide(bScope));
      const bFiber = yield* Effect.forkChild(Stream.runCollect(b));
      const counted = yield* Effect.scoped(Effect.flatMap(session.subscribe("feed.counted", { x: 1 }), Stream.runCollect));
      yield* following(2);
      yield* publish({ room: "b", count: 1 });
      yield* publish({ room: "a", count: 2 });
      yield* Scope.close(bScope, Exit.void);
      yield* following(1);
      yield* publish({ room: "a", count: 3 });
      return {
        a: (yield* Fiber.join(a)).map((each) => each.data),
        b: yield* Fiber.await(bFiber),
        counted: counted.map(({ eventId, data }) => ({ eventId, data })),
      };
    }),
  );
  assert.deepEqual(result.a, [
    { room: "a", count: 2 },
    { room: "a", count: 3 },
  ]);
  assert.ok(Exit.isSuccess(result.b));
  assert.deepEqual(result.counted, [{ eventId: "x", data: { key: "x", value: 1 } }]);
});

test("when the session closes, each subscription ends as complete", async () => {
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const session = yield* Session.make(events, { target: "app" }).pipe(Scope.provide(scope));
      const stream = yield* session.subscribe("feed.ticked", {});
      const fiber = yield* Effect.forkChild(Stream.runCollect(stream));
      yield* following(1);
      yield* publish({ room: "a", count: 1 });
      yield* Scope.close(scope, Exit.void);
      return yield* Fiber.await(fiber);
    }).pipe(Effect.scoped, Effect.provide(feedLayer)),
  );
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(
    exit.value.map((each) => each.data),
    [{ room: "a", count: 1 }],
  );
});

test("a slow client loses the oldest occurrences, and the next one it reads has truncated: true", async () => {
  const received = await run(
    Effect.gen(function* () {
      const session = yield* Session.make(events, { target: "app", eventBuffer: 2 });
      const stream = yield* session.follow(ticked, {});
      yield* following(1);
      for (const count of [1, 2, 3, 4, 5]) yield* publish({ room: "a", count });
      // Let the provider give all the ticks before the client reads.
      yield* Effect.sleep(50);
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 3)));
      yield* Effect.sleep(10);
      yield* publish({ room: "a", count: 6 });
      return yield* Fiber.join(fiber);
    }),
  );
  assert.deepEqual(
    received.map(({ data, truncated }) => ({ count: data.count, truncated })),
    [
      { count: 4, truncated: true },
      { count: 5, truncated: undefined },
      { count: 6, truncated: undefined },
    ],
  );
});

test("a defect of the provider, or a payload that does not agree, ends the subscription with internal", async () => {
  const outcome = (id: string) =>
    run(
      Effect.gen(function* () {
        const session = yield* Session.make(events, { target: "app" });
        const stream = yield* session.subscribe(id, {});
        const received: Occurrence[] = [];
        const exit = yield* Effect.exit(Stream.runForEach(stream, (occurrence) => Effect.sync(() => received.push(occurrence))));
        return { received: received.length, failure: Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined };
      }),
    );
  const crash = await outcome("feed.crashing");
  assert.equal(crash.received, 1);
  assert.ok(crash.failure?._tag === "Some");
  assert.deepEqual({ kind: crash.failure.value.kind, message: crash.failure.value.message }, { kind: "internal", message: "The event failed." });
  const bad = await outcome("feed.disagreeing");
  assert.equal(bad.received, 1);
  assert.ok(bad.failure?._tag === "Some");
  assert.equal(bad.failure.value.kind, "internal");
  assert.doesNotMatch(bad.failure.value.message, /secret/);
});

/** The handle of an id. The handle must exist. */
const eventHandle = (handles: ReadonlyMap<string, Handles.EventHandle>, id: string) => {
  const handle = handles.get(id);
  assert.ok(handle, `there is a handle for ${id}`);
  return handle;
};

/** The call failure that a promise rejects with. */
const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail("the promise must reject"),
    (error: unknown) => {
      assert.ok(error instanceof CallFailureError);
      return error;
    },
  );


test("event handles give occurrences as an async iterable, and reject start failures before the first occurrence", async () => {
  const feed = feedForPromises();
  const session = await Handles.open(events, feed.layer, { target: "app" });
  try {
    assert.deepEqual([...session.events.keys()].sort(), Object.keys(session.view.events ?? {}).sort());
    const typed = session.event(ticked);
    const iterable = await typed.subscribe({ room: "a" });
    const iterator = iterable[Symbol.asyncIterator]();
    const first = iterator.next();
    await feed.following(1);
    await feed.publish({ room: "a", count: 1 });
    const value = await first;
    assert.equal(value.done, false);
    assert.deepEqual(value.value?.data, { room: "a", count: 1 });
    assert.deepEqual(await iterator.return?.(), { done: true, value: undefined });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });

    const unknown = await rejected(eventHandle(session.events, "feed.ticked").subscribeExternal({ room: 1 }));
    assert.equal(unknown.kind, "invalid-input");
    assert.equal(unknown.name, "TypeError");
    const outside = await rejected(session.event(Event.make({ id: "feed.other", description: "", audience: ["app"], subscribe: () => Stream.never })).subscribe({}));
    assert.equal(outside.kind, "unknown-capability");

    const crashing = await eventHandle(session.events, "feed.crashing").subscribeExternal({});
    const crashIterator = crashing[Symbol.asyncIterator]();
    assert.equal((await crashIterator.next()).done, false);
    const internal = await rejected(crashIterator.next());
    assert.equal(internal.kind, "internal");
    assert.deepEqual(await crashIterator.next(), { done: true, value: undefined });

    const values: unknown[] = [];
    for await (const occurrence of await session.event(counted).subscribe({ a: 1, b: 2 })) values.push(occurrence.data);
    assert.deepEqual(values, [
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);
  } finally {
    await session.dispose();
  }
});

test("return() cancels a subscription while next() waits, and that next() resolves done", async () => {
  const feed = feedForPromises();
  const session = await Handles.open(events, feed.layer, { target: "app" });
  try {
    const iterator = (await session.event(ticked).subscribe({}))[Symbol.asyncIterator]();
    await feed.following(1);
    const pending = iterator.next();
    const returned = iterator.return?.();
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.deepEqual(await returned, { done: true, value: undefined });
    await feed.following(0);

    const controller = new AbortController();
    const signalled = (await session.event(ticked).subscribe({}, { signal: controller.signal }))[Symbol.asyncIterator]();
    const waiting = signalled.next();
    controller.abort();
    assert.deepEqual(await waiting, { done: true, value: undefined });

    const open = (await session.event(ticked).subscribe({}))[Symbol.asyncIterator]();
    const left = open.next();
    await session.dispose();
    assert.deepEqual(await left, { done: true, value: undefined });
  } finally {
    await session.dispose();
  }
});

test("a GraphQL subscription uses an event handle, and ends the subscription when the client ends it", async () => {
  const feed = feedForPromises();
  const session = await Handles.open(events, feed.layer, { target: "app" });
  try {
    const handle = session.event(ticked);
    const Arguments = Schema.Struct({ room: Schema.optionalKey(Schema.String) });
    const Tick = new GraphQLObjectType({ name: "Tick", fields: { room: { type: GraphQLString }, count: { type: GraphQLInt } } });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { ok: { type: GraphQLString } } }),
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          ticked: {
            type: Tick,
            args: { room: { type: GraphQLString } },
            subscribe: (_source: unknown, args: unknown) => handle.subscribe(Schema.decodeUnknownSync(Arguments)(args)),
            resolve: (occurrence: unknown) => (isOccurrence(occurrence) ? occurrence.data : null),
          },
        },
      }),
    });
    const result = await subscribe({ schema, document: parse('subscription { ticked(room: "a") { room count } }') });
    assert.ok(Symbol.asyncIterator in result, "the subscription started");
    const iterator = result[Symbol.asyncIterator]();
    await feed.following(1);
    await feed.publish({ room: "a", count: 7 });
    assert.equal(JSON.stringify((await iterator.next()).value), JSON.stringify({ data: { ticked: { room: "a", count: 7 } } }));
    // graphql-js calls return() while next() waits, when the client ends the subscription.
    const pending = iterator.next();
    await iterator.return();
    assert.deepEqual(await pending, { done: true, value: undefined });
    await feed.following(0);
  } finally {
    await session.dispose();
  }
});

test("the WebMCP binding registers the capabilities of a view with events, and no tool for an event", async () => {
  const names = new Set<string>();
  const host = {
    registerTool(tool: { readonly name: string }, options: { signal: AbortSignal }) {
      names.add(tool.name);
      options.signal.addEventListener("abort", () => names.delete(tool.name));
      return { unregister() {} };
    },
  };
  const session = await Handles.open(events, feedLayer, { target: "app", webmcp: host });
  try {
    for (let attempt = 0; attempt < 100 && session.webmcp?.status.getSnapshot().phase !== "ready"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual([...names], ["feed.publish"]);
    assert.ok(session.events.has("feed.ticked"));
  } finally {
    await session.dispose();
  }
});
