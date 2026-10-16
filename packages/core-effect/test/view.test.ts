import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Layer, Schema } from "effect";

import { App, Capability, Handles, Http, Session } from "../src/index.ts";

/** An application whose input schema counts how many times Effect writes it as JSON Schema. */
function countedApp() {
  const counts = { writes: 0 };
  const Counted = Schema.String.check(
    Schema.makeFilter(() => true, {
      toJsonSchema: () => {
        counts.writes += 1;
        return {};
      },
    }),
  );
  const app = App.make({
    targets: { app: { bindings: ["typescript"] }, api: { bindings: ["http"] } },
    capabilities: [
      Capability.make({
        id: "probe.echo",
        description: "Return the input text.",
        audience: ["app", "api"],
        input: Schema.Struct({ text: Counted }),
        output: Schema.Struct({ text: Schema.String }),
        run: (input) => Effect.succeed(input),
      }),
    ],
  });
  return { counts, app };
}

test("a session and its handles open without writing JSON Schema, and the view is written one time for each application", () => {
  const { counts, app } = countedApp();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        const handles = yield* Handles.make(app, session);
        assert.equal(handles.get("probe.echo")?.description, "Return the input text.");
        assert.deepEqual(handles.get("probe.echo")?.audience, ["app"]);
        assert.deepEqual(yield* session.invoke("probe.echo", { text: "hi" }), { ok: true, value: { text: "hi" } });
        assert.equal(counts.writes, 0);

        assert.deepEqual(Object.keys(session.view.capabilities), ["probe.echo"]);
        assert.equal(counts.writes, 1);
        assert.equal(session.view, session.view);

        const other = yield* Session.make(app, { target: "api" });
        assert.deepEqual(Object.keys(other.view.capabilities), ["probe.echo"]);
        assert.equal(counts.writes, 1);
      }),
    ),
  );
});

test("an HTTP call writes no JSON Schema, and GET /catalog writes the view", async () => {
  const { counts, app } = countedApp();
  const handler = Http.toWebHandler(app, Layer.empty, { allowedOrigins: [] });
  const call = await handler(
    new Request("https://probe.example/capabilities/probe.echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    }),
  );
  assert.equal(call.status, 200);
  assert.equal(counts.writes, 0);

  for (let request = 0; request < 2; request++) {
    const catalog = await handler(new Request("https://probe.example/catalog"));
    assert.ok("probe.echo" in ((await catalog.json()) as { capabilities: object }).capabilities);
  }
  assert.equal(counts.writes, 1);
});
