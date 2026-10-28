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

export type WebHandler = (request: Request) => Promise<Response> | Response;

/** Handlers by path prefix, for example `{ "/mcp": mcp, "/api": http }`. The longest prefix that matches gets the request. */
export interface Routes {
  readonly [prefix: string]: WebHandler;
}

/** Serve one handler for all paths, or handlers by path prefix, on `127.0.0.1` and a free port. */
export function serve(handler: WebHandler | Routes): Promise<Served> {
  const routes: Routes = typeof handler === "function" ? { "/": handler } : handler;
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
  routes: Routes,
): Promise<void> {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "127.0.0.1"}`);
  const prefix = prefixes.find(
    (candidate) => candidate === "/" || url.pathname === candidate || url.pathname.startsWith(`${candidate}/`),
  );
  const handler = prefix === undefined ? undefined : routes[prefix];
  if (handler === undefined) {
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
  const init: RequestInit = { method: incoming.method ?? "GET", headers, signal: abort.signal };
  // A request with a stream body must have `duplex: "half"`. The type RequestInit of the DOM library does not declare it.
  const withBody = (): RequestInit & { readonly duplex: "half" } => ({ ...init, body: bodyOf(incoming), duplex: "half" });
  const request = new Request(url, hasBody ? withBody() : init);
  try {
    const response = await handler(request);
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

/**
 * The body of an incoming request, as a web stream. The stream reads the request only when the handler reads the body,
 * and the request pauses after each chunk until the handler reads again. A request that the handler does not read stays
 * unread, so that Node.js discards it after the response. When the handler cancels the stream, the request discards the
 * rest of its body.
 */
function bodyOf(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  let open = true;
  let reading = false;
  const close = (end: () => void) => {
    if (open) end();
    open = false;
  };
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!reading) {
          reading = true;
          incoming.on("data", (chunk: unknown) => {
            if (!open) return;
            if (!(chunk instanceof Uint8Array)) return close(() => controller.error(new TypeError("a chunk of the request body is not bytes")));
            controller.enqueue(chunk);
            incoming.pause();
          });
          incoming.on("end", () => close(() => controller.close()));
          incoming.on("error", (error) => close(() => controller.error(error)));
        }
        incoming.resume();
      },
      cancel() {
        open = false;
        incoming.resume();
      },
    },
    { highWaterMark: 0 },
  );
}
