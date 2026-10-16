import assert from "node:assert/strict";
import { test } from "node:test";

import { CallFailureError } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, SubscriptionRef } from "effect";

import { Handles } from "../src/index.ts";
import { aircon, Unit, unitLayer } from "../examples/aircon.ts";
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
