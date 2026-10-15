import assert from "node:assert/strict";
import { test } from "node:test";

import { AVAILABLE, CallFailureError, unavailable } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

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

test("a listener hears the value that is current when it is told, and may skip the values in between", async () => {
  const owner = gate();
  const session = await Handles.open(
    app,
    Layer.mergeAll(Layer.succeed(Gate, owner), Layer.effect(Door, SubscriptionRef.make<Availability>(AVAILABLE))),
    { target: "app" },
  );
  try {
    const availability = session.handles.get("probe.gate.pass")!.availability;
    const heard: { readonly value: Availability; readonly owner: Availability; readonly snapshot: Availability }[] = [];
    const waiters: { readonly value: Availability; readonly resolve: () => void }[] = [];
    availability.subscribe((value) => {
      heard.push({ value, owner: owner.getSnapshot(), snapshot: availability.getSnapshot() });
      for (const waiter of waiters) if (JSON.stringify(waiter.value) === JSON.stringify(value)) waiter.resolve();
    });
    const heardValue = (value: Availability) => new Promise<void>((resolve) => waiters.push({ value, resolve }));

    // The first change reaches the listener, so the session and the handle both follow the gate.
    const night = unavailable("Closed for the night.");
    owner.set(night);
    await heardValue(night);
    // The owner changes A, B, A, C in one turn, while the fiber that tells the listeners cannot run.
    const repairs = unavailable("Closed for repairs.");
    const good = unavailable("Closed for good.");
    owner.set(AVAILABLE);
    owner.set(repairs);
    owner.set(AVAILABLE);
    owner.set(good);
    await heardValue(good);
    for (const each of heard) {
      assert.deepEqual(each.value, each.owner);
      assert.deepEqual(each.value, each.snapshot);
    }
    assert.deepEqual(
      heard.map((each) => each.value),
      [night, good],
    );
  } finally {
    await session.dispose();
  }
});

test("allAvailable is available when each source is, and gives the reason of the first one that is not", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const admission = yield* SubscriptionRef.make<Availability>(AVAILABLE);
      const guard = yield* SubscriptionRef.make<Availability>(AVAILABLE);
      const both = Capability.allAvailable(Capability.fromSubscriptionRef(admission), Capability.fromSubscriptionRef(guard));
      assert.deepEqual(yield* both.get, AVAILABLE);
      yield* SubscriptionRef.set(guard, unavailable("The owner is busy."));
      assert.deepEqual(yield* both.get, unavailable("The owner is busy."));
      yield* SubscriptionRef.set(admission, unavailable("Signed out."));
      assert.deepEqual(yield* both.get, unavailable("Signed out."));
      const [first] = yield* both.changes.pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(first, unavailable("Signed out."));
    }),
  ));

/** An owner that counts the listeners that follow it. */
function countedGate() {
  const owner = gate();
  const counts = { following: 0 };
  let changed = () => undefined as void;
  return {
    owner,
    counts,
    nextChange: () => new Promise<void>((resolve) => (changed = resolve)),
    source: {
      getSnapshot: owner.getSnapshot,
      subscribe(listener: (value: Availability) => void) {
        counts.following++;
        changed();
        const subscription = owner.subscribe(listener);
        return {
          unsubscribe() {
            counts.following--;
            changed();
            subscription.unsubscribe();
          },
        };
      },
    },
  };
}

test("a session and its handles follow no availability until something listens, and decide calls on it all the same", async () => {
  const gates = Array.from({ length: 99 }, () => countedGate());
  const many = App.make({
    targets: { app: { bindings: ["typescript"] } },
    capabilities: gates.map((each, index) =>
      Capability.make({
        id: `probe.gate${index}.pass`,
        description: `Pass gate ${index}.`,
        audience: ["app"],
        availability: Effect.succeed(Capability.fromObservable(each.source)),
        run: () => Effect.succeed(null),
      }),
    ),
  });
  const following = () => gates.reduce((sum, each) => sum + each.counts.following, 0);
  const session = await Handles.open(many, Layer.empty, { target: "app" });
  // A stream subscribes in its own fiber, so let each fiber that open started run before counting.
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await settled();
    await settled();
    assert.equal(following(), 0);
    gates[3]!.owner.set(unavailable("Closed."));
    const refused = await session.handles.get("probe.gate3.pass")!.execute({}).catch((error: unknown) => error);
    assert.equal((refused as CallFailureError).kind, "unavailable");
    assert.equal(following(), 0);

    const followed = gates[3]!.nextChange();
    const subscription = session.handles.get("probe.gate3.pass")!.availability.subscribe(() => undefined);
    await followed;
    assert.equal(following(), 1);
    const left = gates[3]!.nextChange();
    subscription.unsubscribe();
    await left;
    assert.equal(following(), 0);
  } finally {
    await session.dispose();
  }
});
