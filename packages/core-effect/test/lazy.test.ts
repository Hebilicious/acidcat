/**
 * Capabilities whose schemas and program load on demand. `moon run core-effect:typecheck` checks the types in this file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { CallFailureError } from "@acid-cat/spec-ts";
import { Deferred, Effect, Fiber, Layer } from "effect";

import { App, Capability, Handles, Mcp, Session } from "../src/index.ts";

const evaluations = () => (globalThis as { lazyProbeEvaluations?: number }).lazyProbeEvaluations ?? 0;

/** A lazy capability of the probe module, with a count of its loads, and an optional gate or failure before each load. */
function lazyProbe(options: { readonly gate?: Deferred.Deferred<void>; readonly failures?: number } = {}) {
  const loads = { count: 0, failures: options.failures ?? 0 };
  const capability = Capability.lazy(
    { id: "plan.generate", description: "Make a plan with some stops.", audience: ["app", "mcp"], readOnly: true },
    async () => {
      loads.count++;
      if (options.gate !== undefined) await Effect.runPromise(Deferred.await(options.gate));
      if (loads.failures > 0) {
        loads.failures--;
        throw new Error("The module did not load.");
      }
      return (await import("./lazy-probe.capability.ts")).generate;
    },
  );
  const app = App.make({ targets: { app: { bindings: ["typescript"] }, mcp: { bindings: ["mcp"] } }, capabilities: [capability] });
  return { capability, app, loads };
}

test("opening a session and its handles loads no lazy capability, and the first call loads it once", async () => {
  const { capability, app, loads } = lazyProbe();
  const session = await Handles.open(app, Layer.empty, { target: "app" });
  try {
    const handles = Handles.tree(session.handles, { plan: { generate: capability } });
    assert.equal(loads.count, 0);
    assert.equal(evaluations(), 0);
    assert.deepEqual(await handles.plan.generate.execute({ stops: 3 }), { ok: true, value: { stops: 3, label: "3 stops" } });
    assert.deepEqual(await handles.plan.generate.invokeExternal({ stops: 11 }), { ok: false, error: { _tag: "TooFar", stops: 11 } });
    assert.equal(loads.count, 1);
    assert.equal(evaluations(), 1);
    // @ts-expect-error The input of the lazy capability has the type of the loaded module.
    void (() => handles.plan.generate.execute({ stops: "three" }));
  } finally {
    await session.dispose();
  }
});

test("a cancelled load does not keep the next call from loading, and a failed load is internal, then tried again", async () => {
  const gate = Effect.runSync(Deferred.make<void>());
  const gated = lazyProbe({ gate });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(gated.app, { target: "app" });
        const first = yield* Effect.forkScoped(session.invoke("plan.generate", { stops: 1 }), { startImmediately: true });
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(gate, undefined);
        assert.deepEqual(yield* session.invoke("plan.generate", { stops: 2 }), { ok: true, value: { stops: 2, label: "2 stops" } });
      }),
    ),
  );

  const failing = lazyProbe({ failures: 1 });
  const session = await Handles.open(failing.app, Layer.empty, { target: "app" });
  try {
    const handle = session.handles.get("plan.generate")!;
    const failed = await handle.invokeExternal({ stops: 1 }).catch((error: unknown) => error);
    assert.ok(failed instanceof CallFailureError);
    assert.equal(failed.kind, "internal");
    assert.deepEqual(await handle.invokeExternal({ stops: 1 }), { ok: true, value: { stops: 1, label: "1 stops" } });
    assert.equal(failing.loads.count, 2);
  } finally {
    await session.dispose();
  }
});

test("the catalog of a loaded lazy application is the catalog of the same capabilities declared at once", async () => {
  const { app } = lazyProbe();
  assert.throws(() => App.render(app), /App.load/);
  await Effect.runPromise(App.load(app));
  const { generate } = await import("./lazy-probe.capability.ts");
  const eager = App.make({ targets: { app: { bindings: ["typescript"] }, mcp: { bindings: ["mcp"] } }, capabilities: [generate] });
  const text = App.render(app);
  assert.equal(text, App.render(eager));
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
});

test("MCP loads the lazy capabilities of its view to list them", async () => {
  const { app, loads } = lazyProbe();
  const handler = Mcp.toWebHandler(app, Layer.empty, { name: "probe", version: "0.0.0", allowedOrigins: [] });
  const response = await handler(
    new Request("https://probe.local/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-method": "tools/list", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    }),
  );
  const tools = ((await response.json()) as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } }).result.tools;
  assert.deepEqual(tools.map((tool) => [tool.name, tool.inputSchema.required]), [["plan.generate", ["stops"]]]);
  assert.equal(loads.count, 1);
});
