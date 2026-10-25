/**
 * What the three APIs on @acid-cat/core-ts share: the session of a request, the HTTP binding, and the screening of
 * origins.
 */
import { createSession, httpHandler } from "@acid-cat/core-ts";
import type { Session } from "@acid-cat/core-ts";

import { aircon, toJsonSchema } from "../core-ts/aircon.ts";
import type { Context, Unit } from "../core-ts/aircon.ts";

export interface ApiOptions {
  readonly unit: Unit;
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins?: readonly string[] | undefined;
}

/**
 * Open a session of the `api` target for one request. Each request is one client, so a request that ends cancels only
 * its own calls. Open it with `await using`, so that it closes when the request ends.
 */
export const openSession = (options: ApiOptions): Session<Context> =>
  createSession(aircon, { target: "api", context: { unit: options.unit }, toJsonSchema });

/** The HTTP binding of the `api` target, under `base`. The binding opens its own session for each request. */
export const httpBinding = (options: ApiOptions, base: string) =>
  httpHandler(aircon, { allowedOrigins: options.allowedOrigins ?? [], context: { unit: options.unit }, toJsonSchema, base });

/** True if the request comes from an origin that the API does not allow (spec/bindings/README.md#remote-bindings). */
export function foreignOrigin(request: Request, options: ApiOptions): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && !(options.allowedOrigins ?? []).includes(origin);
}

export const forbidden = () => new Response(null, { status: 403 });
