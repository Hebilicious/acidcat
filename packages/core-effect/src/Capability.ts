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
  /**
   * The value now. A session reads it when a call comes in. It can wait: a handle then reads it in the background, and
   * gives the last value that it read until the read ends. A value that code without Effect reads at once does not wait.
   */
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

/**
 * Availability that is available only when each source is, for example the admission of the session and the guard of
 * an owner. When one is not, it gives the reason of the first source that is not.
 */
export const allAvailable = (...sources: readonly Current<Availability>[]): Current<Availability> => {
  const first = (values: readonly Availability[]): Availability => values.find((value) => !value.available) ?? { available: true };
  return {
    get: Effect.map(Effect.all(sources.map((source) => source.get)), first),
    changes: Stream.zipLatestAll(...sources.map((source) => source.changes)).pipe(Stream.map(first)),
  };
};

const lazyTypeId: unique symbol = Symbol.for("@acid-cat/core-effect/Capability/Lazy");

/** The part of a capability that a lazy capability declares at once. */
export type Metadata<R> = Pick<Capability<any, any, any, R>, "id" | "description" | "audience" | "readOnly" | "availability">;

/** A lazy capability did not load: its module failed. A call to it gives the call failure `internal`. */
export class LoadFailed extends Error {
  constructor(id: string, cause: unknown) {
    super(`The capability ${id} did not load.`, { cause });
    this.name = "LoadFailed";
  }
}

interface Lazy {
  readonly load: () => Promise<Any>;
  readonly loaded: () => Any | undefined;
}

/**
 * A capability whose schemas and program load when they are needed: on its first call, when a binding writes its
 * schemas (MCP `tools/list`, a WebMCP update), or in `App.load` before the catalog is written. The metadata is
 * declared at once, so that a session and its handles open without the module. The capability has the types of the
 * capability that `load` gives, and `load` usually imports its module:
 *
 * ```ts
 * Capability.lazy({ id: "plan.generate", description, audience: ["app"] }, () => import("./plan.ts").then((m) => m.generate));
 * ```
 *
 * The capability loads one time. A call that is cancelled while the module loads does not stop the load for other
 * calls. A load that fails is forgotten, so that the next call loads again. A lazy capability has no state.
 */
export const lazy = <
  Input extends AnySchema = Schema.Struct<{}>,
  Output extends AnySchema = typeof Schema.Null,
  Failure extends AnySchema = typeof Schema.Never,
  R = never,
>(
  metadata: Metadata<R>,
  load: () => Promise<Capability<Input, Output, Failure, R>>,
): Capability<Input, Output, Failure, R> => {
  let loading: Promise<Any> | undefined;
  let loaded: Any | undefined;
  const loadOnce = (): Promise<Any> => {
    loading ??= load().then(
      (module): Any => {
        // The metadata of the lazy capability is the one that the catalog and the view have.
        loaded = { ...metadata, input: module.input, output: module.output, failures: module.failures, run: module.run };
        return loaded;
      },
      (cause: unknown) => {
        loading = undefined;
        throw new LoadFailed(metadata.id, cause);
      },
    );
    return loading;
  };
  const lazyCapability = {
    ...metadata,
    run: (input: Input["Type"]) => Effect.flatMap(loadEffect(lazyCapability as Any), (concrete) => concrete.run(input)),
    [lazyTypeId]: { load: loadOnce, loaded: () => loaded } satisfies Lazy,
  };
  return lazyCapability as unknown as Capability<Input, Output, Failure, R>;
};

const lazyOf = (capability: Any): Lazy | undefined => (capability as { readonly [lazyTypeId]?: Lazy })[lazyTypeId];

/** True if a capability loads its schemas and program when they are needed. */
export const isLazy = (capability: Any): boolean => lazyOf(capability) !== undefined;

const loadEffect = (capability: Any): Effect.Effect<Any> => {
  const lazily = lazyOf(capability);
  return lazily === undefined ? Effect.succeed(capability) : Effect.orDie(Effect.tryPromise({ try: () => lazily.load(), catch: (cause) => cause }));
};

/**
 * The capability with its schemas and program: the capability itself, or the capability that a lazy one loads. A load
 * that fails is a defect (`LoadFailed`), which a session gives as the call failure `internal`.
 */
export const load = (capability: Any): Effect.Effect<Any> => loadEffect(capability);

/** The capability with its schemas and program, if it has them now: a lazy capability that has not loaded gives nothing. */
export const loadedNow = (capability: Any): Any | undefined => {
  const lazily = lazyOf(capability);
  return lazily === undefined ? capability : lazily.loaded();
};

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
