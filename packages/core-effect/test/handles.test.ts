import assert from "node:assert/strict";
import { test } from "node:test";

import { CallFailureError } from "@acid-cat/spec";

import { Handles } from "../src/index.ts";
import { aircon, unitLayer } from "../examples/aircon.ts";
import { fixture, switchLayer } from "./fixture.ts";

/** Wait until `condition` is true. */
async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; !condition(); attempt++) {
    if (attempt > 100) throw new Error("the condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const rejection = (promise: Promise<unknown>) => promise.then(() => assert.fail("the call must reject"), (error: unknown) => error);

test("handles give results, and reject call failures with their kind", async () => {
  const session = await Handles.open(fixture, switchLayer, { target: "app" });
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
    const slow = rejection(handle("fixture.slow").execute({ milliseconds: 60_000 }, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const cancelled = (await slow) as CallFailureError;
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.name, "AbortError");
  } finally {
    await session.dispose();
  }
});

test("availability is an observable, and closing the session cancels the calls in progress", async () => {
  const session = await Handles.open(fixture, switchLayer, { target: "app" });
  const toggle = session.handles.get("fixture.toggle")!;
  const seen: boolean[] = [];
  toggle.availability.subscribe((value) => seen.push(value.available));
  assert.equal(toggle.availability.getSnapshot().available, true);

  await session.handles.get("fixture.switch.set")!.execute({ on: false });
  await eventually(() => !toggle.availability.getSnapshot().available);
  assert.equal(((await rejection(toggle.execute({}))) as CallFailureError).kind, "unavailable");
  await session.handles.get("fixture.switch.set")!.execute({ on: true });
  await eventually(() => toggle.availability.getSnapshot().available);
  assert.deepEqual(seen, [false, true]);

  const slow = rejection(session.handles.get("fixture.slow")!.execute({ milliseconds: 60_000 }));
  await session.dispose();
  assert.equal(((await slow) as CallFailureError).kind, "cancelled");
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
    await eventually(() => seen.length > 0);
    assert.equal((seen.at(-1) as { power: boolean }).power, true);
    assert.equal(session.handles.get("aircon.power.set")!.snapshot, undefined);
  } finally {
    await session.dispose();
  }
});
