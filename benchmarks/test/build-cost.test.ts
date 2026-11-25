import assert from "node:assert/strict";
import { test } from "node:test";
import { costTable, isCostSample } from "../src/build-cost.ts";

test("the table of the build cost pools the runners, and gives the ratio of the last build to the first", () => {
  const samples = [
    { build: "main", measure: "site build (s)", value: 10 },
    { build: "main", measure: "site build (s)", value: 12 },
    { build: "main", measure: "site build (s)", value: 14 },
    { build: "head", measure: "site build (s)", value: 6 },
    { build: "head", measure: "site build (s)", value: 6 },
    { build: "head", measure: "site build (s)", value: 9 },
  ];
  assert.ok(samples.every((sample) => isCostSample(sample)));
  assert.equal(isCostSample({ build: "main", measure: "site build (s)", value: "10" }), false);
  const [header, , row] = costTable(samples).split("\n");
  assert.equal(header, "| Measure | main | head | head ÷ main |");
  assert.equal(row, "| site build (s) | 12.00 (11.00–13.00; 10.00–14.00) | 6.00 (6.00–7.50; 6.00–9.00) | 0.50 |");
});
