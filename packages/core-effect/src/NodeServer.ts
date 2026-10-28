/**
 * Serve web request handlers, such as the handlers of `Mcp.toWebHandler` and `Http.toWebHandler`, on Node.js, with only
 * `node:http`. The server runs while its scope is open, and closes when the scope closes.
 */
import { serve as serveOnNode } from "@acid-cat/spec-ts/node";
import type { Routes, ServeOptions, WebHandler } from "@acid-cat/spec-ts/node";
import { Data, Effect, Layer } from "effect";

export type { Routes, ServeOptions, WebHandler } from "@acid-cat/spec-ts/node";

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
 * `options.port` is `3000` by default, and `0` lets the system choose a free port. `options.hostname` is `127.0.0.1` by
 * default, so that only the same computer can connect. The signal of a request aborts when its client closes the
 * connection, so the handlers of the core then cancel the call. A path that no prefix matches gets `404`, and a handler
 * that rejects gets `500`.
 */
export const serve = (handler: WebHandler | Routes, options: ServeOptions = {}) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => serveOnNode(handler, options), catch: (cause) => new ServeError({ cause }) }),
    (served) => Effect.promise(() => served.close()),
  ).pipe(Effect.map((served): Address => ({ url: served.url, port: served.port })));

/**
 * A layer that serves the handlers while it is built. Run it as a program with `Layer.launch`, which serves until the
 * program is interrupted. See `serve` for the options.
 */
export const layer = (handler: WebHandler | Routes, options: ServeOptions = {}): Layer.Layer<never, ServeError> =>
  Layer.effectDiscard(serve(handler, options));
