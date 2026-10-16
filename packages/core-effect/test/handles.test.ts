import assert from "node:assert/strict";
import { test } from "node:test";

import { CallFailureError } from "@acid-cat/spec-ts";
import type { Availability, Result } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, Option, Schema, SchemaGetter, SchemaTransformation, Stream, SubscriptionRef } from "effect";

import { App, Capability, Handles, Session } from "../src/index.ts";
import { aircon, firmwareUpdate, modeSet, Offline, PoweredOff, powerSet, Status, statusGet, Unit, unitLayer } from "../examples/aircon.ts";
import { fixture, fixtureLayer, holdsLayer, position, Switch } from "./fixture.ts";

const rejection = (promise: Promise<unknown>) => promise.then(() => assert.fail("the call must reject"), (error: unknown) => error);

test("handles give results, and reject call failures with their kind", async () => {
  const session = await Handles.open(fixture, fixtureLayer, { target: "app" });
  try {
    assert.deepEqual([...session.handles.keys()], Object.keys(session.view.capabilities));
    const handle = (id: string) => session.handles.get(id)!;

    assert.deepEqual(await handle("fixture.echo").execute({ text: "hi" }), { ok: true, value: { text: "hi" } });
    assert.deepEqual(await handle("fixture.echo").invokeExternal({ text: "hi" }), { ok: true, value: { text: "hi" } });
    const refused = await handle("fixture.refuse").execute({});
    assert.equal(refused.ok, false);
    assert.equal((refused as { error: { _tag: string } }).error._tag, "Refused");

    const invalid = await rejection(handle("fixture.echo").invokeExternal({ text: 1 }));
    assert.ok(invalid instanceof CallFailureError);
    assert.equal(invalid.kind, "invalid-input");
    assert.equal(invalid.name, "TypeError");
    assert.equal(((await rejection(handle("fixture.crash").execute({}))) as CallFailureError).kind, "internal");

    const controller = new AbortController();
    const held = rejection(handle("fixture.hold").execute({ key: "cancelled" }, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const cancelled = (await held) as CallFailureError;
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
  const toggle = session.handles.get("fixture.toggle")!;
  assert.equal(switchRef.pubsub.subscribers.size, 0);

  turn(false);
  assert.deepEqual(toggle.availability.getSnapshot(), position(false));
  assert.equal(((await rejection(toggle.execute({}))) as CallFailureError).kind, "unavailable");

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
  const held = rejection(session.handles.get("fixture.hold")!.execute({ key: "pending" }));
  await session.dispose();
  assert.equal(switchRef.pubsub.subscribers.size, 0);
  assert.equal(((await held) as CallFailureError).kind, "cancelled");
  assert.ok(session.signal.aborted);
});

test("a handle gives the state as copies, and follows it only while it has listeners", async () => {
  const unit = Context.get(Effect.runSync(Effect.scoped(Layer.build(unitLayer))), Unit);
  const session = await Handles.open(aircon, Layer.succeed(Unit, unit), { target: "app" });
  try {
    const snapshot = session.handles.get("aircon.status.get")!.snapshot!;
    const first = snapshot.getSnapshot() as { power: boolean };
    assert.equal(first.power, false);
    first.power = true;
    assert.equal((snapshot.getSnapshot() as { power: boolean }).power, false);
    assert.equal(unit.status.pubsub.subscribers.size, 0);

    const seen: { power: boolean }[] = [];
    const subscription = snapshot.subscribe((value) => seen.push(value as { power: boolean }));
    assert.equal(unit.status.pubsub.subscribers.size, 1);
    await session.handles.get("aircon.power.set")!.execute({ on: true });
    assert.deepEqual(seen.map((value) => value.power), [true]);
    seen[0]!.power = false;
    assert.equal((snapshot.getSnapshot() as { power: boolean }).power, true);

    subscription.unsubscribe();
    assert.equal(unit.status.pubsub.subscribers.size, 0);
    assert.equal(session.handles.get("aircon.power.set")!.snapshot, undefined);
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
  const session = await Handles.open(aircon, unitLayer, { target: "app" });
  try {
    const power = Handles.get(session.handles, powerSet);
    const powered: Result<null, typeof Offline.Type> = await power.execute({ on: true });
    assert.deepEqual(powered, { ok: true, value: null });

    const mode = Handles.get(session.handles, modeSet);
    const moded: Result<null, typeof Offline.Type | typeof PoweredOff.Type> = await mode.execute({ mode: "heat" });
    assert.deepEqual(moded, { ok: true, value: null });

    const status = Handles.get(session.handles, statusGet);
    const value: Result<typeof Status.Type, typeof Offline.Type> = await status.execute({});
    const snapshot: typeof Status.Encoded | undefined = status.snapshot?.getSnapshot();
    assert.deepEqual(value, { ok: true, value: snapshot });

    // These calls do not run. `moon run core-effect:typecheck` checks that each one is an error.
    const wrongCalls = () => [
      // @ts-expect-error The input of aircon.power.set has `on`, a boolean.
      power.execute({ on: "yes" }),
      // @ts-expect-error The mode is one of the literals of `Mode`.
      mode.execute({ mode: "boil" }),
      // @ts-expect-error The status has no `humidity`.
      status.snapshot?.getSnapshot().humidity,
    ];
    void wrongCalls;
  } finally {
    await session.dispose();
  }
});

test("Handles.get gives an always unavailable handle for a capability outside the view", async () => {
  const session = await Handles.open(aircon, unitLayer, { target: "taskbar" });
  try {
    const firmware = Handles.get(session.handles, firmwareUpdate);
    assert.equal(session.handles.has(firmwareUpdate.id), false);
    assert.equal(firmware.id, "aircon.firmware.update");
    assert.deepEqual(firmware.availability.getSnapshot(), { available: false, reason: "There is no capability aircon.firmware.update." });
    assert.equal(firmware.snapshot, undefined);
    for (const call of [firmware.execute({}), firmware.invokeExternal({})]) {
      const error = await rejection(call);
      assert.ok(error instanceof CallFailureError);
      assert.equal(error.kind, "unknown-capability");
    }
  } finally {
    await session.dispose();
  }
});
