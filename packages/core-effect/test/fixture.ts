/** A test application with one capability for each behavior that the tests examine. */
import { unavailable, AVAILABLE } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Deferred, Effect, Layer, Schema, SubscriptionRef } from "effect";

import { App, Capability } from "../src/index.ts";

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

/** The services of the fixture: the switch, which is on, and the holds. */
export const fixtureLayer = Layer.merge(switchLayer, holdsLayer());

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
  return { counts, layer: Layer.merge(counted, holdsLayer()) };
}

const Text = Schema.Struct({ text: Schema.String });
const Key = Schema.Struct({ key: Schema.String });
const Refused = Schema.TaggedStruct("Refused", { reason: Schema.String });

const Flags = Schema.Struct({
  mode: Schema.Literals(["fast", "slow"]),
  count: Schema.optionalKey(Schema.Int),
  ratio: Schema.optionalKey(Schema.Finite),
  label: Schema.optionalKey(Schema.String),
  verbose: Schema.optionalKey(Schema.Boolean),
  extra: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

const everywhere = ["app", "mcp", "cli", "api"];

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
  description: "One capability for each behavior that acid-cat conform tests.",
  targets: {
    app: { bindings: ["typescript", "webmcp"] },
    mcp: { bindings: ["mcp"] },
    cli: { bindings: ["cli"] },
    api: { bindings: ["http"] },
  },
  capabilities: [
    Capability.make({
      id: "fixture.echo",
      description: "Return the input text.",
      audience: everywhere,
      readOnly: true,
      input: Text,
      output: Text,
      run: (input) => Effect.succeed(input),
    }),
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
      output: Schema.Struct({ keys: Schema.Array(Schema.String) }),
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
