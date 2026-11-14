/**
 * The context of the web handlers: one context that all requests share, or a new context for each request. The
 * function that makes the context of a request can refuse the request (spec/bindings/README.md#remote-bindings).
 */

export type ContextOption<Context> =
  | {
      /** The context of all requests. */
      readonly context: Context;
      readonly createContext?: undefined;
    }
  | {
      /**
       * Make the context of one request. The handler calls it for each request that passes the screening. When the
       * context has `Symbol.asyncDispose` or `Symbol.dispose`, the handler calls it after the response, as a `using`
       * declaration does. Through MCP, a poll lease or a webhook subscription that the request starts keeps the context:
       * the handler calls it when the last of them ends. Give a `Refusal` from `refuse` to answer the request with no session: for example `401` when
       * the request has no valid token.
       */
      readonly createContext: (request: Request) => Context | Refusal | Promise<Context | Refusal>;
      readonly context?: undefined;
    };

/** The key that marks a refusal. A context cannot have it by accident. */
const refusalKey = Symbol("acid-cat.refusal");

/** The answer that refuses a request before the handler opens a session. `refuse` makes it. */
export interface Refusal {
  readonly [refusalKey]: true;
  /** The status of the answer, for example `401` or `403`. */
  readonly status: number;
  /** The text of the answer, in its JSON body `{ "message" }`. Show no internal data. */
  readonly message: string;
  /** The other headers of the answer, for example `WWW-Authenticate`. */
  readonly headers: Headers;
}

/**
 * Refuse a request: `createContext` gives the result instead of a context. The handler answers with `status`, the media
 * type `application/json`, the body `{ "message": message }`, and `headers`. No capability runs, and no subscription
 * starts. `status` must be an integer from 400 to 599: an other value throws a `RangeError`.
 */
export function refuse(status: number, message: string, headers?: HeadersInit): Refusal {
  if (!Number.isInteger(status) || status < 400 || status > 599) throw new RangeError(`The status of a refusal must be an integer from 400 to 599, not ${status}.`);
  return { [refusalKey]: true, status, message, headers: new Headers(headers) };
}

/** Tell if a value is a refusal that `refuse` made. */
export function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === "object" &&
    value !== null &&
    refusalKey in value &&
    value[refusalKey] === true &&
    "status" in value &&
    typeof value.status === "number" &&
    "message" in value &&
    typeof value.message === "string" &&
    "headers" in value &&
    value.headers instanceof Headers
  );
}

/** The answer of a refused request. */
export function refusalResponse(refusal: Refusal): Response {
  const headers = new Headers(refusal.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ message: refusal.message }), { status: refusal.status, headers });
}

/** The context of one request, and the function that releases it if the handler made it. */
export interface OpenedContext<Context> {
  readonly context: Context;
  readonly release: () => Promise<void>;
}

/**
 * The context of one request, or the refusal of the request. A response with a stream, such as the stream of a
 * subscription, releases the context when the stream ends.
 */
export async function openContext<Context>(option: ContextOption<Context>, request: Request): Promise<OpenedContext<Context> | { readonly refusal: Refusal }> {
  if (option.createContext === undefined) return { context: option.context, release: () => Promise.resolve() };
  const made = await option.createContext(request);
  if (isRefusal(made)) return { refusal: made };
  return { context: made, release: () => release(made) };
}

/** Call `Symbol.asyncDispose` or `Symbol.dispose` of a value, if it has one. */
async function release(value: unknown): Promise<void> {
  if (typeof value !== "object" || value === null) return;
  const asyncDispose = Symbol.asyncDispose in value ? value[Symbol.asyncDispose] : undefined;
  const dispose = Symbol.dispose in value ? value[Symbol.dispose] : undefined;
  if (isFunction(asyncDispose)) await asyncDispose.call(value);
  else if (isFunction(dispose)) dispose.call(value);
}

/** Tell if a value is a function. A function can take any arguments, and its result is not known. */
const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";
