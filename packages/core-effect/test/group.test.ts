import assert from "node:assert/strict";
import { test } from "node:test";

import { AVAILABLE, CallFailureError, unavailable } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema, Scope, SubscriptionRef } from "effect";

import { App, Capability, Group, Handles, Session } from "../src/index.ts";

/** The runtime of a domain: a counter, and the availability of its writes. */
class Domain extends Context.Service<
  Domain,
  { readonly count: SubscriptionRef.SubscriptionRef<number>; readonly writes: SubscriptionRef.SubscriptionRef<Availability> }
>()("test/Domain") {}

/** The group of the domain's capabilities, as a service of the application. */
class Domains extends Context.Service<Domains, Group.Group<Domain>>()("test/Domains") {}

/**
 * A domain whose build the test controls: each build records that it started, and waits for `open`, if the test gives
 * one. A build that `fail` names fails. The counts tell how many builds started, succeeded and were released.
 */
function domain() {
  const counts = { started: 0, built: 0, released: 0, interrupted: 0 };
  const controls: { open?: Deferred.Deferred<void>; fail?: boolean; started?: Deferred.Deferred<void> } = {};
  const layer = Layer.effect(
    Domain,
    Effect.gen(function* () {
      counts.started++;
      if (controls.started !== undefined) yield* Deferred.succeed(controls.started, undefined);
      if (controls.open !== undefined) yield* Deferred.await(controls.open).pipe(Effect.onInterrupt(() => Effect.sync(() => counts.interrupted++)));
      if (controls.fail === true) return yield* Effect.fail("The domain is broken.");
      return yield* Effect.acquireRelease(
        Effect.gen(function* () {
          counts.built++;
          return { count: yield* SubscriptionRef.make(0), writes: yield* SubscriptionRef.make<Availability>(AVAILABLE) };
        }),
        () => Effect.sync(() => counts.released++),
      );
    }),
  );
  return { counts, controls, layer: Layer.effect(Domains, Group.make(Effect.succeed(layer))) };
}

const app = App.make({
  targets: { app: { bindings: ["typescript"] } },
  capabilities: [
    Capability.make({
      id: "domain.count.increment",
      description: "Add one to the count.",
      audience: ["app"],
      output: Schema.Int,
      availability: Domains.useSync((group) =>
        group.current((services) => Capability.fromSubscriptionRef(Context.get(services, Domain).writes), {
          dormant: AVAILABLE,
          closed: unavailable("The domain is closed."),
        }),
      ),
      run: () => Domains.use((group) => group.provide(Domain.use(({ count }) => SubscriptionRef.updateAndGet(count, (value) => value + 1)))),
    }),
  ],
});

const increment = (session: Session.Session) => session.invoke("domain.count.increment", {});

test("the services start on the first call, and all calls share them", async () => {
  const { counts, layer } = domain();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        const group = yield* Domains;
        assert.equal(yield* group.phase.get, "dormant");
        assert.deepEqual(yield* session.availability("domain.count.increment"), AVAILABLE);
        assert.equal(counts.started, 0);

        const outcomes = yield* Effect.all([increment(session), increment(session), increment(session)], { concurrency: "unbounded" });
        assert.deepEqual(outcomes.map((outcome) => ("ok" in outcome && outcome.ok ? outcome.value : outcome)).sort(), [1, 2, 3]);
        assert.equal(counts.started, 1);
        assert.equal(yield* group.phase.get, "started");
      }),
    ).pipe(Effect.provide(layer)),
  );
  assert.deepEqual(counts, { started: 1, built: 1, released: 1, interrupted: 0 });
});

test("availability follows the services once they run, and a call is decided on it", () => {
  const { layer } = domain();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        const group = yield* Domains;
        yield* group.start;
        const writes = Context.get(yield* group.provide(Effect.context<Domain>()), Domain).writes;
        yield* SubscriptionRef.set(writes, unavailable("Read only."));
        assert.deepEqual(yield* increment(session), { kind: "unavailable", message: "Read only." });
      }),
    ).pipe(Effect.provide(layer)),
  );
});

test("when the last call that waits is cancelled, the build is interrupted, and the next call starts it again", async () => {
  const { counts, controls, layer } = domain();
  const scope = Effect.runSync(Scope.make());
  try {
    const handles = await Effect.runPromise(
      Effect.gen(function* () {
        const services = yield* Layer.buildWithScope(layer, scope);
        const session = yield* Session.make(app, { target: "app" }).pipe(Effect.provideContext(services));
        return yield* Handles.make(app, session);
      }).pipe(Scope.provide(scope)),
    );
    const handle = handles.get("domain.count.increment")!;
    controls.open = Effect.runSync(Deferred.make<void>());
    controls.started = Effect.runSync(Deferred.make<void>());
    const controller = new AbortController();
    const cancelled = handle.execute({}, { signal: controller.signal }).then(
      () => assert.fail("the call must be cancelled"),
      (error: unknown) => error,
    );
    await Effect.runPromise(Deferred.await(controls.started));
    controller.abort();
    const error = await cancelled;
    assert.ok(error instanceof CallFailureError);
    assert.equal(error.kind, "cancelled");
    assert.equal(counts.interrupted, 1);
    assert.equal(counts.built, 0);

    delete controls.open;
    assert.deepEqual(await handle.execute({}), { ok: true, value: 1 });
    assert.equal(counts.started, 2);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

test("a cancelled call does not stop the build that another call waits for", () => {
  const { counts, controls, layer } = domain();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        controls.open = yield* Deferred.make<void>();
        controls.started = yield* Deferred.make<void>();
        const first = yield* Effect.forkScoped(increment(session), { startImmediately: true });
        const second = yield* Effect.forkScoped(increment(session), { startImmediately: true });
        yield* Deferred.await(controls.started);
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(controls.open, undefined);
        assert.deepEqual(yield* Fiber.join(second), { ok: true, value: 1 });
        assert.equal(counts.interrupted, 0);
        assert.equal(counts.started, 1);
      }),
    ).pipe(Effect.provide(layer)),
  );
});

test("a build that fails is an internal call failure, and the next call tries again", () => {
  const { counts, controls, layer } = domain();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        const group = yield* Domains;
        controls.fail = true;
        assert.deepEqual(yield* increment(session), { kind: "internal", message: "The capability failed." });
        assert.equal(yield* group.phase.get, "dormant");
        controls.fail = false;
        assert.deepEqual(yield* increment(session), { ok: true, value: 1 });
        assert.equal(counts.started, 2);
      }),
    ).pipe(Effect.provide(layer)),
  );
});

test("closing the group releases the services, cancels the calls that wait, and makes it unavailable", async () => {
  const { counts, controls, layer } = domain();
  const groupScope = Effect.runSync(Scope.make());
  const services = await Effect.runPromise(Layer.buildWithScope(layer, groupScope));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        controls.open = yield* Deferred.make<void>();
        controls.started = yield* Deferred.make<void>();
        const waiting = yield* Effect.forkScoped(increment(session), { startImmediately: true });
        yield* Deferred.await(controls.started);
        yield* Scope.close(groupScope, Exit.void);
        assert.deepEqual(yield* Fiber.join(waiting), { kind: "cancelled", message: "The call was cancelled." });
        assert.deepEqual(yield* session.availability("domain.count.increment"), unavailable("The domain is closed."));
        assert.equal(yield* (yield* Domains).phase.get, "closed");
      }),
    ).pipe(Effect.provideContext(services)),
  );
  assert.equal(counts.built, 0);
  assert.equal(counts.interrupted, 1);
});

test("services that ran are released when the group closes", async () => {
  const { counts, layer } = domain();
  const groupScope = Effect.runSync(Scope.make());
  const services = await Effect.runPromise(Layer.buildWithScope(layer, groupScope));
  await Effect.runPromise(Effect.scoped(Effect.flatMap(Session.make(app, { target: "app" }), increment)).pipe(Effect.provideContext(services)));
  assert.equal(counts.released, 0);
  await Effect.runPromise(Scope.close(groupScope, Exit.void));
  assert.equal(counts.released, 1);
});

test("a new build waits until the build that the last cancelled call stopped has released its services", async () => {
  const active = { now: 0, most: 0 };
  const acquired = Effect.runSync(Deferred.make<void>());
  const releasing = Effect.runSync(Deferred.make<void>());
  const releaseGate = Effect.runSync(Deferred.make<void>());
  let first = true;
  const exclusive = Layer.effect(
    Domain,
    Effect.gen(function* () {
      const services = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          active.now++;
          active.most = Math.max(active.most, active.now);
          return { count: yield* SubscriptionRef.make(0), writes: yield* SubscriptionRef.make<Availability>(AVAILABLE) };
        }),
        () => Deferred.succeed(releasing, undefined).pipe(Effect.andThen(Deferred.await(releaseGate)), Effect.andThen(Effect.sync(() => active.now--))),
      );
      if (first) {
        first = false;
        yield* Deferred.succeed(acquired, undefined);
        yield* Effect.never;
      }
      return services;
    }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        const group = yield* Domains;
        const cancelled = yield* Effect.forkScoped(increment(session), { startImmediately: true });
        yield* Deferred.await(acquired);
        yield* Effect.forkScoped(Fiber.interrupt(cancelled), { startImmediately: true });
        yield* Deferred.await(releasing);
        const next = yield* Effect.forkScoped(increment(session), { startImmediately: true });
        assert.equal(yield* group.phase.get, "stopping");
        assert.equal(active.now, 1);
        yield* Deferred.succeed(releaseGate, undefined);
        assert.deepEqual(yield* Fiber.join(next), { ok: true, value: 1 });
        assert.equal(active.most, 1);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseGate, undefined))),
    ).pipe(Effect.provide(Layer.effect(Domains, Group.make(Effect.succeed(exclusive))))),
  );
});

test("closing the group cancels the calls that use its services, before it releases them", async () => {
  const order: string[] = [];
  const running = Effect.runSync(Deferred.make<void>());
  const groupScope = Effect.runSync(Scope.make());
  const layer = Layer.effect(
    Domain,
    Effect.acquireRelease(
      Effect.gen(function* () {
        return { count: yield* SubscriptionRef.make(0), writes: yield* SubscriptionRef.make<Availability>(AVAILABLE) };
      }),
      () => Effect.sync(() => order.push("released")),
    ),
  );
  const domains = await Effect.runPromise(Layer.buildWithScope(Layer.effect(Domains, Group.make(layer)), groupScope));
  const group = Context.get(domains, Domains);
  const call = Effect.runFork(
    group.provide(
      Deferred.succeed(running, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => order.push("call cancelled"))),
      ),
    ),
  );
  await Effect.runPromise(Deferred.await(running));
  await Effect.runPromise(Scope.close(groupScope, Exit.void));
  const exit = await Effect.runPromise(Fiber.await(call));
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
  assert.deepEqual(order, ["call cancelled", "released"]);
});

test("a call that gets the services as the group closes is cancelled, and never runs on released services", async () => {
  const order: string[] = [];
  const open = Effect.runSync(Deferred.make<void>());
  const groupScope = Effect.runSync(Scope.make());
  const layer = Layer.effect(
    Domain,
    Effect.gen(function* () {
      yield* Deferred.await(open);
      return yield* Effect.acquireRelease(
        Effect.gen(function* () {
          return { count: yield* SubscriptionRef.make(0), writes: yield* SubscriptionRef.make<Availability>(AVAILABLE) };
        }),
        () => Effect.sync(() => order.push("released")),
      );
    }),
  );
  const domains = await Effect.runPromise(Layer.buildWithScope(Layer.effect(Domains, Group.make(layer)), groupScope));
  const group = Context.get(domains, Domains);
  // When the services start, close the group at once: the close comes before the call that waits gets the services.
  let closing: Promise<void> | undefined;
  group.observe(() => ({ getSnapshot: () => 0, subscribe: () => ({ unsubscribe() {} }) }), { dormant: 0 }).subscribe(() => {
    closing ??= Effect.runPromise(Scope.close(groupScope, Exit.void));
  });
  const call = Effect.runFork(group.provide(Effect.sync(() => order.push("call ran"))));
  await Effect.runPromise(Deferred.succeed(open, undefined));
  const exit = await Effect.runPromise(Fiber.await(call));
  await closing;
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), JSON.stringify(order));
  assert.deepEqual(order, ["released"]);
});

test("closing a group cancels its calls before it releases its services, also when a listener throws", async () => {
  const order: string[] = [];
  const running = Effect.runSync(Deferred.make<void>());
  const groupScope = Effect.runSync(Scope.make());
  const layer = Layer.effect(
    Domain,
    Effect.acquireRelease(
      Effect.gen(function* () {
        return { count: yield* SubscriptionRef.make(0), writes: yield* SubscriptionRef.make<Availability>(AVAILABLE) };
      }),
      () => Effect.sync(() => order.push("released")),
    ),
  );
  const domains = await Effect.runPromise(Layer.buildWithScope(Layer.effect(Domains, Group.make(layer)), groupScope));
  const group = Context.get(domains, Domains);
  group.observe(() => ({ getSnapshot: () => 0, subscribe: () => ({ unsubscribe() {} }) }), { dormant: 0, closed: -1 }).subscribe(() => {
    throw new Error("The listener is broken.");
  });
  const call = Effect.runFork(
    group.provide(Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Effect.sync(() => order.push("call cancelled"))))),
  );
  await Effect.runPromise(Deferred.await(running));
  const closed = await Effect.runPromiseExit(Scope.close(groupScope, Exit.void).pipe(Effect.provide(Logger.layer([]))));
  assert.ok(Exit.isSuccess(closed));
  await Effect.runPromise(Fiber.await(call));
  assert.deepEqual(order, ["call cancelled", "released"]);
});
