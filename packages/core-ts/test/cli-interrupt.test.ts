import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { INTERRUPT_GRACE_MS } from "@acid-cat/spec-ts";

import { bundledProgram } from "./bundled-program.ts";
import { until } from "../../../test-support/until.ts";
import type { Waiter } from "../../../test-support/until.ts";

const PROBE = fileURLToPath(new URL("interrupt-probe.ts", import.meta.url));

const PROGRAMS = {
  call: { program: "test/fixture-cli-ignoring-cancellation.ts", args: ["fixture", "hold", "--key", "k"], stderr: `${JSON.stringify({ kind: "cancelled", message: "The call was cancelled." })}\n` },
  watch: { program: "test/fixture-cli-watch-ignoring-cancellation.ts", args: ["watch", "fixture.watch", "--key", "k"], stderr: "" },
} as const;

async function interrupted(t: Waiter, kind: keyof typeof PROGRAMS, interrupts: 1 | 2) {
  const directory = mkdtempSync(join(tmpdir(), "core-ts-interrupt-"));
  const marker = join(directory, "running");
  const record = join(directory, "exit");
  const { program, args } = PROGRAMS[kind];
  const child = spawn(process.execPath, ["--import", PROBE, bundledProgram(program), ...args, "--marker", marker], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, INTERRUPT_PROBE_RECORD: record, ...(interrupts === 2 ? { INTERRUPT_PROBE_HOLD: marker } : {}) },
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (...exit) => resolve(exit)));
  let ended: [number | null, NodeJS.Signals | null] | undefined;
  void exited.then((exit) => (ended = exit));
  const waitFor = async (path: string, state: string) => {
    await until(t, () => existsSync(path) || ended !== undefined, Boolean, { what: `the marker file when it ${state}` });
    if (!existsSync(path)) throw new Error(`The ${kind} exited before it wrote its marker file when it ${state}. ${stderr}`);
  };
  try {
    await waitFor(marker, "started");
    let interruptedAt = Date.now();
    child.kill("SIGINT");
    if (interrupts === 2) {
      await waitFor(`${marker}.received`, "received the first interrupt");
      interruptedAt = Date.now();
      child.kill("SIGINT");
      writeFileSync(`${marker}.go`, "");
    }
    const [code, signal] = await until(t, () => ended, (exit) => exit !== undefined, { next: () => exited, what: "the exit of the process" });
    const exit = existsSync(record) ? readFileSync(record, "utf-8") : undefined;
    return { code, signal, stderr, exit, elapsed: Date.now() - interruptedAt };
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const kind of ["call", "watch"] as const) {
  test(`in a process, a ${kind} that ignores the interrupt exits with 130 after the grace period, or at once after a second interrupt`, async (t) => {
    const [once, twice] = await Promise.all([interrupted(t, kind, 1), interrupted(t, kind, 2)]);
    const exit = { code: 130, signal: null, stderr: PROGRAMS[kind].stderr, elapsed: undefined };
    assert.deepEqual({ ...once, elapsed: undefined }, { ...exit, exit: "exit after interrupt 1" });
    assert.ok(once.elapsed >= INTERRUPT_GRACE_MS, `exited ${once.elapsed} ms after the interrupt, before the grace period`);
    assert.deepEqual({ ...twice, elapsed: undefined }, { ...exit, exit: "exit during interrupt 2" });
  });
}
