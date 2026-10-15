import assert from "node:assert/strict";
import { test } from "node:test";

import { AVAILABLE, unavailable } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Effect, Exit, Layer, Logger, Option, Scope, Stream, SubscriptionRef } from "effect";

import { App, Capability, Session, WebMcp } from "../src/index.ts";
import { fixture, Switch, fixtureLayer } from "./fixture.ts";

/** A WebMCP host in memory. It can refuse a tool, to test a failed update, and waits until its tools agree with a condition. */
function fakeHost() {
  const tools = new Map<string, WebMcp.ModelContextTool>();
  const waiters = new Set<() => void>();
  const changed = () => waiters.forEach((waiter) => waiter());
  const host = {
    tools,
    refuse: new Set<string>(),
    registerTool(tool: WebMcp.ModelContextTool, options: { signal: AbortSignal }) {
      if (host.refuse.has(tool.name)) return Promise.reject(new Error(`refused ${tool.name}`));
      tools.set(tool.name, tool);
      changed();
      options.signal.addEventListener("abort", () => {
        tools.delete(tool.name);
        changed();
      });
      return { unregister() {} };
    },
    /** Wait until the tools agree with `condition`. */
    until: (condition: (tools: ReadonlyMap<string, WebMcp.ModelContextTool>) => boolean) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const check = () => {
              if (!condition(tools)) return;
              waiters.delete(check);
              resolve();
            };
            waiters.add(check);
            check();
          }),
      ),
  };
  return host;
}

/** Wait until the status of an installation has a phase. */
const reached = (status: SubscriptionRef.SubscriptionRef<WebMcp.Status>, phase: WebMcp.Phase) =>
  SubscriptionRef.changes(status).pipe(
    Stream.filter((value) => value.phase === phase),
    Stream.take(1),
    Stream.runDrain,
  );

test("tools follow availability, a failed update keeps the last tools, and closing removes them", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = fakeHost();
      const scope = yield* Scope.make();
      const session = yield* Session.make(fixture, { target: "app" }).pipe(Scope.provide(scope));
      const installed = Option.getOrThrow(yield* WebMcp.install(session, { host }).pipe(Scope.provide(scope)));
      yield* reached(installed.status, "ready");
      assert.ok(host.tools.has("fixture.hidden"));
      assert.ok(host.tools.has("fixture.toggle"));

      const echo = yield* Effect.promise(() => host.tools.get("fixture.echo")!.execute({ text: "hi" }));
      assert.deepEqual(echo, { ok: true, value: { text: "hi" } });
      const crash = yield* Effect.promise(() => host.tools.get("fixture.crash")!.execute({}).catch((error) => error));
      assert.equal((crash as { kind: string }).kind, "internal");

      yield* SubscriptionRef.set(yield* Switch, false);
      yield* host.until((tools) => !tools.has("fixture.toggle"));

      host.refuse.add("fixture.toggle");
      yield* SubscriptionRef.set(yield* Switch, true);
      yield* reached(installed.status, "failed");
      assert.ok(host.tools.has("fixture.echo"));
      assert.ok(!host.tools.has("fixture.toggle"));

      host.refuse.clear();
      yield* installed.retry;
      yield* reached(installed.status, "ready");
      assert.ok(host.tools.has("fixture.toggle"));

      yield* Scope.close(scope, { _tag: "Success", value: undefined } as never);
      assert.equal(host.tools.size, 0);
      assert.equal((yield* SubscriptionRef.get(installed.status)).phase, "disposed");
    }).pipe(Effect.provide(Layer.fresh(fixtureLayer))),
  ));

test("with no host, the binding does nothing", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(fixture, { target: "app" });
        assert.ok(Option.isNone(yield* WebMcp.install(session)));
      }),
    ).pipe(Effect.provide(Layer.fresh(fixtureLayer))),
  ));

test("code that does not use Effect observes the status, at once, and retries a failed update with a promise", async () => {
  const host = fakeHost();
  host.refuse.add("fixture.echo");
  const scope = Effect.runSync(Scope.make());
  const installed = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.make(fixture, { target: "app" });
      return Option.getOrThrow(yield* WebMcp.install(session, { host }));
    }).pipe(Scope.provide(scope), Effect.provide(Layer.fresh(fixtureLayer))),
  );
  const status = installed.statusObservable;
  const phases: WebMcp.Phase[] = [];
  const waiters: { readonly phase: WebMcp.Phase; readonly resolve: () => void }[] = [];
  status.subscribe((value) => {
    phases.push(value.phase);
    for (const waiter of waiters) if (waiter.phase === value.phase) waiter.resolve();
  });
  const reached = (phase: WebMcp.Phase) =>
    status.getSnapshot().phase === phase ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ phase, resolve }));

  await reached("failed");
  assert.match(status.getSnapshot().message ?? "", /refused fixture.echo/);
  host.refuse.clear();
  await installed.retryPromise();
  await reached("ready");
  assert.ok(host.tools.has("fixture.echo"));

  await Effect.runPromise(Scope.close(scope, Exit.void));
  assert.deepEqual(phases.slice(-2), ["closing", "disposed"]);
  assert.equal(status.getSnapshot().phase, "disposed");
});

test("a status listener that throws does not stop the updates of the tools, or their removal", async () => {
  const host = fakeHost();
  const scope = Effect.runSync(Scope.make());
  const installed = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.make(fixture, { target: "app" });
      return Option.getOrThrow(yield* WebMcp.install(session, { host }));
    }).pipe(Scope.provide(scope), Effect.provide(Layer.fresh(fixtureLayer)), Effect.provide(Logger.layer([]))),
  );
  installed.statusObservable.subscribe(() => {
    throw new Error("The listener is broken.");
  });
  const phases: WebMcp.Phase[] = [];
  const ready = new Promise<void>((resolve) =>
    installed.statusObservable.subscribe((value) => {
      phases.push(value.phase);
      if (value.phase === "ready") resolve();
    }),
  );
  await installed.retryPromise();
  await ready;
  assert.ok(host.tools.has("fixture.echo"));
  const closed = await Effect.runPromiseExit(Scope.close(scope, Exit.void).pipe(Effect.provide(Logger.layer([]))));
  assert.ok(Exit.isSuccess(closed));
  assert.equal(host.tools.size, 0);
  assert.deepEqual(phases.slice(-2), ["closing", "disposed"]);
});

test("a change while the first update registers the tools reaches the tools", async () => {
  let current: Availability = AVAILABLE;
  const listeners = new Set<(value: Availability) => void>();
  const owner = {
    getSnapshot: () => current,
    subscribe(listener: (value: Availability) => void) {
      listeners.add(listener);
      return { unsubscribe: () => void listeners.delete(listener) };
    },
  };
  const app = App.make({
    targets: { app: { bindings: ["webmcp"] } },
    capabilities: [Capability.make({ id: "probe.gate.pass", description: "Pass the gate.", audience: ["app"], availability: Effect.succeed(Capability.fromObservable(owner)), run: () => Effect.succeed(null) })],
  });
  let removed!: () => void;
  const removal = new Promise<void>((resolve) => (removed = resolve));
  const host: WebMcp.ModelContext = {
    registerTool(_tool, options) {
      // The gate closes while the update registers the tool, after the update has read the availability.
      current = unavailable("Closed.");
      listeners.forEach((listener) => listener(current));
      options.signal.addEventListener("abort", () => removed());
    },
  };
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.make(app, { target: "app" });
      yield* WebMcp.install(session, { host });
    }).pipe(Scope.provide(scope)),
  );
  await removal;
  await Effect.runPromise(Scope.close(scope, Exit.void));
});
