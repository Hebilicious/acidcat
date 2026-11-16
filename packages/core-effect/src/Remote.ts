import { Context, Data, Effect } from "effect";

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

/** Refuse a request: fail with a `Refusal`. It throws a `RangeError` when `status` is not an integer from 400 to 599. */
export const refuse = (status: number, message: string, headers: Readonly<Record<string, string>> = {}): Effect.Effect<never, Refusal> => {
  if (!Number.isInteger(status) || status < 400 || status > 599) throw new RangeError(`The status of a refusal is from 400 to 599, not ${status}.`);
  return Effect.fail(new Refusal({ status, message, headers }));
};

export function refusalResponse(refusal: Refusal): Response {
  const headers = new Headers(refusal.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ message: refusal.message }), { status: refusal.status, headers });
}
