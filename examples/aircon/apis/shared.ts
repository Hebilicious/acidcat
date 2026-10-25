/**
 * What the three APIs on @acid-cat/core-ts share: a session for each request, the HTTP binding, the check of an input
 * that is not trusted, and the value of a typed call.
 */
import { CallFailureError, createSession, httpHandler } from "@acid-cat/core-ts";
import type { Result, Session } from "@acid-cat/core-ts";
import { callFailure } from "@acid-cat/spec-ts";
import { z } from "zod";

import { aircon, toJsonSchema } from "../core-ts/aircon.ts";
import type { Context, Unit } from "../core-ts/aircon.ts";

export interface ApiOptions {
  readonly unit: Unit;
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins?: readonly string[] | undefined;
}

/**
 * Open a session of the `api` target for one request, and close it when the response is ready. Each request is one
 * client, so a request that ends cancels only its own calls.
 */
export async function withSession<T>(options: ApiOptions, use: (session: Session<Context>) => Promise<T>): Promise<T> {
  const session = createSession(aircon, { target: "api", context: { unit: options.unit }, toJsonSchema });
  try {
    return await use(session);
  } finally {
    await session.dispose();
  }
}

/** The HTTP binding of the `api` target, under `base`. The binding opens its own session for each request. */
export const httpBinding = (options: ApiOptions, base: string) =>
  httpHandler(aircon, { allowedOrigins: options.allowedOrigins ?? [], context: { unit: options.unit }, toJsonSchema, base });

/**
 * Check an input that is not trusted with the input schema of a capability. An input that does not agree rejects as
 * `invalid-input`, as a handle does.
 */
export function decode<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CallFailureError(callFailure("invalid-input", z.prettifyError(parsed.error)));
  return parsed.data;
}

/** A failure of a capability: a value with a tag. */
export interface TaggedFailure {
  readonly _tag: string;
}

/**
 * A failure of a capability, as an error, for an API that sends failures as errors. The class has no type parameter:
 * code that catches an error and checks it with `instanceof` gets the type of `failure` with no cast.
 */
export class Failure extends Error {
  readonly failure: TaggedFailure;

  constructor(failure: TaggedFailure) {
    super(`The capability failed: ${failure._tag}.`);
    this.name = "Failure";
    this.failure = failure;
  }
}

/** The value of a call. A failure rejects with a `Failure`. A call failure rejects with a `CallFailureError`. */
export async function value<Value, Tagged extends TaggedFailure>(call: Promise<Result<Value, Tagged>>): Promise<Value> {
  const outcome = await call;
  if (!outcome.ok) throw new Failure(outcome.error);
  return outcome.value;
}

/** True if the request comes from an origin that the API does not allow (spec/bindings/README.md#remote-bindings). */
export function foreignOrigin(request: Request, options: ApiOptions): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && !(options.allowedOrigins ?? []).includes(origin);
}

export const forbidden = () => new Response(null, { status: 403 });
