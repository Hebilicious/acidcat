import assert from "node:assert/strict";
import { test } from "node:test";

import { CallFailureError } from "@acid-cat/spec-ts";
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect";

import { Group } from "../src/index.ts";

/** An owner that code without Effect reads: a count, and listeners that hear each change at once. */
function owner() {
  let count = 0;
  const listeners = new Set<(value: number) => void>();
  return {
    increment() {
      count += 1;
      listeners.forEach((listener) => listener(count));
    },
    snapshot: {
      getSnapshot: () => count,
      subscribe(listener: (value: number) => void) {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    },
  };
}

class Owner extends Context.Service<Owner, ReturnType<typeof owner>>()("test/Owner") {}

/** A group of the owner, in its own scope. `gate`, if given, holds the start until it opens. */
function group(gate?: Deferred.Deferred<void>) {
  const scope = Effect.runSync(Scope.make());
  const started = { count: 0 };
  const layer = Layer.effect(
    Owner,
    Effect.gen(function* () {
      started.count++;
      if (gate !== undefined) yield* Deferred.await(gate);
      return owner();
    }),
  );
  const made = Effect.runSync(Group.make(layer).pipe(Scope.provide(scope)));
  return { group: made, scope, started, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

test("observe gives the dormant value, then the value of the services once they run, then the closed value, at once", async () => {
  const { group: counting, close } = group();
  const count = counting.observe((services) => Context.get(services, Owner).snapshot, { dormant: -1, closed: -2 });
  const heard: number[] = [];
  count.subscribe((value) => heard.push(value));
  assert.equal(count.getSnapshot(), -1);

  await counting.startPromise();
  assert.deepEqual(heard, [0]);
  counting.peek((services) => Context.get(services, Owner))!.increment();
  assert.deepEqual(heard, [0, 1]);
  assert.equal(count.getSnapshot(), 1);

  await close();
  assert.deepEqual(heard, [0, 1, -2]);
  assert.equal(count.getSnapshot(), -2);
});

test("with no dormant value, reading before the services run is an error", async () => {
  const { group: counting, close } = group();
  const count = counting.observe((services) => Context.get(services, Owner).snapshot);
  assert.throws(() => count.getSnapshot(), /has not started/);
  await counting.startPromise();
  assert.equal(count.getSnapshot(), 0);
  await close();
});

test("peek reads the services only when they run, and never starts them", async () => {
  const { group: counting, started, close } = group();
  assert.equal(counting.peek((services) => Context.get(services, Owner).snapshot.getSnapshot()), undefined);
  assert.equal(started.count, 0);
  assert.equal(Effect.runSync(counting.phase.get), "dormant");
  await counting.startPromise();
  assert.equal(counting.peek((services) => Context.get(services, Owner).snapshot.getSnapshot()), 0);
  await close();
});

test("startPromise stops the start when its signal aborts, and rejects a closed group as cancelled", async () => {
  const gate = Effect.runSync(Deferred.make<void>());
  const { group: counting, close } = group(gate);
  const controller = new AbortController();
  const reason = new Error("The page went away.");
  const starting = counting.startPromise({ signal: controller.signal });
  assert.equal(Effect.runSync(counting.phase.get), "starting");
  controller.abort(reason);
  await assert.rejects(starting, (error) => error === reason);
  assert.equal(Effect.runSync(counting.phase.get), "dormant");

  await close();
  const closed = await counting.startPromise().then(() => assert.fail("a closed group must not start"), (error: unknown) => error);
  assert.ok(closed instanceof CallFailureError);
  assert.equal(closed.kind, "cancelled");
});
