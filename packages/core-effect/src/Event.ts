import type { Emitted, Resume } from "@acid-cat/spec-ts";
import { Data, Effect, Schema, Stream } from "effect";

import type { AnySchema, NoInput } from "./Capability.ts";
import { describe } from "./internal/issues.ts";

export type { AnySchema, NoInput } from "./Capability.ts";
export type { Emitted, Resume } from "@acid-cat/spec-ts";

export class PayloadDisagrees extends Data.TaggedError("PayloadDisagrees")<{}> {}

/**
 * The start of a subscription with an input that is already checked: the occurrences that the provider gives from
 * `resume`. Each payload is checked with the payload schema. A payload that does not agree fails the stream with
 * `PayloadDisagrees`.
 */
export type Opener<Payload, R> = (resume: Resume) => Stream.Stream<Emitted<Payload>, PayloadDisagrees, R>;

/**
 * The subscriptions of an event for code that does not know the types of its schemas, for example a session that
 * serves all the events of an application. `make` builds it.
 */
export interface Pipeline<R> {
  /**
   * Decode an input that is not trusted with the input schema. The opener gives each payload in its JSON form, encoded
   * with the payload schema. The failure is the message of an input that does not decode.
   */
  readonly prepare: (input: unknown) => Effect.Effect<Opener<unknown, R>, string>;
}

export interface Event<Input extends AnySchema = AnySchema, Payload extends AnySchema = AnySchema, R = never, Id extends string = string> {
  readonly id: Id;
  /** What happens, and when the provider gives an occurrence. */
  readonly description: string;
  /** The targets that can use the event. With no audience, no target can use it. */
  readonly audience: readonly string[];
  /** The input of a subscription, a `Schema.Struct`. With no input schema, the input is an object. */
  readonly input?: Input | undefined;
  /** The data of each occurrence, a `Schema.Struct`. With no payload schema, the data is an empty object. */
  readonly payload?: Payload | undefined;
  /**
   * The things that happen, for an input that is already decoded. The stream starts at `resume`, or now when `resume`
   * has no cursor. A subscription ends when the stream ends, or when it is interrupted. Put the problems of the source
   * in the payload: a defect of the stream ends the subscription with the call failure `internal`.
   */
  readonly subscribe: (input: Input["Type"], resume: Resume) => Stream.Stream<Emitted<Payload["Type"]>, never, R>;
  /**
   * Check an input that is already decoded against the input schema. The opener gives each payload as a copy, in its
   * type. The failure is the message of an input that does not agree. `make` builds it.
   */
  readonly open: (input: Input["Type"]) => Effect.Effect<Opener<Payload["Type"], R>, string>;
  readonly pipeline: Pipeline<R>;
}

/**
 * An event with schemas that are not known, which needs the services `R`. Each `Event` that needs only services in `R`
 * is an `Any<R>`. An application keeps its events in this form.
 */
export interface Any<R = unknown> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly input?: AnySchema | undefined;
  readonly payload?: AnySchema | undefined;
  readonly pipeline: Pipeline<R>;
}

export type Services<E> = E extends Any<infer R> ? R : never;

export interface Declaration<Payload extends AnySchema, Id extends string> {
  readonly id: Id;
  readonly description: string;
  readonly audience: readonly string[];
  readonly payload?: Payload | undefined;
}

export interface WithInput<Input extends AnySchema, Payload extends AnySchema, R, Id extends string> extends Declaration<Payload, Id> {
  readonly input: Input;
  readonly subscribe: (input: Input["Type"], resume: Resume) => Stream.Stream<Emitted<Payload["Type"]>, never, R>;
}

export interface WithoutInput<Payload extends AnySchema, R, Id extends string> extends Declaration<Payload, Id> {
  readonly input?: undefined;
  readonly subscribe: (input: NoInput, resume: Resume) => Stream.Stream<Emitted<Payload["Type"]>, never, R>;
}

const AnyObject = Schema.Record(Schema.String, Schema.Unknown);

const EmptyPayload = Schema.Struct({});

// Schema.Struct({}) accepts an object with any members, so the data of an event with no payload schema is encoded with this.
const NoMembers = Schema.Record(Schema.String, Schema.Never);

function hasInput<With extends { readonly input: object }, Without extends { readonly input?: undefined }>(
  definition: With | Without,
): definition is With {
  return definition.input !== undefined;
}

export function make<Input extends AnySchema, R = never, Payload extends AnySchema = typeof EmptyPayload, const Id extends string = string>(
  definition: WithInput<Input, Payload, R, Id>,
): Event<Input, Payload, R, Id>;
export function make<R = never, Payload extends AnySchema = typeof EmptyPayload, const Id extends string = string>(
  definition: WithoutInput<Payload, R, Id>,
): Event<Schema.Codec<{}, never>, Payload, R, Id>;
export function make<Input extends AnySchema, R, Payload extends AnySchema, const Id extends string>(
  definition: WithInput<Input, Payload, R, Id> | WithoutInput<Payload, R, Id>,
): Event<Input, Payload, R, Id> {
  const disagrees = () => new PayloadDisagrees();
  const encoded = (data: unknown) =>
    Schema.encodeUnknownEffect(definition.payload ?? NoMembers)(data).pipe(
      Effect.mapError(disagrees),
      Effect.flatMap((json) => Effect.try({ try: () => structuredClone(json), catch: disagrees })),
    );
  const copied = typedCopy(definition.payload, encoded, disagrees);
  const declared = {
    id: definition.id,
    description: definition.description,
    audience: definition.audience,
    input: definition.input,
    payload: definition.payload,
  };

  const finish = <In>(
    calls: {
      readonly decode: (input: unknown) => Effect.Effect<In, string>;
      readonly check: (input: unknown) => Effect.Effect<In, string>;
      readonly subscribe: (input: In, resume: Resume) => Stream.Stream<Emitted<Payload["Type"]>, never, R>;
    },
    subscribe: (input: Input["Type"], resume: Resume) => Stream.Stream<Emitted<Payload["Type"]>, never, R>,
  ): Event<Input, Payload, R, Id> => ({
    ...declared,
    subscribe,
    open: (input) =>
      Effect.map(
        calls.check(input),
        (checked): Opener<Payload["Type"], R> =>
          (resume) => calls.subscribe(checked, resume).pipe(Stream.mapEffect((emitted) => Effect.map(copied(emitted.data), (data) => ({ ...emitted, data })))),
      ),
    pipeline: {
      prepare: (input) =>
        Effect.map(
          calls.decode(input),
          (decoded): Opener<unknown, R> =>
            (resume) => calls.subscribe(decoded, resume).pipe(Stream.mapEffect((emitted) => Effect.map(encoded(emitted.data), (data) => ({ ...emitted, data })))),
        ),
    },
  });

  if (hasInput(definition)) {
    const schema = definition.input;
    return finish(
      {
        decode: (input) => Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError((error) => describe(error.issue))),
        check: (input) => (Schema.is(schema)(input) ? Effect.succeed(input) : Effect.fail(notInput)),
        subscribe: definition.subscribe,
      },
      definition.subscribe,
    );
  }
  const subscribe = definition.subscribe;
  return finish(
    {
      decode: (input) => Schema.decodeUnknownEffect(AnyObject)(input).pipe(Effect.mapError((error) => describe(error.issue))),
      check: (input) => (Schema.is(AnyObject)(input) ? Effect.succeed(input) : Effect.fail(notInput)),
      subscribe,
    },
    (_input, resume) => subscribe({}, resume),
  );
}

const notInput = "input: The input does not agree with the input schema.";

function typedCopy<Payload extends AnySchema>(
  schema: Payload | undefined,
  encoded: (data: unknown) => Effect.Effect<unknown, PayloadDisagrees>,
  disagrees: () => PayloadDisagrees,
): (data: Payload["Type"]) => Effect.Effect<Payload["Type"], PayloadDisagrees> {
  if (schema === undefined) return (data) => Effect.flatMap(encoded(data), () => Effect.try({ try: () => structuredClone(data), catch: disagrees }));
  const decode = Schema.decodeUnknownEffect(schema);
  return (data) => Effect.flatMap(encoded(data), (json) => Effect.mapError(decode(json), disagrees));
}
