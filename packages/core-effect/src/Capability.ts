/**
 * A capability, written in Effect: Effect Schema for its input, output and failures, and an Effect program that does
 * the operation. See spec/catalog.md#capabilities.
 */
import type { Availability } from "@acid-cat/spec-ts";
import type { Effect, Schema, Stream } from "effect";

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
  /** The availability of the capability over time. With no stream, the capability is always available. */
  readonly availability?: Stream.Stream<Availability, never, R> | undefined;
  readonly run: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], R>;
}

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
