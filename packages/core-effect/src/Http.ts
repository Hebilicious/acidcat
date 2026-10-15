/**
 * The HTTP binding (spec/bindings/http.md): JSON through HTTP.
 */
import { callFailure, httpStatus, isCallFailure, readBounded, screenRequest } from "@acid-cat/spec-ts";
import type { Rejection } from "@acid-cat/spec-ts";
import { Cause, Effect, Layer, ManagedRuntime } from "effect";

import * as App from "./App.ts";
import { answer } from "./internal/answer.ts";
import * as Session from "./Session.ts";
import { logLoadFailure } from "./internal/load.ts";

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
   * When `toWebHandler` builds the services from `layer`. With `"shared"`, the default, it builds them once, and all
   * requests use them. With `"per-request"`, it builds them for each request that passes the screening, and releases
   * them when the response is complete. Use `"per-request"` when a request must not use objects that an earlier request
   * made, for example on Cloudflare Workers, or when a stateful service must not be shared between callers.
   */
  readonly services?: "shared" | "per-request" | undefined;
}

/**
 * A web request handler for the API. Each request has its own session. `layer` gives the services that the
 * capabilities need. `options.services` tells when the handler builds them. The signal of the request cancels its call.
 * A request that is aborted before its response rejects with the reason of its signal, as an aborted `fetch` does.
 */
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Options) {
  if (options.services === "per-request") {
    return (request: Request): Promise<Response> =>
      answer(request, Effect.runPromiseExit(handle(app, request, options, layer), { signal: request.signal }));
  }
  // The runtime builds the services the first time that it runs, so the request is screened before it.
  const runtime = ManagedRuntime.make(layer);
  return async (request: Request): Promise<Response> => {
    const routed = await route(request, options);
    if (routed instanceof Response) return routed;
    return answer(request, runtime.runPromiseExit(respond(app, routed, options), { signal: request.signal }));
  };
}

/**
 * Answer one API request with a new session. The request is screened, its route is found and its body is read before
 * the session opens.
 *
 * With `services`, the services are built for this request only after that, and released when the response is
 * complete, so a request that is rejected builds nothing. With no `services`, a host that builds the services itself
 * provides them to this Effect.
 */
export function handle<R>(app: App.App<R>, request: Request, options: Options): Effect.Effect<Response, never, R>;
export function handle<R, E, RIn>(
  app: App.App<R>,
  request: Request,
  options: Options,
  services: Layer.Layer<R, E, RIn>,
): Effect.Effect<Response, E, RIn>;
export function handle<R, E, RIn>(
  app: App.App<R>,
  request: Request,
  options: Options,
  services?: Layer.Layer<R, E, RIn>,
): Effect.Effect<Response, E, R | RIn> {
  return Effect.flatMap(
    Effect.promise(() => route(request, options)),
    (routed): Effect.Effect<Response, E, R | RIn> => {
      if (routed instanceof Response) return Effect.succeed(routed);
      const answered = respond(app, routed, options);
      return services === undefined ? answered : Effect.provide(answered, services);
    },
  );
}

/** What a request that passed the screening asks for. */
type Route =
  | { readonly kind: "list" }
  | { readonly kind: "catalog" }
  | { readonly kind: "call"; readonly id: string; readonly input: unknown };

/**
 * Screen a request (spec/bindings/http.md), find its route, and read the body of a call. The result is the route, or the
 * response for a request that is rejected or that has no route.
 */
async function route(request: Request, options: Options): Promise<Route | Response> {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  const screened = screenRequest(request, {
    methods: ["GET", "POST"],
    allowedOrigins: options.allowedOrigins,
    mediaType: "application/json",
    maximumBytes,
  });
  if (screened !== undefined) return rejection(screened);

  const path = new URL(request.url).pathname.slice((options.base ?? "").length);
  if (request.method === "GET" && path === "/capabilities") return { kind: "list" };
  if (request.method === "GET" && path === "/catalog" && options.serveCatalog !== false) return { kind: "catalog" };
  const id = request.method === "POST" && path.startsWith("/capabilities/") ? path.slice("/capabilities/".length) : undefined;
  if (id === undefined) return json(404, callFailure("unknown-capability", "There is no such route."));

  const body = await readBounded(request, maximumBytes);
  if ("rejection" in body) return rejection(body.rejection);
  try {
    return { kind: "call", id: decodeURIComponent(id), input: body.text === "" ? {} : JSON.parse(body.text) };
  } catch {
    return json(422, callFailure("invalid-input", "The request body is not JSON."));
  }
}

/** Answer one API request that has a route, with a new session. */
const respond = <R>(app: App.App<R>, routed: Route, options: Options): Effect.Effect<Response, never, R> =>
  Effect.gen(function* () {
    const session = yield* Session.make(app, { target: options.target ?? "api" });
    switch (routed.kind) {
      case "list": {
        const list = [];
        for (const id of session.capabilities.keys()) list.push({ id, ...(yield* session.availability(id)) });
        return json(200, list);
      }
      case "catalog": {
        // The view needs the schemas of the capabilities of the target. One that does not load is `internal`.
        const loaded = yield* Effect.exit(App.load(app, { target: session.target }));
        if (loaded._tag === "Failure") {
          yield* logLoadFailure(loaded.cause);
          return json(500, callFailure("internal", "A capability did not load."));
        }
        return json(200, session.view);
      }
      case "call": {
        const outcome = yield* session.invoke(routed.id, routed.input);
        return json(httpStatus(outcome), isCallFailure(outcome) ? { kind: outcome.kind, message: outcome.message } : outcome);
      }
    }
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
