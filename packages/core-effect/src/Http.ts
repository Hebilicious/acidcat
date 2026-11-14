/**
 * The HTTP binding (spec/bindings/http.md): JSON through HTTP, and the occurrences of events as server-sent events.
 */
import { callFailure, HTTP_STATUS, httpEventMessage, httpStatus, isCallFailure, KEEPALIVE_MS, readBounded, screenRequest } from "@acid-cat/spec-ts";
import type { CallFailure, Rejection } from "@acid-cat/spec-ts";
import { Effect, Exit, Scope, Stream } from "effect";
import type { Layer } from "effect";

import type * as App from "./App.ts";
import { cancelOnAbort } from "./internal/cancel.ts";
import * as HttpClient from "./internal/httpClient.ts";
import { withHeartbeat } from "./internal/idle.ts";
import type { IncomingRequest } from "./Remote.ts";
import { answerWith, closeUnlessStreaming, eventStream } from "./internal/web.ts";
import type { Streaming } from "./internal/web.ts";
import * as Session from "./Session.ts";

export interface Options {
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  /** The target that the API serves. The default is `"api"`. */
  readonly target?: string | undefined;
  /**
   * The path before `/capabilities`, `/events` and `/catalog`, for example `"/api"`. The default is `""`. A path that is
   * not `base` and does not start with `base` and `/` gets the `404` of an unknown route.
   */
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
   * service must not be shared between callers. With `"per-request"`, the layer can read the head of the request from
   * `Remote.IncomingRequest`, and refuse the request with a `Remote.Refusal`.
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
 * A client of the HTTP binding of an application that runs in another process or on another machine. Give it to the
 * `remote` option of the command line (spec/bindings/cli.md#server).
 */
export type Client = HttpClient.Client;

/** The options of `client`: the headers of each request, and the HTTP client that sends them. */
export type ClientOptions = HttpClient.ClientOptions;

/** A capability that the server lists, with its availability. */
export type Listed = HttpClient.Listed;

/**
 * A client of the HTTP binding at `base`, an `http` or `https` URL, for example `http://pi.local:8080/cli`. It throws an
 * `Error` when `base` is not such a URL, or when a header is not valid. The message of the error does not contain the
 * value of a header.
 *
 * The client gives the call failure `unavailable` when the server does not answer, and `internal` when the server
 * gives an answer that the HTTP binding does not give.
 */
export const client = (base: string, options?: ClientOptions): Client => HttpClient.make(base, options);

/**
 * A web request handler for the API. Each request has its own session. `layer` gives the services that the
 * capabilities and the events need. `options.services` tells when the handler builds them. The session of a
 * subscription, and its services with `"per-request"`, stay open until the stream of server-sent events ends.
 *
 * With `"per-request"`, the layer can read the head of the request from `Remote.IncomingRequest`, for example to
 * find the caller. When the layer fails with a `Remote.Refusal`, the handler answers with the refusal before it opens
 * a session.
 */
export function toWebHandler<R, E>(
  app: App.App<R>,
  layer: Layer.Layer<R, E, IncomingRequest>,
  options: Options & { readonly services: "per-request" },
): (request: Request) => Promise<Response>;
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Options): (request: Request) => Promise<Response>;
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E, IncomingRequest>, options: Options) {
  const { answer } = answerWith(layer, options.services);
  return async (request: Request): Promise<Response> => {
    const admitted = await admit(request, options);
    if (admitted instanceof Response) return admitted;
    return answer(request, (scope) => respond(app, request, admitted.text, options, scope));
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
    const base = options.base ?? "";
    const underBase = url.pathname === base || url.pathname.startsWith(`${base}/`);
    const path = underBase ? url.pathname.slice(base.length) : undefined;
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
    const route = request.method === "POST" && path !== undefined ? routeOf(path) : undefined;
    if (route === undefined) return json(404, callFailure("unknown-capability", "There is no such route."));

    let input: unknown;
    try {
      input = body === "" ? {} : JSON.parse(body);
    } catch {
      // A body that is not JSON is `invalid-input`, the last kind in the order of the specification. An unknown id, or
      // a capability that is not available, comes first.
      const failure = yield* failureBeforeInput(app, session, route);
      if (failure !== undefined) return json(HTTP_STATUS[failure.kind], failure);
      return json(422, callFailure("invalid-input", "The request body is not JSON."));
    }
    if (route.kind === "event") return yield* subscribe(session, route.id, input, request, url, options, scope);
    const outcome = yield* session.invoke(route.id, input).pipe(cancelOnAbort(request.signal));
    return json(httpStatus(outcome), isCallFailure(outcome) ? { kind: outcome.kind, message: outcome.message } : outcome);
  }).pipe(closeUnlessStreaming(scope));

/**
 * The call failure `unknown-capability` or `unavailable` of a route, if one applies (spec/invocation.md#call-failures).
 * The session gives the same failures when it admits the call or the subscription.
 */
const failureBeforeInput = <R>(
  app: App.App<R>,
  session: Session.Session<R>,
  route: { readonly kind: "capability" | "event"; readonly id: string },
): Effect.Effect<CallFailure | undefined> =>
  Effect.gen(function* () {
    const served = (entry: { readonly id: string; readonly audience: readonly string[] }) => entry.id === route.id && entry.audience.includes(session.target);
    if (route.kind === "event") {
      return (app.events ?? []).some(served) ? undefined : callFailure("unknown-capability", `There is no event ${route.id}.`);
    }
    if (!app.capabilities.some(served)) return callFailure("unknown-capability", `There is no capability ${route.id}.`);
    const availability = yield* session.availability(route.id);
    return availability.available ? undefined : callFailure("unavailable", availability.reason);
  });

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
    // The session checks `maxAgeMs` after it looks up the id. Text that is not the decimal form of an integer that is 0
    // or more becomes `NaN`, which the session rejects as `invalid-input`.
    const maxAgeMs = maxAge === null ? undefined : /^(0|[1-9][0-9]*)$/.test(maxAge) ? Number(maxAge) : Number.NaN;
    const cursor = request.headers.get("Last-Event-ID") ?? undefined;
    const started = yield* Effect.result(
      session
        .subscribe(id, input, { ...(cursor === undefined ? {} : { cursor }), ...(maxAgeMs === undefined ? {} : { maxAgeMs }) })
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
