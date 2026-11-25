import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { Effect, Fiber, Layer, Scope, Stream } from "effect";

import { App, Session } from "../src/index.ts";
import { Lamp, lamp, lampLayer } from "./lamp.ts";
import { run } from "./run.ts";
import { bundledProgram } from "./bundled-program.ts";

const withSession = <A, E>(target: string, body: (session: Session.Session) => Effect.Effect<A, E, Lamp | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(Session.make(lamp, { target }), body)).pipe(Effect.provide(Layer.fresh(lampLayer))));

test("the lamp writes a catalog that conforms, with its shared types in $defs", () => {
  const text = App.render(lamp);
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
  const document = App.document(lamp);
  assert.deepEqual(Object.keys(document.$defs ?? {}).sort(), ["Light", "Scene", "Unreachable"]);
  const light = document.capabilities["lamp.light.get"];
  assert.deepEqual(light?.output, { $ref: "#/$defs/Light" });
  assert.deepEqual(light?.state, { $ref: "#/$defs/Light" });
  assert.deepEqual(document.capabilities["lamp.scene.set"]?.input?.properties, { scene: { $ref: "#/$defs/Scene" } });
  assert.deepEqual(document.capabilities["lamp.brightness.set"]?.input?.properties, { level: { type: "integer", minimum: 0, maximum: 100 } });
});

test("the constraints of the input schemas of the lamp reject input", () =>
  withSession("mcp", (session) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* session.invoke("lamp.power.set", { on: true }), { ok: true, value: null });
      for (const [id, input] of [
        ["lamp.brightness.set", { level: 150 }],
        ["lamp.brightness.set", { level: 12.5 }],
        ["lamp.temperature.set", { kelvin: 9000 }],
        ["lamp.scene.set", { scene: "disco" }],
      ] as const) {
        const invalid = yield* session.invoke(id, input);
        assert.equal("kind" in invalid && invalid.kind, "invalid-input", `${id} ${JSON.stringify(input)}`);
      }
    }),
  ));

test("the state gives the current value, then each change, and a capability with no state gives no values", () =>
  withSession("app", (session) =>
    Effect.gen(function* () {
      const values = yield* session.state("lamp.light.get").pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
      yield* session.invoke("lamp.power.set", { on: true });
      const [first, second] = yield* Fiber.join(values);
      assert.deepEqual(first, { on: false, brightness: 80, kelvin: 3000 });
      assert.deepEqual(second, { on: true, brightness: 80, kelvin: 3000 });
      assert.deepEqual(yield* session.state("lamp.power.set").pipe(Stream.runCollect), []);
    }),
  ));

test("a flag of the command line of the lamp follows a $ref to its type", async (t) => {
  const cli = (...args: string[]) => run(t, bundledProgram("test/lamp-cli.ts"), ...args);
  const [night, disco] = await Promise.all([cli("lamp", "scene", "set", "--scene", "night"), cli("lamp", "scene", "set", "--scene", "disco")]);
  assert.equal(night.code, 0, night.stderr);
  assert.equal(JSON.parse(night.stdout), null);
  assert.equal(disco.code, 3);
});
