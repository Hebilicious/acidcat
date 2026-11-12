import assert from "node:assert/strict";
import { test } from "node:test";

import { isOccurrence } from "@acid-cat/spec-ts";

import { CallFailureError, catalogOf, createSession, defineApp, defineCapability, defineEvent, installWebMcp, ok, renderCatalog } from "../src/index.ts";
import type { ModelContextTool, Occurrences } from "../src/index.ts";
import { broken, clock, failing, hidden, read, readingChanged, sensorOptions, Sensors, sensorsApp, ticks, toJsonSchema } from "./sensors.ts";

/** Wait until a condition is true, or fail after one second. */
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("The condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The next value of a subscription. It fails if the subscription ends. */
async function nextOf<Payload>(occurrences: Occurrences<Payload>) {
  const step = await occurrences.next();
  if (step.done === true) throw new Error("The subscription ended.");
  return step.value;
}

/** The kind of a call failure, or `undefined` for the occurrences of a subscription that started. */
const kindOf = (started: Occurrences<unknown> | { readonly kind: string }) => ("kind" in started ? started.kind : undefined);

/** The kind of the call failure of a promise that rejects. */
async function failureKind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CallFailureError) return error.kind;
    throw error;
  }
  throw new Error("The promise did not reject.");
}

test("the catalog has the events, after the capabilities, and each event has its schemas", () => {
  const catalog = catalogOf(sensorsApp, { toJsonSchema });
  assert.deepEqual(Object.keys(catalog), ["acidcat", "title", "description", "targets", "$defs", "capabilities", "events"]);
  assert.deepEqual(catalog.events?.["sensor.reading.changed"], {
    description: readingChanged.description,
    audience: ["app", "api", "cli", "mcp"],
    input: { type: "object", properties: { room: { type: "string" } }, additionalProperties: false },
    payload: { $ref: "#/$defs/Reading" },
  });
  assert.deepEqual(catalog.events?.["sensor.ticks"], { description: ticks.description, audience: ["app", "api", "cli", "mcp"] });
  assert.equal(catalog.events?.["sensor.threshold"]?.input?.type, "object");
  assert.ok(renderCatalog(sensorsApp, { toJsonSchema }).includes('"events": {'));
});

test("an application with no events writes no events member", () => {
  const app = defineApp({ targets: { app: { bindings: ["typescript"] } }, capabilities: [] });
  assert.equal("events" in catalogOf(app, { toJsonSchema }), false);
});

test("an id that is both a capability and an event stops the catalog and the session", () => {
  const app = defineApp({
    targets: { app: { bindings: ["typescript"] } },
    capabilities: [defineCapability({ id: "probe.same", description: "A capability.", audience: ["app"], run: () => ok(null) })],
    events: [defineEvent({ id: "probe.same", description: "An event.", audience: ["app"], async *subscribe() {} })],
  });
  assert.throws(() => catalogOf(app, { toJsonSchema }), /probe\.same/);
  assert.throws(() => createSession(app, { target: "app", ...sensorOptions() }), /probe\.same/);
});

test("the view of a target has only its events, and the session gives their handles", () => {
  const session = createSession(sensorsApp, { target: "app", ...sensorOptions() });
  assert.equal(session.view.events?.["sensor.hidden"], undefined);
  assert.deepEqual(session.view.events?.["sensor.ticks"]?.audience, ["app"]);
  assert.deepEqual([...session.eventHandles.keys()].sort(), ["sensor.broken", "sensor.clock", "sensor.failing", "sensor.reading.changed", "sensor.threshold", "sensor.ticks"]);
  const other = createSession(sensorsApp, { target: "other", ...sensorOptions() });
  assert.deepEqual([...other.eventHandles.keys()], ["sensor.hidden"]);
  assert.equal(other.view.events?.["sensor.ticks"], undefined);
});

test("a subscription gives each occurrence, with the members of the provider or the ones that the binding makes", async () => {
  const sensors = new Sensors();
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions(sensors) });
  const handle = session.eventHandle(readingChanged);
  const occurrences = await handle.subscribe({ room: "kitchen" });
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 18, "2026-11-10T09:00:00.000Z");
  sensors.emit("kitchen", 21, "2026-11-10T09:00:01.000Z");
  const first = await nextOf(occurrences);
  assert.deepEqual(first, { eventId: "reading-1", name: "sensor.reading.changed", timestamp: "2026-11-10T09:00:01.000Z", data: { room: "kitchen", celsius: 21 }, cursor: "1" });
  // Each occurrence is a copy: a change by the client does not change the history of the provider.
  first.data.celsius = 99;
  assert.equal(sensors.history[1]?.data.celsius, 21);

  const tick = await nextOf(await session.eventHandle(ticks).subscribe({}));
  assert.ok(isOccurrence(tick));
  assert.equal(tick.name, "sensor.ticks");
  assert.deepEqual(tick.data, {});
  assert.ok(tick.eventId.length > 0);
  assert.ok(!Number.isNaN(Date.parse(tick.timestamp)));
});

test("complete: the provider has no more occurrences, so next() resolves with done", async () => {
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions() });
  const seen = [];
  for await (const occurrence of await session.eventHandle(ticks).subscribe({})) seen.push(occurrence);
  assert.equal(seen.length, 3);
});

test("start failures reject before the first occurrence: unknown-capability, invalid-input and cancelled", async () => {
  const session = createSession(sensorsApp, { target: "app", ...sensorOptions() });
  const handle = session.eventHandles.get("sensor.reading.changed");
  assert.ok(handle !== undefined);
  assert.equal(await failureKind(handle.subscribeExternal({ room: 7 })), "invalid-input");
  assert.equal(await failureKind(session.eventHandle(hidden).subscribe({})), "unknown-capability");
  const other = defineEvent({ id: "sensor.ticks", description: "Another object with the same id.", audience: ["app"], async *subscribe() {} });
  assert.equal(await failureKind(session.eventHandle(other).subscribe({})), "unknown-capability");
  assert.deepEqual(await session.subscribe("sensor.hidden", {}), { kind: "unknown-capability", message: "There is no event sensor.hidden." });
  assert.equal(await failureKind(handle.subscribeExternal({}, { signal: AbortSignal.abort() })), "cancelled");
  // An invalid input to a session that closes is cancelled: cancelled comes first.
  await session.dispose();
  assert.equal(await failureKind(handle.subscribeExternal({ room: 7 })), "cancelled");
  assert.equal(await failureKind(session.eventHandle(ticks).subscribe({})), "cancelled");
});

test("maxAgeMs that is not an integer of 0 or more fails as invalid-input, after unknown-capability, in each way to subscribe", async () => {
  const sensors = new Sensors();
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions(sensors) });
  for (const maxAgeMs of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(kindOf(await session.subscribe("sensor.reading.changed", {}, { maxAgeMs })), "invalid-input", String(maxAgeMs));
    assert.equal(kindOf(await session.subscribe("sensor.hidden", {}, { maxAgeMs })), "unknown-capability", String(maxAgeMs));
    assert.equal(await failureKind(session.eventHandle(readingChanged).subscribe({}, { maxAgeMs })), "invalid-input", String(maxAgeMs));
  }
  assert.equal(kindOf(await session.subscribe("sensor.reading.changed", {}, { maxAgeMs: -5, signal: AbortSignal.abort() })), "cancelled");
  assert.equal(sensors.listeners, 0);
  const started = await session.subscribe("sensor.reading.changed", {}, { maxAgeMs: 0 });
  assert.ok(!("kind" in started));
  await started.return();
});

test("a provider that throws when it starts fails as internal before the first occurrence", async () => {
  const defects: string[] = [];
  const app = defineApp({
    targets: { app: { bindings: ["typescript"] } },
    capabilities: [],
    events: [
      defineEvent({
        id: "probe.throws",
        description: "subscribe throws.",
        audience: ["app"],
        subscribe: () => {
          throw new Error("secret");
        },
      }),
    ],
  });
  await using session = createSession(app, { target: "app", ...sensorOptions(), onDefect: (id) => defects.push(id) });
  const failure = await session.subscribe("probe.throws", {});
  assert.deepEqual(failure, { kind: "internal", message: "The event failed." });
  assert.deepEqual(defects, ["probe.throws"]);
});

test("an occurrence that the provider marks truncated keeps the mark, also when earlier occurrences wait in the buffer", async () => {
  const app = defineApp({
    targets: { app: { bindings: ["typescript"] } },
    capabilities: [],
    events: [
      defineEvent({
        id: "probe.gap",
        description: "Give n = 1, then n = 2 after a gap, then n = 3.",
        audience: ["app"],
        async *subscribe() {
          yield { data: {}, eventId: "1" };
          yield { data: {}, eventId: "2", truncated: true as const };
          yield { data: {}, eventId: "3" };
        },
      }),
    ],
  });
  await using session = createSession(app, { target: "app", ...sensorOptions() });
  const occurrences = await session.subscribe("probe.gap", {});
  assert.ok(!("kind" in occurrences));
  // The provider gives all three before the client reads the first.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const read = [await nextOf(occurrences), await nextOf(occurrences), await nextOf(occurrences)];
  assert.deepEqual(read.map((each) => [each.eventId, each.truncated]), [["1", undefined], ["2", true], ["3", undefined]]);
});

test("a payload that does not agree with its schema, or a provider that throws, ends the iterator with internal, then done", async () => {
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions() });
  for (const event of [broken, failing]) {
    const occurrences = await session.eventHandle(event).subscribe({});
    assert.deepEqual((await nextOf(occurrences)).data, { room: "hall", celsius: 20 });
    await assert.rejects(occurrences.next(), (error) => error instanceof CallFailureError && error.kind === "internal" && error.message === "The event failed.");
    assert.deepEqual(await occurrences.next(), { done: true, value: undefined });
  }
});

test("return() cancels while a next() waits: that next() resolves with done, and the provider stops", async () => {
  const sensors = new Sensors();
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions(sensors) });
  const occurrences = await session.eventHandle(readingChanged).subscribe({});
  await until(() => sensors.listeners === 1);
  const pending = occurrences.next();
  const returned = occurrences.return();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.deepEqual(await returned, { done: true, value: undefined });
  assert.deepEqual(await occurrences.next(), { done: true, value: undefined });
  await until(() => sensors.listeners === 0);
});

test("options.signal cancels one subscription, and the others continue", async () => {
  const sensors = new Sensors();
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions(sensors) });
  const handle = session.eventHandle(readingChanged);
  const controller = new AbortController();
  const first = await handle.subscribe({}, { signal: controller.signal });
  const second = await handle.subscribe({});
  const third = await handle.subscribe({ room: "kitchen" });
  await until(() => sensors.listeners === 3);
  controller.abort();
  assert.deepEqual(await first.next(), { done: true, value: undefined });
  await until(() => sensors.listeners === 2);
  sensors.emit("kitchen", 22);
  assert.equal((await nextOf(second)).data.celsius, 22);
  assert.equal((await nextOf(third)).data.celsius, 22);
  // A call at the same time as the subscriptions.
  assert.deepEqual(await session.handle(read).invokeExternal({}), { ok: true, value: { room: "kitchen", celsius: 22 } });
});

test("dispose ends each subscription as complete, and the providers stop", async () => {
  const sensors = new Sensors();
  const session = createSession(sensorsApp, { target: "app", ...sensorOptions(sensors) });
  const first = await session.eventHandle(readingChanged).subscribe({});
  const second = await session.eventHandle(clock).subscribe({});
  await until(() => sensors.listeners === 1);
  const pending = first.next();
  await session.dispose();
  assert.deepEqual(await pending, { done: true, value: undefined });
  // The ticks in the buffer can still be read, then the subscription is complete.
  for (let step = await second.next(); step.done !== true; step = await second.next());
  assert.equal(sensors.listeners, 0);
});

test("a slow client loses the oldest occurrences, and the next occurrence that it reads has truncated", async () => {
  const sensors = new Sensors();
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions(sensors), bufferLimit: 2 });
  const occurrences = await session.eventHandle(readingChanged).subscribe({});
  await until(() => sensors.listeners === 1);
  for (let index = 0; index < 5; index += 1) sensors.emit("hall", index);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const third = await nextOf(occurrences);
  assert.equal(third.data.celsius, 3);
  assert.equal(third.truncated, true);
  const fourth = await nextOf(occurrences);
  assert.equal(fourth.data.celsius, 4);
  assert.equal(fourth.truncated, undefined);
});

test("the cursor and maxAgeMs reach the provider, and a skipped occurrence gives truncated", async () => {
  const sensors = new Sensors();
  const old = new Date(Date.now() - 60_000).toISOString();
  sensors.emit("hall", 1, old);
  sensors.emit("hall", 2, old);
  sensors.emit("hall", 3);
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions(sensors) });
  const resumed = await session.eventHandle(readingChanged).subscribe({}, { cursor: "0" });
  assert.deepEqual([(await nextOf(resumed)).cursor, (await nextOf(resumed)).cursor], ["1", "2"]);
  const recent = await session.eventHandle(readingChanged).subscribe({}, { cursor: "0", maxAgeMs: 1000 });
  const first = await nextOf(recent);
  assert.equal(first.cursor, "2");
  assert.equal(first.truncated, true);
});

test("a GraphQL-style consumer calls return() while next() waits", async () => {
  // graphql-js 17 calls return() of the source while its own next() waits (withConcurrentAbruptClose).
  const sensors = new Sensors();
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions(sensors) });
  const source = await session.eventHandle(readingChanged).subscribe({});
  const iterator = source[Symbol.asyncIterator]();
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 20);
  assert.equal((await iterator.next()).done, false);
  const waiting = iterator.next();
  const [returned, waited] = await Promise.all([iterator.return(), waiting]);
  assert.deepEqual(returned, { done: true, value: undefined });
  assert.deepEqual(waited, { done: true, value: undefined });
  await until(() => sensors.listeners === 0);
});

test("an event with no payload schema must give an empty object", async () => {
  const app = defineApp({
    targets: { app: { bindings: ["typescript"] } },
    capabilities: [],
    events: [
      defineEvent({
        id: "probe.filled",
        description: "Gives data that is not empty, with no payload schema.",
        audience: ["app"],
        async *subscribe() {
          yield { data: Object.defineProperty({}, "secret", { value: 1, enumerable: true }) };
        },
      }),
    ],
  });
  await using session = createSession(app, { target: "app", ...sensorOptions() });
  const filled = await session.subscribe("probe.filled", {});
  assert.ok(!("kind" in filled));
  await assert.rejects(filled.next(), (error) => error instanceof CallFailureError && error.kind === "internal");
});

test("WebMCP serves no events: it registers only the tools of the capabilities", async () => {
  const tools = new Map<string, ModelContextTool>();
  const host = {
    registerTool(tool: ModelContextTool) {
      tools.set(tool.name, tool);
      return undefined;
    },
  };
  await using session = createSession(sensorsApp, { target: "app", ...sensorOptions() });
  const installed = installWebMcp(session, { host });
  assert.ok(installed !== undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(installed.status.getSnapshot().phase, "ready");
  assert.deepEqual([...tools.keys()], ["sensor.read"]);
  await installed.dispose();
});
