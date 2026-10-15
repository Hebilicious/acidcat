/**
 * A session: the context of the calls of one client, for one target. See spec/invocation.md.
 */
import { AVAILABLE, callFailure } from "@acid-cat/spec-ts";
import type { Availability, CallFailure, CatalogDocument, Outcome } from "@acid-cat/spec-ts";
import { Cause, Data, Deferred, Effect, Exit, Fiber, FiberSet, PubSub, Ref, Schema, SchemaIssue, Scope, Stream, SubscriptionRef } from "effect";

import * as App from "./App.ts";
import * as Capability from "./Capability.ts";
import { sameAvailability } from "./internal/availability.ts";
import { logLoadFailure } from "./internal/load.ts";

/** A call failure in the error channel of `execute`. */
export class CallFailed extends Data.TaggedError("CallFailed")<CallFailure> {}

export interface Session {
  readonly target: string;
  /**
   * The capabilities in the view of the target, by id, in the order of the application. Bindings take ids,
   * descriptions, hints and schemas from them. `App.inputJsonSchema` and `App.outputJsonSchema` give their schemas.
   */
  readonly capabilities: ReadonlyMap<string, Capability.Any>;
  /**
   * The view of the target (spec/catalog.md#views), as a catalog. The session writes it the first time that it is
   * read, so a session that only calls capabilities never writes JSON Schema.
   */
  readonly view: CatalogDocument;
  /**
   * The current availability of a capability in the view. For a capability whose availability is a `Current`, this
   * reads it now. A call is decided on this value.
   */
  readonly availability: (id: string) => Effect.Effect<Availability>;
  /**
   * The availability of a capability now, read with no Effect, or `undefined` when only an Effect can read it: a
   * `Current` with no `getUnsafe`.
   */
  readonly availabilityNow: (id: string) => Availability | undefined;
  /** The availability of one capability: the current value, then each change. */
  readonly availabilityChanges: (id: string) => Stream.Stream<Availability>;
  /** An event each time the availability of a capability changes. */
  readonly changes: Stream.Stream<void>;
  /**
   * The state of a capability (spec/invocation.md#state), in its JSON form: the current value, then each change.
   * The stream is empty for a capability with no state, or outside the view.
   */
  readonly state: (id: string) => Stream.Stream<unknown>;
  /** A call with an input that is not trusted. The outcome is in its JSON form. This effect never fails. */
  readonly invoke: (id: string, input: unknown) => Effect.Effect<Outcome<unknown, unknown>>;
  /** A typed call from Effect code. Failures and call failures are in the error channel. */
  readonly execute: <C extends Capability.Any>(
    capability: C,
    input: Capability.InputOf<C>,
  ) => Effect.Effect<Capability.ValueOf<C>, Capability.FailureOf<C> | CallFailed>;
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** The input of a capability with no input schema: an empty object. */
const EmptyInput = Schema.Record(Schema.String, Schema.Unknown);

/** Open a session for a target. The session closes with its scope. */
export const make = <R>(app: App.App<R>, options: { readonly target: string }): Effect.Effect<Session, never, R | Scope.Scope> =>
  Effect.gen(function* () {
  const context = yield* Effect.context<R>();
  const scope = yield* Effect.scope;
  const running = yield* FiberSet.make<unknown, unknown>();
  const closed = yield* Ref.make(false);
  yield* Scope.addFinalizer(scope, Ref.set(closed, true));

  const announcements = yield* PubSub.unbounded<void>();
  const served = new Map<string, Capability.Any<R>>();
  // A capability with no availability is always available. A `Current` is read when a call comes in, and followed only
  // while a reader of `availabilityChanges` or `changes` follows it. A `Stream` has no way to read its value now, so the
  // session follows each one from the start, to know its value when a call comes in, and keeps it in a ref.
  const availability = new Map<string, SubscriptionRef.SubscriptionRef<Availability>>();
  const currents = new Map<string, Capability.Current<Availability>>();
  const reads = new Map<string, Effect.Effect<Availability>>();
  for (const capability of App.capabilitiesOf(app, options.target)) {
    if (served.has(capability.id)) throw new Error(`The capability ${capability.id} is declared two times.`);
    served.set(capability.id, capability);
    if (capability.availability === undefined) continue;
    if (!Stream.isStream(capability.availability)) {
      const current = yield* capability.availability.pipe(Effect.provideContext(context));
      currents.set(capability.id, current);
      reads.set(capability.id, current.get);
      continue;
    }
    const values: Stream.Stream<Availability, never, R> = capability.availability;
    const ref = yield* SubscriptionRef.make<Availability>(AVAILABLE);
    availability.set(capability.id, ref);
    reads.set(capability.id, SubscriptionRef.get(ref));
    yield* values.pipe(
      Stream.runForEach((value) =>
        Effect.gen(function* () {
          if (sameAvailability(yield* SubscriptionRef.get(ref), value)) return;
          yield* SubscriptionRef.set(ref, value);
          yield* PubSub.publish(announcements, undefined);
        }),
      ),
      Effect.provideContext(context),
      // Start at once, so that the stream follows its source before the session is returned.
      Effect.forkIn(scope, { startImmediately: true }),
    );
  }

  // Each state is a ref, made when its stream gives its first value. A reader waits for that value.
  const states = new Map<string, Deferred.Deferred<SubscriptionRef.SubscriptionRef<unknown>>>();
  for (const capability of served.values()) {
    if (Capability.isLazy(capability) || capability.state === undefined) continue;
    const encodeState = Schema.encodeUnknownEffect(capability.state.schema as Schema.Codec<unknown, unknown>);
    const ready = yield* Deferred.make<SubscriptionRef.SubscriptionRef<unknown>>();
    states.set(capability.id, ready);
    yield* capability.state.changes.pipe(
      Stream.mapEffect((value) => encodeState(value).pipe(Effect.orDie)),
      Stream.runForEach((value) =>
        Deferred.isDone(ready).pipe(
          Effect.flatMap((done) =>
            done
              ? Effect.flatMap(Deferred.await(ready), (ref) => SubscriptionRef.set(ref, value))
              : Effect.flatMap(SubscriptionRef.make(value), (ref) => Deferred.succeed(ready, ref)),
          ),
        ),
      ),
      Effect.provideContext(context),
      Effect.forkIn(scope, { startImmediately: true }),
    );
  }

  const stateOf = (id: string): Stream.Stream<unknown> => {
    const ready = states.get(id);
    return ready === undefined ? Stream.empty : Stream.unwrap(Effect.map(Deferred.await(ready), SubscriptionRef.changes));
  };

  const unknown = (id: string) => callFailure("unknown-capability", `There is no capability ${id}.`);

  const notServed = (id: string): Availability => ({ available: false, reason: unknown(id).message });

  const availabilityOf = (id: string): Effect.Effect<Availability> =>
    reads.get(id) ?? Effect.succeed(served.has(id) ? AVAILABLE : notServed(id));

  const availabilityNow = (id: string): Availability | undefined => {
    const ref = availability.get(id);
    if (ref !== undefined) return SubscriptionRef.getUnsafe(ref);
    const current = currents.get(id);
    if (current !== undefined) return current.getUnsafe?.();
    return served.has(id) ? AVAILABLE : notServed(id);
  };

  const availabilityChanges = (id: string): Stream.Stream<Availability> => {
    const ref = availability.get(id);
    if (ref !== undefined) return SubscriptionRef.changes(ref);
    const current = currents.get(id);
    if (current !== undefined) return current.changes.pipe(Stream.changesWith(sameAvailability));
    return Stream.make(served.has(id) ? AVAILABLE : notServed(id));
  };

  /** Admit, validate and run a call. The program fails with a call failure, or with a failure of the capability. */
  const call = (capability: Capability.Any<R>, decoded: unknown) =>
    Effect.gen(function* () {
      const fiber = yield* FiberSet.run(running, Effect.provideContext(capability.run(decoded), context));
      const exit = yield* Fiber.await(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
      if (Exit.isSuccess(exit)) return { ok: true as const, value: exit.value };
      const failure = Cause.findErrorOption(exit.cause);
      if (failure._tag === "Some") return { ok: false as const, error: failure.value };
      if (Cause.hasInterruptsOnly(exit.cause)) return callFailure("cancelled", "The call was cancelled.");
      yield* Effect.logError("A capability failed with a defect", Cause.pretty(exit.cause));
      return callFailure("internal", "The capability failed.");
    });

  const admit = (id: string) =>
    Effect.gen(function* () {
      if (yield* Ref.get(closed)) return callFailure("cancelled", "The session is closed.");
      const capability = served.get(id);
      if (capability === undefined) return unknown(id);
      const current = yield* availabilityOf(id);
      if (!current.available) return callFailure("unavailable", current.reason);
      return capability;
    });

  const invoke = (id: string, input: unknown): Effect.Effect<Outcome<unknown, unknown>> =>
    Effect.gen(function* () {
      const admitted = yield* admit(id);
      if ("kind" in admitted) return admitted;
      // A lazy capability loads its schemas and program here. A load that fails is `internal`; a cancelled one is
      // `cancelled`, as an interrupted call is.
      const loaded = yield* Effect.exit(Capability.load(admitted));
      if (Exit.isFailure(loaded)) {
        if (Cause.hasInterruptsOnly(loaded.cause)) return yield* Effect.interrupt;
        yield* logLoadFailure(loaded.cause);
        return callFailure("internal", "The capability failed.");
      }
      const capability = loaded.value;
      const decoded = yield* Schema.decodeUnknownEffect((capability.input ?? EmptyInput) as Schema.Codec<unknown, unknown>)(input).pipe(
        Effect.result,
      );
      if (decoded._tag === "Failure") {
        const message = formatIssues(decoded.failure.issue)
          .issues.map((issue) => `${(issue.path ?? []).join(".") || "input"}: ${issue.message}`)
          .join("; ");
        return callFailure("invalid-input", message);
      }
      const outcome = yield* call(capability, decoded.success);
      if ("kind" in outcome) return outcome;
      const encoded = yield* (outcome.ok
        ? encode(capability.output ?? Schema.Null, outcome.value)
        : encode(Schema.Union(capability.failures ?? []), outcome.error));
      if (encoded === undefined) return callFailure("internal", "The capability returned a value that does not agree with its schema.");
      return outcome.ok ? { ok: true as const, value: encoded.json } : { ok: false as const, error: encoded.json };
    });

  const execute: Session["execute"] = (capability, input) =>
    Effect.gen(function* () {
      const admitted = yield* admit(capability.id);
      if ("kind" in admitted) return yield* new CallFailed(admitted);
      const outcome = yield* call(admitted, input);
      if ("kind" in outcome) return yield* new CallFailed(outcome);
      if (!outcome.ok) return yield* Effect.fail(outcome.error);
      return outcome.value;
    }) as never;

  // The announcements of the streams, and each change of each `Current`, which is followed while a reader follows this.
  // When the reader starts, it subscribes to the announcements and reads each `Current`, and then it gives each change
  // from that value, so that it misses no change that comes after it starts.
  const changesFrom = (current: Capability.Current<Availability>, first: Availability) => {
    let last = first;
    return current.changes.pipe(
      Stream.filter((next) => {
        const changed = !sameAvailability(last, next);
        last = next;
        return changed;
      }),
      Stream.as(undefined),
    );
  };
  const changes: Stream.Stream<void> = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(announcements);
      const followed = [];
      for (const current of currents.values()) followed.push(changesFrom(current, yield* current.get));
      return Stream.mergeAll([Stream.fromSubscription(subscription), ...followed], { concurrency: "unbounded" });
    }),
  );

  return {
    target: options.target,
    capabilities: served,
    get view() {
      return App.view(app, options.target);
    },
    availability: availabilityOf,
    availabilityNow,
    availabilityChanges,
    changes,
    state: stateOf,
    invoke,
    execute,
  } satisfies Session;
  });

/** Encode a value with its schema. `undefined` if the value does not agree with the schema. */
const encode = (schema: Schema.Top, value: unknown): Effect.Effect<{ readonly json: unknown } | undefined> =>
  Schema.encodeUnknownEffect(schema as Schema.Codec<unknown, unknown>)(value).pipe(
    Effect.map((json) => ({ json })),
    Effect.catch(() => Effect.succeed(undefined)),
  );
