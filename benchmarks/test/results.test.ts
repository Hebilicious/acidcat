import assert from "node:assert/strict";
import { test } from "node:test";
import { cell, isRunResult, summarize } from "../src/results.ts";
import type { RunResult } from "../src/results.ts";
import { spread } from "../src/stats.ts";

test("the spread of a measure gives its median and its quartiles", () => {
  assert.deepEqual(spread([5, 1, 3, 2, 4]), { n: 5, median: 3, q1: 2, q3: 4, min: 1, max: 5 });
  assert.equal(spread([1, 2, 3, 4]).median, 2.5);
  assert.equal(cell(spread([1200, 1000, 1100]), "ms"), "1100 (1050–1150)");
  assert.equal(cell(spread([]), "ms"), "–");
});

const result = (job: string, framework: number, other: number): RunResult => ({
  suite: "fixture",
  title: "The fixture",
  job,
  lighthouseVersion: "13.6.0",
  chromium: "1",
  runs: 1,
  targets: ["framework", "other"],
  samples: [
    { target: "framework", page: "home", metric: "lcp", value: framework, run: 1 },
    { target: "other", page: "home", metric: "lcp", value: other, run: 1 },
    { target: "framework", page: "interaction", metric: "changeNavigation", value: "same document", run: 1 },
    { target: "other", page: "interaction", metric: "changeNavigation", value: "new document", run: 1 },
  ],
});

test("the summary pools the jobs, and marks the best median of each row", () => {
  const text = summarize([result("1", 900, 1500), result("2", 1100, 1700), result("3", 1000, 1600)]);
  assert.match(text, /3 jobs × 1 runs = 3 samples/);
  assert.match(text, /\| Largest Contentful Paint \(ms\) \| \*\*1000 \(950–1050\)\*\* \| 1600 \(1550–1650\) \|/);
  assert.match(text, /\| Page change loads \| same document \(3\/3\) \| new document \(3\/3\) \|/);
});

test("a results file must have the shape that src/run.ts writes", () => {
  assert.equal(isRunResult(result("1", 1, 2)), true);
  assert.equal(isRunResult({ ...result("1", 1, 2), samples: [{ target: "x" }] }), false);
});
