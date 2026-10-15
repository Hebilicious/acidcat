/**
 * A capability, written in Effect: Effect Schema for its input, output and failures, and an Effect program that does
 * the operation. See spec/catalog.md#capabilities.
 */
import type { Availability } from "@acid-cat/spec-ts";
import { Data, Effect, Queue, Stream, SubscriptionRef } from "effect";

import { declarations } from "./internal/declarations.ts";
import type { Schema } from "effect";

/** A schema that needs no services to decode or encode. */
export type AnySchema = Schema.Codec<any, any, never, never>;

const lazyTypeId: unique symbol = Symbol.for("@acid-cat/core-effect/Capability/Lazy");

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
  /** A capability with its schemas is not lazy: only `Capability.Lazy` has this member. */
  readonly [lazyTypeId]?: never;
}

/** A value that a session reads when it needs it, and follows for its listeners. */
export interface Current<A> {
  /**
   * The value now. A session reads it when a call comes in. It can wait: a handle then reads it in the background, and
   * gives the last value that it read until the read ends. A value that code without Effect reads at once does not wait.
   */
  readonly get: Effect.Effect<A>;
  /** The current value, then each change. */
  readonly changes: Stream.Stream<A>;
  /**
   * The value now, read with no Effect, for code that reads it often, such as a user interface that reads it on each
   * render. It gives the value that `get` gives. The constructors of this module give it.
   */
  readonly getUnsafe?: (() => A) | undefined;
}

/** The value of a `SubscriptionRef`, as a `Current`. */
export const fromSubscriptionRef = <A>(ref: SubscriptionRef.SubscriptionRef<A>): Current<A> => ({
  get: SubscriptionRef.get(ref),
  changes: SubscriptionRef.changes(ref),
  getUnsafe: () => SubscriptionRef.getUnsafe(ref),
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
  getUnsafe: () => source.getSnapshot(),
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

/**
 * Availability that is available only when each source is, for example the admission of the session and the guard of
 * an owner. When one is not, it gives the reason of the first source that is not.
 */
export const allAvailable = (...sources: readonly Current<Availability>[]): Current<Availability> => {
  const first = (values: readonly Availability[]): Availability => values.find((value) => !value.available) ?? { available: true };
  const unsafe = sources.every((source) => source.getUnsafe !== undefined);
  return {
    get: Effect.map(Effect.all(sources.map((source) => source.get)), first),
    changes: Stream.zipLatestAll(...sources.map((source) => source.changes)).pipe(Stream.map(first)),
    ...(unsafe ? { getUnsafe: () => first(sources.map((source) => source.getUnsafe!())) } : {}),
  };
};

/** The part of a capability that a lazy capability declares at once. */
export type Metadata<R> = Pick<Capability<any, any, any, R>, "id" | "description" | "audience" | "readOnly" | "availability">;

/**
 * A lazy capability did not load: its module failed, or does not agree with the declaration. `repeated` is true when
 * the load before it failed for the same reason, so that a binding logs a failure one time, not at each retry.
 */
export class LoadFailed extends Data.TaggedError("LoadFailed")<{
  readonly id: string;
  readonly reason: string;
  readonly repeated: boolean;
  readonly cause?: unknown;
}> {
  override get message() {
    return `The capability ${this.id} did not load: ${this.reason}`;
  }
}

interface LazyState {
  readonly load: () => Promise<Capability<any, any, any, any>>;
  readonly loaded: () => Capability<any, any, any, any> | undefined;
}

/**
 * A capability whose schemas and program load when they are needed. It has the metadata of a capability, and `run`,
 * which loads the module first. It has no `input`, `output`, `failures` or `state`: `load` gives the capability that
 * has them. Its type parameters are the types of that capability.
 */
export interface Lazy<Input extends AnySchema = AnySchema, Output extends AnySchema = AnySchema, Failure extends AnySchema = AnySchema, R = never>
  extends Metadata<R> {
  readonly run: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], R>;
  readonly [lazyTypeId]: LazyState;
  /** A lazy capability has no schemas and no state: load it for its schemas. */
  readonly input?: never;
  readonly output?: never;
  readonly failures?: never;
  readonly state?: never;
  /** The types of the schemas that the module gives. There is no such value. */
  readonly "~schemas"?: { readonly input: Input; readonly output: Output; readonly failure: Failure };
}

/** True if two audiences have the same targets, in the same order. */
const sameAudience = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((target, index) => target === right[index]);

/** Why the capability that a module gives does not agree with the declaration of the lazy capability, or nothing. */
function disagreement(metadata: Metadata<unknown>, module: unknown): string | undefined {
  if (typeof module !== "object" || module === null || typeof (module as { run?: unknown }).run !== "function") {
    return "the module gave no capability";
  }
  const capability = module as Capability<any, any, any, any>;
  if (capability.id !== metadata.id) return `the module gave the capability ${capability.id}`;
  if (capability.description !== metadata.description) return "the description of the module is not the description of the declaration";
  if (!sameAudience(capability.audience, metadata.audience)) return "the audience of the module is not the audience of the declaration";
  if ((capability.readOnly === true) !== (metadata.readOnly === true)) return "readOnly of the module is not readOnly of the declaration";
  if (capability.availability !== undefined && capability.availability !== metadata.availability) {
    return "the module declares its own availability: declare it in the lazy declaration only";
  }
  if (capability.state !== undefined) return "a lazy capability has no state";
  return undefined;
}

/**
 * A capability whose schemas and program load when they are needed: on its first call, when a binding writes its
 * schemas (MCP `tools/list`, a WebMCP update, the HTTP catalog), or in `App.load` before the catalog is written. The
 * metadata is declared at once, so that a session and its handles open without the module. The lazy capability has
 * the types of the capability that `load` gives, and `load` usually imports its module:
 *
 * ```ts
 * Capability.lazy({ id: "plan.generate", description, audience: ["app"] }, () => import("./plan.ts").then((m) => m.generate));
 * ```
 *
 * The capability that the module gives must have the same id, description, audience and `readOnly`, no availability
 * of its own and no state. The capability loads one time. Once it has loaded, a call runs its program in the step that
 * admits the call, with no wait. A call that is cancelled while the module loads does not stop
 * the load for other calls. A load that fails, for any reason, is forgotten, so that the next call loads again.
 */
export const lazy = <
  Input extends AnySchema = Schema.Struct<{}>,
  Output extends AnySchema = typeof Schema.Null,
  Failure extends AnySchema = typeof Schema.Never,
  R = never,
>(
  metadata: Metadata<R>,
  load: () => Promise<Capability<Input, Output, Failure, R>>,
): Lazy<Input, Output, Failure, R> => {
  let loading: Promise<Capability<any, any, any, any>> | undefined;
  let loaded: Capability<any, any, any, any> | undefined;
  let lastFailure: string | undefined;
  const loadOnce = (): Promise<Capability<any, any, any, any>> => {
    loading ??= Promise.resolve()
      .then(load)
      .then((module) => {
        const reason = disagreement(metadata, module);
        if (reason !== undefined) throw new Error(reason);
        // The metadata of the lazy capability is the one that the catalog and the view have.
        const concrete: Capability<any, any, any, any> = { ...metadata, input: module.input, output: module.output, failures: module.failures, run: module.run };
        declarations.set(concrete, lazyCapability);
        lastFailure = undefined;
        loaded = concrete;
        return concrete;
      })
      .catch((cause: unknown) => {
        loading = undefined;
        const reason = String((cause as Error)?.message ?? cause);
        const repeated = lastFailure === reason;
        lastFailure = reason;
        throw new LoadFailed({ id: metadata.id, reason, repeated, cause });
      });
    return loading;
  };
  const state: LazyState = { load: loadOnce, loaded: () => loaded };
  const lazyCapability: Lazy<Input, Output, Failure, R> = {
    ...metadata,
    run: (input) => (loaded === undefined ? Effect.flatMap(Effect.orDie(loadState(state)), (concrete) => concrete.run(input)) : loaded.run(input)),
    [lazyTypeId]: state,
  };
  return lazyCapability;
};

/** The loaded capability, at once when it has loaded, so that a call runs in the step that admits it. */
const loadState = (state: LazyState) =>
  Effect.suspend(() => {
    const loaded = state.loaded();
    return loaded === undefined ? Effect.tryPromise({ try: () => state.load(), catch: (cause) => cause as LoadFailed }) : Effect.succeed(loaded);
  });

const lazyOf = (capability: Any): LazyState | undefined => (capability as { readonly [lazyTypeId]?: LazyState })[lazyTypeId];

/** True if a capability loads its schemas and program when they are needed. */
export const isLazy = (capability: Any): capability is Lazy<any, any, any, any> => lazyOf(capability) !== undefined;

/** The capability with its schemas and program: the capability itself, or the capability that a lazy one loads. */
export const load = <R>(capability: Any<R>): Effect.Effect<Capability<any, any, any, R>, LoadFailed> => {
  const state = lazyOf(capability);
  return state === undefined ? Effect.succeed(capability as Capability<any, any, any, R>) : loadState(state);
};

/** The capability with its schemas and program, if it has them now: a lazy capability that has not loaded gives nothing. */
export const loadedNow = <R>(capability: Any<R>): Capability<any, any, any, R> | undefined => {
  const state = lazyOf(capability);
  return state === undefined ? (capability as Capability<any, any, any, R>) : state.loaded();
};

/**
 * A capability that a session can serve: one with its schemas, or a lazy one. A lazy capability matches the type of a
 * capability with no schemas, so the types below test for a lazy capability first.
 */
export type Any<R = any> = Capability<any, any, any, R> | Lazy<any, any, any, R>;

/** The services that a capability needs. */
export type Services<C> = C extends Lazy<any, any, any, infer R> ? R : C extends Capability<any, any, any, infer R> ? R : never;

/** The type of the input of a capability. */
export type InputOf<C> = C extends Lazy<infer I, any, any, any> ? I["Type"] : C extends Capability<infer I, any, any, any> ? I["Type"] : never;

/** The type of the value of a capability. */
export type ValueOf<C> = C extends Lazy<any, infer O, any, any> ? O["Type"] : C extends Capability<any, infer O, any, any> ? O["Type"] : never;

/** The type of the failures of a capability. */
export type FailureOf<C> = C extends Lazy<any, any, infer F, any> ? F["Type"] : C extends Capability<any, any, infer F, any> ? F["Type"] : never;

/** Declare a capability. */
export const make = <
  Input extends AnySchema = Schema.Struct<{}>,
  R = never,
  Output extends AnySchema = typeof Schema.Null,
  Failure extends AnySchema = typeof Schema.Never,
>(
  capability: Capability<Input, Output, Failure, R>,
): Capability<Input, Output, Failure, R> => capability;
