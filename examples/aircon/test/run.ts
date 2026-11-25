import { spawn } from "node:child_process";

export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The part of the context of a `node:test` test that a process uses: the process ends when the test ends. */
export interface Stoppable {
  readonly signal: AbortSignal;
}

/** The options of `spawn` that end the process when the test ends. */
export const endsWith = (t: Stoppable) => ({ signal: t.signal, killSignal: "SIGKILL" }) as const;

export function run(t: Stoppable, path: string, ...args: string[]): Promise<Run> {
  const child = spawn(process.execPath, [path, ...args], { stdio: ["ignore", "pipe", "pipe"], ...endsWith(t) });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
