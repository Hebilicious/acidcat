/**
 * The HTTP binding (spec/bindings/http.md): JSON through HTTP, and the occurrences of events as server-sent events.
 */
import { callFailure, HTTP_STATUS, httpEventMessage, httpStatus, isCallFailure, KEEPALIVE_MS, readBounded, screenRequest } from "@acid-cat/spec-ts";
import type { Rejection } from "@acid-cat/spec-ts";
import { Effect, Exit, Scope, Stream } from "effect";
import type { Layer } from "effect";

import type * as App from "./App.ts";
import { cancelOnAbort } from "./internal/cancel.ts";
import { withHeartbeat } from "./internal/idle.ts";
import { answerWith, closeUnlessStreaming, eventStream } from "./internal/web.ts";
import type { Streaming } from "./internal/web.ts";
import * as Session from "./Session.ts";

export interface Options {
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  /** The target that the API serves. The default is `"api"`. */
  readonly target?: string | undefined;
  /** The path before `/capabilities`, `/events` and `/catalog`, for example `"/api"`. The default is `""`. */
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
  /**
   * The time in milliseconds with no message on a stream of server-sent events after which the binding sends a comment
   * line as a keepalive. The default is 15 000.
   */
  readonly keepaliveMs?: number | undefined;
  /** The number of occurrences of one subscription that the session keeps for a slow client. See `Session.Options`. */
  readonly eventBuffer?: number | undefined;
}

/**
 * A web request handler for the API. Each request has its own session. `layer` gives the services that the
 * capabilities and the events need. `options.services` tells when the handler builds them. The session of a
 * subscription, and its services with `"per-request"`, stay open until the stream of server-sent events ends.
 */
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Options) {
  const { answer } = answerWith(layer, options.services);
  return async (request: Request): Promise<Response> => {
    const admitted = await admit(request, options);
    if (admitted instanceof Response) return admitted;
    return answer((scope) => respond(app, request, admitted.text, options, scope));
  };
}

/**
 * Answer one API request with a new session. The request is screened and its body is bounded, as in `toWebHandler`.
 * A host that builds the services itself provides them to this Effect. The services must stay open until the stream
 * of a subscription ends.
 */
export const handle = <R>(app: App.App<R>, request: Request, options: Options): Effect.Effect<Response, never, R> =>
  Effect.flatMap(
    Effect.promise(() => admit(request, options)),
    (admitted) =>
      admitted instanceof Response ? Effect.succeed(admitted) : Effect.flatMap(Scope.make(), (scope) => respond(app, request, admitted.text, options, scope)),
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

/**
 * Answer one API request that passed the screening, with a new session in `scope`. `body` is the body of the request.
 * The scope closes when the answer is ready, or, for a stream of server-sent events, when the stream ends.
 */
const respond = <R>(app: App.App<R>, request: Request, body: string, options: Options, scope: Scope.Closeable): Effect.Effect<Response, never, R> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const path = url.pathname.slice((options.base ?? "").length);
    const session = yield* Session.make(app, { target: options.target ?? "api", eventBuffer: options.eventBuffer }).pipe(Scope.provide(scope));

    if (request.method === "GET" && path === "/capabilities") {
      const list = [];
      for (const capability of app.capabilities) {
        if (!capability.audience.includes(session.target)) continue;
        list.push({ id: capability.id, ...(yield* session.availability(capability.id)) });
      }
      return json(200, list);
    }
    if (request.method === "GET" && path === "/events") {
      return json(200, Object.keys(session.view.events ?? {}).map((id) => ({ id })));
    }
    if (request.method === "GET" && path === "/catalog" && options.serveCatalog !== false) {
      return json(200, session.view);
    }
    const route = request.method === "POST" ? routeOf(path) : undefined;
    if (route === undefined) return json(404, callFailure("unknown-capability", "There is no such route."));

    let input: unknown;
    try {
      input = body === "" ? {} : JSON.parse(body);
    } catch {
      return json(422, callFailure("invalid-input", "The request body is not JSON."));
    }
    if (route.kind === "event") return yield* subscribe(session, route.id, input, request, url, options, scope);
    const outcome = yield* session.invoke(route.id, input).pipe(cancelOnAbort(request.signal));
    return json(httpStatus(outcome), isCallFailure(outcome) ? { kind: outcome.kind, message: outcome.message } : outcome);
  }).pipe(closeUnlessStreaming(scope));

/** The capability or the event of a `POST` path. */
function routeOf(path: string): { readonly kind: "capability" | "event"; readonly id: string } | undefined {
  if (path.startsWith("/capabilities/")) return { kind: "capability", id: decodeURIComponent(path.slice("/capabilities/".length)) };
  if (path.startsWith("/events/")) return { kind: "event", id: decodeURIComponent(path.slice("/events/".length)) };
  return undefined;
}

/**
 * Subscribe to an event (spec/bindings/http.md#events). A call failure before the first occurrence is a JSON answer.
 * If not, the answer is a stream of server-sent events. The stream closes `scope` when it ends, and the client closing
 * the stream cancels the subscription.
 */
const subscribe = <R>(
  session: Session.Session<R>,
  id: string,
  input: unknown,
  request: Request,
  url: URL,
  options: Options,
  scope: Scope.Closeable,
): Effect.Effect<Response | Streaming> =>
  Effect.gen(function* () {
    const maxAge = url.searchParams.get("maxAgeMs");
    if (maxAge !== null && !/^(0|[1-9][0-9]*)$/.test(maxAge)) {
      return json(422, callFailure("invalid-input", "maxAgeMs: Expected a nonnegative integer."));
    }
    const cursor = request.headers.get("Last-Event-ID") ?? undefined;
    const started = yield* Effect.result(
      session
        .subscribe(id, input, { ...(cursor === undefined ? {} : { cursor }), ...(maxAge === null ? {} : { maxAgeMs: Number(maxAge) }) })
        .pipe(Scope.provide(scope)),
    );
    if (started._tag === "Failure") {
      const { kind, message } = started.failure;
      return json(HTTP_STATUS[kind], { kind, message });
    }
    const messages = Stream.concat(Stream.map(started.success, httpEventMessage.next), Stream.make(httpEventMessage.complete())).pipe(
      Stream.catchTag("CallFailed", (failure) => Stream.make(httpEventMessage.error(failure))),
    );
    const body = withHeartbeat(messages, options.keepaliveMs ?? KEEPALIVE_MS, httpEventMessage.keepalive).pipe(
      Stream.encodeText,
      Stream.ensuring(Scope.close(scope, Exit.void)),
      Stream.toReadableStreamWith(yield* Effect.context<never>(), { signal: request.signal }),
    );
    return eventStream(body, request, scope);
  });

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
