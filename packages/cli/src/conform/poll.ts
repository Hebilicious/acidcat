/**
 * Conformance checks for poll delivery of the MCP events extension (spec/bindings/mcp.md#poll), through a channel. Each
 * transport runs them. The checks read the state of a lease only through `events/poll` and `fixture.watching`, and wait
 * for states that they can observe, not for times.
 *
 * A lease continues after the check that started it, until the lease time of the deployment ends. So each check uses a
 * new key in its input: the leases of one check, or of an earlier run of conform, never have the key of another check.
 */
import { randomUUID } from "node:crypto";

import type { Occurrence } from "@acid-cat/spec-ts";

import { isArrayOf, isObject, memberOf } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { Checks, expect, expectEqual, expectOccurrence, until } from "./check.ts";
import { eventRequests } from "./mcp.ts";
import type { Channel, Message } from "./mcp.ts";

const RULE = "spec/bindings/mcp.md#poll";

/**
 * The poll settings of the deployment that conform tests. Each one is optional. With a setting, conform also tests the
 * rule that depends on it.
 */
export interface PollSettings {
  /** The number of occurrences that a lease keeps. With it, conform tests the occurrences of a cursor older than the buffer. It must be 97 or less. */
  readonly bufferLimit?: number | undefined;
  /** The lease time, in milliseconds. With it, conform tests that a lease with no poll ends. It must be shorter than the deadline. */
  readonly leaseMs?: number | undefined;
}

/** The result of `events/poll`, after the checks of its form. */
interface Polled {
  readonly events: readonly Occurrence[];
  readonly cursor: string;
  readonly truncated: boolean;
  readonly hasMore: boolean;
}

/** The largest count of `fixture.ticks`. */
const MAXIMUM_TICKS = 100;

/** The most occurrences that a check asks for in one poll. */
const MAXIMUM_EVENTS = 100;

export async function checkPoll(checks: Checks, channel: Channel, settings: PollSettings): Promise<void> {
  const { errorOf, watching, signalKey } = eventRequests(channel);

  /** The form of a result of `events/poll` (spec/bindings/mcp.md#poll). */
  const polledOf = (message: Message, name: string): Polled => {
    const result = memberOf(message, "result");
    expect(isObject(result), `events/poll must give a result, got ${JSON.stringify(message)}`);
    expectEqual(result.resultType, "complete", "resultType");
    const { events, cursor, truncated, hasMore, nextPollMs } = result;
    if (!isArrayOf(events, isObject)) throw new Error(`events must be a list of occurrences, got ${JSON.stringify(events)}`);
    for (const each of events) expect(!("truncated" in each), `an item of events must have no truncated member, got ${JSON.stringify(each)}`);
    expect(typeof cursor === "string", `cursor must be a string, got ${JSON.stringify(cursor)}`);
    expect(typeof truncated === "boolean", `truncated must be a boolean, got ${JSON.stringify(truncated)}`);
    expect(typeof hasMore === "boolean", `hasMore must be a boolean, got ${JSON.stringify(hasMore)}`);
    expect(typeof nextPollMs === "number" && Number.isSafeInteger(nextPollMs) && nextPollMs >= 0, `nextPollMs must be an integer of 0 or more, got ${JSON.stringify(nextPollMs)}`);
    return { events: events.map((each) => expectOccurrence(each, name)), cursor, truncated, hasMore };
  };
  /** Poll once. The result must have the form of a result. */
  const poll = async (name: string, input: JsonObject, extra: JsonObject, signal: AbortSignal): Promise<Polled> =>
    polledOf(await channel.request("events/poll", { name, arguments: input, ...extra }, signal), name);
  /** Poll with the same params until `done` is true for the result. Each poll renews the lease. */
  const pollUntil = (what: string, name: string, input: JsonObject, extra: JsonObject, done: (polled: Polled) => boolean, signal: AbortSignal) =>
    until(what, () => poll(name, input, extra, signal), done, signal);
  /** The JSON-RPC error of a poll. */
  const pollError = async (name: string, input: JsonObject, extra: JsonObject, signal: AbortSignal) =>
    errorOf(await channel.request("events/poll", { name, arguments: input, ...extra }, signal));
  const dataOf = (polled: Polled) => polled.events.map((each) => each.data);
  const watched = (key: string, ...values: string[]) => values.map((value) => ({ key, value }));
  const ticks = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => ({ n: from + index }));
  const hasKey = (key: string) => (keys: readonly string[]) => keys.includes(key);
  const lacksKey = (key: string) => (keys: readonly string[]) => !keys.includes(key);
  const expectStart = (polled: Polled, truncated: boolean) => {
    expectEqual(polled.events, [], "the occurrences of the poll that starts the lease");
    expectEqual(polled.truncated, truncated, "truncated");
    expectEqual(polled.hasMore, false, "hasMore");
  };
  /** Start a lease of `fixture.watch` for the key, and wait until its subscription is active. The result is the cursor of the start. */
  const startWatch = async (key: string, signal: AbortSignal) => {
    const started = await poll("fixture.watch", { key }, {}, signal);
    expectStart(started, false);
    await until("fixture.watching gives the key of the lease", () => watching(signal), hasKey(key), signal);
    return started.cursor;
  };
  /** Give values to the subscriptions of the key, one at a time. Each must reach one subscription. */
  const signalAll = async (key: string, values: readonly string[], signal: AbortSignal) => {
    for (const value of values) expectEqual(await signalKey(key, value, signal), 1, "the subscriptions that fixture.signal reached");
  };

  await checks.run("events/poll with no cursor and no lease starts a lease with no occurrences, whose subscription starts now", RULE, async (signal) => {
    const key = randomUUID();
    const cursor = await startWatch(key, signal);
    await signalAll(key, ["first"], signal);
    const polled = await pollUntil("the lease has the occurrence", "fixture.watch", { key }, { cursor }, (each) => each.events.length > 0, signal);
    expectEqual(dataOf(polled), watched(key, "first"), "the data of the occurrences");
    expectEqual([polled.truncated, polled.hasMore], [false, false], "truncated and hasMore");
  });

  await checks.run("a cursor of the lease gives the occurrences after it, in order, and no cursor gives the newest position", RULE, async (signal) => {
    const key = randomUUID();
    const start = await startWatch(key, signal);
    await signalAll(key, ["a", "b"], signal);
    const both = await pollUntil("the lease has both occurrences", "fixture.watch", { key }, { cursor: start }, (each) => each.events.length >= 2, signal);
    expectEqual(dataOf(both), watched(key, "a", "b"), "the data of the occurrences after the start");
    expectEqual(both.truncated, false, "truncated");
    const newest = await poll("fixture.watch", { key }, {}, signal);
    expectEqual([newest.events, newest.truncated], [[], false], "the occurrences and truncated of a poll with no cursor");
    await signalAll(key, ["c"], signal);
    const after = await pollUntil("the lease has the next occurrence", "fixture.watch", { key }, { cursor: newest.cursor }, (each) => each.events.length > 0, signal);
    expectEqual(dataOf(after), watched(key, "c"), "the data of the occurrences after the newest position");
    const next = await poll("fixture.watch", { key }, { cursor: both.cursor }, signal);
    expectEqual(dataOf(next), watched(key, "c"), "the data of the occurrences after the cursor of the last result");
  });

  await checks.run("maxEvents limits the occurrences of a result, and hasMore tells that the buffer has more", RULE, async (signal) => {
    const key = randomUUID();
    const start = await startWatch(key, signal);
    await signalAll(key, ["1", "2", "3"], signal);
    const first = await pollUntil("the lease has three occurrences", "fixture.watch", { key }, { cursor: start, maxEvents: 2 }, (each) => each.hasMore, signal);
    expectEqual(dataOf(first), watched(key, "1", "2"), "the data of the first result");
    const second = await poll("fixture.watch", { key }, { cursor: first.cursor, maxEvents: 2 }, signal);
    expectEqual(dataOf(second), watched(key, "3"), "the data of the second result");
    expectEqual(second.hasMore, false, "hasMore of the second result");
  });

  await checks.run("a maxEvents that is not an integer of 1 or more is the error -32602", RULE, async (signal) => {
    for (const maxEvents of [0, -1, 1.5, "2"]) {
      const error = await pollError("fixture.watch", { key: randomUUID() }, { maxEvents }, signal);
      expectEqual(error.code, -32602, `the JSON-RPC error code for maxEvents ${JSON.stringify(maxEvents)}`);
    }
  });

  await checks.run("a cursor that is not of the lease, while the lease exists, gives no occurrences, the newest position and truncated: true", RULE, async (signal) => {
    const key = randomUUID();
    const start = await startWatch(key, signal);
    const other = await poll("fixture.watch", { key: randomUUID() }, {}, signal);
    await signalAll(key, ["before"], signal);
    await pollUntil("the lease has the occurrence", "fixture.watch", { key }, { cursor: start }, (each) => each.events.length > 0, signal);
    const foreign = await poll("fixture.watch", { key }, { cursor: other.cursor }, signal);
    expectEqual([foreign.events, foreign.truncated], [[], true], "the occurrences and truncated");
    await signalAll(key, ["after"], signal);
    const after = await pollUntil("the lease has the next occurrence", "fixture.watch", { key }, { cursor: foreign.cursor }, (each) => each.events.length > 0, signal);
    expectEqual(dataOf(after), watched(key, "after"), "the data of the occurrences after the newest position");
  });

  await checks.run("a cursor that is not of a lease, with no lease, starts a lease that starts now, with truncated: true", RULE, async (signal) => {
    const other = await poll("fixture.watch", { key: randomUUID() }, {}, signal);
    const key = randomUUID();
    const started = await poll("fixture.watch", { key }, { cursor: other.cursor }, signal);
    expectStart(started, true);
    await until("fixture.watching gives the key of the new lease", () => watching(signal), hasKey(key), signal);
    await signalAll(key, ["now"], signal);
    const polled = await pollUntil("the lease has the occurrence", "fixture.watch", { key }, { cursor: started.cursor }, (each) => each.events.length > 0, signal);
    expectEqual(dataOf(polled), watched(key, "now"), "the data of the occurrences");
  });

  await checks.run("a cursor of push delivery has no cursor of the provider: the new lease starts now, with truncated: true", RULE, async (signal) => {
    const input = { count: 3, key: randomUUID() };
    const started = await poll("fixture.ticks", input, { cursor: "1" }, signal);
    expectStart(started, true);
    const polled = await pollUntil("the lease has the last tick", "fixture.ticks", input, { cursor: started.cursor }, (each) => each.events.some((event) => memberOf(event.data, "n") === 3), signal);
    expectEqual(dataOf(polled), ticks(1, 3), "the data of the occurrences, from n = 1");
  });

  await checks.run("a cursor of another lease with a cursor of the provider starts a lease that resumes after it", RULE, async (signal) => {
    const first = { count: 3, key: randomUUID() };
    const start = await poll("fixture.ticks", first, {}, signal);
    expectStart(start, false);
    const one = await pollUntil("the first lease has the first tick", "fixture.ticks", first, { cursor: start.cursor, maxEvents: 1 }, (each) => each.events.length > 0, signal);
    expectEqual(dataOf(one), ticks(1, 1), "the data of the first occurrence");
    const second = { count: 4, key: randomUUID() };
    const resumed = await poll("fixture.ticks", second, { cursor: one.cursor }, signal);
    expectStart(resumed, false);
    const polled = await pollUntil("the new lease has the last tick", "fixture.ticks", second, { cursor: resumed.cursor }, (each) => each.events.some((event) => memberOf(event.data, "n") === 4), signal);
    expectEqual(dataOf(polled), ticks(2, 4), "the data of the occurrences after the cursor of the provider");
    expectEqual(polled.truncated, false, "truncated");
  });

  await checks.run("an occurrence after a gap gives a result with truncated: true, and its item has no truncated", RULE, async (signal) => {
    const input = { count: 3, gap: 2, key: randomUUID() };
    const start = await poll("fixture.ticks", input, {}, signal);
    expectStart(start, false);
    const before = await pollUntil("the lease has the first tick", "fixture.ticks", input, { cursor: start.cursor, maxEvents: 1 }, (each) => each.events.length > 0, signal);
    expectEqual([dataOf(before), before.truncated], [ticks(1, 1), false], "the data and truncated of the result before the gap");
    const after = await pollUntil("the lease has the last tick", "fixture.ticks", input, { cursor: before.cursor }, (each) => each.events.some((event) => memberOf(event.data, "n") === 3), signal);
    expectEqual([dataOf(after), after.truncated], [ticks(2, 3), true], "the data and truncated of the result with the gap");
  });

  if (settings.bufferLimit !== undefined) {
    const limit = settings.bufferLimit;
    await checks.run("a cursor older than the buffer gives the occurrences in the buffer, and truncated: true", RULE, async (signal) => {
      expect(Number.isSafeInteger(limit) && limit >= 1 && limit + 3 <= MAXIMUM_TICKS, `conform tests the buffer only when it keeps 1 to ${MAXIMUM_TICKS - 3} occurrences, got ${limit}`);
      const total = limit + 3;
      const input = { count: total, key: randomUUID() };
      const start = await poll("fixture.ticks", input, {}, signal);
      expectStart(start, false);
      const polled = await pollUntil("the lease has the last tick", "fixture.ticks", input, { cursor: start.cursor, maxEvents: MAXIMUM_EVENTS }, (each) => each.events.some((event) => memberOf(event.data, "n") === total), signal);
      expectEqual(dataOf(polled), ticks(4, total), "the data of the occurrences in the buffer");
      expectEqual([polled.truncated, polled.hasMore], [true, false], "truncated and hasMore");
    });
  }

  await checks.run("a failure before the first occurrence is a JSON-RPC error, and starts no lease", RULE, async (signal) => {
    for (const [name, input, code] of [
      ["fixture.secret", {}, -32023],
      ["fixture.echo", { text: "x" }, -32023],
      ["fixture.ticks", { count: MAXIMUM_TICKS + 1 }, -32602],
    ] as const) {
      // A lease would answer the second poll with a result. So each poll gets the error.
      for (const attempt of ["first", "second"]) {
        const error = await pollError(name, input, {}, signal);
        expectEqual(error.code, code, `the JSON-RPC error code of the ${attempt} poll of ${name}`);
        if (code === -32023) expectEqual(memberOf(error.data, "kind"), "event", `data.kind of the ${attempt} poll of ${name}`);
      }
    }
  });

  await checks.run("after a defect, the next poll is the error -32603 and ends the lease, and a later poll starts a new lease", RULE, async (signal) => {
    /** Start a lease of `fixture.broken`. A lease of an earlier run can still have the failure: its poll ends it first. */
    const start = async () => {
      const message = await channel.request("events/poll", { name: "fixture.broken", arguments: {} }, signal);
      const polled = memberOf(message, "error") === undefined ? polledOf(message, "fixture.broken") : await poll("fixture.broken", {}, {}, signal);
      expectStart(polled, false);
      return polled.cursor;
    };
    /** Poll until the error. A result before the error can only have the occurrence n = 1. */
    const failure = async (cursor: string) => {
      const message = await until(
        "a poll gets the error",
        async () => {
          const each = await channel.request("events/poll", { name: "fixture.broken", arguments: {}, cursor }, signal);
          if (memberOf(each, "error") === undefined) expect(dataOf(polledOf(each, "fixture.broken")).every((data) => memberOf(data, "n") === 1), "a result before the error has only the occurrence n = 1");
          return each;
        },
        (each) => memberOf(each, "error") !== undefined,
        signal,
      );
      const error = errorOf(message);
      expectEqual(error.code, -32603, "the JSON-RPC error code");
      expect(!/\n\s+at /.test(String(error.message)), "the message must not contain a stack trace");
    };
    await failure(await start());
    await failure(await start());
  });

  if (settings.leaseMs !== undefined) {
    const leaseMs = settings.leaseMs;
    await checks.run("a lease that gets no poll for the lease time ends, and cancels its subscription", RULE, async (signal) => {
      const key = randomUUID();
      const before = Date.now();
      const cursor = await startWatch(key, signal);
      await until("the lease ends, and the key leaves fixture.watching", () => watching(signal), lacksKey(key), signal);
      const elapsed = Date.now() - before;
      expect(elapsed >= leaseMs, `the lease ended ${elapsed} ms after the last poll, before the lease time of ${leaseMs} ms`);
      const again = await poll("fixture.watch", { key }, { cursor }, signal);
      expectStart(again, true);
      await until("fixture.watching gives the key of the new lease", () => watching(signal), hasKey(key), signal);
    });
  }
}
