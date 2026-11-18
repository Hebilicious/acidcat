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
