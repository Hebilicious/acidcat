import { unavailable, AVAILABLE } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Deferred, Effect, Layer, PubSub, Schema, Stream, SubscriptionRef } from "effect";

import * as App from "../src/App.ts";
import * as Capability from "../src/Capability.ts";
import * as Event from "../src/Event.ts";

export class Switch extends Context.Service<Switch, SubscriptionRef.SubscriptionRef<Availability>>()("fixture/Switch") {}

export const position = (on: boolean): Availability => (on ? AVAILABLE : unavailable("The switch is off."));

export const switchLayer = Layer.effect(Switch, SubscriptionRef.make(position(true)));

export class Holds extends Context.Service<
  Holds,
  {
    readonly hold: (key: string, marker: string | undefined) => Effect.Effect<void>;
    readonly held: Effect.Effect<ReadonlyArray<string>>;
    readonly release: (key: string) => Effect.Effect<void>;
  }
>()("fixture/Holds") {}

export interface Marker {
  readonly write: (path: string) => Effect.Effect<void>;
  readonly remove: (path: string) => Effect.Effect<void>;
}

export const holdsLayer = (marker?: Marker, { ignoreInterruption = false }: { readonly ignoreInterruption?: boolean } = {}) =>
  Layer.sync(Holds, () => {
    const holding = new Set<{ readonly key: string; readonly released: Deferred.Deferred<void> }>();
    const writeMarker = (path: string | undefined) => (path === undefined || marker === undefined ? Effect.void : marker.write(path));
    const holdOnAfterInterrupt = (path: string | undefined) => (released: Deferred.Deferred<void>) =>
      Deferred.await(released).pipe(
        Effect.interruptible,
        Effect.onInterrupt(() => writeMarker(path === undefined ? undefined : `${path}.cancelled`)),
        Effect.exit,
        Effect.andThen(Deferred.await(released)),
      );
    const hold = (key: string, path: string | undefined, wait: (released: Deferred.Deferred<void>) => Effect.Effect<void> = Deferred.await) =>
      Effect.acquireUseRelease(
        Effect.map(Deferred.make<void>(), (released) => {
          const entry = { key, released };
          holding.add(entry);
          return entry;
        }),
        (entry) => Effect.andThen(writeMarker(path), wait(entry.released)),
        (entry) =>
          Effect.andThen(
            Effect.sync(() => holding.delete(entry)),
            path === undefined || marker === undefined ? Effect.void : marker.remove(path),
          ),
      );
    return {
      hold: ignoreInterruption ? (key, path) => Effect.uninterruptible(hold(key, path, holdOnAfterInterrupt(path))) : (key, path) => hold(key, path),
      held: Effect.sync(() => [...holding].map((entry) => entry.key)),
      release: (key) =>
        Effect.forEach(
          [...holding].filter((entry) => entry.key === key),
          (entry) => Deferred.succeed(entry.released, undefined),
          { discard: true },
        ),
    };
  });

export class Watchers extends Context.Service<
  Watchers,
  {
    readonly watch: (key: string, marker: string | undefined) => Stream.Stream<string>;
    readonly watching: Effect.Effect<ReadonlyArray<string>>;
    readonly signal: (key: string, value: string) => Effect.Effect<number>;
  }
>()("fixture/Watchers") {}

export const watchersLayer = (marker?: Marker) =>
  Layer.effect(
    Watchers,
    Effect.gen(function* () {
      const signals = yield* PubSub.unbounded<{ readonly key: string; readonly value: string }>();
      const watching = new Set<{ readonly key: string }>();
      return {
        watch: (key, path) =>
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
              if (path !== undefined && marker !== undefined) yield* Effect.acquireRelease(marker.write(path), () => marker.remove(path));
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

export const POLL = { bufferLimit: 5, leaseMs: 5000 } as const;

export const WEBHOOK_LIMITS = { minTtlMs: 1000, maxTtlMs: 5000, maxSubscriptions: 3 } as const;

export const fixtureLayer = Layer.mergeAll(switchLayer, holdsLayer(), watchersLayer());

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

const Note = Schema.Struct({ text: Schema.String, loud: Schema.optionalKey(Schema.Boolean) }).annotate({ identifier: "Note" });

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
    cli: {
      bindings: ["cli"],
      options: {
        cli: {
          aliases: {
            say: { capability: "fixture.echo" },
            "--hello": { capability: "fixture.echo", input: { text: "hello" } },
            quick: { capability: "fixture.flags", input: { mode: "fast" } },
            raw: { capability: "fixture.raw" },
            "held-keys": { capability: "fixture.held" },
            "fixed-note": { capability: "fixture.note", input: { text: "fixed" } },
            ticks: { event: "fixture.ticks", input: { count: 2 } },
            "broken-ticks": { event: "fixture.broken" },
            echoes: { event: "fixture.echoes" },
            notes: { capability: "fixture.raw" },
            "notes add": { capability: "fixture.note" },
            "notes loud": { capability: "fixture.note", input: { loud: true } },
            "shout hello": { capability: "fixture.echo", input: { text: "HELLO" } },
          },
          default: "quick",
        },
      },
    },
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
        "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held gives the key. With a marker, the call writes a file at that path when it starts to hold, and deletes the file when it ends.",
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
      destructive: true,
      idempotent: true,
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
      id: "fixture.note",
      description: "Return the input. The input schema is a $ref with a description beside it.",
      audience: ["cli"],
      // Effect writes the description of a schema with an identifier into its type. The description of a suspended
      // schema stays beside the $ref.
      input: Schema.suspend(() => Note).annotate({ description: "The note." }),
      output: Note,
      run: (input) => Effect.succeed(input),
    }),
    Capability.make({
      id: "fixture.raw",
      description: "Return the input. The input schema has no top-level properties member.",
      audience: ["cli"],
      input: Schema.Record(Schema.String, Schema.Unknown),
      output: Schema.Record(Schema.String, Schema.Unknown),
      run: (input) => Effect.succeed(input),
    }),
    Capability.make({
      id: "fixture.signal",
      description: "Give an occurrence of fixture.watch to each subscription that watches the key. Return the number of these subscriptions.",
      audience: everywhere,
      destructive: false,
      idempotent: false,
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
      description: "Give the occurrences n = 1 to count, with the eventId and the cursor String(n), then end. With a cursor c, start at c + 1. With a gap g, the occurrence n = g has truncated: true, as if the source skipped occurrences before it. The key changes nothing: it gives the subscriptions of each test their own input.",
      audience: everywhere,
      input: Schema.Struct({
        count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
        gap: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
        key: Schema.optionalKey(Schema.String),
      }),
      payload: Tick,
      subscribe: ({ count, gap }, { cursor }) =>
        Stream.range(after(cursor), count).pipe(
          Stream.map((n) => {
            const tick = { data: { n }, eventId: String(n), cursor: String(n) };
            return n === gap ? { ...tick, truncated: true as const } : tick;
          }),
        ),
    }),
    Event.make({
      id: "fixture.watch",
      description: "Give an occurrence each time that fixture.signal gets the key. Never end. With a marker, write a file at that path when the subscription starts, and delete the file when it ends.",
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
      id: "fixture.echoes",
      description: "Give one occurrence whose data is the input, then end.",
      audience: ["cli"],
      input: Schema.Record(Schema.String, Schema.Unknown),
      payload: Schema.Record(Schema.String, Schema.Unknown),
      subscribe: (input) => Stream.make({ data: input }),
    }),
    Event.make({
      id: "fixture.secret",
      description: "Only the app target can follow this event. It never gives an occurrence.",
      audience: ["app"],
      subscribe: () => Stream.never,
    }),
  ],
});

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
