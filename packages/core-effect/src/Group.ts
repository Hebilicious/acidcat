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
import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, Layer, Scope, Semaphore, Stream, SubscriptionRef } from "effect";

import type * as Capability from "./Capability.ts";

export type Phase = "dormant" | "starting" | "started" | "stopping" | "closed";

/** The services of a group did not start. A call that needs them dies with this error. */
export class StartFailed extends Data.TaggedError("StartFailed")<{ readonly cause: Cause.Cause<unknown> }> {
  override get message() {
    return `The services of the group did not start: ${Cause.pretty(this.cause)}`;
  }
}

export interface Group<S> {
  /** Run an effect with the services of the group. The first call starts them. */
  readonly provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, S>>;
  /** Start the services, if they are dormant, and wait until they run. */
  readonly start: Effect.Effect<void>;
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
    const locked = lock.withPermits(1);

    /** Build the services in their own scope. If the build does not succeed, release what it built. */
    const build = Effect.gen(function* () {
      const layer = Layer.isLayer(services)
        ? (services as Layer.Layer<S, E, R>)
        : yield* services as Effect.Effect<Layer.Layer<S, E, R>, E, R>;
      const own = yield* Scope.fork(scope);
      return yield* Layer.buildWithScope(layer, own).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(own, exit))));
    }).pipe(Effect.provideContext(context));

    /** Record the end of a build, if the group still waits for it. */
    const settle = (done: Deferred.Deferred<Exit.Exit<Context.Context<S>, unknown>>, exit: Exit.Exit<Context.Context<S>, unknown>) =>
      locked(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current.phase !== "starting" || current.done !== done) return;
          yield* SubscriptionRef.set(state, Exit.isSuccess(exit) ? { phase: "started", services: exit.value } : { phase: "dormant" });
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
            yield* SubscriptionRef.set(state, next);
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
            yield* SubscriptionRef.set(state, next);
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
            yield* SubscriptionRef.set(state, { ...current, waiting: current.waiting - 1 });
            return undefined;
          }
          const stopped = yield* Deferred.make<void>();
          yield* SubscriptionRef.set(state, { phase: "stopping", stopped });
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
                      if (current.phase === "stopping" && current.stopped === stopping.stopped) yield* SubscriptionRef.set(state, { phase: "dormant" });
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
          yield* SubscriptionRef.set(state, { phase: "closed" });
          return current;
        }),
      ).pipe(
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
        changes: SubscriptionRef.changes(state).pipe(
          Stream.changesWith((left, right) => left.phase === right.phase),
          Stream.switchMap((current) => (current.phase === "started" ? from(current.services).changes : Stream.make(idle(current)))),
        ),
      };
    };

    return {
      provide: (effect) => Effect.flatMap(acquire, (services) => Effect.provideContext(effect, services)),
      start: Effect.asVoid(acquire),
      phase,
      current,
    } satisfies Group<S>;
  });
