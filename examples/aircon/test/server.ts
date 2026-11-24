import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { Readable } from "node:stream";
import type { TestContext } from "node:test";

export async function startServer(context: TestContext, command: string, args: readonly string[]): Promise<string> {
  const server = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  return (await firstLine(server, context)).trim();
}

export function firstLine(child: ChildProcessByStdio<null, Readable, Readable | null>, context: TestContext): Promise<string> {
  context.after(() => child.kill());
  return new Promise((resolve, reject) => {
    let text = "";
    child.on("error", reject);
    child.on("close", (code) => reject(new Error(`The process ended with the code ${code} before it wrote a line: ${text}`)));
    child.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")));
    });
  });
}

/**
 * A proxy in front of the server at `url`, which counts the subscriptions that have started. The HTTP surface answers a
 * subscription with the status 200 only when it has started (spec/surfaces/http.md).
 */
export async function subscriptionProxy(context: TestContext, url: string): Promise<{ readonly url: string; readonly started: (count: number) => Promise<void> }> {
  const target = new URL(url);
  let started = 0;
  const waiting = new Set<() => void>();
  const proxy = createServer((incoming, outgoing) => {
    const forwarded = request(
      { host: target.hostname, port: target.port, method: incoming.method, path: incoming.url, headers: { ...incoming.headers, host: target.host } },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        outgoing.flushHeaders();
        if (incoming.method === "POST" && incoming.url?.includes("/events/") === true && answer.statusCode === 200) {
          started += 1;
          waiting.forEach((check) => check());
        }
        answer.pipe(outgoing);
        answer.on("error", () => outgoing.destroy());
      },
    );
    forwarded.on("error", () => outgoing.destroy());
    outgoing.on("close", () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  context.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("The proxy has no port.");
  return {
    url: `http://127.0.0.1:${address.port}${target.pathname}`,
    started: (count) =>
      new Promise((resolve) => {
        const check = () => {
          if (started < count) return;
          waiting.delete(check);
          resolve();
        };
        waiting.add(check);
        check();
      }),
  };
}
