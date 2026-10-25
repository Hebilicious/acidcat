import type { Availability, Outcome } from "@acid-cat/spec-ts";
import type { Effect, SubscriptionRef } from "effect";

import type { Readable } from "../Capability.ts";

/**
 * What the handles of a session need from it, by id: the refs that the session got from the provider, and calls with
 * inputs that are already decoded but not typed. This module is not an entry point of the package, so other code
 * cannot get them through a session.
 */
export interface ServedRefs {
  readonly availability: (id: string) => SubscriptionRef.SubscriptionRef<Availability> | undefined;
  readonly state: (id: string) => Readable<unknown> | undefined;
  /** A call with an input that is already decoded. The outcome is not encoded. This effect never fails. */
  readonly execute: (id: string, input: unknown) => Effect.Effect<Outcome<unknown, unknown>>;
}

const sessions = new WeakMap<object, ServedRefs>();

/** Keep the refs of a session that `Session.make` opened. */
export const register = (session: object, refs: ServedRefs): void => void sessions.set(session, refs);

/** The refs of a session that `Session.make` opened. */
export function refsOf(session: object): ServedRefs {
  const refs = sessions.get(session);
  if (refs === undefined) throw new Error("The session did not come from Session.make.");
  return refs;
}
