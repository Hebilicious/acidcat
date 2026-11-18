import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePollCursor, encodePollCursor, isJsonObject } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { mcpHandler, runMcpStdio } from "../src/index.ts";
import type { PollOptions } from "../src/index.ts";
import { ManualClock } from "./manual-clock.ts";
import { sensorOptions, Sensors, sensorsApp } from "./sensors.ts";
import { until } from "./until.ts";

const VERSION = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": VERSION };

function objectOf(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("The message is not an object.");
  return value;
}

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

test("poll: nextPollMs is 2000 by default, and closing the handler ends the leases", async () => {
  const { handler, poll, sensors } = httpServer();
  assert.equal((await poll(READINGS)).nextPollMs, 2000);
  await until(() => sensors.listeners === 1);
  await handler.close();
  assert.equal(sensors.listeners, 0);
});

test("poll: the maxEvents of the server limits a poll with no maxEvents, and hasMore tells that more wait", async () => {
  const { handler, poll, sensors } = httpServer({ poll: { maxEvents: 3 } });
  const start = await poll(READINGS);
  await until(() => sensors.listeners === 1);
  for (let reading = 0; reading < 5; reading += 1) sensors.emit("hall", reading);
  await until(async () => positionOf((await poll(READINGS)).cursor).position === 5);
  const first = await poll({ ...READINGS, cursor: start.cursor });
  assert.deepEqual(celsius(first.events), [0, 1, 2]);
  assert.equal(first.hasMore, true);
  await handler.close();
});

test("poll: a cursor that is not a string, or a maxAgeMs that is not an integer of 0 or more, is -32602, after an unknown event, with a lease or not", async () => {
  const { handler, rpc, poll, sensors } = httpServer();
  const error = async (params: object) => {
    const answer = await rpc("events/poll", params);
    return isJsonObject(answer["error"]) ? answer["error"]["code"] : undefined;
  };
  const resume = { cursor: encodePollCursor({ lease: "gone", position: 0, provider: "0" }) };
  assert.equal(await error({ ...READINGS, cursor: 5 }), -32602);
  for (const maxAgeMs of [1.5, -1, "soon"]) {
    assert.equal(await error({ ...READINGS, maxAgeMs }), -32602, String(maxAgeMs));
    assert.equal(await error({ ...READINGS, ...resume, maxAgeMs }), -32602, String(maxAgeMs));
    assert.equal(await error({ name: "sensor.hidden", maxAgeMs }), -32023, String(maxAgeMs));
  }
  assert.equal(sensors.listeners, 0);
  const start = await poll(READINGS);
  await until(() => sensors.listeners === 1);
  assert.equal(await error({ ...READINGS, cursor: start.cursor, maxAgeMs: 1.5 }), -32602);
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
  assert.equal(read.truncated, true);
  assert.equal(read.events[0]?.["truncated"], undefined);
  await handler.close();
});

test("poll: a lease that gets no poll for the lease time ends, and its subscription is cancelled", async () => {
  const { handler, poll, sensors, clock } = httpServer({ poll: { leaseMs: 60_000 } });
  const start = await poll(READINGS);
  await until(() => sensors.listeners === 1);
  clock.advance(59_000);
  await poll({ ...READINGS, cursor: start.cursor });
  clock.advance(59_000);
  assert.equal(sensors.listeners, 1);
  clock.advance(1000);
  await until(() => sensors.listeners === 0);
  const restarted = await poll({ ...READINGS, cursor: start.cursor });
  assert.equal(restarted.truncated, true);
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
  const stolen = await poll({ ...READINGS, cursor: alice.cursor }, "bob");
  assert.equal(positionOf(stolen.cursor).lease, positionOf(bob.cursor).lease);
  await poll({ name: "sensor.reading.changed", arguments: { room: "hall" } }, "alice");
  await until(() => sensors.listeners === 4);
  await handler.close();
  assert.equal(sensors.listeners, 0);
});

test("poll through stdio: the option nextPollMs, and the end of standard input ends the leases", async () => {
  const sensors = new Sensors();
  const lines = [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/poll", params: { ...READINGS, _meta: META } })];
  let answered = () => {};
  const answer = new Promise<void>((resolve) => (answered = resolve));
  async function* input(): AsyncGenerator<string> {
    for (const line of lines) yield `${line}\n`;
    await answer;
    await until(() => sensors.listeners === 1);
  }
  const written: JsonObject[] = [];
  const served = runMcpStdio(sensorsApp, { name: "sensors", version: "0.0.0", ...sensorOptions(sensors), clock: new ManualClock(), poll: { nextPollMs: 500 } }, {
    input: input(),
    write: (text) => {
      written.push(objectOf(text));
      answered();
    },
  });
  await served;
  const [start] = written;
  assert.ok(start !== undefined);
  assert.equal(pollResult(start).nextPollMs, 500);
  assert.equal(sensors.listeners, 0);
});
