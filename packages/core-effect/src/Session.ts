/**
 * A session: the context of the calls of one client, for one target. See spec/invocation.md.
 */
import { AVAILABLE, callFailure, viewOf } from "@acid-cat/spec-ts";
import type { Availability, CallFailure, CatalogDocument, Outcome } from "@acid-cat/spec-ts";
import { Cause, Data, Effect, Exit, Fiber, FiberSet, Ref, Schema, SchemaIssue, Scope, Stream, SubscriptionRef } from "effect";

import * as App from "./App.ts";
import type * as Capability from "./Capability.ts";
import { changesAfter } from "./internal/changes.ts";

/** A call failure in the error channel of `execute`. */
export class CallFailed extends Data.TaggedError("CallFailed")<CallFailure> {}

export interface Session {
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
  /**
   * The ref that the provider gave for the availability of a capability in the view. `undefined` when the capability
   * is always available, or outside the view.
   */
  readonly availabilityRef: (id: string) => SubscriptionRef.SubscriptionRef<Availability> | undefined;
  /**
   * The ref that the provider gave for the state of a capability in the view, with values that are not encoded.
   * `undefined` when the capability has no state, or is outside the view.
   */
  readonly stateRef: (id: string) => SubscriptionRef.SubscriptionRef<unknown> | undefined;
  /** A call with an input that is not trusted. The outcome is in its JSON form. This effect never fails. */
  readonly invoke: (id: string, input: unknown) => Effect.Effect<Outcome<unknown, unknown>>;
  /** A typed call from Effect code. Failures and call failures are in the error channel. */
  readonly execute: <C extends Capability.Any>(
    capability: C,
    input: C["input"]["Type"],
  ) => Effect.Effect<NonNullable<C["output"]>["Type"], NonNullable<C["failures"]>[number]["Type"] | CallFailed>;
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** The input of a capability with no input schema: an empty object. */
const EmptyInput = Schema.Record(Schema.String, Schema.Unknown);

interface Served<R> {
  readonly capability: Capability.Any<R>;
  readonly availability: SubscriptionRef.SubscriptionRef<Availability> | undefined;
  readonly state: { readonly ref: SubscriptionRef.SubscriptionRef<unknown>; readonly schema: Capability.AnySchema } | undefined;
}

/**
 * Open a session for a target. The session gets the availability and state refs of the capabilities in the view one
 * time, and starts no fiber. The session closes with its scope.
 */
export const make = <R>(app: App.App<R>, options: { readonly target: string }): Effect.Effect<Session, never, R | Scope.Scope> =>
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
    const state = capability.state === undefined ? undefined : { ref: yield* capability.state.value, schema: capability.state.schema };
    served.set(capability.id, { capability, availability, state });
  }

  const stateOf = (id: string): Stream.Stream<unknown> => {
    const state = served.get(id)?.state;
    if (state === undefined) return Stream.empty;
    const encodeState = Schema.encodeUnknownEffect(state.schema as Schema.Codec<unknown, unknown>);
    return SubscriptionRef.changes(state.ref).pipe(Stream.mapEffect((value) => Effect.orDie(encodeState(value))));
  };

  const unknown = (id: string) => callFailure("unknown-capability", `There is no capability ${id}.`);

  const availabilityOf = (id: string): Effect.Effect<Availability> => {
    const entry = served.get(id);
    if (entry === undefined) return Effect.succeed({ available: false, reason: unknown(id).message });
    return entry.availability === undefined ? Effect.succeed(AVAILABLE) : SubscriptionRef.get(entry.availability);
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
      const entry = served.get(id);
      if (entry === undefined) return unknown(id);
      const current = yield* availabilityOf(id);
      if (!current.available) return callFailure("unavailable", current.reason);
      return entry.capability;
    });

  const invoke = (id: string, input: unknown): Effect.Effect<Outcome<unknown, unknown>> =>
    Effect.gen(function* () {
      const admitted = yield* admit(id);
      if ("kind" in admitted) return admitted;
      const capability = admitted;
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
      const encoded = outcome.ok
        ? yield* encode(capability.output ?? Schema.Null, outcome.value).pipe(Effect.map((value) => ({ ok: true as const, value })))
        : yield* encode(Schema.Union(capability.failures ?? []), outcome.error).pipe(
            Effect.map((error) => ({ ok: false as const, error })),
          );
      return encoded ?? callFailure("internal", "The capability returned a value that does not agree with its schema.");
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

  const availabilityRefs = [...served.values()].flatMap(({ availability }) => (availability === undefined ? [] : [availability]));
  const changes = Stream.suspend(() =>
    Stream.mergeAll(
      availabilityRefs.map((ref) => changesAfter(ref, SubscriptionRef.getUnsafe(ref))),
      { concurrency: "unbounded" },
    ),
  ).pipe(Stream.as(undefined));

  let view: CatalogDocument | undefined;

  return {
    target: options.target,
    get view() {
      return (view ??= viewOf(App.document(app), options.target));
    },
    availability: availabilityOf,
    changes,
    state: stateOf,
    availabilityRef: (id) => served.get(id)?.availability,
    stateRef: (id) => served.get(id)?.state?.ref,
    invoke,
    execute,
  } satisfies Session;
  });

/** Encode a value with its schema. `undefined` if the value does not agree with the schema. */
const encode = (schema: Schema.Top, value: unknown) =>
  Schema.encodeUnknownEffect(schema as Schema.Codec<unknown, unknown>)(value).pipe(
    Effect.map((encoded) => encoded as unknown),
    Effect.catch(() => Effect.succeed(undefined)),
  );
