import { spawn } from "node:child_process";

export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function run(path: string, ...args: string[]): Promise<Run> {
  return runWith({}, path, ...args);
}

export function runWith(environment: Readonly<Record<string, string>>, path: string, ...args: string[]): Promise<Run> {
  const child = spawn(process.execPath, [path, ...args], { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
