import assert from "node:assert/strict";
import { test } from "node:test";

import type { Occurrence } from "../src/index.ts";
import { idlePuller } from "../src/stream.ts";
import type { Occurrences } from "../src/subscription.ts";

test("an idle pull keeps its waiting next(), so the pull after it gets the occurrence", async () => {
  const waiting: ((step: IteratorResult<Occurrence<string>, undefined>) => void)[] = [];
  const occurrences: Occurrences<string> = {
    next: () => new Promise((resolve) => waiting.push(resolve)),
    return: () => Promise.resolve({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => occurrences,
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
  const occurrence: Occurrence<string> = { eventId: "e1", name: "probe.changed", timestamp: "2026-01-01T00:00:00.000Z", data: "x" };
  const pull = idlePuller(occurrences, 5);

  assert.deepEqual(await pull(), { idle: true });
  const pulled = pull();
  waiting[0]?.({ done: false, value: occurrence });
  assert.deepEqual(await pulled, { step: { done: false, value: occurrence } });
  assert.equal(waiting.length, 1);
});
