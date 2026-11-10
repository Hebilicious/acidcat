/**
 * A webhook receiver for the tests: an HTTPS server on 127.0.0.1, with a certificate that `openssl` makes for each run
 * in a temporary directory. The key never leaves that directory, and the directory is removed when the receiver closes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isJsonObject } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

/** One request that the receiver got. */
export interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly body: JsonObject;
}

/** The answer of the receiver to one request: a status and a body. */
export type Answer = { readonly status: number; readonly body?: string };

/** Make a self-signed certificate for `localhost` and `127.0.0.1`. */
export function testCertificate(): { readonly cert: string; readonly key: string } {
  const directory = mkdtempSync(join(tmpdir(), "acid-cat-webhook-"));
  try {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert,
    ], { stdio: "ignore" });
    return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Start a receiver. By default it answers a verification with its challenge, and each other request with 200.
 * `answer` changes the answer to a request.
 */
export async function startReceiver(certificate: { readonly cert: string; readonly key: string }) {
  const received: Received[] = [];
  let answer: (request: Received) => Answer | undefined = () => undefined;
  const server = createServer({ cert: certificate.cert, key: certificate.key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const parsed: unknown = JSON.parse(text);
      const each: Received = { headers: request.headers, text, body: isJsonObject(parsed) ? parsed : {} };
      received.push(each);
      const chosen = answer(each) ?? (each.body["type"] === "verification" ? { status: 200, body: JSON.stringify({ challenge: each.body["challenge"] }) } : { status: 200 });
      response.writeHead(chosen.status, { "Content-Type": "application/json" }).end(chosen.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    url: `https://127.0.0.1:${port}/hook`,
    received,
    /** The requests that are not verifications. */
    deliveries: () => received.filter((each) => each.body["type"] !== "verification"),
    answer: (choose: (request: Received) => Answer | undefined) => {
      answer = choose;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
