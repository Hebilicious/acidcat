import type { Availability, Outcome } from "@acid-cat/spec-ts";
import type { Effect, SubscriptionRef } from "effect";

import type { Readable } from "../Capability.ts";

export interface ServedRefs {
  readonly availability: (id: string) => SubscriptionRef.SubscriptionRef<Availability> | undefined;
  readonly state: (id: string) => Readable<unknown> | undefined;
  readonly execute: (id: string, input: unknown) => Effect.Effect<Outcome<unknown, unknown>>;
  readonly serves: (capability: { readonly id: string }) => boolean;
  readonly servesEvent: (event: { readonly id: string }) => boolean;
  readonly perform: <A, E>(capability: { readonly id: string }, prepared: Effect.Effect<Effect.Effect<A, E>, string>) => Effect.Effect<Outcome<A, E>>;
}

const sessions = new WeakMap<object, ServedRefs>();

export const register = (session: object, refs: ServedRefs): void => void sessions.set(session, refs);

export function refsOf(session: object): ServedRefs {
  const refs = sessions.get(session);
  if (refs === undefined) throw new Error("The session did not come from Session.make.");
  return refs;
}
