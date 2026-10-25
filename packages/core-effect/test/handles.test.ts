import assert from "node:assert/strict";
import { test } from "node:test";

import { CallFailureError } from "@acid-cat/spec-ts";
import type { Availability, Result } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, Option, Schema, SchemaGetter, SchemaTransformation, Stream, SubscriptionRef } from "effect";

import { App, Capability, Handles, Session } from "../src/index.ts";
import { fixture, fixtureLayer, holdsLayer, position, Switch } from "./fixture.ts";
import { Burnt, Lamp, lamp, lampLayer, Light, lightGet, pair, powerSet, sceneSet, Unreachable } from "./lamp.ts";

/** The error that a promise rejects with. */
const rejection = (promise: Promise<unknown>) => promise.then(() => assert.fail("the promise must reject"), (error: unknown) => error);

/** The call failure that a promise rejects with. */
const callFailure = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail("the call must reject"),
    (error: unknown) => {
      assert.ok(error instanceof CallFailureError);
      return error;
    },
  );

/** The handle of an id. The handle must exist. */
const handleOf = (handles: ReadonlyMap<string, Handles.Handle>, id: string) => {
  const handle = handles.get(id);
  assert.ok(handle, `there is a handle for ${id}`);
  return handle;
};

test("handles give results, and reject call failures with their kind", async () => {
  const session = await Handles.open(fixture, fixtureLayer, { target: "app" });
  try {
    assert.deepEqual([...session.handles.keys()], Object.keys(session.view.capabilities));
    const handle = (id: string) => handleOf(session.handles, id);

    assert.deepEqual(await handle("fixture.echo").execute({ text: "hi" }), { ok: true, value: { text: "hi" } });
    assert.deepEqual(await handle("fixture.echo").invokeExternal({ text: "hi" }), { ok: true, value: { text: "hi" } });
    assert.deepEqual(await handle("fixture.refuse").execute({}), { ok: false, error: { _tag: "Refused", reason: "No." } });

    const invalid = await callFailure(handle("fixture.echo").invokeExternal({ text: 1 }));
    assert.equal(invalid.kind, "invalid-input");
    assert.equal(invalid.name, "TypeError");
    assert.equal((await callFailure(handle("fixture.crash").execute({}))).kind, "internal");

    const controller = new AbortController();
    const held = callFailure(handle("fixture.hold").execute({ key: "cancelled" }, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const cancelled = await held;
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.name, "AbortError");
  } finally {
    await session.dispose();
  }
});

test("a handle reads its availability when it is asked, and follows it only while it has listeners", async () => {
  const switchRef = Effect.runSync(SubscriptionRef.make(position(true)));
  const turn = (on: boolean) => Effect.runSync(SubscriptionRef.set(switchRef, position(on)));
  const session = await Handles.open(fixture, Layer.merge(Layer.succeed(Switch, switchRef), holdsLayer()), { target: "app" });
  const toggle = handleOf(session.handles, "fixture.toggle");
  assert.equal(switchRef.pubsub.subscribers.size, 0);

  turn(false);
  assert.deepEqual(toggle.availability.getSnapshot(), position(false));
  assert.equal((await callFailure(toggle.execute({}))).kind, "unavailable");

  const seen: Availability[] = [];
  const first = toggle.availability.subscribe((value) => seen.push(value));
  const second = toggle.availability.subscribe(() => undefined);
  assert.equal(switchRef.pubsub.subscribers.size, 1);
  turn(false);
  turn(true);
  turn(true);
  assert.deepEqual(seen, [position(true)]);

  first.unsubscribe();
  assert.equal(switchRef.pubsub.subscribers.size, 1);
  second.unsubscribe();
  assert.equal(switchRef.pubsub.subscribers.size, 0);
  turn(false);
  assert.deepEqual(seen, [position(true)]);

  toggle.availability.subscribe(() => undefined);
  assert.equal(switchRef.pubsub.subscribers.size, 1);
  const held = callFailure(handleOf(session.handles, "fixture.hold").execute({ key: "pending" }));
  await session.dispose();
  assert.equal(switchRef.pubsub.subscribers.size, 0);
  assert.equal((await held).kind, "cancelled");
  assert.ok(session.signal.aborted);
});

test("a handle gives the state as copies, and follows it only while it has listeners", async () => {
  const device = Context.get(Effect.runSync(Effect.scoped(Layer.build(lampLayer))), Lamp);
  const session = await Handles.open(lamp, Layer.succeed(Lamp, device), { target: "app" });
  try {
    const snapshot = Handles.get(session.handles, lightGet).snapshot;
    assert.ok(snapshot);
    const first = snapshot.getSnapshot();
    assert.equal(first.on, false);
    Object.assign(first, { on: true });
    assert.equal(snapshot.getSnapshot().on, false);
    assert.equal(device.light.pubsub.subscribers.size, 0);

    const seen: (typeof Light.Encoded)[] = [];
    const subscription = snapshot.subscribe((value) => seen.push(value));
    assert.equal(device.light.pubsub.subscribers.size, 1);
    await Handles.get(session.handles, powerSet).execute({ on: true });
    assert.deepEqual(seen.map((value) => value.on), [true]);
    const [changed] = seen;
    assert.ok(changed);
    Object.assign(changed, { on: false });
    assert.equal(snapshot.getSnapshot().on, true);

    subscription.unsubscribe();
    assert.equal(device.light.pubsub.subscribers.size, 0);
    assert.equal(handleOf(session.handles, powerSet.id).snapshot, undefined);
  } finally {
    await session.dispose();
  }
});

test("handles need a state schema that encodes synchronously, a failed open releases the services, and a session does not need it", async () => {
  const encodeLater = SchemaGetter.transformOptionalEffect((value: Option.Option<string>) => Effect.promise(async () => value));
  const Suspending = Schema.String.pipe(
    Schema.decodeTo(Schema.String, SchemaTransformation.makeTransformation({ decode: SchemaGetter.passthrough(), encode: encodeLater })),
  );
  class Label extends Context.Service<Label, SubscriptionRef.SubscriptionRef<string>>()("probe/Label") {}
  const counts = { built: 0, released: 0 };
  const labelLayer = Layer.effect(
    Label,
    Effect.acquireRelease(
      Effect.sync(() => counts.built++).pipe(Effect.andThen(SubscriptionRef.make("first"))),
      () => Effect.sync(() => counts.released++),
    ),
  );
  const app = App.make({
    targets: { app: { bindings: ["typescript"] } },
    capabilities: [
      Capability.make({
        id: "probe.label.get",
        description: "Read the label.",
        audience: ["app"],
        state: { schema: Suspending, value: Label },
        run: () => Effect.succeed(null),
      }),
    ],
  });

  const error = await rejection(Handles.open(app, labelLayer, { target: "app" }));
  assert.ok(error instanceof Error);
  assert.equal(error.message, "The state schema of probe.label.get does not encode synchronously. A handle needs a state schema that encodes synchronously.");
  assert.deepEqual(counts, { built: 1, released: 1 });

  const [state] = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(Session.make(app, { target: "app" }), (session) => session.state("probe.label.get").pipe(Stream.take(1), Stream.runCollect))).pipe(
      Effect.provide(labelLayer),
    ),
  );
  assert.equal(state, "first");
});

test("Handles.get gives a handle with the types of its capability", async () => {
  const session = await Handles.open(lamp, lampLayer, { target: "app" });
  try {
    const power = Handles.get(session.handles, powerSet);
    const powered: Result<null, typeof Unreachable.Type | typeof Burnt.Type> = await power.execute({ on: true });
    assert.deepEqual(powered, { ok: true, value: null });

    const scene = Handles.get(session.handles, sceneSet);
    const chosen: Result<null, typeof Unreachable.Type> = await scene.execute({ scene: "relax" });
    assert.deepEqual(chosen, { ok: true, value: null });

    const light = Handles.get(session.handles, lightGet);
    const value: Result<typeof Light.Type, typeof Unreachable.Type> = await light.execute({});
    const snapshot: typeof Light.Encoded | undefined = light.snapshot?.getSnapshot();
    assert.deepEqual(value, { ok: true, value: snapshot });
    assert.deepEqual(snapshot, { on: true, brightness: 80, kelvin: 3000, scene: "relax" });

    // These calls do not run. `moon run core-effect:typecheck` checks that each one is an error.
    const wrongCalls = () => [
      // @ts-expect-error The input of lamp.power.set has `on`, a boolean.
      power.execute({ on: "yes" }),
      // @ts-expect-error The scene is one of the literals of `Scene`.
      scene.execute({ scene: "disco" }),
      // @ts-expect-error The light has no `colour`.
      light.snapshot?.getSnapshot().colour,
    ];
    void wrongCalls;
  } finally {
    await session.dispose();
  }
});

test("Handles.get gives an always unavailable handle for a capability outside the view", async () => {
  const session = await Handles.open(lamp, lampLayer, { target: "remote" });
  try {
    const pairing = Handles.get(session.handles, pair);
    assert.equal(session.handles.has(pair.id), false);
    assert.equal(pairing.id, "lamp.pair");
    assert.deepEqual(pairing.availability.getSnapshot(), { available: false, reason: "There is no capability lamp.pair." });
    assert.equal(pairing.snapshot, undefined);
    for (const call of [pairing.execute({}), pairing.invokeExternal({})]) {
      assert.equal((await callFailure(call)).kind, "unknown-capability");
    }
  } finally {
    await session.dispose();
  }
});
