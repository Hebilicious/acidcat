import { Stream, SubscriptionRef } from "effect";

/**
 * Each change of a ref after `start`, the value that the reader saw when it started to follow the ref. Each value is
 * the value of the ref at the moment that the stream gives it, and two values in sequence are never equal.
 * `SubscriptionRef.changes` gives the current value first. That value is not a change, unless it differs from `start`.
 */
export const changesAfter = <A>(ref: SubscriptionRef.SubscriptionRef<A>, start: A): Stream.Stream<A> =>
  Stream.make(start).pipe(
    Stream.concat(Stream.map(SubscriptionRef.changes(ref), () => SubscriptionRef.getUnsafe(ref))),
    Stream.changes,
    Stream.drop(1),
  );
