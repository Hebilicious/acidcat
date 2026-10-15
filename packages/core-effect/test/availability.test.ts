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
  // Following a `Current` needs its `changes`: count each time that the session or a handle reads them.
  const reads = { changes: 0 };
  const many = App.make({
    targets: { app: { bindings: ["typescript"] } },
    capabilities: gates.map((each, index) => {
      const current = Capability.fromObservable(each.source);
      return Capability.make({
        id: `probe.gate${index}.pass`,
        description: `Pass gate ${index}.`,
        audience: ["app"],
        availability: Effect.succeed({
          get: current.get,
          get changes() {
            reads.changes++;
            return current.changes;
          },
        }),
        run: () => Effect.succeed(null),
      });
    }),
  });
  const following = () => gates.reduce((sum, each) => sum + each.counts.following, 0);
  const session = await Handles.open(many, Layer.empty, { target: "app" });
  try {
    assert.equal(reads.changes, 0);
    gates[3]!.owner.set(unavailable("Closed."));
    const refused = await session.handles.get("probe.gate3.pass")!.execute({}).catch((error: unknown) => error);
    assert.equal((refused as CallFailureError).kind, "unavailable");
    assert.equal(reads.changes, 0);

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

/** An application with one capability whose availability is a `Current`. */
const single = (current: Capability.Current<Availability>) =>
  App.make({
    targets: { app: { bindings: ["typescript"] } },
    capabilities: [Capability.make({ id: "probe.gate.pass", description: "Pass the gate.", audience: ["app"], availability: Effect.succeed(current), run: () => Effect.succeed(null) })],
  });

test("a handle gives the availability of a Current whose read waits", async () => {
  const session = await Handles.open(
    single({ get: Effect.sleep(1).pipe(Effect.as(unavailable("Not yet."))), changes: Stream.make(unavailable("Not yet.")) }),
    Layer.empty,
    { target: "app" },
  );
  try {
    assert.deepEqual(session.handles.get("probe.gate.pass")!.availability.getSnapshot(), unavailable("Not yet."));
  } finally {
    await session.dispose();
  }
});

/** Each value that a listener hears, and a promise for the next one. */
function hearing() {
  const heard: Availability[] = [];
  let next = () => undefined as void;
  return {
    heard,
    listener: (value: Availability) => {
      heard.push(value);
      next();
    },
    nextValue: () => new Promise<void>((resolve) => (next = resolve)),
  };
}

test("a listener that throws does not stop the others, or later changes", async () => {
  const owner = gate();
  const session = await Handles.open(single(Capability.fromObservable(owner)), Layer.empty, { target: "app" });
  try {
    const availability = session.handles.get("probe.gate.pass")!.availability;
    availability.subscribe(() => {
      throw new Error("The listener is broken.");
    });
    const other = hearing();
    availability.subscribe(other.listener);
    let next = other.nextValue();
    owner.set(unavailable("First."));
    await next;
    next = other.nextValue();
    owner.set(AVAILABLE);
    await next;
    assert.deepEqual(other.heard, [unavailable("First."), AVAILABLE]);
  } finally {
    await session.dispose();
  }
});

test("a listener that comes back in the same turn hears each change one time", async () => {
  const owner = gate();
  const session = await Handles.open(single(Capability.fromObservable(owner)), Layer.empty, { target: "app" });
  try {
    const availability = session.handles.get("probe.gate.pass")!.availability;
    const first = hearing();
    const firstSubscription = availability.subscribe(first.listener);
    let next = first.nextValue();
    owner.set(unavailable("One."));
    await next;

    firstSubscription.unsubscribe();
    const second = hearing();
    availability.subscribe(second.listener);
    next = second.nextValue();
    owner.set(unavailable("Two."));
    await next;
    next = second.nextValue();
    owner.set(AVAILABLE);
    await next;
    assert.deepEqual(second.heard, [unavailable("Two."), AVAILABLE]);
  } finally {
    await session.dispose();
  }
});

test("reads that wait start one read in the background, and a newer value replaces a read that never ends", async () => {
  const owner = gate();
  // Each read of `get` waits until the test answers it, and records if it was interrupted.
  const reads: { readonly resolve: (value: Availability) => void; interrupted: boolean }[] = [];
  let started = () => undefined as void;
  const nextRead = () => new Promise<void>((resolve) => (started = resolve));
  const current = Capability.fromObservable(owner);
  const first = nextRead();
  const opening = Handles.open(
    single({
      get: Effect.promise(
        (signal) =>
          new Promise<Availability>((resolve) => {
            const read = { resolve, interrupted: false };
            signal.addEventListener("abort", () => (read.interrupted = true));
            reads.push(read);
            started();
          }),
      ),
      changes: current.changes,
    }),
    Layer.empty,
    { target: "app" },
  );
  await first;
  reads[0]!.resolve(AVAILABLE);
  const session = await opening;
  try {
    const availability = session.handles.get("probe.gate.pass")!.availability;
    // The first read waits, and goes on in the background; the nine after it start no read.
    for (let read = 0; read < 10; read++) assert.deepEqual(availability.getSnapshot(), AVAILABLE);
    assert.equal(reads.length, 2);

    // A newer value comes through a listener: the read in the background cannot win any more, and is replaced.
    const heard = hearing();
    availability.subscribe(heard.listener);
    const next = heard.nextValue();
    owner.set(unavailable("Newer."));
    await next;
    assert.deepEqual(availability.getSnapshot(), unavailable("Newer."));
    assert.equal(reads[1]!.interrupted, true);
    assert.equal(reads.length, 3);
  } finally {
    reads.forEach((read) => read.resolve(AVAILABLE));
    await session.dispose();
  }
});

test("a handle reads the availability of a Current with no Effect, followed or not", async () => {
  const owner = gate();
  const counted = { effectReads: 0 };
  const current = Capability.fromObservable(owner);
  const session = await Handles.open(
    single({
      ...current,
      get: Effect.sync(() => {
        counted.effectReads++;
        return owner.getSnapshot();
      }),
    }),
    Layer.empty,
    { target: "app" },
  );
  try {
    const availability = session.handles.get("probe.gate.pass")!.availability;
    const atOpen = counted.effectReads;
    for (let read = 0; read < 100; read++) availability.getSnapshot();
    owner.set(unavailable("Closed."));
    assert.deepEqual(availability.getSnapshot(), unavailable("Closed."));
    const heard = hearing();
    availability.subscribe(heard.listener);
    for (let read = 0; read < 100; read++) availability.getSnapshot();
    assert.equal(counted.effectReads, atOpen);
  } finally {
    await session.dispose();
  }
});
