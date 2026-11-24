import assert from "node:assert/strict";
import { test } from "node:test";
import { gearPath, polar } from "../src/lib/geometry.ts";

test("polar puts 0 degrees straight up", () => {
  assert.deepEqual(polar(100, 100, 50, 0), { x: 100, y: 50 });
  assert.deepEqual(polar(100, 100, 50, 90), { x: 150, y: 100 });
});

test("a gear has one arc for each tooth and a closed hole", () => {
  const path = gearPath({ cx: 0, cy: 0, teeth: 12, outer: 40, root: 34, hole: 8 });
  assert.equal(path.match(/A34 34/g)?.length, 12);
  assert.equal(path.match(/A8 8/g)?.length, 2);
  assert.equal(path.match(/Z/g)?.length, 2);
});
