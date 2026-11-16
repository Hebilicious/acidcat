import { createSession, httpHandler } from "@acid-cat/core-ts";
import type { Session } from "@acid-cat/core-ts";

import { aircon, toJsonSchema } from "../core-ts/aircon.ts";
import type { Context, Unit } from "../core-ts/aircon.ts";

export interface ApiOptions {
  readonly unit: Unit;
  readonly allowedOrigins?: readonly string[] | undefined;
}

export const openSession = (options: ApiOptions): Session<Context> =>
  createSession(aircon, { target: "api", context: { unit: options.unit }, toJsonSchema });

export const httpBinding = (options: ApiOptions, base: string) =>
  httpHandler(aircon, { allowedOrigins: options.allowedOrigins ?? [], context: { unit: options.unit }, toJsonSchema, base });

/** True if the request comes from an origin that the API does not allow (spec/bindings/README.md#remote-bindings). */
export function foreignOrigin(request: Request, options: ApiOptions): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && !(options.allowedOrigins ?? []).includes(origin);
}

export const forbidden = () => new Response(null, { status: 403 });
