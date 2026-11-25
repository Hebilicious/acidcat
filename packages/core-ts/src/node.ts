import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

export { webhookDelivery } from "./webhook.ts";
export type { WebhookOptions } from "./webhook.ts";

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

export interface UnixServeOptions {
  /** The path of a new Unix socket to listen on. Serving fails when a file is at this path. */
  readonly path: string;
}

/** A server that runs. `await using` closes it at the end of its block. */
export interface Served extends AsyncDisposable {
  /** The base URL, for example `http://127.0.0.1:3000`. */
  readonly url: string;
  readonly port: number;
  /** Stop accepting connections, and resolve when the open requests are complete. */
  readonly close: () => Promise<void>;
}

/** A server that runs on a Unix socket. `await using` closes it at the end of its block. */
export interface UnixServed extends AsyncDisposable {
  /** The base URL to give with the path of the socket, `http://localhost`. Each request uses it for its path and its `Host` header. */
  readonly url: string;
  readonly path: string;
  /** Stop accepting connections, remove the socket file, and resolve when the open requests are complete. */
  readonly close: () => Promise<void>;
}

/**
 * Serve one handler for all paths, or handlers by path prefix. The promise resolves when the server listens, and rejects
 * when it cannot listen, for example when the port is in use. The server serves plain HTTP/1.1. For HTTPS, HTTP/2 or
 * middleware, use a library for web handlers.
 *
 * - The signal of each request aborts when the client closes the connection before the response is complete. A handler
 *   that follows the signal then cancels its work.
 * - A path that no prefix matches gets `404`. A handler that throws or rejects gets `500`. A request that is not valid
 *   HTTP for a URL gets `400`.
 * - The body of a request is a stream that reads from the connection only when the handler reads it.
 *
 * With `path`, the server listens on a Unix socket. Give its clients the fetch of `unixSocketFetch`.
 */
export function serve(handler: WebHandler | Routes, options: UnixServeOptions): Promise<UnixServed>;
export function serve(handler: WebHandler | Routes, options?: ServeOptions): Promise<Served>;
export function serve(handler: WebHandler | Routes, options?: ServeOptions | UnixServeOptions): Promise<Served | UnixServed>;
export function serve(handler: WebHandler | Routes, options: ServeOptions | UnixServeOptions = {}): Promise<Served | UnixServed> {
  const route = router(handler);
  // With `keepAliveTimeout: 0`, Node.js closes no idle connection and sends no `Keep-Alive` header, so a client never
  // sends a request on a connection at the moment when the server closes it. `close` ends only the connections that are
  // idle at that moment, so each other connection ends when both its request and its response are complete.
  const server = createServer({ keepAliveTimeout: 0 }, (incoming, outgoing) => {
    const closeIfIdle = () => server.listening || server.closeIdleConnections();
    incoming.on("end", closeIfIdle);
    outgoing.on("finish", closeIfIdle);
    void answer(incoming, outgoing, route);
  });
  const close = () => new Promise<void>((done) => server.close(() => done()));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const listening = (served: Served | UnixServed) => {
      server.off("error", reject);
      resolve(served);
    };
    if ("path" in options) {
      const { path } = options;
      server.listen(path, () => listening({ url: "http://localhost", path, close, [Symbol.asyncDispose]: close }));
      return;
    }
    const hostname = options.hostname ?? "127.0.0.1";
    server.listen(options.port ?? 3000, hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      listening({ url: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`, port, close, [Symbol.asyncDispose]: close });
    });
  });
}

/**
 * A fetch that sends each request with plain HTTP/1.1 through the Unix socket at `path`. The URL of the request gives
 * its path and its `Host` header. Give it to `httpClient`, for example
 * `httpClient("http://localhost/cli", { fetch: unixSocketFetch("/run/app.sock") })`. A socket that does not exist
 * rejects, as a server that does not answer.
 */
export function unixSocketFetch(path: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        { socketPath: path, method: request.method, path: `${url.pathname}${url.search}`, headers: { ...Object.fromEntries(request.headers), host: url.host }, signal: request.signal },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          const empty = request.method === "HEAD" || [101, 204, 205, 304].includes(status);
          resolve(new Response(empty ? null : bodyOf(incoming, () => incoming.destroy()), { status, statusText: incoming.statusMessage ?? "", headers: headersOf(incoming.rawHeaders) }));
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };
}

function headersOf(raw: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < raw.length; index += 2) headers.append(raw[index] ?? "", raw[index + 1] ?? "");
  return headers;
}

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
  const withBody: RequestInit & { readonly duplex: "half" } = { ...init, body: bodyOf(incoming, () => incoming.resume()), duplex: "half" };
  return new Request(url, withBody);
}

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
  // Send the headers at once, so that the client gets the response before the first chunk, for example a stream of
  // server-sent events that waits for its first event.
  outgoing.flushHeaders();
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

/** Node.js discards an unread request body after its response. */
function bodyOf(incoming: IncomingMessage, cancel: () => void): ReadableStream<Uint8Array> {
  let open = true;
  const close = (end: () => void) => {
    if (open) end();
    open = false;
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        incoming.pause();
        incoming.on("data", (chunk: unknown) => {
          if (!open) return;
          if (!(chunk instanceof Uint8Array)) return close(() => controller.error(new TypeError("a chunk of the body is not bytes")));
          controller.enqueue(chunk);
          incoming.pause();
        });
        incoming.on("end", () => close(() => controller.close()));
        incoming.on("error", (error) => close(() => controller.error(error)));
      },
      pull() {
        incoming.resume();
      },
      cancel() {
        open = false;
        cancel();
      },
    },
    { highWaterMark: 0 },
  );
}
