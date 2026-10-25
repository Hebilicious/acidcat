import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";

import { aircon, unitLayer } from "../core-effect/aircon.ts";
import { App, Mcp, Session } from "@acid-cat/core-effect";
import { shape, writtenText } from "./shape.ts";

/** The part of a `tools/list` response that the test reads. */
const ToolList = Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }) });

test("the code writes a catalog that conforms and agrees with the Pkl catalog", () => {
  const text = App.render(aircon);
  assert.deepEqual(check(JSON.parse(text), text).errors, []);
  assert.deepEqual(shape(App.document(aircon)), shape(JSON.parse(writtenText)));
});

test("the unit works through a session", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(aircon, { target: "mcp" });
        assert.deepEqual(yield* session.invoke("aircon.mode.set", { mode: "heat" }), { ok: false, error: { _tag: "PoweredOff" } });
        assert.deepEqual(yield* session.invoke("aircon.power.set", { on: true }), { ok: true, value: null });
        assert.deepEqual(yield* session.invoke("aircon.mode.set", { mode: "heat" }), { ok: true, value: null });
        const invalid = yield* session.invoke("aircon.temperature.set", { celsius: 40 });
        assert.equal("kind" in invalid && invalid.kind, "invalid-input");
        const [state] = yield* session.state("aircon.status.get").pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(state, { power: true, mode: "heat", fan: "auto", targetCelsius: 22, roomCelsius: 25 });
        const status = yield* session.invoke("aircon.status.get", {});
        assert.deepEqual(status, { ok: true, value: { power: true, mode: "heat", fan: "auto", targetCelsius: 22, roomCelsius: 25 } });
      }),
    ).pipe(Effect.provide(Layer.fresh(unitLayer))),
  ));

test("an agent sees the mcp view through MCP", async () => {
  const handler = Mcp.toWebHandler(aircon, unitLayer, { name: "aircon", version: "0.1.0", allowedOrigins: [] });
  const response = await handler(
    new Request("https://unit.local/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-method": "tools/list", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    }),
  );
  const { result } = Schema.decodeUnknownSync(ToolList)(await response.json());
  const tools = result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ["aircon.fan.set", "aircon.mode.set", "aircon.power.set", "aircon.status.get", "aircon.temperature.set"]);
});

test("a flag follows a $ref to its type", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = new URL("../core-effect/cli.ts", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [cli, "aircon", "mode", "set", "--mode", "heat"], { encoding: "utf-8", timeout: 20_000 });
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stdout), { _tag: "PoweredOff" });
  assert.equal(spawnSync(process.execPath, [cli, "aircon", "mode", "set", "--mode", "boil"], { timeout: 20_000 }).status, 3);
});

test("the state gives the current value, then each change", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(aircon, { target: "app" });
        const values = yield* session.state("aircon.status.get").pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
        yield* session.invoke("aircon.power.set", { on: true });
        const [first, second] = yield* Fiber.join(values).pipe(Effect.timeout(1000));
        const off = { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 };
        assert.deepEqual([first, second], [off, { ...off, power: true }]);
        assert.deepEqual(yield* session.state("aircon.power.set").pipe(Stream.runCollect), []);
      }),
    ).pipe(Effect.provide(Layer.fresh(unitLayer))),
  ));
