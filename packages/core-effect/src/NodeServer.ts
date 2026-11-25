import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ListenOptions } from "node:net";

import { Data, Effect, Exit, FiberSet, Layer } from "effect";
import type { Scope } from "effect";

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

export interface Address {
  /** The base URL, for example `http://127.0.0.1:3000`. */
  readonly url: string;
  readonly port: number;
}

export interface UnixAddress {
  /** The base URL to give with the path of the socket, `http://localhost`. Each request uses it for its path and its `Host` header. */
  readonly url: string;
  readonly path: string;
}

/** The server cannot listen, for example because the port is in use. `cause` is the error of Node.js. */
export class ServeError extends Data.TaggedError("ServeError")<{ readonly cause: unknown }> {}

/**
 * Serve one handler for all paths, or handlers by path prefix, for example `{ "/mcp": mcp, "/api": http }`. The effect
 * succeeds when the server listens. When the scope closes, the server stops accepting connections, and the scope waits
 * until the open requests are complete. The server serves plain HTTP/1.1. For HTTPS, HTTP/2 or middleware, use a
 * library for web handlers.
 *
 * - The signal of each request aborts when the client closes the connection before the response is complete. The
 *   handlers of the core then cancel the call.
 * - A path that no prefix matches gets `404`. A handler that throws or rejects gets `500`. A request that is not valid
 *   HTTP for a URL gets `400`.
 * - The body of a request is a stream that reads from the connection only when the handler reads it.
 * - The headers of a response with a body go to the client before the first chunk of the body, so that a client of a
 *   stream, for example of server-sent events, gets the status before the first message.
 *
 * With `path`, the server listens on a Unix socket. Give its clients the layer `NodeHttpClient.layerUndiciOptions({
 * connect: { socketPath } })` of `@effect/platform-node`.
 */
export function serve(handler: WebHandler | Routes, options: UnixServeOptions): Effect.Effect<UnixAddress, ServeError, Scope.Scope>;
export function serve(handler: WebHandler | Routes, options?: ServeOptions): Effect.Effect<Address, ServeError, Scope.Scope>;
export function serve(handler: WebHandler | Routes, options?: ServeOptions | UnixServeOptions): Effect.Effect<Address | UnixAddress, ServeError, Scope.Scope>;
export function serve(handler: WebHandler | Routes, options: ServeOptions | UnixServeOptions = {}): Effect.Effect<Address | UnixAddress, ServeError, Scope.Scope> {
  return serveOn(handler, options);
}

const serveOn = Effect.fnUntraced(function* (handler: WebHandler | Routes, options: ServeOptions | UnixServeOptions) {
  const route = router(handler);
  // The scope closes the server first, which waits for the open requests. Then the set interrupts the fibers that are left.
  const run = yield* FiberSet.makeRuntime();
  // With `keepAliveTimeout: 0`, Node.js closes no idle connection and sends no `Keep-Alive` header, so a client never
  // sends a request on a connection at the moment when the server closes it. `close` ends only the connections that are
  // idle at that moment, so each other connection ends when both its request and its response are complete.
  const server = createServer({ keepAliveTimeout: 0 }, (incoming, outgoing) => {
    const closeIfIdle = () => server.listening || server.closeIdleConnections();
    incoming.on("end", closeIfIdle);
    outgoing.on("finish", closeIfIdle);
    run(answer(incoming, outgoing, route));
  });
  const listenOn = "path" in options ? { path: options.path } : { port: options.port ?? 3000, host: options.hostname ?? "127.0.0.1" };
  yield* Effect.acquireRelease(listen(server, listenOn), () => close(server));
  if ("path" in listenOn) {
    const address: UnixAddress = { url: "http://localhost", path: listenOn.path };
    return address;
  }
  const { host } = listenOn;
  const listened = server.address();
  const port = typeof listened === "object" && listened !== null ? listened.port : 0;
  const address: Address = { url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`, port };
  return address;
});

/**
 * A layer that serves the handlers while it is built. Run it as a program with `Layer.launch`, which serves until the
 * program is interrupted. See `serve` for the options.
 */
export const layer = (handler: WebHandler | Routes, options: ServeOptions | UnixServeOptions = {}): Layer.Layer<never, ServeError> =>
  Layer.effectDiscard(serveOn(handler, options));

const listen = (server: Server, options: ListenOptions) =>
  Effect.callback<void, ServeError>((resume) => {
    const failed = (cause: unknown) => resume(Effect.fail(new ServeError({ cause })));
    server.once("error", failed);
    server.listen(options, () => {
      server.off("error", failed);
      resume(Effect.void);
    });
  });

const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

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

class BadRequest extends Data.TaggedError("BadRequest")<{ readonly cause: unknown }> {}

class HandlerError extends Data.TaggedError("HandlerError")<{ readonly cause: unknown }> {}

const answer = (incoming: IncomingMessage, outgoing: ServerResponse, route: (path: string) => WebHandler | undefined) =>
  Effect.gen(function* () {
    const abort = new AbortController();
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) abort.abort();
    });
    const request = yield* Effect.try({ try: () => requestOf(incoming, abort.signal), catch: (cause) => new BadRequest({ cause }) });
    const handler = route(new URL(request.url).pathname);
    if (handler === undefined) {
      outgoing.writeHead(404).end();
      return;
    }
    yield* Effect.tryPromise({ try: async () => handler(request), catch: (cause) => new HandlerError({ cause }) }).pipe(
      Effect.flatMap((response) => send(response, outgoing)),
      Effect.onInterrupt(() => Effect.sync(() => abort.abort())),
    );
  }).pipe(
    Effect.catchTag("BadRequest", () => Effect.sync(() => outgoing.writeHead(400).end())),
    Effect.catchTag("HandlerError", () =>
      // Before the headers, the client gets a 500. After them, the response is cut, so that the client sees that it failed.
      Effect.sync(() => (outgoing.headersSent ? outgoing.destroy() : outgoing.writeHead(500).end())),
    ),
  );

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

const send = (response: Response, outgoing: ServerResponse) =>
  Effect.gen(function* () {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of response.headers) if (name !== "set-cookie") headers[name] = value;
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) headers["set-cookie"] = cookies;
    yield* Effect.try({
      try: () => outgoing.writeHead(response.status, response.statusText, headers),
      catch: (cause) => new HandlerError({ cause }),
    });
    const body = response.body;
    if (body === null) {
      outgoing.end();
      return;
    }
    // Send the headers now. The first chunk of a stream, for example of server-sent events, can come much later.
    outgoing.flushHeaders();
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const reader = body.getReader();
        const cancel = () => void reader.cancel().catch(() => undefined);
        outgoing.on("close", cancel);
        return { reader, cancel };
      }),
      ({ reader }) => write(reader, outgoing),
      ({ cancel }, exit) =>
        Effect.sync(() => {
          outgoing.off("close", cancel);
          if (Exit.isFailure(exit)) cancel();
        }),
    );
  });

const write = (reader: ReadableStreamDefaultReader<Uint8Array>, outgoing: ServerResponse) =>
  Effect.gen(function* () {
    for (;;) {
      const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: (cause) => new HandlerError({ cause }) });
      if (chunk.done) break;
      if (outgoing.destroyed) return;
      if (!outgoing.write(chunk.value)) yield* drained(outgoing);
    }
    outgoing.end();
  });

const drained = (outgoing: ServerResponse) =>
  Effect.callback<void>((resume) => {
    const done = () => {
      outgoing.off("drain", done);
      outgoing.off("close", done);
      resume(Effect.void);
    };
    outgoing.on("drain", done);
    outgoing.on("close", done);
    return Effect.sync(() => {
      outgoing.off("drain", done);
      outgoing.off("close", done);
    });
  });

/** A request that the handler does not read stays unread, so that Node.js discards it after the response. */
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
