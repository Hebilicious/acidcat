import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import { cancellations } from "../src/conform/properties.ts";
import { checkWebMcp } from "../src/conform/webmcp.ts";
import type { WebMcpDriver } from "../src/conform/webmcp.ts";

test("each run of the cancellation property cancels at least one call and keeps at least one", () => {
  for (const run of fc.sample(cancellations, 2_000)) {
    assert.ok(run.includes(true) && run.includes(false), JSON.stringify(run));
    assert.ok(run.length >= 2 && run.length <= 5, JSON.stringify(run));
  }
});

test("a page whose tools change without end fails its checks at the guard of each wait", async () => {
  let version = 0;
  const churning: WebMcpDriver = {
    tools: async () => [{ name: `churn.${version}`, description: "", inputSchema: {} }],
    version: async () => version,
    changed: async () => ++version,
    call: async () => ({ missing: true }),
    start: async () => 1,
    cancel: async () => undefined,
    result: async () => ({ missing: true }),
    close: async () => undefined,
  };
  const results = (await checkWebMcp(churning, 300)).results;
  const waits = results.filter((result) => /the tools/.test(result.detail ?? ""));
  assert.equal(waits.length, 2, JSON.stringify(results, null, 2));
  for (const result of waits) assert.match(result.detail ?? "", /did not settle within 300 ms, the guard of acid-cat conform/);
});
