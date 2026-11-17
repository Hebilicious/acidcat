import type { Availability } from "@acid-cat/spec-ts";
import { Effect, Schema } from "effect";
import type { Stream, SubscriptionRef } from "effect";

import { readable } from "./internal/changes.ts";
import { describe } from "./internal/issues.ts";

export type AnySchema = Schema.Codec<unknown, unknown, never, never>;

/** The input that `run` gets when a capability has no input schema: the object that the client sent. */
export type NoInput = { readonly [key: string]: unknown };

export interface Readable<A> {
  readonly get: () => A;
  /** The current value, then each change. */
  readonly changes: Stream.Stream<A>;
}

export type PipelineError =
  | { readonly _tag: "InvalidInput"; readonly message: string }
  | { readonly _tag: "Failure"; readonly error: unknown }
  | { readonly _tag: "Disagrees" };

/**
 * The calls of a capability for code that does not know the types of its schemas, for example a session that serves
 * all the capabilities of an application. `make` builds the pipeline where the types are known, so each part checks
 * its values with the schemas of the same capability.
 */
export interface Pipeline<R> {
  /**
   * Decode an input that is not trusted with the input schema, run the capability, and encode its value with the
   * output schema. A failure of the capability is encoded with the failure schemas.
   */
  readonly invoke: (input: unknown) => Effect.Effect<unknown, PipelineError, R>;
  /** Check an input that is already decoded against the input schema, and run the capability. Nothing is encoded. */
  readonly execute: (input: unknown) => Effect.Effect<unknown, PipelineError, R>;
  /** The state, if the capability has one. A session gets it one time, when it opens. */
  readonly state: Effect.Effect<Readable<unknown>, never, R> | undefined;
}

export interface Capability<
  Input extends AnySchema = AnySchema,
  Output extends AnySchema = AnySchema,
  Failure extends AnySchema = AnySchema,
  R = never,
  State extends AnySchema = AnySchema,
  Id extends string = string,
> {
  readonly id: Id;
  readonly description: string;
  /** The targets that can use the capability. With no audience, no target can use it. */
  readonly audience: readonly string[];
  readonly readOnly?: boolean | undefined;
  /** `true` when a call can delete or overwrite something that a client can see, `false` when a call only adds. */
  readonly destructive?: boolean | undefined;
  /** `true` when a second call with the same input has no further effect that a client can see. */
  readonly idempotent?: boolean | undefined;
  /**
   * The input, a `Schema.Struct`, or a `Schema.Union` of structs. With no input schema, the input is an empty object.
   */
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
  /** The operation, with an input that is already decoded. A capability with no input schema ignores its input. */
  readonly run: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], R>;
  /**
   * Decode an input that is not trusted with the input schema. The result is the call of `run` with the decoded input,
   * or the message of an input that does not decode. `make` builds it.
   */
  readonly prepare: (input: unknown) => Effect.Effect<Effect.Effect<Output["Type"], Failure["Type"], R>, string>;
  readonly pipeline: Pipeline<R>;
}

/**
 * A capability with schemas that are not known, which needs the services `R`. Each `Capability` that needs only
 * services in `R` is an `Any<R>`. An application keeps its capabilities in this form. It has the data of the catalog,
 * and calls the capability only through its `pipeline`.
 */
export interface Any<R = unknown> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly readOnly?: boolean | undefined;
  readonly destructive?: boolean | undefined;
  readonly idempotent?: boolean | undefined;
  readonly input?: AnySchema | undefined;
  readonly output?: AnySchema | undefined;
  readonly failures?: readonly AnySchema[] | undefined;
  readonly state?: { readonly schema: AnySchema } | undefined;
  readonly availability?: Effect.Effect<SubscriptionRef.SubscriptionRef<Availability>, never, R> | undefined;
  readonly pipeline: Pipeline<R>;
}

export type Services<C> = C extends Any<infer R> ? R : never;

export interface Declaration<Output extends AnySchema, Failure extends AnySchema, State extends AnySchema, Id extends string, RAvailability, RState> {
  readonly id: Id;
  readonly description: string;
  readonly audience: readonly string[];
  readonly readOnly?: boolean | undefined;
  readonly destructive?: boolean | undefined;
  readonly idempotent?: boolean | undefined;
  readonly output?: Output | undefined;
  readonly failures?: readonly Failure[] | undefined;
  readonly availability?: Effect.Effect<SubscriptionRef.SubscriptionRef<Availability>, never, RAvailability> | undefined;
  readonly state?:
    | { readonly schema: State; readonly value: Effect.Effect<SubscriptionRef.SubscriptionRef<State["Type"]>, never, RState> }
    | undefined;
}

export interface WithInput<
  Input extends AnySchema,
  Output extends AnySchema,
  Failure extends AnySchema,
  R,
  State extends AnySchema,
  Id extends string,
  RAvailability,
  RState,
> extends Declaration<Output, Failure, State, Id, RAvailability, RState> {
  readonly input: Input;
  readonly run: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], R>;
}

export interface WithoutInput<Output extends AnySchema, Failure extends AnySchema, R, State extends AnySchema, Id extends string, RAvailability, RState>
  extends Declaration<Output, Failure, State, Id, RAvailability, RState> {
  readonly input?: undefined;
  readonly run: (input: NoInput) => Effect.Effect<Output["Type"], Failure["Type"], R>;
}

/** TypeScript does not narrow a union on a property whose type is a type parameter, so this check narrows it. */
function hasInput<With extends { readonly input: object }, Without extends { readonly input?: undefined }>(
  definition: With | Without,
): definition is With {
  return definition.input !== undefined;
}

const AnyObject = Schema.Record(Schema.String, Schema.Unknown);

export function make<
  Input extends AnySchema,
  R = never,
  Output extends AnySchema = typeof Schema.Null,
  Failure extends AnySchema = typeof Schema.Never,
  State extends AnySchema = typeof Schema.Never,
  const Id extends string = string,
  RAvailability = never,
  RState = never,
>(
  definition: WithInput<Input, Output, Failure, R, State, Id, RAvailability, RState>,
): Capability<Input, Output, Failure, NoInfer<R | RAvailability | RState>, State, Id>;
export function make<
  R = never,
  Output extends AnySchema = typeof Schema.Null,
  Failure extends AnySchema = typeof Schema.Never,
  State extends AnySchema = typeof Schema.Never,
  const Id extends string = string,
  RAvailability = never,
  RState = never,
>(
  definition: WithoutInput<Output, Failure, R, State, Id, RAvailability, RState>,
): Capability<Schema.Codec<{}, never>, Output, Failure, NoInfer<R | RAvailability | RState>, State, Id>;
export function make<
  Input extends AnySchema,
  R,
  Output extends AnySchema,
  Failure extends AnySchema,
  State extends AnySchema,
  const Id extends string,
  RAvailability,
  RState,
>(
  definition:
    | WithInput<Input, Output, Failure, R, State, Id, RAvailability, RState>
    | WithoutInput<Output, Failure, R, State, Id, RAvailability, RState>,
): Capability<Input, Output, Failure, R | RAvailability | RState, State, Id> {
  const declared = {
    id: definition.id,
    description: definition.description,
    audience: definition.audience,
    readOnly: definition.readOnly,
    destructive: definition.destructive,
    idempotent: definition.idempotent,
    input: definition.input,
    output: definition.output,
    failures: definition.failures,
    state: definition.state,
    availability: definition.availability,
  };
  const state = definition.state === undefined ? undefined : Effect.map(definition.state.value, readable);
  const parts = { output: definition.output, failures: definition.failures, state };
  const finish = <In>(
    calls: {
      readonly decode: (input: unknown) => Effect.Effect<In, string>;
      readonly check: (input: unknown) => Effect.Effect<In, string>;
      readonly run: (input: In) => Effect.Effect<Output["Type"], Failure["Type"], R>;
    },
    run: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], R>,
  ): Capability<Input, Output, Failure, R | RAvailability | RState, State, Id> => ({
    ...declared,
    run,
    prepare: (input) => Effect.map(calls.decode(input), calls.run),
    pipeline: pipeline({ ...parts, ...calls }),
  });
  if (hasInput(definition)) {
    const schema = definition.input;
    return finish(
      {
        decode: (input) => Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError((error) => describe(error.issue))),
        check: (input) => (Schema.is(schema)(input) ? Effect.succeed(input) : Effect.fail(notInput)),
        run: definition.run,
      },
      definition.run,
    );
  }
  const run = definition.run;
  return finish(
    {
      decode: (input) => Schema.decodeUnknownEffect(AnyObject)(input).pipe(Effect.mapError((error) => describe(error.issue))),
      check: (input) => (Schema.is(AnyObject)(input) ? Effect.succeed(input) : Effect.fail(notInput)),
      run,
    },
    () => run({}),
  );
}

const notInput = "input: The input does not agree with the input schema.";

function pipeline<In, Value, Error, R, RState>(parts: {
  readonly decode: (input: unknown) => Effect.Effect<In, string>;
  readonly check: (input: unknown) => Effect.Effect<In, string>;
  readonly run: (input: In) => Effect.Effect<Value, Error, R>;
  readonly output: AnySchema | undefined;
  readonly failures: readonly AnySchema[] | undefined;
  readonly state: Effect.Effect<Readable<unknown>, never, RState> | undefined;
}): Pipeline<R | RState> {
  const encodeValue = Schema.encodeUnknownEffect(parts.output ?? Schema.Null);
  const encodeFailure = Schema.encodeUnknownEffect(Schema.Union(parts.failures ?? []));
  const disagrees: PipelineError = { _tag: "Disagrees" };
  const invalid = (message: string): PipelineError => ({ _tag: "InvalidInput", message });
  return {
    invoke: (untrusted) =>
      parts.decode(untrusted).pipe(
        Effect.mapError(invalid),
        Effect.flatMap((input) =>
          parts.run(input).pipe(
            Effect.matchEffect({
              onSuccess: (value) => Effect.mapError(encodeValue(value), () => disagrees),
              onFailure: (error) =>
                encodeFailure(error).pipe(
                  Effect.mapError(() => disagrees),
                  Effect.flatMap((encoded) => Effect.fail<PipelineError>({ _tag: "Failure", error: encoded })),
                ),
            }),
          ),
        ),
      ),
    execute: (decoded) =>
      parts.check(decoded).pipe(
        Effect.mapError(invalid),
        Effect.flatMap((input) => Effect.mapError(parts.run(input), (error): PipelineError => ({ _tag: "Failure", error }))),
      ),
    state: parts.state,
  };
}
