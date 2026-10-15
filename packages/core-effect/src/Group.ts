/**
 * Services that a group of capabilities shares, and that start on the first call to one of them. For example, the
 * runtime of one domain of an application, which a dynamic `import()` loads.
 *
 * A group has four phases:
 *
 * | Phase | What the group does |
 * | --- | --- |
 * | `dormant` | No services. The first call starts them |
 * | `starting` | One fiber builds the services. Each call waits for it |
 * | `started` | All calls share the services, until the scope of the group closes |
 * | `stopping` | The last call that waited was cancelled. The group interrupts the build and waits until it has released what it built. A new call waits too |
 * | `closed` | The scope of the group closed. Calls are interrupted |
 *
 * When the last call that waits for the services is interrupted, the group interrupts the build, and becomes dormant
 * again when the build has released what it built: a cancelled call reaches the build, and two builds never run at the
 * same time. When the build fails, the waiting calls die, so a session reports an
 * `internal` call failure, not `cancelled`, and the group becomes dormant again: the next call tries again.
 */
import { CallFailureError, callFailure } from "@acid-cat/spec-ts";
import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Schema, Scope, Semaphore, Stream, SubscriptionRef } from "effect";

import type * as Capability from "./Capability.ts";
import { notify } from "./internal/listeners.ts";

export type Phase = "dormant" | "starting" | "started" | "stopping" | "closed";

/** The services of a group did not start. A call that needs them dies with this error. */
export class StartFailed extends Data.TaggedError("StartFailed")<{ readonly cause: Cause.Cause<unknown> }> {
  override get message() {
    return `The services of the group did not start: ${Cause.pretty(this.cause)}`;
  }
}

export interface Group<S> {
  /**
   * Run an effect with the services of the group. The first call starts them. The effect runs in the lifetime of the
   * group: when the group closes, it is interrupted before the services are released, and the call is cancelled.
   */
  readonly provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, S>>;
  /** Start the services, if they are dormant, and wait until they run. */
  readonly start: Effect.Effect<void>;
  /**
   * `start` for code that does not use Effect. The signal stops the wait, and the start too when no other call waits
   * for it: the promise then rejects with the reason of the signal. For a closed group, it rejects with the call failure
   * `cancelled`. For a start that fails, it rejects with `StartFailed`.
   */
  readonly startPromise: (options?: { readonly signal?: AbortSignal | undefined }) => Promise<void>;
  /**
   * A value of the services for code that does not use Effect, for example a value that a user interface shows. It is
   * the value of `select` once the services run, `dormant` before, and `closed` after the group closes. Listeners hear
   * each change at once, and subscribing does not start the services. With no `dormant`, reading the value before the
   * services run is an error.
   */
  readonly observe: <A>(
    select: (services: Context.Context<S>) => Capability.Observable<A>,
    values?: { readonly dormant?: A; readonly closed?: A },
  ) => Capability.Observable<A>;
  /** Read the services if they run now, or give `undefined`. It never starts them. */
  readonly peek: <A>(select: (services: Context.Context<S>) => A) => A | undefined;
  /** The phase of the group. */
  readonly phase: Capability.Current<Phase>;
  /**
   * A value that comes from the services once they run: for example the availability or the state of a capability.
   * Before the services run, the value is `dormant`. After the group closes, it is `closed`, or else `dormant`. Reading
   * the value does not start the services.
   */
  readonly current: <A>(
    select: (services: Context.Context<S>) => Capability.Current<A>,
    values: { readonly dormant: A; readonly closed?: A | undefined },
  ) => Capability.Current<A>;
}

type State<S> =
  | { readonly phase: "dormant" }
  | {
      readonly phase: "starting";
      readonly build: Fiber.Fiber<void>;
      readonly done: Deferred.Deferred<Exit.Exit<Context.Context<S>, unknown>>;
      readonly waiting: number;
    }
  | { readonly phase: "started"; readonly services: Context.Context<S> }
  | { readonly phase: "stopping"; readonly stopped: Deferred.Deferred<void> }
  | { readonly phase: "closed" };

/**
 * Make a group from the layer of its services, or from an Effect that gives the layer, for example one that imports
 * a module. The services are built in the scope of the group, and released when it closes.
 */
export const make = <S, E, R>(
  services: Layer.Layer<S, E, R> | Effect.Effect<Layer.Layer<S, E, R>, E, R>,
): Effect.Effect<Group<S>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const scope = yield* Effect.scope;
    const state = yield* SubscriptionRef.make<State<S>>({ phase: "dormant" });
    const lock = yield* Semaphore.make(1);
    // The services live in their own scope, which closes after the finalizer of the group has cancelled the calls.
    const servicesScope = yield* Scope.fork(scope);
    // The calls that use the services. Closing the group interrupts them before it releases the services.
    const calls = yield* FiberSet.make<unknown, unknown>();
    // Code that does not use Effect hears each change of the phase at once, in the fiber that makes it.
    const phaseListeners = new Set<() => void>();
    // A listener that throws does not stop the group: `notify` logs its error, and calls the other listeners.
    const setState = (next: State<S>) =>
      SubscriptionRef.set(state, next).pipe(Effect.andThen(notify(phaseListeners, undefined, "A listener of a group failed")));
    const locked = lock.withPermits(1);

    /** Build the services in their own scope. If the build does not succeed, release what it built. */
    const build = Effect.gen(function* () {
      const layer = Layer.isLayer(services)
        ? (services as Layer.Layer<S, E, R>)
        : yield* services as Effect.Effect<Layer.Layer<S, E, R>, E, R>;
      const own = yield* Scope.fork(servicesScope);
      return yield* Layer.buildWithScope(layer, own).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(own, exit))));
    }).pipe(Effect.provideContext(context));

    /** Record the end of a build, if the group still waits for it. */
    const settle = (done: Deferred.Deferred<Exit.Exit<Context.Context<S>, unknown>>, exit: Exit.Exit<Context.Context<S>, unknown>) =>
      locked(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current.phase !== "starting" || current.done !== done) return;
          yield* setState(Exit.isSuccess(exit) ? { phase: "started", services: exit.value } : { phase: "dormant" });
        }),
      ).pipe(Effect.andThen(Deferred.succeed(done, exit)));

    /** Join the build, and start it if no build runs. */
    const join = locked(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        switch (current.phase) {
          case "started":
          case "stopping":
          case "closed":
            return current;
          case "starting": {
            const next = { ...current, waiting: current.waiting + 1 };
            yield* setState(next);
            return next;
          }
          case "dormant": {
            const done = yield* Deferred.make<Exit.Exit<Context.Context<S>, unknown>>();
            const fiber = yield* build.pipe(
              Effect.exit,
              Effect.flatMap((exit) => settle(done, exit)),
              Effect.asVoid,
              Effect.forkIn(scope, { startImmediately: true }),
            );
            const next = { phase: "starting" as const, build: fiber, done, waiting: 1 };
            yield* setState(next);
            return next;
          }
        }
      }),
    );

    /**
     * A call that waited for the build was interrupted. The last one interrupts the build. The group stays `stopping`
     * until the build has released what it built, so that no new build starts before that.
     */
    const leave = (done: Deferred.Deferred<Exit.Exit<Context.Context<S>, unknown>>) =>
      locked(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current.phase !== "starting" || current.done !== done) return undefined;
          if (current.waiting > 1) {
            yield* setState({ ...current, waiting: current.waiting - 1 });
            return undefined;
          }
          const stopped = yield* Deferred.make<void>();
          yield* setState({ phase: "stopping", stopped });
          return { build: current.build, stopped };
        }),
      ).pipe(
        Effect.flatMap((stopping) =>
          stopping === undefined
            ? Effect.void
            : Fiber.interrupt(stopping.build).pipe(
                Effect.andThen(
                  locked(
                    Effect.gen(function* () {
                      const current = yield* SubscriptionRef.get(state);
                      if (current.phase === "stopping" && current.stopped === stopping.stopped) yield* setState({ phase: "dormant" });
                    }),
                  ),
                ),
                Effect.andThen(Deferred.succeed(stopping.stopped, undefined)),
              ),
        ),
      );

    const acquire: Effect.Effect<Context.Context<S>> = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let joined = yield* join;
        while (joined.phase === "stopping") {
          yield* restore(Deferred.await(joined.stopped));
          joined = yield* join;
        }
        if (joined.phase === "started") return joined.services;
        if (joined.phase === "closed") return yield* Effect.interrupt;
        const waited = yield* restore(Deferred.await(joined.done)).pipe(Effect.exit);
        if (Exit.isFailure(waited)) {
          yield* leave(joined.done);
          return yield* Effect.interrupt;
        }
        const exit = waited.value;
        if (Exit.isSuccess(exit)) return exit.value;
        if (Cause.hasInterruptsOnly(exit.cause) && (yield* SubscriptionRef.get(state)).phase === "closed") {
          return yield* Effect.interrupt;
        }
        return yield* Effect.die(new StartFailed({ cause: exit.cause }));
      }),
    );

    yield* Scope.addFinalizer(
      scope,
      locked(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          yield* setState({ phase: "closed" });
          return current;
        }),
      ).pipe(
        // A call that waits for the build leaves under the lock, so the calls are cancelled after the lock is free.
        Effect.tap(() => FiberSet.clear(calls)),
        Effect.flatMap((last) => {
          if (last.phase === "starting") return Fiber.interrupt(last.build).pipe(Effect.andThen(Deferred.succeed(last.done, Exit.interrupt())));
          if (last.phase === "stopping") return Deferred.await(last.stopped);
          return Effect.void;
        }),
      ),
    );

    const phase: Capability.Current<Phase> = {
      get: Effect.map(SubscriptionRef.get(state), (current) => current.phase),
      changes: SubscriptionRef.changes(state).pipe(
        Stream.map((current) => current.phase),
        Stream.changes,
      ),
    };

    const current = <A>(
      select: (services: Context.Context<S>) => Capability.Current<A>,
      values: { readonly dormant: A; readonly closed?: A | undefined },
    ): Capability.Current<A> => {
      let selected: { readonly services: Context.Context<S>; readonly value: Capability.Current<A> } | undefined;
      const from = (services: Context.Context<S>) => {
        if (selected?.services !== services) selected = { services, value: select(services) };
        return selected.value;
      };
      const idle = (current: State<S>) => (current.phase === "closed" ? (values.closed ?? values.dormant) : values.dormant);
      return {
        get: Effect.flatMap(SubscriptionRef.get(state), (current) =>
          current.phase === "started" ? from(current.services).get : Effect.succeed(idle(current)),
        ),
        getUnsafe: () => {
          const current = SubscriptionRef.getUnsafe(state);
          if (current.phase !== "started") return idle(current);
          const selected = from(current.services);
          return selected.getUnsafe === undefined ? Effect.runSync(selected.get) : selected.getUnsafe();
        },
        changes: SubscriptionRef.changes(state).pipe(
          Stream.changesWith((left, right) => left.phase === right.phase),
          Stream.switchMap((current) => (current.phase === "started" ? from(current.services).changes : Stream.make(idle(current)))),
        ),
      };
    };

    const startPromise = async (options: { readonly signal?: AbortSignal | undefined } = {}): Promise<void> => {
      const exit = await Effect.runPromiseExit(acquire, options.signal === undefined ? {} : { signal: options.signal });
      if (Exit.isSuccess(exit)) return;
      if (options.signal?.aborted === true && Cause.hasInterruptsOnly(exit.cause)) throw options.signal.reason;
      if (Cause.hasInterruptsOnly(exit.cause)) throw new CallFailureError(callFailure("cancelled", "The group is closed."));
      throw Cause.squash(exit.cause);
    };

    const peek = <A>(select: (services: Context.Context<S>) => A): A | undefined => {
      const now = SubscriptionRef.getUnsafe(state);
      return now.phase === "started" ? select(now.services) : undefined;
    };

    const observe = <A>(
      select: (services: Context.Context<S>) => Capability.Observable<A>,
      values: { readonly dormant?: A; readonly closed?: A } = {},
    ): Capability.Observable<A> => {
      let selected: { readonly services: Context.Context<S>; readonly value: Capability.Observable<A> } | undefined;
      const from = (services: Context.Context<S>) => {
        if (selected?.services !== services) selected = { services, value: select(services) };
        return selected.value;
      };
      /** What the value comes from now: the services, the closed value, or the dormant value. */
      const kind = (): "started" | "closed" | "dormant" => {
        const phase = SubscriptionRef.getUnsafe(state).phase;
        return phase === "started" ? "started" : phase === "closed" && "closed" in values ? "closed" : "dormant";
      };
      const getSnapshot = (): A => {
        const now = SubscriptionRef.getUnsafe(state);
        if (now.phase === "started") return from(now.services).getSnapshot();
        if (now.phase === "closed" && "closed" in values) return values.closed as A;
        if ("dormant" in values) return values.dormant as A;
        if (now.phase === "closed") throw new Error("The group is closed, so this value does not exist any more.");
        throw new Error(`The group has not started, so this value does not exist yet. Start the group before reading it.`);
      };
      return {
        getSnapshot,
        subscribe(listener) {
          let inner: { unsubscribe(): void } | undefined;
          let last = kind();
          const follow = () => {
            const now = SubscriptionRef.getUnsafe(state);
            if (now.phase === "started" && inner === undefined) inner = from(now.services).subscribe(listener);
            if (now.phase !== "started" && inner !== undefined) {
              inner.unsubscribe();
              inner = undefined;
            }
          };
          const onPhase = () => {
            follow();
            const next = kind();
            if (next === last) return;
            last = next;
            if (next !== "dormant" || "dormant" in values) listener(getSnapshot());
          };
          phaseListeners.add(onPhase);
          follow();
          return {
            unsubscribe() {
              phaseListeners.delete(onPhase);
              inner?.unsubscribe();
            },
          };
        },
      };
    };

    return {
      // The call is a fiber of the group before it asks for the services, so a close at any time cancels it.
      provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        FiberSet.run(
          calls,
          Effect.flatMap(acquire, (services) => Effect.provideContext(effect, services)),
        ).pipe(Effect.flatMap((fiber) => Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))))) as Effect.Effect<A, E, Exclude<R, S>>,
      start: Effect.asVoid(acquire),
      startPromise,
      phase,
      current,
      observe,
      peek,
    } satisfies Group<S>;
  });

/**
 * A capability that runs inside a group. `run` can use the services of the group: each call starts the group if it is
 * dormant, as a part of the call, and runs in the lifetime of the group, as `group.provide` does. The capability needs
 * the service of the group, not the services in it. Its availability and state can come from the group with
 * `group.current`.
 */
export const capability = <
  Self,
  S,
  Input extends Capability.AnySchema = Schema.Struct<{}>,
  R = never,
  Output extends Capability.AnySchema = typeof Schema.Null,
  Failure extends Capability.AnySchema = typeof Schema.Never,
>(
  group: Context.Key<Self, Group<S>>,
  definition: Omit<Capability.Capability<Input, Output, Failure, R>, "run"> & {
    readonly run: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], R | S>;
  },
): Capability.Capability<Input, Output, Failure, Exclude<R, S> | Self> => ({
  ...(definition as Omit<Capability.Capability<Input, Output, Failure, Exclude<R, S> | Self>, "run">),
  run: (input) => Effect.flatMap(group, (running) => running.provide(definition.run(input))) as Effect.Effect<Output["Type"], Failure["Type"], Exclude<R, S> | Self>,
});
