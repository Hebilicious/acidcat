import assert from "node:assert/strict";
import { test } from "node:test";

import { CallFailureError } from "@acid-cat/spec-ts";

import { Effect, Layer, SubscriptionRef } from "effect";

import { Handles } from "../src/index.ts";
import { aircon, unitLayer } from "../examples/aircon.ts";
import { fixture, holdsLayer, Switch } from "./fixture.ts";

/** Wait until an observable gives a value that agrees with `condition`. Its value now counts. */
function until<T>(observable: Handles.Observable<T>, condition: (value: T) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (condition(observable.getSnapshot())) return resolve();
    const subscription = observable.subscribe((value) => {
      if (!condition(value)) return;
      subscription.unsubscribe();
      resolve();
    });
  });
}

/**
 * The services of the fixture, where a call to fixture.hold with a marker tells that it holds: `holding(marker)`
 * resolves then.
 */
function markedFixture() {
  const marks = new Map<string, { readonly promise: Promise<void>; readonly resolve: () => void }>();
  const markOf = (marker: string) => {
    let mark = marks.get(marker);
    if (mark === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => (resolve = done));
      mark = { promise, resolve };
      marks.set(marker, mark);
    }
    return mark;
  };
  const layer = Layer.merge(Layer.effect(Switch, SubscriptionRef.make(true)), holdsLayer((marker) => Effect.sync(() => markOf(marker).resolve())));
  return { layer, holding: (marker: string) => markOf(marker).promise };
}

const rejection = (promise: Promise<unknown>) => promise.then(() => assert.fail("the call must reject"), (error: unknown) => error);

test("handles give results, and reject call failures with their kind", async () => {
  const { layer, holding } = markedFixture();
  const session = await Handles.open(fixture, layer, { target: "app" });
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
    const held = rejection(handle("fixture.hold").execute({ key: "cancelled", marker: "cancelled" }, { signal: controller.signal }));
    await holding("cancelled");
    controller.abort();
    const cancelled = (await held) as CallFailureError;
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.name, "AbortError");
    assert.deepEqual(await handle("fixture.held").execute({}), { ok: true, value: { keys: [] } });
  } finally {
    await session.dispose();
  }
});

test("availability is an observable, and closing the session cancels the calls in progress", async () => {
  const { layer, holding } = markedFixture();
  const session = await Handles.open(fixture, layer, { target: "app" });
  const toggle = session.handles.get("fixture.toggle")!;
  const seen: boolean[] = [];
  toggle.availability.subscribe((value) => seen.push(value.available));
  assert.equal(toggle.availability.getSnapshot().available, true);

  await session.handles.get("fixture.switch.set")!.execute({ on: false });
  await until(toggle.availability, (availability) => !availability.available);
  assert.equal(((await rejection(toggle.execute({}))) as CallFailureError).kind, "unavailable");
  await session.handles.get("fixture.switch.set")!.execute({ on: true });
  await until(toggle.availability, (availability) => availability.available);
  assert.deepEqual(seen, [false, true]);

  const held = rejection(session.handles.get("fixture.hold")!.execute({ key: "closing", marker: "closing" }));
  await holding("closing");
  await session.dispose();
  assert.equal(((await held) as CallFailureError).kind, "cancelled");
  assert.ok(session.signal.aborted);
});

test("a handle gives the state as copies, and each change", async () => {
  const session = await Handles.open(aircon, unitLayer, { target: "app" });
  try {
    const snapshot = session.handles.get("aircon.status.get")!.snapshot!;
    const first = snapshot.getSnapshot() as { power: boolean };
    assert.equal(first.power, false);
    first.power = true;
    assert.equal((snapshot.getSnapshot() as { power: boolean }).power, false);

    const seen: unknown[] = [];
    snapshot.subscribe((value) => seen.push(value));
    await session.handles.get("aircon.power.set")!.execute({ on: true });
    await until(snapshot, (value) => (value as { power: boolean }).power);
    assert.equal((seen.at(-1) as { power: boolean }).power, true);
    assert.equal(session.handles.get("aircon.power.set")!.snapshot, undefined);
  } finally {
    await session.dispose();
  }
});
