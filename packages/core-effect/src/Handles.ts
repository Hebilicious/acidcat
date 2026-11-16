import { AVAILABLE, CallFailureError, callFailure } from "@acid-cat/spec-ts";
import type { Availability, Occurrence, Outcome, Result } from "@acid-cat/spec-ts";
import { Cause, Context, Effect, Exit, Fiber, FiberSet, Layer, Option, Pull, Schema, Scope, Stream } from "effect";

import type * as App from "./App.ts";
import type * as Capability from "./Capability.ts";
import type * as Event from "./Event.ts";
import { changesAfter, readable } from "./internal/changes.ts";
import { refsOf } from "./internal/served.ts";
import * as Session from "./Session.ts";
import * as WebMcp from "./WebMcp.ts";

export interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: (value: T) => void): { unsubscribe(): void };
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

/**
 * The handle of a capability (spec/bindings/typescript.md#handles). `Input`, `Value` and `Failure` are the types of
 * the schemas of the capability, and `State` is the JSON form of its state. `get` gives a handle with these types.
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

export type HandleOf<C extends Capability.Any> = Handle<
  NonNullable<C["input"]>["Type"],
  NonNullable<C["output"]>["Type"],
  NonNullable<C["failures"]>[number]["Type"],
  NonNullable<C["state"]>["schema"]["Encoded"]
>;

export type { Occurrence } from "@acid-cat/spec-ts";

export interface SubscribeOptions {
  readonly signal?: AbortSignal | undefined;
  /** Start after this position (spec/events.md#resuming). */
  readonly cursor?: string | undefined;
  /** Send no occurrence that is older than this number of milliseconds. */
  readonly maxAgeMs?: number | undefined;
}

/**
 * The handle of an event (spec/bindings/typescript.md#event-handles). `Input` and `Payload` are the types of the
 * schemas of the event. `event` gives a handle with these types.
 *
 * The promise of `subscribe` resolves when the subscription has started, and rejects with a `CallFailureError` before
 * the first occurrence. `return()` of the iterator cancels the subscription, also while a `next()` waits: that `next()`
 * then resolves with `done: true`. A GraphQL server can return the promise from the `subscribe` resolver of a field.
 */
export interface EventHandle<Input = unknown, Payload = unknown> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  /** A subscription with an input that is already decoded. Each `data` is a copy, in the type of the payload. */
  subscribe(input: Input, options?: SubscribeOptions): Promise<AsyncIterable<Occurrence<Payload>>>;
  /** A subscription with an input that is not trusted. The handle validates it first. Each `data` is in its JSON form. */
  subscribeExternal(input: unknown, options?: SubscribeOptions): Promise<AsyncIterable<Occurrence<unknown>>>;
}

export type EventHandleOf<E extends Event.Any> = EventHandle<NonNullable<E["input"]>["Type"], NonNullable<E["payload"]>["Type"]>;

function typedHandle<
  Input extends Capability.AnySchema,
  Output extends Capability.AnySchema,
  Failure extends Capability.AnySchema,
  R,
  State extends Capability.AnySchema,
  Id extends string,
>(
  capability: Capability.Capability<Input, Output, Failure, R, State, Id>,
  handle: Handle,
  execute: (input: Input["Type"], options: CallOptions | undefined) => Promise<Result<Output["Type"], Failure["Type"]>>,
): Handle<Input["Type"], Output["Type"], Failure["Type"], State["Encoded"]> {
  const state = capability.state;
  const snapshot = handle.snapshot === undefined || state === undefined ? undefined : checked(handle.snapshot, Schema.is(Schema.toEncoded(state.schema)), capability.id);
  return {
    id: handle.id,
    description: handle.description,
    audience: handle.audience,
    availability: handle.availability,
    ...(snapshot === undefined ? {} : { snapshot }),
    execute,
    invokeExternal: (input, options) => handle.invokeExternal(input, options),
  };
}

function checked<T>(source: Observable<unknown>, is: (value: unknown) => value is T, id: string): Observable<T> {
  const check = (value: unknown): T => {
    if (is(value)) return value;
    throw new Error(`The state of ${id} does not agree with its schema.`);
  };
  return {
    getSnapshot: () => check(source.getSnapshot()),
    subscribe: (listener) => source.subscribe((value) => listener(check(value))),
  };
}

function outsideView(capability: Capability.Any): Handle<never, never, never, never> {
  const failure = callFailure("unknown-capability", `There is no capability ${capability.id}.`);
  const reject = () => Promise.reject(new CallFailureError(failure));
  return {
    id: capability.id,
    description: capability.description,
    audience: [],
    availability: constant({ available: false, reason: failure.message }),
    execute: reject,
    invokeExternal: reject,
  };
}

function eventOutsideView(event: { readonly id: string; readonly description: string }): EventHandle<never, never> {
  const reject = () => Promise.reject(new CallFailureError(callFailure("unknown-capability", `There is no event ${event.id}.`)));
  return { id: event.id, description: event.description, audience: [], subscribe: reject, subscribeExternal: reject };
}

const constant = <T>(value: T): Observable<T> => ({ getSnapshot: () => value, subscribe: () => ({ unsubscribe() {} }) });

function observe<A, T>(
  ref: Capability.Readable<A>,
  read: (value: A) => T,
  follow: (effect: Effect.Effect<void>) => Fiber.Fiber<void>,
): Observable<T> {
  const listeners = new Set<(value: T) => void>();
  let follower: Fiber.Fiber<void> | undefined;
  return {
    getSnapshot: () => read(ref.get()),
    subscribe(listener) {
      listeners.add(listener);
      follower ??= follow(
        changesAfter(ref, ref.get()).pipe(
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

function synchronousEncoder(id: string, schema: Capability.AnySchema, current: unknown): (value: unknown) => unknown {
  const encode = Schema.encodeUnknownSync(schema);
  try {
    encode(current);
  } catch (cause) {
    if (Schema.isSchemaError(cause)) throw cause;
    throw new Error(`The state schema of ${id} does not encode synchronously. A handle needs a state schema that encodes synchronously.`, { cause });
  }
  return encode;
}

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

    const run = runner(lifetime.signal, context);

    const handles = new Map<string, Handle>();
    for (const capability of app.capabilities) {
      if (!capability.audience.includes(session.target)) continue;
      const id = capability.id;

      const availabilityRef = refs.availability(id);
      const availability = availabilityRef === undefined ? constant(AVAILABLE) : observe(readable(availabilityRef), (value) => value, follow);

      const stateRef = refs.state(id);
      const snapshot =
        stateRef === undefined || capability.state === undefined
          ? undefined
          : detached(observe(stateRef, synchronousEncoder(id, capability.state.schema, stateRef.get()), follow));

      handles.set(id, {
        id,
        description: capability.description,
        audience: [session.target],
        availability,
        ...(snapshot === undefined ? {} : { snapshot }),
        execute: (input, options) => run(resultOf(refs.execute(id, input)), options),
        invokeExternal: (input, options) => run(resultOf(session.invoke(id, input)), options),
      });
    }
    return handles;
  });

/**
 * The handles of the events of a session, by id. A subscription works while the scope is open. When the scope closes,
 * each subscription ends: its `next()` resolves with `done: true`. The session must come from `Session.make`.
 */
export const makeEvents = <R>(app: App.App<R>, session: Session.Session): Effect.Effect<ReadonlyMap<string, EventHandle>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const lifetime = new AbortController();
    yield* Scope.addFinalizer(scope, Effect.sync(() => lifetime.abort()));
    const handles = new Map<string, EventHandle>();
    for (const event of app.events ?? []) {
      if (!event.audience.includes(session.target)) continue;
      const subscribeExternal = (input: unknown, options?: SubscribeOptions) =>
        iterate(session.subscribe(event.id, input, resumeOf(options)), lifetime.signal, options);
      handles.set(event.id, {
        id: event.id,
        description: event.description,
        audience: [session.target],
        subscribe: subscribeExternal,
        subscribeExternal,
      });
    }
    return handles;
  });

const resumeOf = (options: SubscribeOptions | undefined): Session.SubscribeOptions => ({
  ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
  ...(options?.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
});

const cancelledError = () => new CallFailureError(callFailure("cancelled", "The subscription was cancelled."));

/**
 * `return()` interrupts the fiber of a `next()` that waits. `Stream.toAsyncIterable` does not do this: its `return()`
 * waits for the `next()` in progress.
 */
async function iterate<P>(
  start: Effect.Effect<Session.Subscription<P>, Session.CallFailed, Scope.Scope>,
  lifetime: AbortSignal,
  options: SubscribeOptions | undefined,
): Promise<AsyncIterable<Occurrence<P>>> {
  const signal = AbortSignal.any([lifetime, ...(options?.signal ? [options.signal] : [])]);
  if (signal.aborted) throw cancelledError();
  const scope = Effect.runSync(Scope.make());
  const started = await Effect.runPromiseExit(Effect.flatMap(start, Stream.toPull).pipe(Scope.provide(scope)), { signal });
  if (Exit.isFailure(started)) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    if (Cause.hasInterruptsOnly(started.cause)) throw cancelledError();
    const failure = Cause.findErrorOption(started.cause);
    if (failure._tag === "Some") throw new CallFailureError(failure.value);
    throw Cause.squash(started.cause);
  }
  const pull = started.value;

  const ready: Occurrence<P>[] = [];
  let finished = false;
  let waiting: Fiber.Fiber<readonly Occurrence<P>[], Session.CallFailed | Cause.Done> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", finish);
    waiting?.interruptUnsafe();
    ready.length = 0;
    Effect.runFork(Scope.close(scope, Exit.void));
  };
  signal.addEventListener("abort", finish, { once: true });

  const done = (): IteratorResult<Occurrence<P>> => ({ done: true, value: undefined });
  const step = (): Promise<IteratorResult<Occurrence<P>>> => {
    const value = ready.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (finished) return Promise.resolve(done());
    return new Promise((resolve, reject) => {
      const fiber = Effect.runFork(pull);
      waiting = fiber;
      fiber.addObserver((exit) => {
        waiting = undefined;
        if (Exit.isSuccess(exit)) {
          ready.push(...exit.value);
          return resolve(step());
        }
        const ended = finished || Pull.isDoneCause(exit.cause) || Cause.hasInterruptsOnly(exit.cause);
        finish();
        if (ended) return resolve(done());
        const failure = Cause.findErrorOption(exit.cause);
        reject(failure._tag === "Some" && !Cause.isDone(failure.value) ? new CallFailureError(failure.value) : Cause.squash(exit.cause));
      });
    });
  };
  let last: Promise<unknown> = Promise.resolve();
  const iterator: AsyncIterator<Occurrence<P>> = {
    next: () => {
      const result = last.then(step, step);
      last = result.catch(() => undefined);
      return result;
    },
    return: () => {
      finish();
      return Promise.resolve(done());
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

const resultOf = <Value, Failure>(outcome: Effect.Effect<Outcome<Value, Failure>>): Effect.Effect<Result<Value, Failure>> =>
  Effect.flatMap(outcome, (each) => ("kind" in each ? Effect.die(new CallFailureError(each)) : Effect.succeed(each)));

const runner =
  (lifetime: AbortSignal, context: Context.Context<never>) =>
  <A>(effect: Effect.Effect<A, unknown>, options: CallOptions | undefined): Promise<A> => {
    const signal = AbortSignal.any([lifetime, ...(options?.signal ? [options.signal] : [])]);
    if (signal.aborted) return Promise.reject(new CallFailureError(callFailure("cancelled", "The call was cancelled.")));
    return Effect.runPromiseExitWith(context)(effect, { signal }).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      if (Cause.hasInterruptsOnly(exit.cause)) throw new CallFailureError(callFailure("cancelled", "The call was cancelled."));
      throw Cause.squash(exit.cause);
    });
  };

/** The tools of a session on a WebMCP host, while the session is open, or until `remove`. */
export interface WebMcpRegistration {
  readonly status: Observable<WebMcp.Status>;
  /**
   * Ask for the last failed update again. The promise resolves when the request is queued, not when the update ends.
   * `status` gives the outcome of the update. After `remove`, it does nothing.
   */
  readonly retry: () => Promise<void>;
  /**
   * Remove the tools of the session from the host, and register no more tools, while the session stays open. The promise
   * resolves when the tools are removed. The calls in progress continue, so a capability can call it during its own
   * call. The handles and the services stay open. `status` is `closing` until the WebMCP calls in progress end, then
   * `disposed`. A second call does nothing more, and `dispose` works after it.
   */
  readonly remove: () => Promise<void>;
}

export interface OpenOptions {
  readonly target: string;
  /** The number of occurrences of one subscription that the session keeps for a slow client. See `Session.Options`. */
  readonly eventBuffer?: number | undefined;
  readonly webmcp?: WebMcp.ModelContext | undefined;
}

/**
 * A session for code that does not use Effect, of an application that needs the services `R`. Its functions do not use
 * `this`, so code can pass them on alone, for example `onClose(session.dispose)`.
 */
export interface PromiseSession<R = never> {
  readonly target: string;
  readonly view: Session.Session["view"];
  readonly handles: ReadonlyMap<string, Handle>;
  /**
   * The handle of a capability, with the types of the capability. Only the capability object that the session serves
   * gets a handle that calls it. Any other capability, also one with the same id, gets a handle that is always
   * unavailable, and each call rejects as `unknown-capability`. Each call of `handle` gives a new handle.
   */
  readonly handle: <
    Input extends Capability.AnySchema,
    Output extends Capability.AnySchema,
    Failure extends Capability.AnySchema,
    State extends Capability.AnySchema,
    Id extends string,
  >(
    capability: Capability.Capability<Input, Output, Failure, R, State, Id>,
  ) => Handle<Input["Type"], Output["Type"], Failure["Type"], State["Encoded"]>;
  /**
   * A call of a capability with an input that is not trusted. The input schema of the capability decodes the input, so
   * the result has the types of the capability. A call failure rejects with a `CallFailureError`: an input that does
   * not decode as `invalid-input`, and a capability object that the session does not serve as `unknown-capability`.
   */
  readonly call: <Value, Failure>(
    capability: Session.Preparable<Value, Failure, R>,
    input: unknown,
    options?: CallOptions,
  ) => Promise<Result<Value, Failure>>;
  readonly events: ReadonlyMap<string, EventHandle>;
  /**
   * The handle of an event, with the types of the event. Only the event object that the session serves gets a handle
   * that subscribes to it. Any other event, also one with the same id, gets a handle whose subscriptions reject as
   * `unknown-capability`. Each call of `event` gives a new handle.
   */
  readonly event: <Input extends Capability.AnySchema, Payload extends Capability.AnySchema, Id extends string>(
    event: Event.Event<Input, Payload, R, Id>,
  ) => EventHandle<Input["Type"], Payload["Type"]>;
  readonly webmcp: WebMcpRegistration | undefined;
  /** The signal of the session. It aborts when the session closes. */
  readonly signal: AbortSignal;
  /** Close the session: remove its tools, cancel the calls in progress, and wait for them. */
  readonly dispose: () => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Open a session and its handles from code that does not use Effect. `layer` gives the services of the capabilities.
 * With `options.webmcp`, the session also registers its tools on that WebMCP host. The services, the handles and the
 * tools close together. If one of them cannot open, the others are released, and the promise rejects.
 */
export async function open<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: OpenOptions): Promise<PromiseSession<R>> {
  const scope = Effect.runSync(Scope.make());
  const lifetime = new AbortController();
  const opened = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const services = yield* Layer.buildWithScope(layer, scope);
      const session = yield* Session.make(app, { target: options.target, eventBuffer: options.eventBuffer }).pipe(Effect.provideContext(services));
      const handles = yield* make(app, session);
      const events = yield* makeEvents(app, session);
      const installation = options.webmcp === undefined ? Option.none<WebMcp.Installation>() : yield* WebMcp.install(session, { host: options.webmcp });
      const follow = yield* FiberSet.runtime(yield* FiberSet.make<void>())();
      const webmcp = Option.getOrUndefined(
        Option.map(installation, ({ status, retry, remove }): WebMcpRegistration => ({
          status: observe(readable(status), (value) => value, follow),
          retry: () => Effect.runPromise(retry),
          remove: () => Effect.runPromise(remove),
        })),
      );
      return { services, session, handles, events, webmcp };
    }).pipe(Scope.provide(scope)),
  );
  if (Exit.isFailure(opened)) {
    await Effect.runPromise(Scope.close(scope, opened));
    throw Cause.squash(opened.cause);
  }
  const { services, session, handles, events, webmcp } = opened.value;
  const refs = refsOf(session);
  const run = runner(lifetime.signal, Context.empty());
  const withServices = <A, Err>(program: Effect.Effect<A, Err, R>): Effect.Effect<A, Err> =>
    Effect.updateContext(program, (current: Context.Context<never>) => Context.merge(current, services));
  const dispose = async () => {
    lifetime.abort();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  };
  return {
    target: session.target,
    get view() {
      return session.view;
    },
    handles,
    handle: (capability) => {
      const handle = handles.get(capability.id);
      if (handle === undefined || !refs.serves(capability)) return outsideView(capability);
      return typedHandle(capability, handle, (input, callOptions) => run(resultOf(session.outcome(capability, input)), callOptions));
    },
    call: (capability, input, callOptions) =>
      run(resultOf(refs.perform(capability, Effect.map(capability.prepare(input), withServices))), callOptions),
    events,
    event: (event) => {
      const handle = events.get(event.id);
      if (handle === undefined || !refs.servesEvent(event)) return eventOutsideView(event);
      return {
        id: handle.id,
        description: handle.description,
        audience: handle.audience,
        subscribe: (input, subscribeOptions) => iterate(session.follow(event, input, resumeOf(subscribeOptions)), lifetime.signal, subscribeOptions),
        subscribeExternal: (input, subscribeOptions) => handle.subscribeExternal(input, subscribeOptions),
      };
    },
    webmcp,
    signal: lifetime.signal,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}
