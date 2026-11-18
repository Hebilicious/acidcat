import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { TestContext } from "node:test";

export async function startServer(context: TestContext, command: string, args: readonly string[]): Promise<string> {
  const server = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  context.after(() => server.kill());
  return await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    let text = "";
    server.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")).trim());
    });
  });
}

export async function changeStatusUntil(url: string, done: () => boolean): Promise<void> {
  for (let turn = 0; !done(); turn++) {
    const response = await fetch(`${url}/capabilities/aircon.fan.set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speed: turn % 2 === 0 ? "low" : "high" }),
    });
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function collect(child: ChildProcessByStdio<null, Readable, Readable>, context: TestContext): () => string {
  context.after(() => child.kill());
  let text = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (text += chunk));
  return () => text;
}

export const firstLine = (text: string): string => text.slice(0, text.indexOf("\n"));
