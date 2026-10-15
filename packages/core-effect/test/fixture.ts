/** A test application with one capability for each behavior that the tests examine. */
import { unavailable, AVAILABLE } from "@acid-cat/spec-ts";
import { Context, Deferred, Effect, Layer, Schema, Stream, SubscriptionRef } from "effect";

import { App, Capability } from "../src/index.ts";

/** A switch that the tests turn on and off, to change the availability of `fixture.toggle`. */
export class Switch extends Context.Service<Switch, SubscriptionRef.SubscriptionRef<boolean>>()("fixture/Switch") {}

/**
 * The calls to `fixture.hold` that hold now, for all the sessions of the provider. `mark` creates the file of a marker:
 * only the command line of the fixture can write files.
 */
export class Holds extends Context.Service<
  Holds,
  {
    readonly hold: (key: string, marker: string | undefined) => Effect.Effect<{ readonly key: string }>;
    readonly held: Effect.Effect<readonly string[]>;
    readonly release: (key: string) => Effect.Effect<number>;
  }
>()("fixture/Holds") {}

/** The holds of a provider. `mark` creates the file at a path. With no `mark`, a call with a marker is a defect. */
export const holdsLayer = (mark: (path: string) => Effect.Effect<void> = () => Effect.die(new Error("This host writes no files."))) =>
  Layer.sync(Holds, () => {
    const holding = new Set<{ readonly key: string; readonly release: Deferred.Deferred<void> }>();
    return {
      hold: (key, marker) =>
        Effect.acquireUseRelease(
          Effect.map(Deferred.make<void>(), (release) => {
            const entry = { key, release };
            holding.add(entry);
            return entry;
          }),
          (entry) =>
            (marker === undefined ? Effect.void : mark(marker)).pipe(
              Effect.andThen(Deferred.await(entry.release)),
              Effect.as({ key }),
            ),
          (entry) => Effect.sync(() => holding.delete(entry)),
        ),
      held: Effect.sync(() => [...holding].map((entry) => entry.key).sort()),
      release: (key) =>
        Effect.gen(function* () {
          const released = [...holding].filter((entry) => entry.key === key);
          for (const entry of released) {
            holding.delete(entry);
            yield* Deferred.succeed(entry.release, undefined);
          }
          return released.length;
        }),
    };
  });

/** The services of the fixture: the switch, on, and the holds. */
export const fixtureLayer = Layer.merge(Layer.effect(Switch, SubscriptionRef.make(true)), holdsLayer());

/** The layer of the fixture, which counts how many times it is built and released, to test when a host builds services. */
export function countedFixtureLayer() {
  const counts = { built: 0, released: 0 };
  const layer = Layer.merge(
    Layer.effect(
      Switch,
      Effect.acquireRelease(
        Effect.sync(() => counts.built++).pipe(Effect.andThen(SubscriptionRef.make(true))),
        () => Effect.sync(() => counts.released++),
      ),
    ),
    holdsLayer(),
  );
  return { counts, layer };
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
    Capability.make({
      id: "fixture.refuse",
      description: "Always return the failure Refused.",
      audience: everywhere,
      failures: [Refused],
      run: () => Effect.fail(Refused.make({ reason: "No." })),
    }),
    Capability.make({
      id: "fixture.crash",
      description: "Always fail with a defect.",
      audience: everywhere,
      run: () => Effect.die(new Error("secret internal detail")),
    }),
    Capability.make({
      id: "fixture.hold",
      description:
        "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held lists the key. With a marker, the call creates the file at that path when it starts to hold.",
      audience: everywhere,
      input: Schema.Struct({ key: Schema.String, marker: Schema.optionalKey(Schema.String) }),
      output: Key,
      run: ({ key, marker }) => Holds.use((holds) => holds.hold(key, marker)),
    }),
    Capability.make({
      id: "fixture.held",
      description: "List the keys of the calls to fixture.hold that hold now, in code point order.",
      audience: everywhere,
      readOnly: true,
      output: Schema.Struct({ keys: Schema.Array(Schema.String) }),
      run: () => Holds.use((holds) => Effect.map(holds.held, (keys) => ({ keys }))),
    }),
    Capability.make({
      id: "fixture.release",
      description: "Release the calls to fixture.hold that hold the key, and return how many calls it released.",
      audience: everywhere,
      input: Key,
      output: Schema.Struct({ released: Schema.Int }),
      run: ({ key }) => Holds.use((holds) => Effect.map(holds.release(key), (released) => ({ released }))),
    }),
    Capability.make({
      id: "fixture.hidden",
      description: "Only the app target can use this capability.",
      audience: ["app"],
      run: () => Effect.succeed(null),
    }),
    Capability.make({
      id: "fixture.toggle",
      description: "Available only while the switch is on.",
      audience: everywhere,
      input: Schema.Struct({}),
      availability: Stream.unwrap(
        Effect.gen(function* () {
          const ref = yield* Switch;
          return SubscriptionRef.changes(ref).pipe(Stream.map((on) => (on ? AVAILABLE : unavailable("The switch is off."))));
        }),
      ),
      run: () => Effect.succeed(null),
    }),
    Capability.make({
      id: "fixture.switch.set",
      description: "Turn the switch on or off. The switch controls the availability of fixture.toggle.",
      audience: everywhere,
      input: Schema.Struct({ on: Schema.Boolean }),
      run: ({ on }) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(yield* Switch, on);
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
