import assert from "node:assert/strict";
import { test } from "node:test";

import { AVAILABLE, CallFailureError, unavailable } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, SubscriptionRef } from "effect";

import { App, Capability, Handles, Session } from "../src/index.ts";

/** A gate that code without Effect opens and closes, as the owner of a user interface does. */
function gate() {
  let current: Availability = AVAILABLE;
  const listeners = new Set<(value: Availability) => void>();
  return {
    set(next: Availability) {
      current = next;
      listeners.forEach((listener) => listener(next));
    },
    getSnapshot: () => current,
    subscribe(listener: (value: Availability) => void) {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
  };
}

class Gate extends Context.Service<Gate, ReturnType<typeof gate>>()("test/Gate") {}
class Door extends Context.Service<Door, SubscriptionRef.SubscriptionRef<Availability>>()("test/Door") {}

const app = App.make({
  targets: { app: { bindings: ["typescript"] } },
  capabilities: [
    Capability.make({
      id: "probe.gate.pass",
      description: "Pass the gate.",
      audience: ["app"],
      availability: Gate.useSync((owner) => Capability.fromObservable(owner)),
      run: () => Effect.succeed(null),
    }),
    Capability.make({
      id: "probe.door.pass",
      description: "Pass the door.",
      audience: ["app"],
      availability: Door.useSync((ref) => Capability.fromSubscriptionRef(ref)),
      run: () => Effect.succeed(null),
    }),
  ],
});

test("a session decides a call on the availability at the time of the call", () => {
  const owner = gate();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        const door = yield* Door;

        owner.set(unavailable("The gate is closed."));
        assert.deepEqual(yield* session.invoke("probe.gate.pass", {}), { kind: "unavailable", message: "The gate is closed." });
        owner.set(AVAILABLE);
        assert.deepEqual(yield* session.invoke("probe.gate.pass", {}), { ok: true, value: null });

        yield* SubscriptionRef.set(door, unavailable("The door is closed."));
        assert.deepEqual(yield* session.invoke("probe.door.pass", {}), { kind: "unavailable", message: "The door is closed." });
        yield* SubscriptionRef.set(door, AVAILABLE);
        assert.deepEqual(yield* session.invoke("probe.door.pass", {}), { ok: true, value: null });
      }),
    ).pipe(Effect.provide(Layer.mergeAll(Layer.succeed(Gate, owner), Layer.effect(Door, SubscriptionRef.make<Availability>(AVAILABLE))))),
  );
});

test("a handle reads and admits on the availability at the time of the call, and its listeners hear the change", async () => {
  const owner = gate();
  const session = await Handles.open(
    app,
    Layer.mergeAll(Layer.succeed(Gate, owner), Layer.effect(Door, SubscriptionRef.make<Availability>(AVAILABLE))),
    { target: "app" },
  );
  try {
    const handle = session.handles.get("probe.gate.pass")!;
    const heard = new Promise<Availability>((resolve) => handle.availability.subscribe(resolve));

    owner.set(unavailable("The gate is closed."));
    assert.deepEqual(handle.availability.getSnapshot(), unavailable("The gate is closed."));
    const refused = await handle.execute({}).then(
      () => assert.fail("the call must be refused"),
      (error: unknown) => error,
    );
    assert.ok(refused instanceof CallFailureError);
    assert.equal(refused.kind, "unavailable");
    assert.deepEqual(await heard, unavailable("The gate is closed."));

    owner.set(AVAILABLE);
    assert.equal(handle.availability.getSnapshot().available, true);
    assert.deepEqual(await handle.execute({}), { ok: true, value: null });
  } finally {
    await session.dispose();
  }
});

test("a handle gives the same availability object while the value stays the same", async () => {
  const owner = gate();
  const session = await Handles.open(
    app,
    Layer.mergeAll(Layer.succeed(Gate, owner), Layer.effect(Door, SubscriptionRef.make<Availability>(AVAILABLE))),
    { target: "app" },
  );
  try {
    const availability = session.handles.get("probe.gate.pass")!.availability;
    const first = availability.getSnapshot();
    owner.set({ available: true });
    assert.equal(availability.getSnapshot(), first);
  } finally {
    await session.dispose();
  }
});

test("listeners hear each change in order, also when changes come faster than they are delivered", async () => {
  const owner = gate();
  const session = await Handles.open(
    app,
    Layer.mergeAll(Layer.succeed(Gate, owner), Layer.effect(Door, SubscriptionRef.make<Availability>(AVAILABLE))),
    { target: "app" },
  );
  try {
    const heard: Availability[] = [];
    const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
    session.handles.get("probe.gate.pass")!.availability.subscribe((value) => {
      heard.push(value);
      for (const waiter of waiters) if (heard.length === waiter.count) waiter.resolve();
    });
    const heardCount = (count: number) => new Promise<void>((resolve) => waiters.push({ count, resolve }));

    // The first change reaches the listener, so the session and the handle both follow the gate.
    owner.set(unavailable("Closed for the night."));
    await heardCount(1);
    owner.set(AVAILABLE);
    owner.set(unavailable("Closed for repairs."));
    owner.set(AVAILABLE);
    await heardCount(4);
    assert.deepEqual(heard, [unavailable("Closed for the night."), AVAILABLE, unavailable("Closed for repairs."), AVAILABLE]);
  } finally {
    await session.dispose();
  }
});
