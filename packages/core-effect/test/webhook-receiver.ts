/**
 * A webhook endpoint for the tests: an HTTPS server on the local computer, with a certificate that is made for the test
 * and removed after it. It keeps each request that it gets, and answers as the test tells it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isJsonObject } from "@acid-cat/spec-ts";

/** One request that the endpoint got. */
export interface Received {
  readonly path: string;
  readonly headers: { readonly [name: string]: string };
  readonly body: string;
  readonly json: unknown;
}

/** The answer to a request. */
export interface Reply {
  readonly status: number;
  readonly body?: string;
}

/** A function that answers a request. */
export type Responder = (received: Received) => Reply | Promise<Reply>;

/** Answer a verification with its challenge, and each other request with 200. */
export const agree: Responder = (received) => {
  const challenge = isJsonObject(received.json) && received.json.type === "verification" ? received.json.challenge : undefined;
  return typeof challenge === "string" ? { status: 200, body: JSON.stringify({ challenge }) } : { status: 200 };
};

/** A self-signed certificate for `localhost` and `127.0.0.1`, made with OpenSSL in a temporary directory. */
function certificate(): { readonly key: string; readonly cert: string } {
  const directory = mkdtempSync(join(tmpdir(), "acid-cat-webhook-"));
  try {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
      { stdio: "ignore" },
    );
    return { key: readFileSync(key, "utf-8"), cert: readFileSync(cert, "utf-8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function startReceiver() {
  const { key, cert } = certificate();
  const received: Received[] = [];
  const waiters: Array<() => void> = [];
  let responder: Responder = agree;
  const server = createServer({ key, cert }, (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers[name] = value;
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      const request: Received = { path: incoming.url ?? "/", headers, body, json };
      received.push(request);
      waiters.splice(0).forEach((wake) => wake());
      void Promise.resolve(responder(request)).then((reply) => outgoing.writeHead(reply.status, { "Content-Type": "application/json" }).end(reply.body ?? ""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    cert,
    port,
    received,
    /** The URL of a path on the endpoint, with the host name `localhost`. */
    url: (path: string) => `https://localhost:${port}${path}`,
    /** Answer the next requests with this function. */
    respond: (next: Responder) => void (responder = next),
    /** Wait until the endpoint has got at least `count` requests, and give them. */
    async count(count: number, timeoutMs = 5000): Promise<readonly Received[]> {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) throw new Error(`The endpoint got ${received.length} requests, not ${count}.`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
      return received.slice(0, count);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
