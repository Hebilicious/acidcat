/**
 * The TypeScript binding (spec/bindings/typescript.md): handles with promises and observables, for code that does not
 * use Effect. For example, a component of a user interface, or a library that takes handles.
 *
 * The handles use a session of Effect. The program that opens the session keeps its services and its scope.
 */
import { CallFailureError, callFailure } from "@acid-cat/spec-ts";
import type { Availability, Result } from "@acid-cat/spec-ts";
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Scope, Stream } from "effect";

import type * as App from "./App.ts";
import type * as Capability from "./Capability.ts";
import { sameAvailability } from "./internal/availability.ts";
import { notify } from "./internal/listeners.ts";
import * as Session from "./Session.ts";

/** A value that changes, and that code without Effect can read and observe. */
export type Observable<T> = Capability.Observable<T>;

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

/**
 * The handle of one capability (spec/bindings/typescript.md#handles). `Input`, `Value` and `Failure` are the types of
 * the capability's schemas. `HandleOf` gives them for a capability.
 */
export interface Handle<Input = unknown, Value = unknown, Failure = unknown, State = unknown> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly availability: Observable<Availability>;
  /** The state of the capability, if it has one, in its JSON form. Each value is a copy. */
  readonly snapshot?: Observable<State>;
  /** A call with an input that is already decoded. A call failure rejects with a `CallFailureError`. */
  execute(input: Input, options?: CallOptions): Promise<Result<Value, Failure>>;
  /** A call with an input that is not trusted. The result is in its JSON form. */
  invokeExternal(input: unknown, options?: CallOptions): Promise<Result<unknown, unknown>>;
}

/** The handle of a capability, with the types of its schemas. */
export type HandleOf<C> =
  C extends Capability.Capability<infer Input, infer Output, infer Failure, any>
    ? Handle<Input["Type"], Output["Type"], Failure["Type"]>
    : never;

const leafTypeId: unique symbol = Symbol.for("@acid-cat/core-effect/Handles/Leaf");

/**
 * A value that a handle can give as a copy: data that `structuredClone` copies. A function is not data, so a type with
 * a function in it is not such a value. A copy of a class instance is a plain object: it has the data of the instance,
 * not its prototype.
 */
export type Detachable<T> = T extends (...args: never[]) => unknown ? never : T extends object ? { readonly [K in keyof T]: Detachable<T[K]> } : T;

/**
 * The check of `Handles.leaf` that a snapshot is data: no condition when `State` is `Detachable`, and a member that no
 * value has when it is not. A helper that is generic over the snapshot puts it on its own parameter, so that its
 * callers get the check, and it calls `leaf` with no cast.
 */
export type OnlyData<State> = [State] extends [Detachable<State>] ? unknown : { readonly "a snapshot is data that structuredClone copies, with no functions": never };

/** The mark of a leaf whose snapshot is an Effect, which only `treeWith` can read. */
declare const readsServices: unique symbol;
type ReadsServices = typeof readsServices;

/**
 * A capability with a snapshot that the application gives to its handle. The TypeScript binding allows a handle to have
 * a snapshot for code in the same process when the catalog has no state (spec/bindings/typescript.md#handles), for
 * example a large typed value of the provider that a user interface reads as it is. The handle gives each value as a
 * copy.
 */
export interface Leaf<C extends Capability.Any, State, R> {
  readonly [leafTypeId]: true;
  readonly capability: C;
  readonly snapshot: Observable<State> | Effect.Effect<Observable<State>, never, Exclude<R, ReadsServices>>;
}

/**
 * A capability with the snapshot of its handle. The snapshot can be an Effect that reads it from the services: only
 * `treeWith` reads such a leaf. A capability with `state` gives its state through its handle, so it cannot be a leaf.
 */
export function leaf<C extends Capability.Any, State>(
  capability: C,
  options: { readonly snapshot: Observable<State> } & OnlyData<State>,
): Leaf<C, State, never>;
export function leaf<C extends Capability.Any, State, R>(
  capability: C,
  options: { readonly snapshot: Effect.Effect<Observable<State>, never, R> } & OnlyData<State>,
): Leaf<C, State, R | ReadsServices>;
export function leaf<C extends Capability.Any, State, R>(
  capability: C,
  options: { readonly snapshot: Observable<State> | Effect.Effect<Observable<State>, never, R> },
): Leaf<C, State, R> {
  if (capability.state !== undefined) {
    throw new Error(`The capability ${capability.id} has state, which its handle gives. A leaf gives a snapshot only to a capability with no state.`);
  }
  return Object.freeze({ [leafTypeId]: true as const, capability, snapshot: options.snapshot as Observable<State> });
}

/** A tree of capabilities and leaves, in the shape that the application chooses. */
export interface CapabilityTree {
  readonly [key: string]: Capability.Any | Leaf<Capability.Any, any, any> | CapabilityTree;
}

/** The handle of a leaf: the handle of its capability, with the snapshot of the leaf. */
export type LeafHandle<C extends Capability.Any, State> = Omit<HandleOf<C>, "snapshot"> & { readonly snapshot: Observable<State> };

/** The handles of a tree, in the same shape, each with the types of its capability, and of its snapshot for a leaf. */
export type HandleTree<Tree> = {
  readonly [Key in keyof Tree]: Tree[Key] extends Leaf<infer C, infer State, any>
    ? LeafHandle<C, State>
    : Tree[Key] extends Capability.Any
      ? HandleOf<Tree[Key]>
      : HandleTree<Tree[Key]>;
};

/** The services that the snapshots of the leaves of a tree read, with the mark of a snapshot that is an Effect. */
type LeafServicesOf<Tree> = {
  readonly [Key in keyof Tree]: Tree[Key] extends Leaf<any, any, infer R>
    ? R
    : Tree[Key] extends Capability.Any
      ? never
      : LeafServicesOf<Tree[Key]>;
}[keyof Tree];

/** The services that the snapshots of the leaves of a tree read. */
export type ServicesOf<Tree> = Exclude<LeafServicesOf<Tree>, ReadsServices>;

const isLeaf = (value: unknown): value is Leaf<Capability.Any, unknown, unknown> =>
  typeof value === "object" && value !== null && leafTypeId in value;

const isCapability = (value: Capability.Any | CapabilityTree): value is Capability.Any =>
  typeof value.id === "string" && typeof value.run === "function";

/** The leaves of a tree, in the order of the tree. */
function leavesOf(tree: CapabilityTree): Leaf<Capability.Any, unknown, unknown>[] {
  return Object.values(tree).flatMap((value) =>
    isLeaf(value) ? [value] : isCapability(value as Capability.Any | CapabilityTree) ? [] : leavesOf(value as CapabilityTree),
  );
}

/** The capabilities of a tree, in the order of the tree. Give them to `App.make`. */
export function capabilities<const Tree extends CapabilityTree>(tree: Tree): Capability.Any[] {
  return Object.values(tree).flatMap((value): Capability.Any[] =>
    isLeaf(value) ? [value.capability] : isCapability(value as Capability.Any | CapabilityTree) ? [value as Capability.Any] : capabilities(value as CapabilityTree),
  );
}

/**
 * The handle of a capability, with the types of its schemas. A capability outside the view of the session has a handle
 * that is always unavailable, and whose calls reject with `unknown-capability`.
 */
export function get<C extends Capability.Any>(handles: ReadonlyMap<string, Handle>, capability: C): HandleOf<C> {
  return (handles.get(capability.id) ?? outsideView(capability)) as HandleOf<C>;
}

/**
 * Build the handles of a tree, with the snapshot of each leaf. A leaf outside the view of the session is an error: its
 * snapshot would give data that the view does not have.
 */
function build(handles: ReadonlyMap<string, Handle>, tree: CapabilityTree, snapshotOf: (leaf: Leaf<Capability.Any, unknown, unknown>) => Observable<unknown>): object {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(tree).map(([key, value]) => {
        if (isLeaf(value)) {
          const handle = handles.get(value.capability.id);
          if (handle === undefined) {
            throw new Error(`The capability ${value.capability.id} is outside the view of the session, so its handle cannot have a snapshot.`);
          }
          return [key, Object.freeze({ ...handle, snapshot: detached(snapshotOf(value)) })];
        }
        const branch = value as Capability.Any | CapabilityTree;
        return [key, isCapability(branch) ? get(handles, branch) : build(handles, branch, snapshotOf)];
      }),
    ),
  );
}

/**
 * The handles of a tree, in the same shape. The application chooses the tree, and no name comes from it
 * (spec/bindings/typescript.md#handles). See `get` for a capability outside the view. A leaf must have an observable as
 * its snapshot: use `treeWith` for snapshots that the services give.
 */
export function tree<const Tree extends CapabilityTree>(
  handles: ReadonlyMap<string, Handle>,
  capabilities: Tree & ([LeafServicesOf<Tree>] extends [never] ? unknown : never),
): HandleTree<Tree> {
  return build(handles, capabilities, (each) => {
    if (Effect.isEffect(each.snapshot)) throw new Error(`The snapshot of ${each.capability.id} is an Effect: use treeWith.`);
    return each.snapshot;
  }) as HandleTree<Tree>;
}

/** The handles of a tree, as `tree` gives them, with the snapshots that the services give. */
export const treeWith = <const Tree extends CapabilityTree>(
  handles: ReadonlyMap<string, Handle>,
  capabilities: Tree,
): Effect.Effect<HandleTree<Tree>, never, ServicesOf<Tree>> =>
  Effect.gen(function* () {
    const read = new Map<Leaf<Capability.Any, unknown, unknown>, Observable<unknown>>();
    for (const each of leavesOf(capabilities)) {
      read.set(each, Effect.isEffect(each.snapshot) ? yield* (each.snapshot as Effect.Effect<Observable<unknown>, never, ServicesOf<Tree>>) : each.snapshot);
    }
    return build(handles, capabilities, (each) => read.get(each)!) as HandleTree<Tree>;
  });

function outsideView(capability: Capability.Any): Handle {
  const failure = callFailure("unknown-capability", `There is no capability ${capability.id}.`);
  const availability: Availability = { available: false, reason: failure.message };
  const reject = () => Promise.reject(new CallFailureError(failure));
  return Object.freeze({
    id: capability.id,
    description: capability.description,
    audience: [],
    availability: { getSnapshot: () => availability, subscribe: () => ({ unsubscribe() {} }) },
    execute: reject,
    invokeExternal: reject,
  });
}

/** A source of values with listeners. */
function observable<T>(initial: T) {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    set(value: T) {
      current = value;
      Effect.runSync(notify(listeners, value, "A listener of a snapshot failed"));
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
 * Effect sees a change of a `Current` availability at once. A `Current` whose read waits gives the last value that the
 * handle read, and the handle reads it again in the background. It gives the same object while the value stays the
 * same. Listeners hear each value that the session announces, in order, and never the same value two times in a row.
 */
const followAvailability = (
  session: Session.Session,
  id: string,
  changes: boolean,
  runFork: (effect: Effect.Effect<void>) => Fiber.Fiber<void>,
  initial: Availability,
): Observable<Availability> => {
  let snapshot = initial;
  let delivered = initial;
  let following: Fiber.Fiber<void> | undefined;
  // Each time that the handle starts to follow, it has a new generation. A fiber of an older generation, which may run
  // until its interruption, gives the listeners nothing.
  let generation = 0;
  const listeners = new Set<(value: Availability) => void>();
  const keep = (value: Availability) => {
    if (!sameAvailability(snapshot, value)) snapshot = value;
  };
  const read = (): Availability => {
    const exit = Effect.runSyncExit(session.availability(id));
    if (Exit.isSuccess(exit)) keep(exit.value);
    else runFork(Effect.map(session.availability(id), keep));
    return snapshot;
  };
  // The handle follows the availability only while a listener listens, so a handle that nobody observes costs nothing.
  const follow = (mine: number) =>
    runFork(
      session.availabilityChanges(id).pipe(
        Stream.runForEach((next) =>
          Effect.suspend(() => {
            if (mine !== generation || sameAvailability(delivered, next)) return Effect.void;
            delivered = next;
            return notify(listeners, next, "A listener of an availability failed");
          }),
        ),
      ),
    );
  return {
    getSnapshot: read,
    subscribe(listener: (value: Availability) => void) {
      listeners.add(listener);
      if (changes && following === undefined) {
        delivered = read();
        following = follow(++generation);
      }
      return {
        unsubscribe: () => {
          listeners.delete(listener);
          if (listeners.size > 0 || following === undefined) return;
          const stopping = following;
          following = undefined;
          generation++;
          runFork(Fiber.interrupt(stopping).pipe(Effect.asVoid));
        },
      };
    },
  };
};

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
    // The fibers that follow availability for listeners. They end with the scope.
    const runFork = yield* FiberSet.makeRuntime<never, void, never>();
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
      const availability = followAvailability(session, id, capability.availability !== undefined, runFork, yield* session.availability(id));

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
