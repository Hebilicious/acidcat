import assert from "node:assert/strict";
import { test } from "node:test";

import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";

import { Checks } from "../src/conform/check.ts";
import { checkCli } from "../src/conform/cli.ts";
import { conform, serve } from "../src/conform/index.ts";
import { cancellations } from "../src/conform/properties.ts";
import { checkWebMcp, createTestHost } from "../src/conform/webmcp.ts";
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

test("an MCP server that never answers fails the connection of the property checks too", async () => {
  const served = await serve({
    "/mcp": (request) => new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason))),
  });
  try {
    const results = await conform({ mcp: `${served.url}/mcp`, guard: 300 });
    const connection = results.find((result) => result.binding === "mcp properties");
    assert.ok(connection !== undefined && !connection.passed, JSON.stringify(results, null, 2));
    assert.match(connection.detail ?? "", /did not settle within 300 ms/);
  } finally {
    await served.close();
  }
});

test("an installation that ends after the guard is removed", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let removed!: () => void;
  const removal = new Promise<void>((resolve) => (removed = resolve));
  const results = await conform({
    guard: 200,
    webmcp: async () => {
      await gate;
      return removed;
    },
  });
  assert.deepEqual(
    results.map((result) => `${result.name}: ${result.passed}`),
    ["the implementation installs its tools: false"],
  );
  open();
  await removal;
});

test("a wait for a change of the tools stops at a signal that aborted before, and leaves no listener on its signal", async () => {
  const host = createTestHost();
  const aborted = new AbortController();
  const reason = new Error("The check ended before.");
  aborted.abort(reason);
  await assert.rejects(host.changed(0, aborted.signal), (error) => error === reason);

  const waiting = new AbortController();
  const changed = host.changed(0, waiting.signal);
  host.modelContext.registerTool({ name: "probe.tool" }, { signal: new AbortController().signal });
  assert.equal(await changed, 1);
  assert.equal(getEventListeners(waiting.signal, "abort").length, 0);
});

test("a wait for a change of the tools stops at its signal", async () => {
  const host = createTestHost();
  const controller = new AbortController();
  const reason = new Error("The check ended.");
  const waiting = host.changed(0, controller.signal);
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
});

/** A page whose tool calls the test controls: each call starts when `starts` opens. */
function lateDriver() {
  let open!: () => void;
  const starts = new Promise<void>((resolve) => (open = resolve));
  const cancelled: number[] = [];
  let calls = 0;
  let allCancelled = () => undefined as void;
  const driver: WebMcpDriver = {
    tools: async () => [],
    version: async () => 0,
    changed: () => new Promise(() => undefined),
    call: async () => ({ missing: true }),
    start: async () => {
      await starts;
      return ++calls;
    },
    cancel: async (call) => {
      cancelled.push(call);
      if (cancelled.length === calls) allCancelled();
    },
    result: async () => ({ missing: true }),
    close: async () => undefined,
  };
  /** Resolves when each call that started is cancelled. */
  const eachCancelled = () => new Promise<void>((resolve) => (allCancelled = resolve));
  return { driver, open, cancelled, eachCancelled, started: () => calls };
}

test("a tool call that starts after the deadline of its check is cancelled", async () => {
  const late = lateDriver();
  await checkWebMcp(late.driver, 100);
  const cancelled = late.eachCancelled();
  late.open();
  await cancelled;
  assert.ok(late.started() > 0);
  assert.deepEqual([...late.cancelled].sort(), Array.from({ length: late.started() }, (_, index) => index + 1));
});

test("fixture.held must succeed: a failure of it fails the check, and does not count as no calls that hold", async () => {
  let key: string | undefined;
  let cancelled = false;
  const driver: WebMcpDriver = {
    tools: async () => [],
    version: async () => 0,
    changed: () => new Promise(() => undefined),
    call: async () => ({ missing: true }),
    start: async (name, input) => {
      if (name === "fixture.hold") key = (input as { key: string }).key;
      return name === "fixture.hold" ? 1 : 2;
    },
    cancel: async () => void (cancelled = true),
    result: async (call) => {
      if (call === 1) return { rejected: { name: "AbortError", kind: "cancelled", message: "The call was cancelled." } };
      return cancelled ? { resolved: { ok: false, error: { _tag: "Broken" } } } : { resolved: { ok: true, value: { keys: [key] } } };
    },
    close: async () => undefined,
  };
  const results = (await checkWebMcp(driver, 500)).results;
  const cancellation = results.find((result) => result.name === "the signal of the host cancels a call, as an AbortError");
  assert.equal(cancellation?.passed, false, JSON.stringify(cancellation));
  assert.match(cancellation?.detail ?? "", /fixture.held gave/);
});

test("no process of the command line outlives its check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acid-cat-guard-"));
  try {
    // A command line that never exits, records its process id, ignores SIGINT, and creates the marker of a hold.
    const script = join(directory, "stuck.mjs");
    await writeFile(
      script,
      `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(directory, "pids"))}, process.pid + "\\n");
process.on("SIGINT", () => undefined);
const marker = process.argv.indexOf("--marker");
if (marker > 0) writeFileSync(process.argv[marker + 1], "");
setInterval(() => undefined, 1000);
`,
    );
    const checks = await checkCli([process.execPath, script], 300);
    assert.ok(checks.results.every((result) => !result.passed));
    const pids = (await readFile(join(directory, "pids"), "utf-8")).trim().split("\n").map(Number);
    assert.equal(pids.length, checks.results.length);
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    assert.deepEqual(alive, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a check whose work does not stop when it is cancelled says so", async () => {
  const checks = new Checks("probe", 100);
  await checks.run("a check that never ends", "spec/conformance.md", () => new Promise<void>(() => undefined));
  const [result] = checks.results;
  assert.equal(result?.passed, false);
  assert.match(result?.detail ?? "", /did not settle within 100 ms/);
  assert.match(result?.detail ?? "", /the work of the check did not stop within 100 ms after it was cancelled/);
});
