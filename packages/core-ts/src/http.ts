/**
 * The HTTP binding (spec/bindings/http.md): JSON through HTTP.
 */
import { CallFailureError, callFailure, httpEventMessage, httpStatus, isCallFailure, KEEPALIVE_MS, readBounded, screenRequest, SSE_MEDIA_TYPE } from "@acid-cat/spec-ts";
import type { CallFailure, Rejection } from "@acid-cat/spec-ts";

import type { App, ToJsonSchema } from "./app.ts";
import { openContext } from "./context.ts";
import type { ContextOption } from "./context.ts";
import { createSession } from "./session.ts";
import type { Session } from "./session.ts";
import { idlePuller, textStream } from "./stream.ts";

/** The options of `httpHandler`. Give `context` to share one context, or `createContext` to make one for each request. */
export type HttpOptions<Context> = HttpSettings & ContextOption<Context>;

export interface HttpSettings {
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  readonly toJsonSchema: ToJsonSchema;
  /** The target that the API serves. The default is `"api"`. */
  readonly target?: string | undefined;
  /** The path before `/capabilities` and `/catalog`, for example `"/api"`. The default is `""`. */
  readonly base?: string | undefined;
  /** Serve `GET {base}/catalog`. The default is `true`. */
  readonly serveCatalog?: boolean | undefined;
  /** The maximum size of a request body, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
  /** The time with nothing sent on the stream of a subscription after which the binding sends a comment line, in milliseconds. The default is 15 seconds. */
  readonly keepaliveMs?: number | undefined;
  /** The number of occurrences that each subscription keeps for a client that reads slowly. The default is 256. */
  readonly bufferLimit?: number | undefined;
}

/** A web request handler for the API. Each request has its own session, and with `createContext` its own context. */
export function httpHandler<Context>(app: App<Context>, options: HttpOptions<Context>) {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  return async (request: Request): Promise<Response> => {
    const screened = screenRequest(request, {
      methods: ["GET", "POST"],
      allowedOrigins: options.allowedOrigins,
      mediaType: "application/json",
      maximumBytes,
    });
    if (screened !== undefined) return rejection(screened);
    const body = await readBounded(request, maximumBytes);
    if ("rejection" in body) return rejection(body.rejection);

    const url = new URL(request.url);
    const path = url.pathname.slice((options.base ?? "").length);
    const opened = await openContext<Context>(options, request);
    const session = createSession(app, {
      target: options.target ?? "api",
      context: opened.context,
      toJsonSchema: options.toJsonSchema,
      ...(options.bufferLimit === undefined ? {} : { bufferLimit: options.bufferLimit }),
    });
    const close = async () => {
      await session.dispose();
      await opened.release();
    };
    // A stream of a subscription closes the session and releases the context when it ends.
    let streaming = false;
    try {
      if (request.method === "GET" && path === "/capabilities") {
        return json(
          200,
          [...session.handles.values()].map((handle) => ({ id: handle.id, ...handle.availability.getSnapshot() })),
        );
      }
      if (request.method === "GET" && path === "/events") return json(200, [...session.eventHandles.keys()].map((id) => ({ id })));
      if (request.method === "GET" && path === "/catalog" && options.serveCatalog !== false) return json(200, session.view);
      const route = request.method === "POST" ? postRoute(path) : undefined;
      if (route === undefined) return json(404, callFailure("unknown-capability", "There is no such route."));

      let input: unknown;
      try {
        input = body.text === "" ? {} : JSON.parse(body.text);
      } catch {
        return json(422, callFailure("invalid-input", "The request body is not JSON."));
      }
      const id = decodeURIComponent(route.id);
      if (route.kind === "capability") {
        const outcome = await session.invoke(id, input, { signal: request.signal });
        return json(httpStatus(outcome), isCallFailure(outcome) ? failureBody(outcome) : outcome);
      }
      const subscribed = await subscribe(session, id, input, url, request, { keepaliveMs: options.keepaliveMs ?? KEEPALIVE_MS, close });
      streaming = subscribed.streaming;
      return subscribed.response;
    } finally {
      if (!streaming) await close();
    }
  };
}

/** The capability or the event of a `POST` route, or `undefined` for another path. */
function postRoute(path: string): { readonly kind: "capability" | "event"; readonly id: string } | undefined {
  if (path.startsWith("/capabilities/")) return { kind: "capability", id: path.slice("/capabilities/".length) };
  if (path.startsWith("/events/")) return { kind: "event", id: path.slice("/events/".length) };
  return undefined;
}

/**
 * Subscribe to an event (spec/bindings/http.md#events). A call failure before the first occurrence is a JSON answer.
 * After that, the answer is a stream of server-sent events, which closes the session when it ends.
 */
async function subscribe(
  session: Session,
  id: string,
  input: unknown,
  url: URL,
  request: Request,
  stream: { readonly keepaliveMs: number; readonly close: () => Promise<void> },
): Promise<{ readonly response: Response; readonly streaming: boolean }> {
  const maxAge = url.searchParams.get("maxAgeMs");
  const maxAgeMs = maxAge === null ? undefined : Number(maxAge);
  if (maxAgeMs !== undefined && (maxAge?.trim() === "" || !Number.isInteger(maxAgeMs) || maxAgeMs < 0)) {
    return { response: json(422, callFailure("invalid-input", "maxAgeMs must be a whole number of milliseconds.")), streaming: false };
  }
  const cursor = request.headers.get("Last-Event-ID") ?? undefined;
  const subscribed = await session.subscribe(id, input, {
    signal: request.signal,
    ...(cursor === undefined ? {} : { cursor }),
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
  });
  if ("kind" in subscribed) return { response: json(httpStatus(subscribed), failureBody(subscribed)), streaming: false };

  const pull = idlePuller(subscribed, stream.keepaliveMs);
  let ended = false;
  const produce = async (): Promise<readonly string[] | undefined> => {
    if (ended) return undefined;
    const pulled = await pull();
    if ("idle" in pulled) return [httpEventMessage.keepalive()];
    if ("error" in pulled) {
      ended = true;
      return [httpEventMessage.error(internalOf(pulled.error))];
    }
    if (pulled.step.done === true) {
      ended = true;
      return [httpEventMessage.complete()];
    }
    return [httpEventMessage.next(pulled.step.value)];
  };
  const body = textStream(produce, () => void subscribed.return(), stream.close);
  return { response: new Response(body, { status: 200, headers: { "Content-Type": SSE_MEDIA_TYPE, "Cache-Control": "no-store" } }), streaming: true };
}

/** The call failure that ends a subscription. A subscription ends only with `internal`. */
function internalOf(error: unknown): CallFailure {
  return error instanceof CallFailureError ? callFailure(error.kind, error.message) : callFailure("internal", "The event failed.");
}

const failureBody = (failure: CallFailure) => ({ kind: failure.kind, message: failure.message });

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
