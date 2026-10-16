/**
 * The TypeScript binding (spec/bindings/typescript.md): handles with promises and observables, for code that does not
 * use Effect. For example, a component of a user interface, or a library that takes handles.
 *
 * The handles use a session of Effect. The program that opens the session keeps its services and its scope.
 */
import { AVAILABLE, CallFailureError, callFailure } from "@acid-cat/spec-ts";
import type { Availability, Result } from "@acid-cat/spec-ts";
import { Cause, Effect, Exit, Fiber, FiberSet, Layer, Schema, Scope, Stream, SubscriptionRef } from "effect";

import type * as App from "./App.ts";
import type * as Capability from "./Capability.ts";
import { changesAfter } from "./internal/changes.ts";
import { refsOf } from "./internal/served.ts";
import * as Session from "./Session.ts";

/** A value that changes, and that code without Effect can read and observe. */
export interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: (value: T) => void): { unsubscribe(): void };
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface Handle {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly availability: Observable<Availability>;
  /** The state of the capability, if it has one, in its JSON form. Each value is a copy. */
  readonly snapshot?: Observable<unknown>;
  /** A call with an input that is already decoded. A call failure rejects with a `CallFailureError`. */
  execute(input: unknown, options?: CallOptions): Promise<Result<unknown, unknown>>;
  /** A call with an input that is not trusted. The result is in its JSON form. */
  invokeExternal(input: unknown, options?: CallOptions): Promise<Result<unknown, unknown>>;
}

/** A value that never changes. */
const constant = <T>(value: T): Observable<T> => ({ getSnapshot: () => value, subscribe: () => ({ unsubscribe() {} }) });

/**
 * An observable of a ref. `getSnapshot` reads the ref. The observable follows the ref only while it has listeners: one
 * follower starts with the first listener, and stops after the last listener unsubscribes. A listener gets the value
 * of the ref at the moment that it is delivered, and never the same value two times in sequence.
 */
function observe<A, T>(
  ref: SubscriptionRef.SubscriptionRef<A>,
  read: (value: A) => T,
  follow: (effect: Effect.Effect<void>) => Fiber.Fiber<void>,
): Observable<T> {
  const listeners = new Set<(value: T) => void>();
  let follower: Fiber.Fiber<void> | undefined;
  return {
    getSnapshot: () => read(SubscriptionRef.getUnsafe(ref)),
    subscribe(listener) {
      listeners.add(listener);
      follower ??= follow(
        changesAfter(ref, SubscriptionRef.getUnsafe(ref)).pipe(
          Stream.runForEach((value) =>
            Effect.sync(() => {
              const delivered = read(value);
              listeners.forEach((each) => each(delivered));
            }),
          ),
        ),
      );
      return {
        unsubscribe() {
          if (!listeners.delete(listener) || listeners.size > 0) return;
          follower?.interruptUnsafe();
          follower = undefined;
        },
      };
    },
  };
}

/**
 * The synchronous encoder of a state schema. `getSnapshot` is synchronous, so a handle needs a state schema that
 * encodes synchronously. Encode the current value one time to check this.
 */
function synchronousEncoder(id: string, schema: Capability.AnySchema, current: unknown): (value: unknown) => unknown {
  const encode = Schema.encodeUnknownSync(schema as Schema.Codec<unknown, unknown>);
  try {
    encode(current);
  } catch (cause) {
    if (Schema.isSchemaError(cause)) throw cause;
    throw new Error(`The state schema of ${id} does not encode synchronously. A handle needs a state schema that encodes synchronously.`, { cause });
  }
  return encode;
}

/** A copy of each value, so that a client cannot change the data of the provider. */
const detached = <T>(source: Observable<T>): Observable<T> => ({
  getSnapshot: () => structuredClone(source.getSnapshot()),
  subscribe: (listener) => source.subscribe((value) => listener(structuredClone(value))),
});

/**
 * The handles of a session, by id. The handles work while the scope is open. When it closes, the observables stop
 * and the calls in progress are cancelled. The handles start no fiber until a listener subscribes. The session must
 * come from `Session.make`.
 */
export const make = <R>(app: App.App<R>, session: Session.Session): Effect.Effect<ReadonlyMap<string, Handle>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    const lifetime = new AbortController();
    yield* Scope.addFinalizer(scope, Effect.sync(() => lifetime.abort()));
    const follow = yield* FiberSet.runtime(yield* FiberSet.make<void>())();
    const refs = refsOf(session);

    /** Run a call as a promise. The signal of the call and the scope interrupt it, as `cancelled`. */
    const run = <A>(effect: Effect.Effect<A, unknown>, options: CallOptions | undefined): Promise<A> => {
      const signal = AbortSignal.any([lifetime.signal, ...(options?.signal ? [options.signal] : [])]);
      if (signal.aborted) return Promise.reject(new CallFailureError(callFailure("cancelled", "The call was cancelled.")));
      return Effect.runPromiseExitWith(context)(effect, { signal }).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        if (Cause.hasInterruptsOnly(exit.cause)) throw new CallFailureError(callFailure("cancelled", "The call was cancelled."));
        throw Cause.squash(exit.cause);
      });
    };

    const handles = new Map<string, Handle>();
    for (const capability of app.capabilities) {
      if (!capability.audience.includes(session.target)) continue;
      const id = capability.id;

      const availabilityRef = refs.availability(id);
      const availability = availabilityRef === undefined ? constant(AVAILABLE) : observe(availabilityRef, (value) => value, follow);

      const stateRef = refs.state(id);
      const snapshot =
        stateRef === undefined || capability.state === undefined
          ? undefined
          : detached(observe(stateRef, synchronousEncoder(id, capability.state.schema, SubscriptionRef.getUnsafe(stateRef)), follow));

      handles.set(id, {
        id,
        description: capability.description,
        audience: [session.target],
        availability,
        ...(snapshot === undefined ? {} : { snapshot }),
        execute: (input, options) =>
          run(
            session.execute(capability, input as never).pipe(
              Effect.map((value) => ({ ok: true as const, value })),
              Effect.catch((error: unknown) =>
                error instanceof Session.CallFailed
                  ? Effect.die(new CallFailureError(error))
                  : Effect.succeed({ ok: false as const, error }),
              ),
            ),
            options,
          ),
        invokeExternal: (input, options) =>
          run(
            session.invoke(id, input).pipe(
              Effect.flatMap((outcome) => ("kind" in outcome ? Effect.die(new CallFailureError(outcome)) : Effect.succeed(outcome))),
            ),
            options,
          ),
      });
    }
    return handles as ReadonlyMap<string, Handle>;
  });

/** A session for code that does not use Effect. */
export interface PromiseSession {
  readonly target: string;
  /** The view of the target. */
  readonly view: Session.Session["view"];
  /** The handles of the capabilities in the view, by id. */
  readonly handles: ReadonlyMap<string, Handle>;
  /** The signal of the session. It aborts when the session closes. */
  readonly signal: AbortSignal;
  /** Close the session: cancel the calls in progress, and wait for them. */
  dispose(): Promise<void>;
}

/** Open a session and its handles from code that does not use Effect. `layer` gives the services of the capabilities. */
export async function open<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: { readonly target: string }): Promise<PromiseSession> {
  const scope = Effect.runSync(Scope.make());
  const lifetime = new AbortController();
  const { session, handles } = await Effect.runPromise(
    Effect.gen(function* () {
      // The services live as long as the session.
      const services = yield* Layer.buildWithScope(layer, scope);
      const session = yield* Session.make(app, options).pipe(Effect.provideContext(services));
      return { session, handles: yield* make(app, session) };
    }).pipe(Scope.provide(scope)),
  );
  return {
    target: session.target,
    get view() {
      return session.view;
    },
    handles,
    signal: lifetime.signal,
    async dispose() {
      lifetime.abort();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}
