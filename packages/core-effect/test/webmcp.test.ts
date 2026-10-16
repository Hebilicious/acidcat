import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Layer, Option, Scope, SubscriptionRef } from "effect";

import { Session, WebMcp } from "../src/index.ts";
import { fixture, Switch, fixtureLayer } from "./fixture.ts";

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

const settle = Effect.sleep(20);

test("tools follow availability, a failed update keeps the last tools, and closing removes them", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = fakeHost();
      const scope = yield* Scope.make();
      const session = yield* Session.make(fixture, { target: "app" }).pipe(Scope.provide(scope));
      const installed = Option.getOrThrow(yield* WebMcp.install(session, { host }).pipe(Scope.provide(scope)));
      yield* settle;
      assert.equal((yield* SubscriptionRef.get(installed.status)).phase, "ready");
      assert.ok(host.tools.has("fixture.hidden"));
      assert.ok(host.tools.has("fixture.toggle"));

      const echo = yield* Effect.promise(() => host.tools.get("fixture.echo")!.execute({ text: "hi" }));
      assert.deepEqual(echo, { ok: true, value: { text: "hi" } });
      const crash = yield* Effect.promise(() => host.tools.get("fixture.crash")!.execute({}).catch((error) => error));
      assert.equal((crash as { kind: string }).kind, "internal");

      yield* SubscriptionRef.set(yield* Switch, false);
      yield* settle;
      assert.ok(!host.tools.has("fixture.toggle"));

      host.refuse.add("fixture.toggle");
      yield* SubscriptionRef.set(yield* Switch, true);
      yield* settle;
      const failed = yield* SubscriptionRef.get(installed.status);
      assert.equal(failed.phase, "failed");
      assert.ok(host.tools.has("fixture.echo"));

      host.refuse.clear();
      yield* installed.retry;
      yield* settle;
      assert.equal((yield* SubscriptionRef.get(installed.status)).phase, "ready");
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
