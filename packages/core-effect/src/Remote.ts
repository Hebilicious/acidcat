/**
 * The services of one request of a remote binding (spec/bindings/README.md#remote-bindings): the head of the request,
 * and the refusal that answers a request before its session opens.
 *
 * `Http.toWebHandler` and `Mcp.toWebHandler` with `services: "per-request"` build the services from the layer for each
 * request that passes the screening. The layer can read the head of the request from `Remote.IncomingRequest`, for
 * example to find the caller from a bearer token. When the layer fails with a `Refusal`, the handler answers with it,
 * and opens no session: no capability runs.
 */
import { Context, Data, Effect } from "effect";

/** The head of a request: its method, its URL and its headers. The body is not in it. */
export interface RequestHead {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
}

/**
 * The head of the request whose services a per-request layer builds. Only a layer that a handler builds with
 * `services: "per-request"` can read it.
 */
export class IncomingRequest extends Context.Service<IncomingRequest, RequestHead>()("@acid-cat/core-effect/Remote/IncomingRequest") {}

/** The head of a web request. A host that builds the services itself gives it to `IncomingRequest`. */
export const headOf = (request: Request): RequestHead => ({ method: request.method, url: request.url, headers: new Headers(request.headers) });

/**
 * The answer that refuses a request, for example `401` when the request has no valid token. The answer has the status,
 * the headers, `Content-Type: application/json`, and the body `{ "message": message }`. Show no internal data in the
 * message.
 */
export class Refusal extends Data.TaggedError("Refusal")<{
  readonly status: number;
  readonly message: string;
  readonly headers: Readonly<Record<string, string>>;
}> {}

/** Refuse a request: fail with a `Refusal`. */
export const refuse = (status: number, message: string, headers: Readonly<Record<string, string>> = {}): Effect.Effect<never, Refusal> =>
  Effect.fail(new Refusal({ status, message, headers }));

/** The web response of a refusal. */
export function refusalResponse(refusal: Refusal): Response {
  const headers = new Headers(refusal.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ message: refusal.message }), { status: refusal.status, headers });
}
