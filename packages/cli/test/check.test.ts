import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";

import { Checks } from "../src/conform/check.ts";

test("checks that run at the same time keep the order in which they are defined", async () => {
  const checks = new Checks("cli", 1_000);
  await checks.concurrently((check) => {
    check("slow", "rule", () => pause(50));
    check("fails", "rule", () => {
      throw new Error("refused");
    });
    check("fast", "rule", () => undefined);
  });
  assert.deepEqual(
    checks.results.map(({ name, passed, detail }) => [name, passed, detail]),
    [
      ["slow", true, undefined],
      ["fails", false, "refused"],
      ["fast", true, undefined],
    ],
  );
});

test("the end of a check stops the work that it started, also when one part of it fails first", async () => {
  const checks = new Checks("cli", 60_000);
  let started: AbortSignal | undefined;
  await checks.run("fails", "rule", async (signal) => {
    started = signal;
    await Promise.all([pause(60_000, undefined, { signal }), Promise.reject(new Error("refused"))]);
  });
  assert.equal(started?.aborted, true);
  assert.deepEqual(
    checks.results.map(({ name, passed, detail }) => [name, passed, detail]),
    [["fails", false, "refused"]],
  );
});
