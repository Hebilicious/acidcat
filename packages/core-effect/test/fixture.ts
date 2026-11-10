/** A test application with one capability for each behavior that the tests examine. */
import { unavailable, AVAILABLE } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Deferred, Effect, Layer, PubSub, Schema, Stream, SubscriptionRef } from "effect";

import { App, Capability, Event } from "../src/index.ts";

/** A switch that the tests turn on and off. It holds the availability of `fixture.toggle`. */
export class Switch extends Context.Service<Switch, SubscriptionRef.SubscriptionRef<Availability>>()("fixture/Switch") {}

/** The availability of `fixture.toggle` when the switch is on or off. */
export const position = (on: boolean): Availability => (on ? AVAILABLE : unavailable("The switch is off."));

export const switchLayer = Layer.effect(Switch, SubscriptionRef.make(position(true)));

/** The calls to `fixture.hold` that hold now, for all the sessions of one provider. */
export class Holds extends Context.Service<
  Holds,
  {
    /** Hold until `release` releases the key. An interruption stops the hold. */
    readonly hold: (key: string, marker: string | undefined) => Effect.Effect<void>;
    readonly held: Effect.Effect<ReadonlyArray<string>>;
    readonly release: (key: string) => Effect.Effect<void>;
  }
>()("fixture/Holds") {}

/** The holds of one provider. `mark` writes the file of a marker. A page cannot write files, so only the command line of the fixture gives it. */
export const holdsLayer = (mark?: (path: string) => Effect.Effect<void>) =>
  Layer.sync(Holds, () => {
    const holding = new Set<{ readonly key: string; readonly released: Deferred.Deferred<void> }>();
    return {
      hold: (key, marker) =>
        Effect.acquireUseRelease(
          Effect.map(Deferred.make<void>(), (released) => {
            const entry = { key, released };
            holding.add(entry);
            return entry;
          }),
          (entry) => Effect.andThen(marker === undefined || mark === undefined ? Effect.void : mark(marker), Deferred.await(entry.released)),
          (entry) => Effect.sync(() => holding.delete(entry)),
        ),
      held: Effect.sync(() => [...holding].map((entry) => entry.key)),
      release: (key) =>
        Effect.forEach(
          [...holding].filter((entry) => entry.key === key),
          (entry) => Deferred.succeed(entry.released, undefined),
          { discard: true },
        ),
    };
  });

/** The subscriptions to `fixture.watch` that are active now, for all the sessions of one provider. */
export class Watchers extends Context.Service<
  Watchers,
  {
    /**
     * The values that `signal` gives for the key, while the stream runs. The watch starts before the stream first
     * waits. With a marker, the stream writes its file after the watch starts.
     */
    readonly watch: (key: string, marker: string | undefined) => Stream.Stream<string>;
    readonly watching: Effect.Effect<ReadonlyArray<string>>;
    /** Give the value to each watch of the key. Give the number of these watches. */
    readonly signal: (key: string, value: string) => Effect.Effect<number>;
  }
>()("fixture/Watchers") {}

/** The watchers of one provider. `mark` writes the file of a marker, as for `holdsLayer`. */
export const watchersLayer = (mark?: (path: string) => Effect.Effect<void>) =>
  Layer.effect(
    Watchers,
    Effect.gen(function* () {
      const signals = yield* PubSub.unbounded<{ readonly key: string; readonly value: string }>();
      const watching = new Set<{ readonly key: string }>();
      return {
        watch: (key, marker) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const subscription = yield* Effect.acquireRelease(
                Effect.map(PubSub.subscribe(signals), (subscription) => {
                  const entry = { key };
                  watching.add(entry);
                  return { subscription, entry };
                }),
                ({ entry }) => Effect.sync(() => watching.delete(entry)),
              );
              if (marker !== undefined && mark !== undefined) yield* mark(marker);
              return Stream.fromSubscription(subscription.subscription).pipe(
                Stream.filter((signal) => signal.key === key),
                Stream.map((signal) => signal.value),
              );
            }),
          ),
        watching: Effect.sync(() => [...watching].map((entry) => entry.key)),
        signal: (key, value) =>
          Effect.as(
            PubSub.publish(signals, { key, value }),
            [...watching].filter((entry) => entry.key === key).length,
          ),
      };
    }),
  );

/** The services of the fixture: the switch, which is on, the holds and the watchers. */
export const fixtureLayer = Layer.mergeAll(switchLayer, holdsLayer(), watchersLayer());

/** The services of the fixture, which count how many times the switch is built and released, to test when a host builds the services. */
export function countedFixtureLayer() {
  const counts = { built: 0, released: 0 };
  const counted = Layer.effect(
    Switch,
    Effect.acquireRelease(
      Effect.sync(() => counts.built++).pipe(Effect.andThen(SubscriptionRef.make(position(true)))),
      () => Effect.sync(() => counts.released++),
    ),
  );
  return { counts, layer: Layer.mergeAll(counted, holdsLayer(), watchersLayer()) };
}

const Text = Schema.Struct({ text: Schema.String });
const Key = Schema.Struct({ key: Schema.String });
const Refused = Schema.TaggedStruct("Refused", { reason: Schema.String });
const Keys = Schema.Struct({ keys: Schema.Array(Schema.String) });
const Tick = Schema.Struct({ n: Schema.Int });
const Watched = Schema.Struct({ key: Schema.String, value: Schema.String });

/** The position after a cursor of `fixture.ticks`. A cursor that is not a count starts at the first tick. */
const after = (cursor: string | undefined): number => {
  const position = Number(cursor);
  return Number.isInteger(position) && position >= 0 ? position + 1 : 1;
};

const Flags = Schema.Struct({
  mode: Schema.Literals(["fast", "slow"]),
  count: Schema.optionalKey(Schema.Int),
  ratio: Schema.optionalKey(Schema.Finite),
  label: Schema.optionalKey(Schema.String),
  verbose: Schema.optionalKey(Schema.Boolean),
  extra: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  steps: Schema.optionalKey(Schema.Array(Schema.Int)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});

const everywhere = ["app", "mcp", "cli", "api"];

export const echo = Capability.make({
  id: "fixture.echo",
  description: "Return the input text.",
  audience: everywhere,
  readOnly: true,
  input: Text,
  output: Text,
  run: (input) => Effect.succeed(input),
});

export const refuse = Capability.make({
  id: "fixture.refuse",
  description: "Always return the failure Refused.",
  audience: everywhere,
  failures: [Refused],
  run: () => Effect.fail(Refused.make({ reason: "No." })),
});

export const hidden = Capability.make({
  id: "fixture.hidden",
  description: "Only the app target can use this capability.",
  audience: ["app"],
  run: () => Effect.succeed(null),
});

export const fixture = App.make({
  title: "Fixture",
  description: "One capability or event for each behavior that acid-cat conform tests.",
  targets: {
    app: { bindings: ["typescript", "webmcp"] },
    mcp: { bindings: ["mcp"] },
    cli: { bindings: ["cli"] },
    api: { bindings: ["http"] },
  },
  capabilities: [
    echo,
    refuse,
    Capability.make({
      id: "fixture.crash",
      description: "Always fail with a defect.",
      audience: everywhere,
      run: () => Effect.die(new Error("secret internal detail")),
    }),
    Capability.make({
      id: "fixture.hold",
      description:
        "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held gives the key. With a marker, the call writes a file at that path when it starts to hold.",
      audience: everywhere,
      input: Schema.Struct({ key: Schema.String, marker: Schema.optionalKey(Schema.String) }),
      output: Key,
      run: ({ key, marker }) => Holds.use((holds) => holds.hold(key, marker)).pipe(Effect.as({ key })),
    }),
    Capability.make({
      id: "fixture.held",
      description: "Return the keys of the calls to fixture.hold that hold now.",
      audience: everywhere,
      readOnly: true,
      output: Keys,
      run: () => Holds.use((holds) => Effect.map(holds.held, (keys) => ({ keys }))),
    }),
    Capability.make({
      id: "fixture.release",
      description: "Release the calls to fixture.hold that hold the key.",
      audience: everywhere,
      input: Key,
      run: ({ key }) => Holds.use((holds) => holds.release(key)).pipe(Effect.as(null)),
    }),
    hidden,
    Capability.make({
      id: "fixture.toggle",
      description: "Available only while the switch is on.",
      audience: everywhere,
      input: Schema.Struct({}),
      availability: Switch,
      run: () => Effect.succeed(null),
    }),
    Capability.make({
      id: "fixture.switch.set",
      description: "Turn the switch on or off. The switch controls the availability of fixture.toggle.",
      audience: everywhere,
      input: Schema.Struct({ on: Schema.Boolean }),
      run: ({ on }) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(yield* Switch, position(on));
          return null;
        }),
    }),
    Capability.make({
      id: "fixture.flags",
      description: "Return the input. The input has one property for each kind of command-line flag.",
      audience: ["cli"],
      input: Flags,
      output: Flags,
      run: (input) => Effect.succeed(input),
    }),
    Capability.make({
      id: "fixture.signal",
      description: "Give an occurrence of fixture.watch to each subscription that watches the key. Return the number of these subscriptions.",
      audience: everywhere,
      input: Watched,
      output: Schema.Struct({ delivered: Schema.Int }),
      run: ({ key, value }) => Watchers.use((watchers) => Effect.map(watchers.signal(key, value), (delivered) => ({ delivered }))),
    }),
    Capability.make({
      id: "fixture.watching",
      description: "Return the keys of the subscriptions to fixture.watch that are active now.",
      audience: everywhere,
      readOnly: true,
      output: Keys,
      run: () => Watchers.use((watchers) => Effect.map(watchers.watching, (keys) => ({ keys }))),
    }),
  ],
  events: [
    Event.make({
      id: "fixture.ticks",
      description: "Give the occurrences n = 1 to count, with the eventId and the cursor String(n), then end. With a cursor c, start at c + 1.",
      audience: everywhere,
      input: Schema.Struct({ count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })) }),
      payload: Tick,
      subscribe: ({ count }, { cursor }) =>
        Stream.range(after(cursor), count).pipe(Stream.map((n) => ({ data: { n }, eventId: String(n), cursor: String(n) }))),
    }),
    Event.make({
      id: "fixture.watch",
      description: "Give an occurrence each time that fixture.signal gets the key. Never end. With a marker, write a file at that path when the subscription starts.",
      audience: everywhere,
      input: Schema.Struct({ key: Schema.String, marker: Schema.optionalKey(Schema.String) }),
      payload: Watched,
      subscribe: ({ key, marker }) =>
        Stream.unwrap(Watchers.use((watchers) => Effect.succeed(watchers.watch(key, marker)))).pipe(Stream.map((value) => ({ data: { key, value } }))),
    }),
    Event.make({
      id: "fixture.broken",
      description: "Give the occurrence n = 1, then fail with a defect.",
      audience: everywhere,
      payload: Tick,
      subscribe: () => Stream.concat(Stream.make({ data: { n: 1 } }), Stream.die(new Error("secret internal detail"))),
    }),
    Event.make({
      id: "fixture.secret",
      description: "Only the app target can follow this event. It never gives an occurrence.",
      audience: ["app"],
      subscribe: () => Stream.never,
    }),
  ],
});

/**
 * An application with one capability, `held.wait`, that runs until it is interrupted. `started` completes when the
 * call starts, and `interrupted` when the call is interrupted.
 */
export function heldApp() {
  const started = Deferred.makeUnsafe<void>();
  const interrupted = Deferred.makeUnsafe<void>();
  const app = App.make({
    targets: { mcp: { bindings: ["mcp"] }, api: { bindings: ["http"] } },
    capabilities: [
      Capability.make({
        id: "held.wait",
        description: "Wait until the call is cancelled.",
        audience: ["mcp", "api"],
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      }),
    ],
  });
  return { app, started, interrupted };
}

/** An application with one capability, `recorded.run`. `record.ran` tells if a call ran it. */
export function recordingApp() {
  const record = { ran: false };
  const app = App.make({
    targets: { mcp: { bindings: ["mcp"] }, api: { bindings: ["http"] } },
    capabilities: [
      Capability.make({
        id: "recorded.run",
        description: "Record that a call ran the capability.",
        audience: ["mcp", "api"],
        run: () => Effect.sync(() => void (record.ran = true)).pipe(Effect.as(null)),
      }),
    ],
  });
  return { app, record };
}
