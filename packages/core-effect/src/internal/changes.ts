import { Stream, SubscriptionRef } from "effect";

import type { Readable } from "../Capability.ts";

/** A ref, as a value that code can read and follow. */
export const readable = <A>(ref: SubscriptionRef.SubscriptionRef<A>): Readable<A> => ({
  get: () => SubscriptionRef.getUnsafe(ref),
  changes: SubscriptionRef.changes(ref),
});

/**
 * Each change of a value after `start`, the value that the reader saw when it started to follow it. Each value is the
 * value at the moment that the stream gives it, and two values in sequence are never equal. `changes` gives the
 * current value first. That value is not a change, unless it differs from `start`.
 */
export const changesAfter = <A>(source: Readable<A>, start: A): Stream.Stream<A> =>
  Stream.make(start).pipe(
    Stream.concat(Stream.map(source.changes, () => source.get())),
    Stream.changes,
    Stream.drop(1),
  );
