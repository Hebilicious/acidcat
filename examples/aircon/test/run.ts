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
  return runCommand(t, process.execPath, [path, ...args]);
}

export function runCommand(t: Stoppable, command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], ...endsWith(t) });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
