/**
 * An event, written in Effect: Effect Schema for its input and its payload, and a `Stream` of the things that happen.
 * See spec/events.md and spec/catalog.md#events.
 */
import type { Emitted, Resume } from "@acid-cat/spec-ts";
import { Data, Effect, Schema, Stream } from "effect";

import type { AnySchema, NoInput } from "./Capability.ts";
import { describe } from "./internal/issues.ts";

export type { AnySchema, NoInput } from "./Capability.ts";
export type { Emitted, Resume } from "@acid-cat/spec-ts";

/** The provider gave a payload that does not agree with the payload schema of the event. */
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
  /** The subscriptions of the event for code that does not know the types of its schemas. `make` builds it. */
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

/** The services that an event needs. */
export type Services<E> = E extends Any<infer R> ? R : never;

/** The members of a declaration that do not depend on the input. */
export interface Declaration<Payload extends AnySchema, Id extends string> {
  readonly id: Id;
  readonly description: string;
  readonly audience: readonly string[];
  readonly payload?: Payload | undefined;
}

/** The declaration of an event with an input schema. `subscribe` gets the decoded input. */
export interface WithInput<Input extends AnySchema, Payload extends AnySchema, R, Id extends string> extends Declaration<Payload, Id> {
  readonly input: Input;
  readonly subscribe: (input: Input["Type"], resume: Resume) => Stream.Stream<Emitted<Payload["Type"]>, never, R>;
}

/** The declaration of an event with no input schema. `subscribe` gets the object that the client sent. */
export interface WithoutInput<Payload extends AnySchema, R, Id extends string> extends Declaration<Payload, Id> {
  readonly input?: undefined;
  readonly subscribe: (input: NoInput, resume: Resume) => Stream.Stream<Emitted<Payload["Type"]>, never, R>;
}

/** The input of an event with no input schema. */
const AnyObject = Schema.Record(Schema.String, Schema.Unknown);

/** The data of an event with no payload schema: an empty object. */
const EmptyPayload = Schema.Struct({});

/** `true` if a declaration has an input. See `hasInput` in `Capability.ts`. */
function hasInput<With extends { readonly input: object }, Without extends { readonly input?: undefined }>(
  definition: With | Without,
): definition is With {
  return definition.input !== undefined;
}

/**
 * Declare an event. The id keeps its literal type. The event needs the services that `subscribe` needs. With no input
 * schema, the type of the input is the empty struct. With no payload schema, the data is an empty object.
 */
export function make<Input extends AnySchema, R = never, Payload extends AnySchema = typeof EmptyPayload, const Id extends string = string>(
  definition: WithInput<Input, Payload, R, Id>,
): Event<Input, Payload, R, Id>;
export function make<R = never, Payload extends AnySchema = typeof EmptyPayload, const Id extends string = string>(
  definition: WithoutInput<Payload, R, Id>,
): Event<Schema.Struct<{}>, Payload, R, Id>;
/** Each declaration above is this function with `Input` set: the type of its input schema, or the empty struct. */
export function make<Input extends AnySchema, R, Payload extends AnySchema, const Id extends string>(
  definition: WithInput<Input, Payload, R, Id> | WithoutInput<Payload, R, Id>,
): Event<Input, Payload, R, Id> {
  const disagrees = () => new PayloadDisagrees();
  /** The payload in its JSON form, as a copy. */
  const encoded = (data: unknown) =>
    Schema.encodeUnknownEffect(definition.payload ?? EmptyPayload)(data).pipe(
      Effect.mapError(disagrees),
      Effect.flatMap((json) => Effect.try({ try: () => structuredClone(json), catch: disagrees })),
    );
  /**
   * The payload as a copy, in its type: the JSON form, decoded again. With no payload schema, the type is the empty
   * object type, and the copy is a clone of an object that encodes.
   */
  const copied = typedCopy(definition.payload, encoded, disagrees);
  const declared = {
    id: definition.id,
    description: definition.description,
    audience: definition.audience,
    input: definition.input,
    payload: definition.payload,
  };

  /** The event, from the decoding and the check of the input of one member of the declaration. */
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

/** The copy of a payload in its type, with the payload schema, or a clone of the payload when there is no schema. */
function typedCopy<Payload extends AnySchema>(
  schema: Payload | undefined,
  encoded: (data: unknown) => Effect.Effect<unknown, PayloadDisagrees>,
  disagrees: () => PayloadDisagrees,
): (data: Payload["Type"]) => Effect.Effect<Payload["Type"], PayloadDisagrees> {
  if (schema === undefined) return (data) => Effect.flatMap(encoded(data), () => Effect.try({ try: () => structuredClone(data), catch: disagrees }));
  const decode = Schema.decodeUnknownEffect(schema);
  return (data) => Effect.flatMap(encoded(data), (json) => Effect.mapError(decode(json), disagrees));
}
