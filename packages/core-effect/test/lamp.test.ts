import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import type { CatalogDocument } from "@acid-cat/spec-ts";
import { Effect, Fiber, Layer, Schema, Scope, Stream, SubscriptionRef } from "effect";

import { App, Mcp, Session } from "../src/index.ts";
import { Lamp, lamp, lampLayer, makeLampLayer } from "./lamp.ts";

/** Run a test with a session for a target, and a lamp of its own. */
const withSession = <A, E>(
  target: string,
  body: (session: Session.Session) => Effect.Effect<A, E, Lamp | Scope.Scope>,
  layer = lampLayer,
) => Effect.runPromise(Effect.scoped(Effect.flatMap(Session.make(lamp, { target }), body)).pipe(Effect.provide(Layer.fresh(layer))));

/** The parts of a catalog that tell who can do what. */
const shape = (catalog: CatalogDocument) =>
  Object.fromEntries(
    Object.entries(catalog.capabilities).map(([id, capability]) => [
      id,
      {
        audience: capability.audience,
        readOnly: capability.readOnly ?? false,
        failures: Object.keys(capability.failures ?? {}).sort(),
        state: capability.state !== undefined,
      },
    ]),
  );

test("the lamp writes a catalog that conforms, with its shared types in $defs", () => {
  const text = App.render(lamp);
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });

  const document = App.document(lamp);
  assert.deepEqual(Object.keys(document.targets).sort(), ["api", "app", "cli", "mcp", "remote"]);
  assert.deepEqual(Object.keys(document.$defs ?? {}).sort(), ["Light", "Scene", "Unreachable"]);
  const everywhere = ["app", "remote", "cli", "mcp", "api"];
  const controls = ["app", "cli", "mcp", "api"];
  assert.deepEqual(shape(document), {
    "lamp.brightness.set": { audience: everywhere, readOnly: false, failures: ["Unreachable"], state: false },
    "lamp.light.get": { audience: everywhere, readOnly: true, failures: ["Unreachable"], state: true },
    "lamp.pair": { audience: ["app"], readOnly: false, failures: ["Unreachable"], state: false },
    "lamp.power.set": { audience: everywhere, readOnly: false, failures: ["Burnt", "Unreachable"], state: false },
    "lamp.scene.set": { audience: controls, readOnly: false, failures: ["Unreachable"], state: false },
    "lamp.temperature.set": { audience: controls, readOnly: false, failures: ["Unreachable"], state: false },
  });

  const light = document.capabilities["lamp.light.get"];
  assert.deepEqual(light?.output, { $ref: "#/$defs/Light" });
  assert.deepEqual(light?.state, { $ref: "#/$defs/Light" });
  assert.deepEqual(document.capabilities["lamp.scene.set"]?.input?.properties, { scene: { $ref: "#/$defs/Scene" } });
  assert.deepEqual(document.capabilities["lamp.brightness.set"]?.input?.properties, { level: { type: "integer", minimum: 0, maximum: 100 } });
});

test("the lamp works through a session", () =>
  withSession("mcp", (session) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* session.invoke("lamp.brightness.set", { level: 40 }), { kind: "unavailable", message: "The lamp is off." });
      assert.deepEqual(yield* session.invoke("lamp.power.set", { on: true }), { ok: true, value: null });
      assert.deepEqual(yield* session.invoke("lamp.brightness.set", { level: 40 }), { ok: true, value: null });
      assert.deepEqual(yield* session.invoke("lamp.scene.set", { scene: "reading" }), { ok: true, value: null });

      for (const [id, input] of [
        ["lamp.brightness.set", { level: 150 }],
        ["lamp.brightness.set", { level: 12.5 }],
        ["lamp.temperature.set", { kelvin: 9000 }],
        ["lamp.scene.set", { scene: "disco" }],
      ] as const) {
        const invalid = yield* session.invoke(id, input);
        assert.equal("kind" in invalid && invalid.kind, "invalid-input", `${id} ${JSON.stringify(input)}`);
      }

      const light = { on: true, brightness: 40, kelvin: 3000, scene: "reading" };
      const [state] = yield* session.state("lamp.light.get").pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(state, light);
      assert.deepEqual(yield* session.invoke("lamp.light.get", {}), { ok: true, value: light });
    }),
  ));

test("each failure of the lamp is a result with its tag", async () => {
  await withSession(
    "app",
    (session) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* session.invoke("lamp.power.set", { on: true }), { ok: false, error: { _tag: "Burnt", hours: 1200 } });
        assert.deepEqual(yield* session.availability("lamp.brightness.set"), { available: false, reason: "The lamp is off." });
      }),
    makeLampLayer({ burntAfter: 1200 }),
  );
  await withSession("app", (session) =>
    Effect.gen(function* () {
      yield* SubscriptionRef.set((yield* Lamp).reachable, false);
      assert.deepEqual(yield* session.invoke("lamp.light.get", {}), { ok: false, error: { _tag: "Unreachable" } });
      assert.deepEqual(yield* session.invoke("lamp.pair", {}), { ok: false, error: { _tag: "Unreachable" } });
    }),
  );
});

test("the state gives the current value, then each change, and a capability with no state gives no values", () =>
  withSession("app", (session) =>
    Effect.gen(function* () {
      const values = yield* session.state("lamp.light.get").pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
      yield* session.invoke("lamp.power.set", { on: true });
      const [first, second] = yield* Fiber.join(values).pipe(Effect.timeout(1000));
      assert.deepEqual(first, { on: false, brightness: 80, kelvin: 3000 });
      assert.deepEqual(second, { on: true, brightness: 80, kelvin: 3000 });
      assert.deepEqual(yield* session.state("lamp.power.set").pipe(Stream.runCollect), []);
    }),
  ));

const ToolList = Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }) });

test("an agent sees the available capabilities of the mcp view through MCP", async () => {
  const handler = Mcp.toWebHandler(lamp, Layer.fresh(lampLayer), { name: "lamp", version: "0.0.0", allowedOrigins: [] });
  const request = (method: string, params: object = {}, name?: string) => {
    const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-method": method, "mcp-protocol-version": "2026-07-28" });
    if (name !== undefined) headers.set("mcp-name", name);
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
    return handler(
      new Request("https://lamp.local/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
      }),
    );
  };
  const tools = async () => Schema.decodeUnknownSync(ToolList)(await (await request("tools/list")).json()).result.tools.map((tool) => tool.name).sort();

  assert.deepEqual(await tools(), ["lamp.light.get", "lamp.power.set", "lamp.scene.set", "lamp.temperature.set"]);
  assert.equal((await request("tools/call", { name: "lamp.power.set", arguments: { on: true } }, "lamp.power.set")).status, 200);
  assert.deepEqual(await tools(), ["lamp.brightness.set", "lamp.light.get", "lamp.power.set", "lamp.scene.set", "lamp.temperature.set"]);
});

test("the command line of the lamp gives each outcome its exit code, and a flag follows a $ref to its type", () => {
  const cli = (...args: string[]) => {
    const run = spawnSync(process.execPath, [new URL("./lamp-cli.ts", import.meta.url).pathname, ...args], { encoding: "utf-8", timeout: 20_000 });
    return { code: run.status, stdout: run.stdout };
  };

  const scene = cli("lamp", "scene", "set", "--scene", "night");
  assert.equal(scene.code, 0);
  assert.equal(JSON.parse(scene.stdout), null);
  assert.equal(cli("lamp", "scene", "set", "--scene", "disco").code, 3);

  const power = cli("lamp", "power", "set", "--on");
  assert.equal(power.code, 1);
  assert.deepEqual(JSON.parse(power.stdout), { _tag: "Burnt", hours: 1200 });

  assert.equal(cli("lamp", "brightness", "set", "--level", "50").code, 4);
  assert.equal(cli("lamp", "temperature", "set", "--kelvin", "9000").code, 3);
  assert.equal(cli("lamp", "pair").code, 2);
});
