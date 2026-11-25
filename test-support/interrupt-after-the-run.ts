import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { until } from "./until.ts";
import type { Waiter } from "./until.ts";

const HOST = fileURLToPath(new URL("host-after-the-run.ts", import.meta.url));

/** The standard error of a host that the interrupts after the run of the command line do not exit. */
export const HOST_STILL_RUNNING = "returned\ninterrupt 1\ninterrupt 2\nstill running\n";

/**
 * Start a command-line program of a core, with `host-after-the-run.ts`. When its run has ended, give it an interrupt,
 * a second one when the host has counted the first, and end its standard input when the host has counted the second.
 * The result is how the process ended and its standard error.
 */
export async function interruptedAfterTheRun(t: Waiter, args: readonly string[]) {
  const child = spawn(process.execPath, ["--import", HOST, ...args], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.on("error", () => undefined);
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (...exit) => resolve(exit)));
  let ended: [number | null, NodeJS.Signals | null] | undefined;
  void exited.then((exit) => (ended = exit));
  const written = (line: string) => until(t, () => stderr.includes(`${line}\n`) || ended !== undefined, Boolean, { what: `the host to write ${line}` });
  try {
    await written("returned");
    child.kill("SIGINT");
    await written("interrupt 1");
    child.kill("SIGINT");
    await written("interrupt 2");
    child.stdin.end();
    const [code, signal] = await until(t, () => ended, (exit) => exit !== undefined, { next: () => exited, what: "the exit of the process" });
    return { code, signal, stderr };
  } finally {
    child.kill("SIGKILL");
  }
}
