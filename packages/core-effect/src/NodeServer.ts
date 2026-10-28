/**
 * Serve web request handlers, such as the handlers of `Mcp.toWebHandler` and `Http.toWebHandler`, on Node.js, with only
 * `node:http`. The server runs while its scope is open, and closes when the scope closes.
 *
 * The server serves plain HTTP/1.1. For HTTPS, HTTP/2 or middleware, use a library for web handlers.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { Data, Effect, Exit, FiberSet, Layer } from "effect";

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

/** The address of a server that runs. */
export interface Address {
  /** The base URL, for example `http://127.0.0.1:3000`. */
  readonly url: string;
  /** The port that the server listens on. */
  readonly port: number;
}

/** The server cannot listen, for example because the port is in use. `cause` is the error of Node.js. */
export class ServeError extends Data.TaggedError("ServeError")<{ readonly cause: unknown }> {}

/**
 * Serve one handler for all paths, or handlers by path prefix, for example `{ "/mcp": mcp, "/api": http }`. The effect
 * succeeds when the server listens. When the scope closes, the server stops accepting connections, and the scope waits
 * until the open requests are complete.
 *
 * - The signal of each request aborts when the client closes the connection before the response is complete. The
 *   handlers of the core then cancel the call.
 * - A path that no prefix matches gets `404`. A handler that throws or rejects gets `500`. A request that is not valid
 *   HTTP for a URL gets `400`.
 * - The body of a request is a stream that reads from the connection only when the handler reads it.
 */
export const serve = Effect.fnUntraced(function* (handler: WebHandler | Routes, options: ServeOptions = {}) {
  const route = router(handler);
  const hostname = options.hostname ?? "127.0.0.1";
  // Each request runs in a fiber of this set. The server closes first, and waits for the open requests. Then the set
  // interrupts the fibers that are left.
  const run = yield* FiberSet.makeRuntime();
  const server = createServer((incoming, outgoing) => {
    run(answer(incoming, outgoing, route));
  });
  const port = yield* Effect.acquireRelease(listen(server, options.port ?? 3000, hostname), () => close(server));
  const address: Address = { url: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`, port };
  return address;
});

/**
 * A layer that serves the handlers while it is built. Run it as a program with `Layer.launch`, which serves until the
 * program is interrupted. See `serve` for the options.
 */
export const layer = (handler: WebHandler | Routes, options: ServeOptions = {}): Layer.Layer<never, ServeError> =>
  Layer.effectDiscard(serve(handler, options));

/** Listen, and give the port. */
const listen = (server: Server, port: number, hostname: string) =>
  Effect.callback<number, ServeError>((resume) => {
    const failed = (cause: unknown) => resume(Effect.fail(new ServeError({ cause })));
    server.once("error", failed);
    server.listen(port, hostname, () => {
      server.off("error", failed);
      const address = server.address();
      resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0));
    });
  });

/** Stop accepting connections, and wait until the open requests are complete. */
const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

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

/** The request is not valid HTTP for a URL. */
class BadRequest extends Data.TaggedError("BadRequest")<{ readonly cause: unknown }> {}

/** A handler threw or rejected, or the body of its response failed. */
class HandlerError extends Data.TaggedError("HandlerError")<{ readonly cause: unknown }> {}

/** Answer one request. When the fiber is interrupted, the signal of the request aborts. */
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
 * Write a web response. The body waits when the connection is full. When the client closes the connection, or the
 * fiber is interrupted, the body is cancelled.
 */
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

/** Write the chunks of a body until it ends, or until the connection closes. */
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

/** Wait until the connection can take more data, or until it closes. */
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
