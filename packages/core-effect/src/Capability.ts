/**
 * A capability, written in Effect: Effect Schema for its input, output and failures, and an Effect program that does
 * the operation. See spec/catalog.md#capabilities.
 */
import type { Availability } from "@acid-cat/spec-ts";
import { Effect, Queue, Stream, SubscriptionRef } from "effect";
import type { Schema } from "effect";

/** A schema that needs no services to decode or encode. */
export type AnySchema = Schema.Codec<any, any, never, never>;

export interface Capability<
  Input extends AnySchema = AnySchema,
  Output extends AnySchema = AnySchema,
  Failure extends AnySchema = AnySchema,
  R = never,
> {
  readonly id: string;
  readonly description: string;
  /** The targets that can use the capability. With no audience, no target can use it. */
  readonly audience: readonly string[];
  readonly readOnly?: boolean | undefined;
  /** The input, a `Schema.Struct`. With no input schema, the input is an empty object. */
  readonly input?: Input | undefined;
  /** The value of a successful call. With no output schema, the value is `null`. */
  readonly output?: Output | undefined;
  /** The failures, each a `Schema.TaggedStruct` with its own tag. */
  readonly failures?: readonly Failure[] | undefined;
  /**
   * A value that clients can observe (spec/invocation.md#state): its schema, and a stream of its values. The first
   * value of the stream is the current value.
   */
  readonly state?: { readonly schema: AnySchema; readonly changes: Stream.Stream<unknown, never, R> } | undefined;
  /**
   * The availability of the capability. With no availability, the capability is always available.
   *
   * - A `Stream` gives each value. The session keeps the last value, and decides each call on it. A value reaches the
   *   session when its fiber runs, so a call that comes in the same turn as a change is decided on the value before
   *   the change.
   * - An Effect that gives a `Current` gives a value that the session reads when a call comes in. Use it when the
   *   availability changes in code that does not wait, so that a call just after a change is decided on the new value.
   *   `fromSubscriptionRef` and `fromObservable` make a `Current`.
   */
  readonly availability?: Stream.Stream<Availability, never, R> | Effect.Effect<Current<Availability>, never, R> | undefined;
  readonly run: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], R>;
}

/** A value that a session reads when it needs it, and follows for its listeners. */
export interface Current<A> {
  /** The value now. This effect does not wait, so that code that does not use Effect can read it at once. */
  readonly get: Effect.Effect<A>;
  /** The current value, then each change. */
  readonly changes: Stream.Stream<A>;
}

/** The value of a `SubscriptionRef`, as a `Current`. */
export const fromSubscriptionRef = <A>(ref: SubscriptionRef.SubscriptionRef<A>): Current<A> => ({
  get: SubscriptionRef.get(ref),
  changes: SubscriptionRef.changes(ref),
});

/** A source of values for code that does not use Effect. Its listeners hear each change. */
export interface Observable<A> {
  getSnapshot(): A;
  subscribe(listener: (value: A) => void): { unsubscribe(): void };
}

/**
 * The value of an observable, as a `Current`. `get` reads `getSnapshot`. `changes` subscribes while a reader follows
 * it, and unsubscribes when the reader stops.
 */
export const fromObservable = <A>(source: Observable<A>): Current<A> => ({
  get: Effect.sync(() => source.getSnapshot()),
  changes: Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const subscription = source.subscribe((value) => void Queue.offerUnsafe(queue, value));
        Queue.offerUnsafe(queue, source.getSnapshot());
        return subscription;
      }),
      (subscription) => Effect.sync(() => subscription.unsubscribe()),
    ),
  ),
});

export type Any<R = any> = Capability<any, any, any, R>;

/** The services that a capability needs. */
export type Services<C> = C extends Capability<any, any, any, infer R> ? R : never;

/** Declare a capability. */
export const make = <
  Input extends AnySchema = Schema.Struct<{}>,
  R = never,
  Output extends AnySchema = typeof Schema.Null,
  Failure extends AnySchema = typeof Schema.Never,
>(
  capability: Capability<Input, Output, Failure, R>,
): Capability<Input, Output, Failure, R> => capability;
