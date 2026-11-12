/**
 * A session: the context of the calls and the subscriptions of one client, for one target. See spec/invocation.md and
 * spec/events.md.
 */
import { AVAILABLE, callFailure, occurrenceOf, viewOf } from "@acid-cat/spec-ts";
import type { Availability, CallFailure, CatalogDocument, Occurrence, Outcome, Resume } from "@acid-cat/spec-ts";
import { Cause, Data, Effect, Exit, Fiber, FiberSet, Queue, Ref, Schema, Scope, Stream, SubscriptionRef } from "effect";

import * as App from "./App.ts";
import type * as Capability from "./Capability.ts";
import type * as Event from "./Event.ts";
import { changesAfter, readable } from "./internal/changes.ts";
import { resumeIssue } from "./internal/resume.ts";
import { register } from "./internal/served.ts";

/** A call failure in the error channel of `execute`. */
export class CallFailed extends Data.TaggedError("CallFailed")<CallFailure> {}

/**
 * The part of a capability that a typed call with a decoded input uses: its id and its operation. Each `Capability` is
 * an `Executable` with the types of its schemas.
 */
export interface Executable<Input, Value, Failure, R> {
  readonly id: string;
  readonly run: (input: Input) => Effect.Effect<Value, Failure, R>;
}

/**
 * The part of a capability that a typed call with an input that is not trusted uses: its id, and the decoding of its
 * input. Each `Capability` is a `Preparable` with the types of its schemas.
 */
export interface Preparable<Value, Failure, R> {
  readonly id: string;
  readonly prepare: (input: unknown) => Effect.Effect<Effect.Effect<Value, Failure, R>, string>;
}

/**
 * The part of an event that a typed subscription with a decoded input uses: its id, and the check of its input. Each
 * `Event` is a `Followable` with the types of its schemas.
 */
export interface Followable<Input, Payload, R> {
  readonly id: string;
  readonly open: (input: Input) => Effect.Effect<Event.Opener<Payload, R>, string>;
}

/** Where a subscription starts (spec/events.md#resuming). */
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

/** The default number of occurrences of one subscription that a session keeps for a slow client. */
export const DEFAULT_EVENT_BUFFER = 1024;

/** A session of an application that needs the services `R`. */
export interface Session<R = never> {
  readonly target: string;
  /**
   * The view of the target (spec/catalog.md#views). Bindings take names, descriptions and schemas from it. The
   * session writes the view when it is first read.
   */
  readonly view: CatalogDocument;
  /** The current availability of a capability in the view. */
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
    const scope = yield* Effect.scope;
    const running = yield* FiberSet.make<unknown, unknown>();
    const closed = yield* Ref.make(false);
    yield* Scope.addFinalizer(scope, Ref.set(closed, true));

    const served = new Map<string, Served<R>>();
    for (const capability of app.capabilities) {
      if (!capability.audience.includes(options.target)) continue;
      if (served.has(capability.id)) throw new Error(`The capability ${capability.id} is declared two times.`);
      const availability = capability.availability === undefined ? undefined : yield* capability.availability;
      const stateValue = capability.pipeline.state === undefined ? undefined : yield* capability.pipeline.state;
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

    /** Run a call in the session. The result is the value, the failure, or a call failure. */
    const call = <A, E>(program: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const fiber = yield* FiberSet.run(running, Effect.provideContext(program, context));
        const exit = yield* Fiber.await(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
        if (Exit.isSuccess(exit)) return { ok: true as const, value: exit.value };
        const failure = Cause.findErrorOption(exit.cause);
        if (failure._tag === "Some") return { ok: false as const, error: failure.value };
        if (Cause.hasInterruptsOnly(exit.cause)) return callFailure("cancelled", "The call was cancelled.");
        yield* Effect.logError("A capability failed with a defect", Cause.pretty(exit.cause));
        return callFailure("internal", "The capability failed.");
      });

    /**
     * Admit a call: the session is open, and the capability is in the view and available. With `object`, the capability
     * must also be that object.
     */
    const admit = (id: string, object?: { readonly id: string }) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return callFailure("cancelled", "The session is closed.");
        const entry = served.get(id);
        if (entry === undefined || (object !== undefined && entry.capability !== object)) return unknown(id);
        const current = yield* availabilityOf(id);
        if (!current.available) return callFailure("unavailable", current.reason);
        return entry.capability;
      });

    /** Admit and run a call through the pipeline of the capability. */
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

    /** Admit a typed call of a capability object, prepare its program, and run it. */
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

    /**
     * Admit a subscription and start it: the session is open, the event is in the view, and the input agrees with the
     * input schema. With `object`, the event must also be that object. The provider runs in a fiber of the session, so
     * the session closing ends the subscription as complete.
     */
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
        // The occurrences that the client has not read. When the queue is full, it drops the oldest one. A gap in the
        // sequence numbers tells the reader that occurrences were dropped.
        const queue = yield* Queue.sliding<{ readonly sequence: number; readonly occurrence: Occurrence<P> }, CallFailed | Cause.Done>(capacity);
        let sequence = 0;
        const provider = opener(where).pipe(
          Stream.runForEach((emitted) =>
            Effect.sync(() => {
              const occurrence = occurrenceOf(id, emitted, newEventId, () => new Date());
              Queue.offerUnsafe(queue, { sequence: sequence++, occurrence });
            }),
          ),
          Effect.exit,
          Effect.flatMap((exit) => {
            if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return Queue.end(queue);
            const disagrees = Cause.findErrorOption(exit.cause)._tag === "Some";
            return Effect.logError(disagrees ? "An event gave a payload that does not agree with its schema" : "An event failed with a defect", Cause.pretty(exit.cause)).pipe(
              Effect.andThen(Queue.fail(queue, new CallFailed(callFailure("internal", disagrees ? "The event gave a payload that does not agree with its schema." : "The event failed.")))),
            );
          }),
          Effect.onInterrupt(() => Queue.end(queue)),
        );
        const fiber = yield* FiberSet.run(running, Effect.provideContext(provider, context));
        yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
        let delivered = -1;
        return Stream.fromQueue(queue).pipe(
          Stream.map(({ sequence: next, occurrence }) => {
            const skipped = next !== delivered + 1;
            delivered = next;
            return skipped && occurrence.truncated !== true ? { ...occurrence, truncated: true as const } : occurrence;
          }),
        );
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

/** An `eventId` that is unique in a subscription, for an occurrence whose provider gives none. */
const newEventId = (): string => globalThis.crypto.randomUUID();

/** An outcome with its failures and call failures in the error channel. */
const lift = <Value, Failure>(outcome: Effect.Effect<Outcome<Value, Failure>>): Effect.Effect<Value, Failure | CallFailed> =>
  Effect.gen(function* () {
    const each = yield* outcome;
    if ("kind" in each) return yield* new CallFailed(each);
    if (!each.ok) return yield* Effect.fail(each.error);
    return each.value;
  });
