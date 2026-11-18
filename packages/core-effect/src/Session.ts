import { AVAILABLE, callFailure, occurrenceOf, viewOf } from "@acid-cat/spec-ts";
import type { Availability, CallFailure, CatalogDocument, Occurrence, Outcome, Resume } from "@acid-cat/spec-ts";
import { Cause, Context, Data, Effect, Exit, Fiber, FiberSet, Queue, Ref, Schema, Scope, Stream, SubscriptionRef } from "effect";

import * as App from "./App.ts";
import type * as Capability from "./Capability.ts";
import type * as Event from "./Event.ts";
import { changesAfter, readable } from "./internal/changes.ts";
import { resumeIssue } from "./internal/resume.ts";
import { register } from "./internal/served.ts";

/**
 * The target of the session that runs the effect (spec/invocation.md#sessions). The work of a capability, its
 * availability and its state, and the provider of an event read it with `yield* Session.Target`. Each session provides
 * it, so it is not in the services that an application needs. Outside a session, its value is the empty string.
 */
export const Target: Context.Reference<string> = Context.Reference<string>("@acid-cat/core-effect/Session/Target", { defaultValue: () => "" });

export class CallFailed extends Data.TaggedError("CallFailed")<CallFailure> {}

export interface Executable<Input, Value, Failure, R> {
  readonly id: string;
  readonly run: (input: Input) => Effect.Effect<Value, Failure, R>;
}

export interface Preparable<Value, Failure, R> {
  readonly id: string;
  readonly prepare: (input: unknown) => Effect.Effect<Effect.Effect<Value, Failure, R>, string>;
}

export interface Followable<Input, Payload, R> {
  readonly id: string;
  readonly open: (input: Input) => Effect.Effect<Event.Opener<Payload, R>, string>;
}

export type SubscribeOptions = Resume;

/**
 * A subscription that started: the stream of its occurrences. Run it one time. The stream ends when the provider has
 * no more occurrences, or when the session closes. It fails with the call failure `internal` when the provider fails,
 * or gives a payload that does not agree with the payload schema. Interrupt it, or close the scope of the
 * subscription, to cancel the subscription.
 */
export type Subscription<Payload> = Stream.Stream<Occurrence<Payload>, CallFailed>;

export interface Options {
  readonly target: string;
  /**
   * The number of occurrences of one subscription that the session keeps for a client that reads slower than the
   * provider gives them. When the limit is full, the session removes the oldest occurrence, and the next occurrence
   * that the client reads has `truncated: true` (spec/events.md#slow-clients). The default is 1024.
   */
  readonly eventBuffer?: number | undefined;
}

export const DEFAULT_EVENT_BUFFER = 1024;

export interface Session<R = never> {
  readonly target: string;
  /**
   * The view of the target (spec/catalog.md#views). Bindings take names, descriptions and schemas from it. The
   * session writes the view when it is first read.
   */
  readonly view: CatalogDocument;
  readonly availability: (id: string) => Effect.Effect<Availability>;
  /**
   * An event each time the availability of a capability changes, after the stream starts. The stream follows the
   * availability refs only while it runs.
   */
  readonly changes: Stream.Stream<void>;
  /**
   * The state of a capability (spec/invocation.md#state), in its JSON form: the current value, then each change.
   * The stream follows the state ref only while it runs. It is empty for a capability with no state, or outside the
   * view.
   */
  readonly state: (id: string) => Stream.Stream<unknown>;
  /** A call with an input that is not trusted. The outcome is in its JSON form. This effect never fails. */
  readonly invoke: (id: string, input: unknown) => Effect.Effect<Outcome<unknown, unknown>>;
  /**
   * A typed call from Effect code, with an input that is not trusted. The input schema of the capability decodes the
   * input, so the value and the failure have the types of the capability. An input that does not decode fails as the
   * call failure `invalid-input`. Only the capability object that the session serves can be called: any other object,
   * also one with the same id, fails as `unknown-capability`. Failures and call failures are in the error channel.
   */
  readonly call: <Value, Failure>(capability: Preparable<Value, Failure, R>, input: unknown) => Effect.Effect<Value, Failure | CallFailed>;
  /** A typed call, as `call`, with an input that is already decoded. */
  readonly execute: <Input, Value, Failure>(
    capability: Executable<Input, Value, Failure, R>,
    input: NoInfer<Input>,
  ) => Effect.Effect<Value, Failure | CallFailed>;
  /** A typed call, as `execute`, whose outcome holds the value, the failure or the call failure. This effect never fails. */
  readonly outcome: <Input, Value, Failure>(
    capability: Executable<Input, Value, Failure, R>,
    input: NoInfer<Input>,
  ) => Effect.Effect<Outcome<Value, Failure>>;
  /**
   * Subscribe to an event with an input that is not trusted. Each `data` is in its JSON form. The effect succeeds when
   * the subscription has started. It fails with a call failure before the first occurrence: `cancelled` when the
   * session is closing, `unknown-capability` when the event is not in the view, and `invalid-input` when the input
   * does not decode or `maxAgeMs` is not an integer that is 0 or more. The scope is the lifetime of the subscription:
   * when it closes, the subscription is cancelled.
   */
  readonly subscribe: (id: string, input: unknown, options?: SubscribeOptions) => Effect.Effect<Subscription<unknown>, CallFailed, Scope.Scope>;
  /**
   * A typed subscription from Effect code, with an input that is already decoded. Each `data` is a copy, with the type
   * of the payload schema. Only the event object that the session serves can be followed: any other object, also one
   * with the same id, fails as `unknown-capability`. See `subscribe`.
   */
  readonly follow: <Input, Payload>(
    event: Followable<Input, Payload, R>,
    input: NoInfer<Input>,
    options?: SubscribeOptions,
  ) => Effect.Effect<Subscription<Payload>, CallFailed, Scope.Scope>;
}

interface Served<R> {
  readonly capability: Capability.Any<R>;
  readonly availability: SubscriptionRef.SubscriptionRef<Availability> | undefined;
  readonly state: { readonly value: Capability.Readable<unknown>; readonly schema: Capability.AnySchema } | undefined;
}

/**
 * Open a session for a target. The session gets the availability and state refs of the capabilities in the view one
 * time, and starts no fiber. The session closes with its scope.
 */
export const make = <R>(app: App.App<R>, options: Options): Effect.Effect<Session<R>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const inSession = <A, E>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(Target, options.target), Effect.provideContext(context));
    const scope = yield* Effect.scope;
    const running = yield* FiberSet.make<unknown, unknown>();
    const closed = yield* Ref.make(false);
    yield* Scope.addFinalizer(scope, Ref.set(closed, true));

    const served = new Map<string, Served<R>>();
    for (const capability of app.capabilities) {
      if (!capability.audience.includes(options.target)) continue;
      if (served.has(capability.id)) throw new Error(`The capability ${capability.id} is declared two times.`);
      const availability = capability.availability === undefined ? undefined : yield* inSession(capability.availability);
      const stateValue = capability.pipeline.state === undefined ? undefined : yield* inSession(capability.pipeline.state);
      const state = stateValue === undefined || capability.state === undefined ? undefined : { value: stateValue, schema: capability.state.schema };
      served.set(capability.id, { capability, availability, state });
    }

    const events = new Map<string, Event.Any<R>>();
    for (const event of app.events ?? []) {
      if (!event.audience.includes(options.target)) continue;
      if (events.has(event.id)) throw new Error(`The event ${event.id} is declared two times.`);
      events.set(event.id, event);
    }
    const capacity = Math.max(1, options.eventBuffer ?? DEFAULT_EVENT_BUFFER);

    const stateOf = (id: string): Stream.Stream<unknown> => {
      const state = served.get(id)?.state;
      if (state === undefined) return Stream.empty;
      const encodeState = Schema.encodeUnknownEffect(state.schema);
      return state.value.changes.pipe(Stream.mapEffect((value) => Effect.orDie(encodeState(value))));
    };

    const unknown = (id: string) => callFailure("unknown-capability", `There is no capability ${id}.`);

    const availabilityOf = (id: string): Effect.Effect<Availability> => {
      const entry = served.get(id);
      if (entry === undefined) return Effect.succeed({ available: false, reason: unknown(id).message });
      return entry.availability === undefined ? Effect.succeed(AVAILABLE) : SubscriptionRef.get(entry.availability);
    };

    const call = <A, E>(program: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const fiber = yield* FiberSet.run(running, inSession(program));
        const exit = yield* Fiber.await(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
        if (Exit.isSuccess(exit)) return { ok: true as const, value: exit.value };
        const failure = Cause.findErrorOption(exit.cause);
        if (failure._tag === "Some") return { ok: false as const, error: failure.value };
        if (Cause.hasInterruptsOnly(exit.cause)) return callFailure("cancelled", "The call was cancelled.");
        yield* Effect.logError("A capability failed with a defect", Cause.pretty(exit.cause));
        return callFailure("internal", "The capability failed.");
      });

    const admit = (id: string, object?: { readonly id: string }) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return callFailure("cancelled", "The session is closed.");
        const entry = served.get(id);
        if (entry === undefined || (object !== undefined && entry.capability !== object)) return unknown(id);
        const current = yield* availabilityOf(id);
        if (!current.available) return callFailure("unavailable", current.reason);
        return entry.capability;
      });

    const throughPipeline = (
      id: string,
      use: (pipeline: Capability.Pipeline<R>) => Effect.Effect<unknown, Capability.PipelineError, R>,
    ): Effect.Effect<Outcome<unknown, unknown>> =>
      Effect.gen(function* () {
        const admitted = yield* admit(id);
        if ("kind" in admitted) return admitted;
        const outcome = yield* call(use(admitted.pipeline));
        if ("kind" in outcome) return outcome;
        if (outcome.ok) return outcome;
        switch (outcome.error._tag) {
          case "InvalidInput":
            return callFailure("invalid-input", outcome.error.message);
          case "Failure":
            return { ok: false as const, error: outcome.error.error };
          case "Disagrees":
            return callFailure("internal", "The capability returned a value that does not agree with its schema.");
        }
      });

    const invoke = (id: string, input: unknown): Effect.Effect<Outcome<unknown, unknown>> =>
      throughPipeline(id, (pipeline) => pipeline.invoke(input));

    const perform = <A, E>(capability: { readonly id: string }, prepared: Effect.Effect<Effect.Effect<A, E, R>, string>) =>
      Effect.gen(function* () {
        const admitted = yield* admit(capability.id, capability);
        if ("kind" in admitted) return admitted;
        const program = yield* Effect.result(prepared);
        if (program._tag === "Failure") return callFailure("invalid-input", program.failure);
        return yield* call(program.success);
      });

    const outcome: Session<R>["outcome"] = (capability, input) => perform(capability, Effect.succeed(capability.run(input)));
    const execute: Session<R>["execute"] = (capability, input) => lift(outcome(capability, input));
    const typedCall: Session<R>["call"] = (capability, input) => lift(perform(capability, capability.prepare(input)));

    const start = <P>(
      id: string,
      object: { readonly id: string } | undefined,
      open: (event: Event.Any<R>) => Effect.Effect<Event.Opener<P, R>, string>,
      resume: SubscribeOptions = {},
    ): Effect.Effect<Subscription<P>, CallFailed, Scope.Scope> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return yield* new CallFailed(callFailure("cancelled", "The session is closed."));
        const event = events.get(id);
        if (event === undefined || (object !== undefined && event !== object)) {
          return yield* new CallFailed(callFailure("unknown-capability", `There is no event ${id}.`));
        }
        const issue = resumeIssue(resume);
        if (issue !== undefined) return yield* new CallFailed(callFailure("invalid-input", issue));
        const opener = yield* Effect.mapError(open(event), (message) => new CallFailed(callFailure("invalid-input", message)));
        const where: Resume = {
          ...(resume.cursor === undefined ? {} : { cursor: resume.cursor }),
          ...(resume.maxAgeMs === undefined ? {} : { maxAgeMs: resume.maxAgeMs }),
        };
        const buffer = yield* truncatingBuffer<P>(capacity);
        const provider = Stream.suspend(() => opener(where)).pipe(
          Stream.runForEach((emitted) => Effect.sync(() => buffer.offer(occurrenceOf(id, emitted, newEventId, () => new Date())))),
          Effect.exit,
          Effect.flatMap((exit) => {
            if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return buffer.end;
            const disagrees = Cause.findErrorOption(exit.cause)._tag === "Some";
            return Effect.logError(disagrees ? "An event gave a payload that does not agree with its schema" : "An event failed with a defect", Cause.pretty(exit.cause)).pipe(
              Effect.andThen(buffer.fail(new CallFailed(callFailure("internal", disagrees ? "The event gave a payload that does not agree with its schema." : "The event failed.")))),
            );
          }),
          Effect.onInterrupt(() => buffer.end),
        );
        const fiber = yield* FiberSet.run(running, inSession(provider));
        yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
        return buffer.occurrences;
      });

    const subscribe: Session<R>["subscribe"] = (id, input, resume) => start(id, undefined, (event) => event.pipeline.prepare(input), resume);
    const follow: Session<R>["follow"] = (event, input, resume) => start(event.id, event, () => event.open(input), resume);

    const availabilityRefs = [...served.values()].flatMap(({ availability }) => (availability === undefined ? [] : [readable(availability)]));
    const changes = Stream.suspend(() =>
      Stream.mergeAll(
        availabilityRefs.map((ref) => changesAfter(ref, ref.get())),
        { concurrency: "unbounded" },
      ),
    ).pipe(Stream.as(undefined));

    let view: CatalogDocument | undefined;

    const session: Session<R> = {
      target: options.target,
      get view() {
        return (view ??= viewOf(App.document(app), options.target));
      },
      availability: availabilityOf,
      changes,
      state: stateOf,
      invoke,
      call: typedCall,
      execute,
      outcome,
      subscribe,
      follow,
    };
    register(session, {
      availability: (id) => served.get(id)?.availability,
      state: (id) => served.get(id)?.state?.value,
      execute: (id, input) => throughPipeline(id, (pipeline) => pipeline.execute(input)),
      serves: (capability) => served.get(capability.id)?.capability === capability,
      servesEvent: (event) => events.get(event.id) === event,
      perform,
    });
    return session;
  });

interface TruncatingBuffer<P> {
  readonly offer: (occurrence: Occurrence<P>) => void;
  readonly end: Effect.Effect<boolean>;
  readonly fail: (failure: CallFailed) => Effect.Effect<boolean>;
  readonly occurrences: Stream.Stream<Occurrence<P>, CallFailed>;
}

const truncatingBuffer = <P>(capacity: number): Effect.Effect<TruncatingBuffer<P>> =>
  Effect.gen(function* () {
    const queue = yield* Queue.sliding<{ readonly sequence: number; readonly occurrence: Occurrence<P> }, CallFailed | Cause.Done>(capacity);
    let offered = 0;
    let delivered = -1;
    return {
      offer: (occurrence) => {
        Queue.offerUnsafe(queue, { sequence: offered++, occurrence });
      },
      end: Queue.end(queue),
      fail: (failure) => Queue.fail(queue, failure),
      occurrences: Stream.fromQueue(queue).pipe(
        Stream.map(({ sequence, occurrence }) => {
          const dropped = sequence !== delivered + 1;
          delivered = sequence;
          return dropped && occurrence.truncated !== true ? { ...occurrence, truncated: true as const } : occurrence;
        }),
      ),
    };
  });

const newEventId = (): string => globalThis.crypto.randomUUID();

const lift = <Value, Failure>(outcome: Effect.Effect<Outcome<Value, Failure>>): Effect.Effect<Value, Failure | CallFailed> =>
  Effect.gen(function* () {
    const each = yield* outcome;
    if ("kind" in each) return yield* new CallFailed(each);
    if (!each.ok) return yield* Effect.fail(each.error);
    return each.value;
  });
