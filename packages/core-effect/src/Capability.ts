/**
 * A capability, written in Effect: Effect Schema for its input, output and failures, and an Effect program that does
 * the operation. See spec/catalog.md#capabilities.
 */
import type { Availability } from "@acid-cat/spec-ts";
import type { Effect, Schema, SubscriptionRef } from "effect";

/** A schema that needs no services to decode or encode. */
export type AnySchema = Schema.Codec<any, any, never, never>;

export interface Capability<
  Input extends AnySchema = AnySchema,
  Output extends AnySchema = AnySchema,
  Failure extends AnySchema = AnySchema,
  R = never,
  State extends AnySchema = AnySchema,
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
   * A value that clients can observe (spec/invocation.md#state): its schema, and the ref that holds it. A session gets
   * the ref one time, when it opens. Handles need a state schema that encodes synchronously, because `getSnapshot` is
   * synchronous. `Handles.make` checks this when it opens.
   */
  readonly state?:
    | { readonly schema: State; readonly value: Effect.Effect<SubscriptionRef.SubscriptionRef<State["Type"]>, never, R> }
    | undefined;
  /**
   * The ref that holds the availability of the capability. A session gets the ref one time, when it opens, and reads it
   * when a call comes in. With no ref, the capability is always available.
   */
  readonly availability?: Effect.Effect<SubscriptionRef.SubscriptionRef<Availability>, never, R> | undefined;
  readonly run: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], R>;
}

export type Any<R = any> = Capability<any, any, any, R, any>;

/** The services that a capability needs. */
export type Services<C> = C extends Capability<any, any, any, infer R, any> ? R : never;

/** Declare a capability. */
export const make = <
  Input extends AnySchema = Schema.Struct<{}>,
  R = never,
  Output extends AnySchema = typeof Schema.Null,
  Failure extends AnySchema = typeof Schema.Never,
  State extends AnySchema = typeof Schema.Never,
>(
  capability: Capability<Input, Output, Failure, R, State>,
): Capability<Input, Output, Failure, R, State> => capability;
