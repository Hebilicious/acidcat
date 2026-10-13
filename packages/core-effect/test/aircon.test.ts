import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import type { CatalogDocument } from "@acid-cat/spec";
import { Effect, Fiber, Layer, Stream } from "effect";

import { aircon, unitLayer } from "../examples/aircon.ts";
import { App, Mcp, Session } from "../src/index.ts";

const written = JSON.parse(readFileSync(new URL("../../../examples/aircon.acidcat.json", import.meta.url), "utf-8")) as CatalogDocument;
const generated = App.document(aircon);

/** The parts of a catalog that do not depend on how its schemas are written. */
const shape = (catalog: CatalogDocument) => ({
  targets: catalog.targets,
  capabilities: Object.fromEntries(
    Object.entries(catalog.capabilities).map(([id, capability]) => [
      id,
      { audience: capability.audience, readOnly: capability.readOnly ?? false, failures: Object.keys(capability.failures ?? {}).sort(), state: capability.state !== undefined },
    ]),
  ),
});

test("the code writes a catalog that conforms and agrees with the Pkl catalog", () => {
  const text = App.render(aircon);
  assert.deepEqual(check(JSON.parse(text), text).errors, []);
  assert.deepEqual(shape(generated), shape(written));
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
  const tools = ((await response.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ["aircon.fan.set", "aircon.mode.set", "aircon.power.set", "aircon.status.get", "aircon.temperature.set"]);
});

test("a flag follows a $ref to its type", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = new URL("../examples/aircon-cli.ts", import.meta.url).pathname;
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
        assert.equal((first as { power: boolean }).power, false);
        assert.equal((second as { power: boolean }).power, true);
        assert.deepEqual(yield* session.state("aircon.power.set").pipe(Stream.runCollect), []);
      }),
    ).pipe(Effect.provide(Layer.fresh(unitLayer))),
  ));
