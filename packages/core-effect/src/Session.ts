/**
 * A session: the context of the calls of one client, for one target. See spec/invocation.md.
 */
import { AVAILABLE, callFailure, viewOf } from "@acid-cat/spec-ts";
import type { Availability, CallFailure, CatalogDocument, Outcome } from "@acid-cat/spec-ts";
import { Cause, Data, Effect, Exit, Fiber, FiberSet, Ref, Schema, Scope, Stream, SubscriptionRef } from "effect";

import * as App from "./App.ts";
import type * as Capability from "./Capability.ts";
import { changesAfter, readable } from "./internal/changes.ts";
import { register } from "./internal/served.ts";

/** A call failure in the error channel of `execute`. */
export class CallFailed extends Data.TaggedError("CallFailed")<CallFailure> {}

/**
 * The part of a capability that a typed call uses: its id and its operation. Each `Capability` is an `Executable` with
 * the types of its schemas.
 */
export interface Executable<Input, Value, Failure, R> {
  readonly id: string;
  readonly run: (input: Input) => Effect.Effect<Value, Failure, R>;
}

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
   * A typed call from Effect code. The capability needs only services of the application. The session admits the call
   * by the id of the capability. The outcome holds the value, the failure or the call failure. This effect never fails.
   */
  readonly call: <Input, Value, Failure>(
    capability: Executable<Input, Value, Failure, R>,
    input: NoInfer<Input>,
  ) => Effect.Effect<Outcome<Value, Failure>>;
  /** A typed call, as `call`, with failures and call failures in the error channel. */
  readonly execute: <Input, Value, Failure>(
    capability: Executable<Input, Value, Failure, R>,
    input: NoInfer<Input>,
  ) => Effect.Effect<Value, Failure | CallFailed>;
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
export const make = <R>(app: App.App<R>, options: { readonly target: string }): Effect.Effect<Session<R>, never, R | Scope.Scope> =>
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

    /** Admit a call: the session is open, and the capability is in the view and available. */
    const admit = (id: string) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return callFailure("cancelled", "The session is closed.");
        const entry = served.get(id);
        if (entry === undefined) return unknown(id);
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

    const typedCall: Session<R>["call"] = (capability, input) =>
      Effect.gen(function* () {
        const admitted = yield* admit(capability.id);
        if ("kind" in admitted) return admitted;
        return yield* call(capability.run(input));
      });

    const execute: Session<R>["execute"] = (capability, input) =>
      Effect.gen(function* () {
        const outcome = yield* typedCall(capability, input);
        if ("kind" in outcome) return yield* new CallFailed(outcome);
        if (!outcome.ok) return yield* Effect.fail(outcome.error);
        return outcome.value;
      });

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
    };
    register(session, {
      availability: (id) => served.get(id)?.availability,
      state: (id) => served.get(id)?.state?.value,
      execute: (id, input) => throughPipeline(id, (pipeline) => pipeline.execute(input)),
    });
    return session;
  });
