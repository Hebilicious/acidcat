import assert from "node:assert/strict";
import { test } from "node:test";

import { CallFailureError } from "@acid-cat/spec-ts";
import { Effect, Exit, Layer, Option, Scope, SubscriptionRef } from "effect";

import { Handles, Session, WebMcp } from "../src/index.ts";
import { fixture, fixtureLayer, position, Switch } from "./fixture.ts";
import { lamp, lampLayer } from "./lamp.ts";

/** A WebMCP host in memory. It can refuse a tool, to test a failed update. */
function fakeHost() {
  const tools = new Map<string, WebMcp.ModelContextTool>();
  const host = {
    tools,
    refuse: new Set<string>(),
    registerTool(tool: WebMcp.ModelContextTool, options: { signal: AbortSignal }) {
      if (host.refuse.has(tool.name)) return Promise.reject(new Error(`refused ${tool.name}`));
      tools.set(tool.name, tool);
      options.signal.addEventListener("abort", () => tools.delete(tool.name));
      return { unregister() {} };
    },
  };
  return host;
}

/** The tool of a host with a name. It must exist. */
function toolOf(host: ReturnType<typeof fakeHost>, name: string) {
  const tool = host.tools.get(name);
  assert.ok(tool !== undefined, `The host has no tool ${name}.`);
  return tool;
}

/**
 * Wait until `done` is true. The binding updates its tools in its own fiber, so a test waits for the state that it checks,
 * not for a time. The wait fails after 5 seconds.
 */
const until = (done: () => boolean | Promise<boolean>) =>
  Effect.gen(function* () {
    while (!(yield* Effect.promise(async () => done()))) yield* Effect.sleep(5);
  }).pipe(Effect.timeout("5 seconds"), Effect.orDie);

/** A short time, for the one check that nothing happens. */
const settle = Effect.sleep(20);

test("tools follow availability, a failed update keeps the last tools, and closing removes them", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = fakeHost();
      const scope = yield* Scope.make();
      const session = yield* Session.make(fixture, { target: "app" }).pipe(Scope.provide(scope));
      const installed = Option.getOrThrow(yield* WebMcp.install(session, { host }).pipe(Scope.provide(scope)));
      yield* until(() => SubscriptionRef.getUnsafe(installed.status).phase === "ready" && host.tools.has("fixture.toggle"));
      assert.equal((yield* SubscriptionRef.get(installed.status)).phase, "ready");
      assert.ok(host.tools.has("fixture.hidden"));
      assert.ok(host.tools.has("fixture.toggle"));

      const echo = yield* Effect.promise(() => toolOf(host, "fixture.echo").execute({ text: "hi" }));
      assert.deepEqual(echo, { ok: true, value: { text: "hi" } });
      const crash = yield* Effect.promise(() => toolOf(host, "fixture.crash").execute({}).catch((error: unknown) => error));
      assert.ok(crash instanceof CallFailureError);
      assert.equal(crash.kind, "internal");

      yield* SubscriptionRef.set(yield* Switch, position(false));
      yield* until(() => !host.tools.has("fixture.toggle"));
      assert.ok(!host.tools.has("fixture.toggle"));

      host.refuse.add("fixture.toggle");
      yield* SubscriptionRef.set(yield* Switch, position(true));
      yield* until(() => SubscriptionRef.getUnsafe(installed.status).phase === "failed");
      const failed = yield* SubscriptionRef.get(installed.status);
      assert.equal(failed.phase, "failed");
      assert.ok(host.tools.has("fixture.echo"));

      host.refuse.clear();
      yield* installed.retry;
      yield* until(() => SubscriptionRef.getUnsafe(installed.status).phase === "ready" && host.tools.has("fixture.toggle"));
      assert.equal((yield* SubscriptionRef.get(installed.status)).phase, "ready");
      assert.ok(host.tools.has("fixture.toggle"));

      yield* Scope.close(scope, Exit.void);
      assert.equal(host.tools.size, 0);
      assert.equal((yield* SubscriptionRef.get(installed.status)).phase, "disposed");
    }).pipe(Effect.provide(Layer.fresh(fixtureLayer))),
  ));

test("remove takes the tools away while the scope stays open, does nothing a second time, and closing works after it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = fakeHost();
      const scope = yield* Scope.make();
      const session = yield* Session.make(fixture, { target: "app" }).pipe(Scope.provide(scope));
      const installed = Option.getOrThrow(yield* WebMcp.install(session, { host }).pipe(Scope.provide(scope)));
      yield* until(() => host.tools.has("fixture.toggle"));
      assert.ok(host.tools.has("fixture.toggle"));

      yield* installed.remove;
      assert.equal(host.tools.size, 0);
      assert.equal((yield* SubscriptionRef.get(installed.status)).phase, "disposed");
      yield* installed.remove;

      yield* SubscriptionRef.set(yield* Switch, position(false));
      yield* SubscriptionRef.set(yield* Switch, position(true));
      yield* installed.retry;
      yield* until(() => host.tools.size === 0 && SubscriptionRef.getUnsafe(installed.status).phase === "disposed");
      assert.equal(host.tools.size, 0);
      assert.equal((yield* SubscriptionRef.get(installed.status)).phase, "disposed");

      yield* Scope.close(scope, Exit.void);
      assert.equal((yield* SubscriptionRef.get(installed.status)).phase, "disposed");
      yield* installed.remove;
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

test("Handles.open registers the tools on a host, observes their status, and dispose removes them", async () => {
  const host = fakeHost();
  const phases: WebMcp.Phase[] = [];
  {
    await using session = await Handles.open(lamp, lampLayer, { target: "app", webmcp: host });
    const webmcp = session.webmcp;
    assert.ok(webmcp !== undefined);
    webmcp.status.subscribe((status) => phases.push(status.phase));
    await Effect.runPromise(until(() => webmcp.status.getSnapshot().phase === "ready"));
    assert.equal(webmcp.status.getSnapshot().phase, "ready");
    const available = [...session.handles.values()].filter((handle) => handle.availability.getSnapshot().available);
    assert.deepEqual([...host.tools.keys()].sort(), available.map((handle) => handle.id).sort());
    await webmcp.retry();
    await Effect.runPromise(until(() => webmcp.status.getSnapshot().phase === "ready"));
    assert.equal(webmcp.status.getSnapshot().phase, "ready");
  }
  assert.equal(host.tools.size, 0);
  assert.ok(phases.includes("reconciling"));
});

test("Handles.open without a host registers no tool", async () => {
  await using session = await Handles.open(lamp, lampLayer, { target: "app" });
  assert.equal(session.webmcp, undefined);
});

test("Handles.open: remove takes the tools away during a call of the same session, and the calls in progress complete", async () => {
  const host = fakeHost();
  const phases: WebMcp.Phase[] = [];
  const session = await Handles.open(fixture, fixtureLayer, { target: "app", webmcp: host });
  const webmcp = session.webmcp;
  assert.ok(webmcp !== undefined);
  webmcp.status.subscribe((status) => phases.push(status.phase));
  const handle = (id: string) => {
    const found = session.handles.get(id);
    assert.ok(found !== undefined, `The session has no handle ${id}.`);
    return found;
  };
  await Effect.runPromise(until(() => host.tools.has("fixture.toggle")));
  assert.ok(host.tools.has("fixture.toggle"));

  const sessionCall = handle("fixture.hold").invokeExternal({ key: "session" });
  const toolCall = toolOf(host, "fixture.hold").execute({ key: "tool" });
  await Effect.runPromise(until(async () => JSON.stringify(await handle("fixture.held").invokeExternal({})).includes('"session","tool"')));
  assert.deepEqual(await handle("fixture.held").invokeExternal({}), { ok: true, value: { keys: ["session", "tool"] } });

  await webmcp.remove();
  assert.equal(host.tools.size, 0);
  assert.equal(webmcp.status.getSnapshot().phase, "closing");
  await webmcp.remove();
  assert.equal(host.tools.size, 0);

  await handle("fixture.switch.set").invokeExternal({ on: false });
  await handle("fixture.switch.set").invokeExternal({ on: true });
  await webmcp.retry();
  // Nothing must happen here, and a test cannot wait for nothing, so it waits for a time.
  await Effect.runPromise(settle);
  assert.equal(host.tools.size, 0);

  assert.equal(session.signal.aborted, false);
  await handle("fixture.release").invokeExternal({ key: "session" });
  await handle("fixture.release").invokeExternal({ key: "tool" });
  assert.deepEqual(await sessionCall, { ok: true, value: { key: "session" } });
  assert.deepEqual(await toolCall, { ok: true, value: { key: "tool" } });
  await Effect.runPromise(until(() => webmcp.status.getSnapshot().phase === "disposed"));
  assert.equal(webmcp.status.getSnapshot().phase, "disposed");
  assert.deepEqual(await handle("fixture.echo").invokeExternal({ text: "still open" }), { ok: true, value: { text: "still open" } });

  await session.dispose();
  assert.equal(host.tools.size, 0);
  assert.equal(webmcp.status.getSnapshot().phase, "disposed");
  assert.deepEqual(phases.slice(-2), ["closing", "disposed"]);
});
