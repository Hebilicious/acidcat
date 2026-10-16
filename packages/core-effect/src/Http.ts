/**
 * The HTTP binding (spec/bindings/http.md): JSON through HTTP.
 */
import { callFailure, httpStatus, isCallFailure, readBounded, screenRequest } from "@acid-cat/spec-ts";
import type { Rejection } from "@acid-cat/spec-ts";
import { Effect, Layer, ManagedRuntime } from "effect";

import type * as App from "./App.ts";
import { cancelOnAbort } from "./internal/cancel.ts";
import * as Session from "./Session.ts";

export interface Options {
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  /** The target that the API serves. The default is `"api"`. */
  readonly target?: string | undefined;
  /** The path before `/capabilities` and `/catalog`, for example `"/api"`. The default is `""`. */
  readonly base?: string | undefined;
  /** Serve `GET {base}/catalog`. The default is `true`. */
  readonly serveCatalog?: boolean | undefined;
  /** The maximum size of a request body, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
  /**
   * When `toWebHandler` builds the services from `layer`. With `"shared"`, the default, it builds them once, for the
   * first request that passes the screening, and all requests use them. With `"per-request"`, it builds them for each
   * request that passes the screening, and releases them when the response is complete. Use `"per-request"` when a
   * request must not use objects that an earlier request made, for example on Cloudflare Workers, or when a stateful
   * service must not be shared between callers.
   */
  readonly services?: "shared" | "per-request" | undefined;
}

/**
 * A web request handler for the API. Each request has its own session. `layer` gives the services that the
 * capabilities need. `options.services` tells when the handler builds them.
 */
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Options) {
  const runtime = options.services === "per-request" ? undefined : ManagedRuntime.make(layer);
  return async (request: Request): Promise<Response> => {
    const admitted = await admit(request, options);
    if (admitted instanceof Response) return admitted;
    const answer = respond(app, request, admitted.text, options);
    return runtime === undefined ? Effect.runPromise(Effect.provide(answer, layer)) : runtime.runPromise(answer);
  };
}

/**
 * Answer one API request with a new session. The request is screened and its body is bounded, as in `toWebHandler`.
 * A host that builds the services itself provides them to this Effect.
 */
export const handle = <R>(app: App.App<R>, request: Request, options: Options): Effect.Effect<Response, never, R> =>
  Effect.flatMap(
    Effect.promise(() => admit(request, options)),
    (admitted) => (admitted instanceof Response ? Effect.succeed(admitted) : respond(app, request, admitted.text, options)),
  );

/**
 * Screen a request and read its body (spec/bindings/http.md). The result is the rejection, or the body that was read.
 */
async function admit(request: Request, options: Options): Promise<Response | { readonly text: string }> {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  const screened = screenRequest(request, {
    methods: ["GET", "POST"],
    allowedOrigins: options.allowedOrigins,
    mediaType: "application/json",
    maximumBytes,
  });
  if (screened !== undefined) return rejection(screened);
  const body = await readBounded(request, maximumBytes);
  return "rejection" in body ? rejection(body.rejection) : body;
}

/** Answer one API request that passed the screening, with a new session. `body` is the body of the request. */
const respond = <R>(app: App.App<R>, request: Request, body: string, options: Options): Effect.Effect<Response, never, R> =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname.slice((options.base ?? "").length);
    const session = yield* Session.make(app, { target: options.target ?? "api" });

    if (request.method === "GET" && path === "/capabilities") {
      const list = [];
      for (const id of Object.keys(session.view.capabilities)) {
        list.push({ id, ...(yield* session.availability(id)) });
      }
      return json(200, list);
    }
    if (request.method === "GET" && path === "/catalog" && options.serveCatalog !== false) {
      return json(200, session.view);
    }
    const id = request.method === "POST" && path.startsWith("/capabilities/") ? path.slice("/capabilities/".length) : undefined;
    if (id === undefined) return json(404, callFailure("unknown-capability", "There is no such route."));

    let input: unknown;
    try {
      input = body === "" ? {} : JSON.parse(body);
    } catch {
      return json(422, callFailure("invalid-input", "The request body is not JSON."));
    }
    const outcome = yield* session.invoke(decodeURIComponent(id), input).pipe(cancelOnAbort(request.signal));
    return json(httpStatus(outcome), isCallFailure(outcome) ? { kind: outcome.kind, message: outcome.message } : outcome);
  }).pipe(Effect.scoped);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const statuses: { readonly [R in Rejection]: number } = {
  method: 405,
  origin: 403,
  "media-type": 415,
  "too-large": 413,
  "not-utf8": 400,
};

function rejection(reason: Rejection): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (reason === "method") headers.set("Allow", "GET, POST");
  return new Response(null, { status: statuses[reason], headers });
}
