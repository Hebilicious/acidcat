import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";

import { INTERRUPT_GRACE_MS } from "@acid-cat/spec-ts";

const DEADLINE_MS = 10_000;

const STATE_DEADLINE_MS = 30_000;

async function interruptedWatch(interrupts: 1 | 2) {
  const directory = mkdtempSync(join(tmpdir(), "core-ts-interrupt-"));
  const marker = join(directory, "watching");
  const fixture = new URL("./fixture-cli-watch-ignoring-cancellation.ts", import.meta.url).pathname;
  const child = spawn(process.execPath, [fixture, "watch", "fixture.watch", "--key", "k", "--marker", marker], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (...exit) => resolve(exit)));
  const waitFor = async (path: string, state: string) => {
    const start = Date.now();
    while (!existsSync(path)) {
      if (Date.now() - start > STATE_DEADLINE_MS) throw new Error(`The subscription did not write its marker file when it ${state}. ${stderr}`);
      await pause(10);
    }
  };
  try {
    await waitFor(marker, "started");
    let interrupted = Date.now();
    child.kill("SIGINT");
    // Unix merges a signal that is still pending with the next one of the same kind.
    if (interrupts === 2) {
      await waitFor(`${marker}.cancelled`, "was cancelled");
      interrupted = Date.now();
      child.kill("SIGINT");
    }
    const ended = await Promise.race([exited, pause(DEADLINE_MS, "running" as const)]);
    const [code, signal] = ended === "running" ? [null, null] : ended;
    return { code, signal, stderr, elapsed: Date.now() - interrupted, running: ended === "running" };
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
}

test("in a process, a subscription that ignores the interrupt exits with 130 after the grace period, or at once after a second interrupt", async () => {
  const [once, twice] = await Promise.all([interruptedWatch(1), interruptedWatch(2)]);
  assert.deepEqual({ ...once, elapsed: undefined }, { code: 130, signal: null, stderr: "", elapsed: undefined, running: false });
  assert.ok(once.elapsed >= INTERRUPT_GRACE_MS, `exited ${once.elapsed} ms after the interrupt, before the grace period`);
  assert.deepEqual({ ...twice, elapsed: undefined }, { code: 130, signal: null, stderr: "", elapsed: undefined, running: false });
  assert.ok(twice.elapsed < INTERRUPT_GRACE_MS, `exited ${twice.elapsed} ms after the second interrupt, not at once`);
});
