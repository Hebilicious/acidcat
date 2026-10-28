/**
 * The functions that need Node.js. The main entry point, `@acid-cat/core-ts`, works in all runtimes.
 *
 * `serve` serves web request handlers, `(request: Request) => Promise<Response>`, such as the handlers of `mcpHandler`
 * and `httpHandler`, on Node.js, with only `node:http`. The server serves plain HTTP/1.1. For HTTPS, HTTP/2 or
 * middleware, use a library for web handlers.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

/** A web request handler. */
export type WebHandler = (request: Request) => Promise<Response> | Response;

/**
 * Handlers by path prefix, for example `{ "/mcp": mcp, "/api": http }`. A prefix matches its own path and the paths
 * below it: `/api` matches `/api` and `/api/status`, but not `/apis`. The longest prefix that matches gets the request.
 * The prefix `/` matches all paths. The handler gets the full URL of the request.
 */
export interface Routes {
  readonly [prefix: string]: WebHandler;
}

export interface ServeOptions {
  /** The port. The default is `3000`. With `0`, the system chooses a free port. */
  readonly port?: number | undefined;
  /**
   * The address to listen on. The default is `127.0.0.1`, so that only the same computer can connect. Use `0.0.0.0`
   * or `::` to accept connections from the network.
   */
  readonly hostname?: string | undefined;
}

/** A server that runs. `await using` closes it at the end of its block. */
export interface Served extends AsyncDisposable {
  /** The base URL, for example `http://127.0.0.1:3000`. */
  readonly url: string;
  /** The port that the server listens on. */
  readonly port: number;
  /** Stop accepting connections, and resolve when the open requests are complete. */
  readonly close: () => Promise<void>;
}

/**
 * Serve one handler for all paths, or handlers by path prefix. The promise resolves when the server listens, and rejects
 * when it cannot listen, for example when the port is in use.
 *
 * - The signal of each request aborts when the client closes the connection before the response is complete. A handler
 *   that follows the signal then cancels its work.
 * - A path that no prefix matches gets `404`. A handler that throws or rejects gets `500`. A request that is not valid
 *   HTTP for a URL gets `400`.
 * - The body of a request is a stream that reads from the connection only when the handler reads it.
 */
export function serve(handler: WebHandler | Routes, options: ServeOptions = {}): Promise<Served> {
  const route = router(handler);
  const hostname = options.hostname ?? "127.0.0.1";
  const server = createServer((incoming, outgoing) => {
    void answer(incoming, outgoing, route);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3000, hostname, () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const close = () => new Promise<void>((done) => server.close(() => done()));
      resolve({ url: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`, port, close, [Symbol.asyncDispose]: close });
    });
  });
}

/** The handler of a path, or `undefined` when no prefix matches. */
function router(handler: WebHandler | Routes): (path: string) => WebHandler | undefined {
  if (typeof handler === "function") return () => handler;
  const prefixes = Object.keys(handler).sort((a, b) => b.length - a.length);
  const matches = (path: string, prefix: string) =>
    prefix.endsWith("/") ? path.startsWith(prefix) || path === prefix.slice(0, -1) : path === prefix || path.startsWith(`${prefix}/`);
  return (path) => {
    const prefix = prefixes.find((candidate) => matches(path, candidate));
    return prefix === undefined ? undefined : handler[prefix];
  };
}

async function answer(incoming: IncomingMessage, outgoing: ServerResponse, route: (path: string) => WebHandler | undefined): Promise<void> {
  const abort = new AbortController();
  outgoing.on("close", () => {
    if (!outgoing.writableFinished) abort.abort();
  });
  let request: Request;
  try {
    request = requestOf(incoming, abort.signal);
  } catch {
    outgoing.writeHead(400).end();
    return;
  }
  const handler = route(new URL(request.url).pathname);
  if (handler === undefined) {
    outgoing.writeHead(404).end();
    return;
  }
  try {
    await send(await handler(request), outgoing);
  } catch {
    // Before the headers, the client gets a 500. After them, the response is cut, so that the client sees that it failed.
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(500).end();
  }
}

/** The web request of an incoming request. It throws when the request has no valid URL. */
function requestOf(incoming: IncomingMessage, signal: AbortSignal): Request {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = incoming.method ?? "GET";
  const init: RequestInit = { method, headers, signal };
  if (method === "GET" || method === "HEAD") return new Request(url, init);
  // A request with a stream body must have `duplex: "half"`. The type RequestInit of the DOM library does not declare it.
  const withBody: RequestInit & { readonly duplex: "half" } = { ...init, body: bodyOf(incoming), duplex: "half" };
  return new Request(url, withBody);
}

/**
 * Write a web response. The body waits when the connection is full. When the client closes the connection, the body
 * is cancelled.
 */
async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) if (name !== "set-cookie") headers[name] = value;
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  outgoing.writeHead(response.status, response.statusText, headers);
  if (response.body === null) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  outgoing.on("close", cancel);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (outgoing.destroyed) return;
      if (!outgoing.write(chunk.value)) await drained(outgoing);
    }
    outgoing.end();
  } finally {
    outgoing.off("close", cancel);
  }
}

/** Resolve when the connection can take more data, or when it closes. */
function drained(outgoing: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      outgoing.off("drain", done);
      outgoing.off("close", done);
      resolve();
    };
    outgoing.on("drain", done);
    outgoing.on("close", done);
  });
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
