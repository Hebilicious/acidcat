import { Stream, SubscriptionRef } from "effect";

import type { Readable } from "../Capability.ts";

export const readable = <A>(ref: SubscriptionRef.SubscriptionRef<A>): Readable<A> => ({
  get: () => SubscriptionRef.getUnsafe(ref),
  changes: SubscriptionRef.changes(ref),
});

// `SubscriptionRef.changes` gives the current value first. That value is not a change, unless it differs from `start`.
export const changesAfter = <A>(source: Readable<A>, start: A): Stream.Stream<A> =>
  Stream.make(start).pipe(
    Stream.concat(Stream.map(source.changes, () => source.get())),
    Stream.changes,
    Stream.drop(1),
  );
