/**
 * The TypeScript binding (spec/bindings/typescript.md): handles with promises and observables, for code that does not
 * use Effect. For example, a component of a user interface, or a library that takes handles.
 *
 * The handles use a session of Effect. The program that opens the session keeps its services and its scope.
 */
import { CallFailureError, callFailure } from "@acid-cat/spec-ts";
import type { Availability, Result } from "@acid-cat/spec-ts";
import { Cause, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect";

import type * as App from "./App.ts";
import type * as Capability from "./Capability.ts";
import { sameAvailability } from "./internal/availability.ts";
import * as Session from "./Session.ts";

/** A value that changes, and that code without Effect can read and observe. */
export type Observable<T> = Capability.Observable<T>;

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

/** A source of values with listeners. */
function observable<T>(initial: T) {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    set(value: T) {
      current = value;
      listeners.forEach((listener) => listener(value));
    },
    observable: {
      getSnapshot: () => current,
      subscribe(listener: (value: T) => void) {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    } satisfies Observable<T>,
  };
}

/**
 * The availability of one capability as an observable. `getSnapshot` reads the session now, so code that does not use
 * Effect sees a change of a `Current` availability at once. It gives the same object while the value stays the same.
 * When the session announces a change, listeners hear the value that `getSnapshot` gives at that moment, and never the
 * same value two times in a row. Values that changed again before the listeners were told are skipped.
 */
const followAvailability = (session: Session.Session, id: string, changes: boolean) =>
  Effect.gen(function* () {
    let snapshot = yield* session.availability(id);
    let delivered = snapshot;
    const listeners = new Set<(value: Availability) => void>();
    const keep = (value: Availability) => {
      if (!sameAvailability(snapshot, value)) snapshot = value;
    };
    /** The value now, or `otherwise` when the read waits. */
    const readOr = (otherwise: Availability): Availability => {
      const exit = Effect.runSyncExit(session.availability(id));
      keep(Exit.isSuccess(exit) ? exit.value : otherwise);
      return snapshot;
    };
    const read = (): Availability => readOr(snapshot);
    if (changes) {
      yield* session.availabilityChanges(id).pipe(
        Stream.runForEach((next) =>
          Effect.sync(() => {
            // The announced value can be old by now: the listeners hear the value of the moment.
            const current = readOr(next);
            if (sameAvailability(delivered, current)) return;
            delivered = current;
            listeners.forEach((listener) => listener(current));
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
    }
    return {
      getSnapshot: read,
      subscribe(listener: (value: Availability) => void) {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    } satisfies Observable<Availability>;
  });

/** A copy of each value, so that a client cannot change the data of the provider. */
const detached = <T>(source: Observable<T>): Observable<T> => ({
  getSnapshot: () => structuredClone(source.getSnapshot()),
  subscribe: (listener) => source.subscribe((value) => listener(structuredClone(value))),
});

/**
 * The handles of a session, by id. The handles work while the scope is open. When it closes, the observables stop
 * and the calls in progress are cancelled.
 */
export const make = <R>(app: App.App<R>, session: Session.Session): Effect.Effect<ReadonlyMap<string, Handle>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    const lifetime = new AbortController();
    yield* Scope.addFinalizer(scope, Effect.sync(() => lifetime.abort()));

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
    for (const [id, capability] of session.capabilities) {
      // Each handle follows the availability of its own capability, so a change reaches one handle.
      const availability = yield* followAvailability(session, id, capability.availability !== undefined);

      let snapshot: Observable<unknown> | undefined;
      if (capability.state !== undefined) {
        // The stream gives the current value first. Wait for it, so that `getSnapshot` always has a value.
        const first = yield* Deferred.make<void>();
        const state = observable<unknown>(undefined);
        yield* session.state(id).pipe(
          Stream.runForEach((value) => Effect.sync(() => state.set(value)).pipe(Effect.andThen(Deferred.succeed(first, undefined)))),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        yield* Deferred.await(first);
        snapshot = detached(state.observable);
      }

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
