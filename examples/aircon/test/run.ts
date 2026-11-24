import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { after } from "node:test";

export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const running = new Set<ChildProcess>();

// A process that outlives the test timeout keeps the test file alive, so the file kills what still runs at its end.
after(() => running.forEach((child) => child.kill("SIGKILL")));

/** Kills the process at the end of the test file if it still runs then. */
export function tracked<Child extends ChildProcess>(child: Child): Child {
  running.add(child);
  child.on("close", () => running.delete(child));
  return child;
}

export function run(path: string, ...args: string[]): Promise<Run> {
  const child = tracked(spawn(process.execPath, [path, ...args], { stdio: ["ignore", "pipe", "pipe"] }));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
