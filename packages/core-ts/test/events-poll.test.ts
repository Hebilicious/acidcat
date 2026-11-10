import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePollCursor, encodePollCursor, isJsonObject } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { mcpHandler, runMcpStdio } from "../src/index.ts";
import type { PollOptions } from "../src/index.ts";
import { ManualClock } from "./manual-clock.ts";
import { sensorOptions, Sensors, sensorsApp } from "./sensors.ts";

/** Wait until a condition is true, or fail after one second. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 1000;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("The condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const VERSION = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": VERSION };

function objectOf(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("The message is not an object.");
  return value;
}

/** The result of a poll, with its members checked. */
interface PollResult {
  readonly events: readonly JsonObject[];
  readonly cursor: string;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly nextPollMs: unknown;
}

function pollResult(message: JsonObject): PollResult {
  const result = message["result"];
  if (!isJsonObject(result)) throw new Error(`The answer is not a result: ${JSON.stringify(message)}`);
  const { events, cursor, truncated, hasMore, nextPollMs, resultType } = result;
  assert.equal(resultType, "complete");
  if (!Array.isArray(events) || typeof cursor !== "string" || typeof truncated !== "boolean" || typeof hasMore !== "boolean") throw new Error("The result of a poll is not valid.");
  return { events: events.filter(isJsonObject), cursor, truncated, hasMore, nextPollMs };
}

/** The position of a poll cursor. */
function positionOf(cursor: string) {
  const position = decodePollCursor(cursor);
  if (position === undefined) throw new Error("The cursor is not a poll cursor.");
  return position;
}

const celsius = (events: readonly JsonObject[]) => events.map((event) => (isJsonObject(event["data"]) ? event["data"]["celsius"] : undefined));

function httpServer(options: { readonly poll?: PollOptions } = {}) {
  const sensors = new Sensors();
  const clock = new ManualClock();
  const handler = mcpHandler(sensorsApp, {
    name: "sensors",
    version: "0.0.0",
    allowedOrigins: [],
    ...sensorOptions(sensors),
    clock,
    principal: (request) => request.headers.get("X-Principal") ?? undefined,
    ...(options.poll === undefined ? {} : { poll: options.poll }),
  });
  const rpc = async (method: string, params: object, principal?: string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", "MCP-Protocol-Version": VERSION };
    if (principal !== undefined) headers["X-Principal"] = principal;
    const response = await handler(new Request("https://sensors.example/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }) }));
    return objectOf(await response.text());
  };
  const poll = async (params: object, principal?: string) => pollResult(await rpc("events/poll", params, principal));
  return { handler, rpc, poll, sensors, clock };
}

const READINGS = { name: "sensor.reading.changed", arguments: {} };

test("poll: the first poll starts a lease, and the next polls read its occurrences in order", async () => {
  const { handler, poll, sensors } = httpServer();
  const start = await poll(READINGS);
  assert.deepEqual(start.events, []);
  assert.equal(start.truncated, false);
  assert.equal(start.hasMore, false);
  assert.equal(start.nextPollMs, 2000);
  assert.equal(positionOf(start.cursor).position, 0);
  await until(() => sensors.listeners === 1);

  sensors.emit("hall", 20, "2026-11-10T09:00:00.000Z");
  sensors.emit("hall", 21, "2026-11-10T09:00:01.000Z");
  await until(async () => (await poll({ ...READINGS, cursor: start.cursor })).events.length === 2);
  const read = await poll({ ...READINGS, cursor: start.cursor });
  assert.deepEqual(read.events[0], { eventId: "reading-0", name: "sensor.reading.changed", timestamp: "2026-11-10T09:00:00.000Z", data: { room: "hall", celsius: 20 }, cursor: "0" });
  assert.deepEqual(celsius(read.events), [20, 21]);
  assert.equal(read.truncated, false);
  assert.deepEqual(positionOf(read.cursor), { lease: positionOf(start.cursor).lease, position: 2, provider: "1" });

  // A poll with the last cursor and nothing new gives no occurrences, and the cursor of the request.
  const empty = await poll({ ...READINGS, cursor: read.cursor });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.cursor, read.cursor);
  // A poll with no cursor, while the lease exists, gives the cursor of the newest position.
  const newest = await poll(READINGS);
  assert.deepEqual(newest.events, []);
  assert.deepEqual(positionOf(newest.cursor), positionOf(read.cursor));
  // Two polls with the same key read the same lease: one subscription.
  assert.equal(sensors.listeners, 1);
  await handler.close();
  assert.equal(sensors.listeners, 0);
});

test("poll: maxEvents limits the occurrences, and hasMore tells that more wait", async () => {
  const { handler, poll, sensors } = httpServer({ poll: { maxEvents: 3 } });
  const start = await poll(READINGS);
  await until(() => sensors.listeners === 1);
  for (let reading = 0; reading < 5; reading += 1) sensors.emit("hall", reading);
  await until(async () => (await poll({ ...READINGS, cursor: start.cursor, maxEvents: 5 })).events.length === 5);
  const first = await poll({ ...READINGS, cursor: start.cursor, maxEvents: 2 });
  assert.deepEqual(celsius(first.events), [0, 1]);
  assert.equal(first.hasMore, true);
  // The default of the deployment is 3.
  const second = await poll({ ...READINGS, cursor: first.cursor });
  assert.deepEqual(celsius(second.events), [2, 3, 4]);
  assert.equal(second.hasMore, false);
  await handler.close();
});

test("poll: maxEvents that is not a positive integer is -32602, and failures before the first occurrence start no lease", async () => {
  const { handler, rpc, sensors } = httpServer();
  const error = async (params: object) => {
    const answer = await rpc("events/poll", params);
    return isJsonObject(answer["error"]) ? answer["error"] : undefined;
  };
  for (const maxEvents of [0, -1, 1.5, "2"]) assert.equal((await error({ ...READINGS, maxEvents }))?.["code"], -32602, String(maxEvents));
  assert.deepEqual(await error({ name: "sensor.hidden" }), { code: -32023, message: "There is no event sensor.hidden.", data: { kind: "event" } });
  assert.equal((await error({ name: "sensor.reading.changed", arguments: { room: 7 } }))?.["code"], -32602);
  assert.equal((await error({ ...READINGS, cursor: 5 }))?.["code"], -32602);
  assert.equal(sensors.listeners, 0);
  await handler.close();
});

test("poll: a cursor older than the buffer gives the occurrences in the buffer, and truncated", async () => {
  const { handler, poll, sensors } = httpServer({ poll: { bufferLimit: 2 } });
  const start = await poll(READINGS);
  await until(() => sensors.listeners === 1);
  for (let reading = 0; reading < 4; reading += 1) sensors.emit("hall", reading);
  await until(async () => positionOf((await poll(READINGS)).cursor).position === 4);
  const read = await poll({ ...READINGS, cursor: start.cursor });
  assert.deepEqual(celsius(read.events), [2, 3]);
  assert.equal(read.truncated, true);
  await handler.close();
});

test("poll: a cursor of a lease that does not exist starts a lease that resumes after the cursor of the provider", async () => {
  const { handler, poll, sensors } = httpServer();
  for (let reading = 0; reading < 4; reading += 1) sensors.emit("hall", reading);
  const resumed = await poll({ ...READINGS, cursor: encodePollCursor({ lease: "gone", position: 9, provider: "1" }) });
  assert.deepEqual(resumed.events, []);
  assert.equal(resumed.truncated, false);
  assert.equal(positionOf(resumed.cursor).position, 0);
  assert.equal(positionOf(resumed.cursor).provider, "1");
  await until(async () => (await poll({ ...READINGS, cursor: resumed.cursor })).events.length === 2);
  assert.deepEqual(celsius((await poll({ ...READINGS, cursor: resumed.cursor })).events), [2, 3]);
  await handler.close();
});

test("poll: maxAgeMs bounds the replay of a lease that resumes", async () => {
  const { handler, poll, sensors } = httpServer();
  const old = new Date(Date.now() - 60_000).toISOString();
  sensors.emit("hall", 0, old);
  sensors.emit("hall", 1, old);
  sensors.emit("hall", 2);
  const resumed = await poll({ ...READINGS, cursor: encodePollCursor({ lease: "gone", position: 0, provider: "0" }), maxAgeMs: 1000 });
  await until(async () => (await poll({ ...READINGS, cursor: resumed.cursor })).events.length === 1);
  const read = await poll({ ...READINGS, cursor: resumed.cursor });
  assert.deepEqual(celsius(read.events), [2]);
  // The provider skipped reading 1, so the occurrence and the result are truncated. The item has no truncated member.
  assert.equal(read.truncated, true);
  assert.equal(read.events[0]?.["truncated"], undefined);
  await handler.close();
});

test("poll: a cursor with no cursor of the provider, or a text that is not a cursor, starts a lease with truncated", async () => {
  const { handler, poll, rpc } = httpServer();
  const foreign = await poll({ ...READINGS, cursor: encodePollCursor({ lease: "gone", position: 3 }) });
  assert.equal(foreign.truncated, true);
  assert.equal(positionOf(foreign.cursor).position, 0);
  const other = await poll({ name: "sensor.clock", cursor: "not a cursor" });
  assert.equal(other.truncated, true);
  // A cursor of another lease, while a lease with the key exists, gives the newest position and truncated.
  const again = await poll({ name: "sensor.clock", cursor: foreign.cursor });
  assert.equal(again.truncated, true);
  assert.equal(positionOf(again.cursor).lease, positionOf(other.cursor).lease);
  assert.equal(isJsonObject((await rpc("events/poll", { name: "sensor.clock" }))["result"]), true);
  await handler.close();
});

test("poll: a lease that gets no poll for the lease time ends, and its subscription is cancelled", async () => {
  const { handler, poll, sensors, clock } = httpServer({ poll: { leaseMs: 60_000 } });
  const start = await poll(READINGS);
  await until(() => sensors.listeners === 1);
  clock.advance(59_000);
  // Each poll renews the lease.
  await poll({ ...READINGS, cursor: start.cursor });
  clock.advance(59_000);
  assert.equal(sensors.listeners, 1);
  clock.advance(1000);
  await until(() => sensors.listeners === 0);
  // The cursor is of a lease that does not exist: a new lease starts now, with truncated.
  const restarted = await poll({ ...READINGS, cursor: start.cursor });
  assert.equal(restarted.truncated, true);
  assert.notEqual(positionOf(restarted.cursor).lease, positionOf(start.cursor).lease);
  await handler.close();
});

test("poll: a complete subscription keeps its buffer until the lease ends", async () => {
  const { handler, poll } = httpServer();
  const start = await poll({ name: "sensor.ticks" });
  await until(async () => (await poll({ name: "sensor.ticks", cursor: start.cursor })).events.length === 3);
  const read = await poll({ name: "sensor.ticks", cursor: start.cursor });
  assert.equal(read.events.length, 3);
  assert.deepEqual((await poll({ name: "sensor.ticks", cursor: read.cursor })).events, []);
  await handler.close();
});

test("poll: internal gives -32603 to the next poll, and the lease ends", async () => {
  const { handler, rpc } = httpServer();
  const start = pollResult(await rpc("events/poll", { name: "sensor.failing" }));
  let answer: JsonObject = {};
  await until(async () => {
    answer = await rpc("events/poll", { name: "sensor.failing", cursor: start.cursor });
    return answer["error"] !== undefined;
  });
  assert.deepEqual(answer["error"], { code: -32603, message: "The event failed." });
  // The lease is gone: the next poll starts a new lease.
  const restarted = pollResult(await rpc("events/poll", { name: "sensor.failing", cursor: start.cursor }));
  assert.notEqual(positionOf(restarted.cursor).lease, positionOf(start.cursor).lease);
  await handler.close();
});

test("poll: the principal is part of the key, so two principals have two leases", async () => {
  const { handler, poll, sensors } = httpServer();
  const alice = await poll(READINGS, "alice");
  const bob = await poll(READINGS, "bob");
  const nobody = await poll(READINGS);
  await until(() => sensors.listeners === 3);
  assert.notEqual(positionOf(alice.cursor).lease, positionOf(bob.cursor).lease);
  assert.notEqual(positionOf(alice.cursor).lease, positionOf(nobody.cursor).lease);
  sensors.emit("hall", 20);
  await until(async () => (await poll({ ...READINGS, cursor: alice.cursor }, "alice")).events.length === 1);
  // The cursor of alice is not of a lease of bob: bob gets no occurrences of the lease of alice.
  const stolen = await poll({ ...READINGS, cursor: alice.cursor }, "bob");
  assert.equal(positionOf(stolen.cursor).lease, positionOf(bob.cursor).lease);
  // Another input is another key.
  await poll({ name: "sensor.reading.changed", arguments: { room: "hall" } }, "alice");
  await until(() => sensors.listeners === 4);
  await handler.close();
  assert.equal(sensors.listeners, 0);
});

// --- Through stdio ---------------------------------------------------------------------------------------------------

test("poll through stdio: leases, their occurrences, and the end of standard input ends them", async () => {
  const sensors = new Sensors();
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
  const served = runMcpStdio(sensorsApp, { name: "sensors", version: "0.0.0", ...sensorOptions(sensors), clock: new ManualClock(), poll: { nextPollMs: 500 } }, {
    input: input(),
    write: (text) => written.push(objectOf(text)),
  });
  let next = 0;
  const rpc = async (method: string, params: object) => {
    next += 1;
    const id = next;
    queue.push(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }));
    wake();
    let found: JsonObject | undefined;
    await until(() => (found = written.find((message) => message["id"] === id)) !== undefined);
    if (found === undefined) throw new Error("No answer.");
    return found;
  };

  const start = pollResult(await rpc("events/poll", READINGS));
  assert.equal(start.nextPollMs, 500);
  await until(() => sensors.listeners === 1);
  sensors.emit("kitchen", 21);
  let read: PollResult | undefined;
  await until(async () => (read = pollResult(await rpc("events/poll", { ...READINGS, cursor: start.cursor }))).events.length === 1);
  assert.deepEqual(celsius(read?.events ?? []), [21]);
  assert.equal(member(await rpc("events/poll", { name: "sensor.hidden" }), "error")["code"], -32023);

  ended = true;
  wake();
  await served;
  assert.equal(sensors.listeners, 0);
});

function member(value: JsonObject, key: string): JsonObject {
  const inner = value[key];
  if (!isJsonObject(inner)) throw new Error(`The member ${key} is not an object.`);
  return inner;
}
