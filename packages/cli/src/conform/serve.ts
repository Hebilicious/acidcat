/**
 * Serve a web request handler, `(request: Request) => Promise<Response>`, on a local port. Implementations use it
 * to run `acid-cat conform` against their bindings in a test.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Served {
  /** The base URL, for example `http://127.0.0.1:40123`. */
  readonly url: string;
  close(): Promise<void>;
}

export type WebHandler = (request: Request) => Promise<Response>;

/** Serve handlers by path prefix, for example `{ "/mcp": mcp, "/api": http }`. */
export function serve(routes: { readonly [prefix: string]: WebHandler }): Promise<Served> {
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  const server = createServer((incoming, outgoing) => {
    void answer(incoming, outgoing, prefixes, routes);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function answer(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  prefixes: readonly string[],
  routes: { readonly [prefix: string]: WebHandler },
): Promise<void> {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "127.0.0.1"}`);
  const prefix = prefixes.find((candidate) => url.pathname === candidate || url.pathname.startsWith(`${candidate}/`));
  if (prefix === undefined) {
    outgoing.writeHead(404).end();
    return;
  }
  const abort = new AbortController();
  outgoing.on("close", () => {
    if (!outgoing.writableFinished) abort.abort();
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  const request = new Request(url, {
    method: incoming.method ?? "GET",
    headers,
    signal: abort.signal,
    ...(hasBody ? { body: incoming as unknown as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
  try {
    const response = await routes[prefix]!(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) {
      outgoing.end();
      return;
    }
    for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}
