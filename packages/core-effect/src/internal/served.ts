import type { Availability } from "@acid-cat/spec-ts";
import type { SubscriptionRef } from "effect";

/**
 * The refs that a session got from the provider, by id. Only the handles of the session read them. This module is not
 * an entry point of the package, so other code cannot get the refs of a provider through a session.
 */
export interface ServedRefs {
  readonly availability: (id: string) => SubscriptionRef.SubscriptionRef<Availability> | undefined;
  readonly state: (id: string) => SubscriptionRef.SubscriptionRef<unknown> | undefined;
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
