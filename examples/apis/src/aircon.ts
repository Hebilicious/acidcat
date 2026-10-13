/**
 * The air conditioner of @acid-cat/core-ts, and what the three APIs share: one session for the `api` target, the
 * HTTP binding, and a call that gives the value of a capability.
 */
import { createSession, httpHandler } from "@acid-cat/core-ts";
import type { Result, Session } from "@acid-cat/core-ts";
import type { z } from "zod";

import { aircon, Status, toJsonSchema, Unit } from "../../../packages/core-ts/examples/aircon.ts";

export { aircon, FanSpeed, Mode, Status, toJsonSchema, Unit } from "../../../packages/core-ts/examples/aircon.ts";

export type StatusValue = z.infer<typeof Status>;

export interface ApiOptions {
  readonly unit: Unit;
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins?: readonly string[] | undefined;
}

/**
 * The session of the API. All clients share it, because the context has no identity of a client. To give each
 * client its own session, open one for each request, and dispose it when the response is sent.
 */
export const apiSession = (options: ApiOptions): Session =>
  createSession(aircon, { target: "api", context: { unit: options.unit }, toJsonSchema });

/** The HTTP binding of the `api` target, under `base`. */
export const httpBinding = (options: ApiOptions, base: string) =>
  httpHandler(aircon, { allowedOrigins: options.allowedOrigins ?? [], context: { unit: options.unit }, toJsonSchema, base });

/** A failure of a capability, as an error, for an API that sends failures as errors. */
export class Failure extends Error {
  readonly failure: { readonly _tag: string };

  constructor(failure: { readonly _tag: string }) {
    super(`The capability failed: ${failure._tag}.`);
    this.name = "Failure";
    this.failure = failure;
  }
}

/** Call a capability with an input that is not trusted. A call failure rejects with a `CallFailureError`. */
export const result = (session: Session, id: string, input: unknown): Promise<Result<unknown, { readonly _tag: string }>> =>
  session.handles.get(id)!.invokeExternal(input) as Promise<Result<unknown, { readonly _tag: string }>>;

/** Call a capability and give its value. A failure rejects with a `Failure`. */
export async function value(session: Session, id: string, input: unknown): Promise<unknown> {
  const outcome = await result(session, id, input);
  if (!outcome.ok) throw new Failure(outcome.error);
  return outcome.value;
}

/** The status of the unit. */
export const status = async (session: Session) => (await value(session, "aircon.status.get", {})) as StatusValue;

/** True if the request comes from an origin that the API does not allow (spec/bindings/README.md#remote-bindings). */
export function foreignOrigin(request: Request, options: ApiOptions): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && !(options.allowedOrigins ?? []).includes(origin);
}

export const forbidden = () => new Response(null, { status: 403 });
