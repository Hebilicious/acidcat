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
 * rule that depends on it. The lease time of the deployment must be longer than the deadline: a lease must last for a
 * whole check.
 */
export interface PollSettings {
  /** The number of occurrences that a lease keeps. With it, conform tests the occurrences of a cursor older than the buffer. It must be 97 or less. */
  readonly bufferLimit?: number | undefined;
}

interface Polled {
  readonly events: readonly Occurrence[];
  readonly cursor: string;
  readonly truncated: boolean;
  readonly hasMore: boolean;
}

const MAXIMUM_TICKS = 100;

const MAXIMUM_EVENTS = 100;

function pollRequests(channel: Channel) {
  const { errorOf, watching, signalKey } = eventRequests(channel);

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
  const poll = async (name: string, input: JsonObject, extra: JsonObject, signal: AbortSignal): Promise<Polled> =>
    polledOf(await channel.request("events/poll", { name, arguments: input, ...extra }, signal), name);
  const pollUntil = (what: string, name: string, input: JsonObject, extra: JsonObject, done: (polled: Polled) => boolean, signal: AbortSignal) =>
    until(what, () => poll(name, input, extra, signal), done, signal);
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
  const startWatch = async (key: string, signal: AbortSignal) => {
    const started = await poll("fixture.watch", { key }, {}, signal);
    expectStart(started, false);
    await until("fixture.watching gives the key of the lease", () => watching(signal), hasKey(key), signal);
    return started.cursor;
  };
  const signalAll = async (key: string, values: readonly string[], signal: AbortSignal) => {
    for (const value of values) expectEqual(await signalKey(key, value, signal), 1, "the subscriptions that fixture.signal reached");
  };
  return { errorOf, watching, polledOf, poll, pollUntil, pollError, dataOf, watched, ticks, hasKey, lacksKey, expectStart, startWatch, signalAll };
}

export async function checkPoll(checks: Checks, channel: Channel, settings: PollSettings): Promise<void> {
  const { errorOf, watching, polledOf, poll, pollUntil, pollError, dataOf, watched, ticks, hasKey, expectStart, startWatch, signalAll } = pollRequests(channel);

  await checks.run("events/poll with no cursor and no lease starts a lease with no occurrences, whose subscription starts now; a cursor of the lease gives the occurrences after it, in order; and no cursor gives the newest position", RULE, async (signal) => {
    const key = randomUUID();
    const start = await startWatch(key, signal);
    await signalAll(key, ["a", "b"], signal);
    const both = await pollUntil("the lease has both occurrences", "fixture.watch", { key }, { cursor: start }, (each) => each.events.length >= 2, signal);
    expectEqual(dataOf(both), watched(key, "a", "b"), "the data of the occurrences after the start");
    expectEqual([both.truncated, both.hasMore], [false, false], "truncated and hasMore");
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
      for (const attempt of ["first", "second"]) {
        const error = await pollError(name, input, {}, signal);
        expectEqual(error.code, code, `the JSON-RPC error code of the ${attempt} poll of ${name}`);
        if (code === -32023) expectEqual(memberOf(error.data, "kind"), "event", `data.kind of the ${attempt} poll of ${name}`);
      }
    }
  });

  await checks.run("after a defect, the next poll is the error -32603 and ends the lease, and a later poll starts a new lease", RULE, async (signal) => {
    const start = async () => {
      const message = await channel.request("events/poll", { name: "fixture.broken", arguments: {} }, signal);
      const polled = memberOf(message, "error") === undefined ? polledOf(message, "fixture.broken") : await poll("fixture.broken", {}, {}, signal);
      expectStart(polled, false);
      return polled.cursor;
    };
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
}

export async function checkPollLease(checks: Checks, channel: Channel, leaseMs: number): Promise<void> {
  const { watching, poll, lacksKey, hasKey, expectStart } = pollRequests(channel);
  const keepUntilWatched = async (key: string, cursor: string, signal: AbortSignal) => {
    const lease = { cursor, renewedAt: Date.now() };
    await until(
      "fixture.watching gives the key of the lease, while each poll renews the lease",
      async () => {
        lease.renewedAt = Date.now();
        lease.cursor = (await poll("fixture.watch", { key }, { cursor: lease.cursor }, signal)).cursor;
        return watching(signal);
      },
      hasKey(key),
      signal,
    );
    return lease;
  };

  await checks.run("a lease that gets no poll for the lease time ends, and cancels its subscription", RULE, async (signal) => {
    expect(Number.isSafeInteger(leaseMs) && leaseMs >= 1 && leaseMs < checks.deadline, `conform tests the end of a lease only when the lease time is shorter than the deadline of ${checks.deadline} ms, got ${leaseMs}`);
    const key = randomUUID();
    const started = await poll("fixture.watch", { key }, {}, signal);
    expectStart(started, false);
    const lease = await keepUntilWatched(key, started.cursor, signal);
    await until("the lease ends, and the key leaves fixture.watching", () => watching(signal), lacksKey(key), signal);
    const elapsed = Date.now() - lease.renewedAt;
    expect(elapsed >= leaseMs, `the lease ended ${elapsed} ms after the last poll, before the lease time of ${leaseMs} ms`);
    const again = await poll("fixture.watch", { key }, { cursor: lease.cursor }, signal);
    expectStart(again, true);
    await keepUntilWatched(key, again.cursor, signal);
  });
}
