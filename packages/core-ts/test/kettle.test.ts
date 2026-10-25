/**
 * The core with the kettle of `kettle.ts`: the catalog it writes, named types, state, typed handles, availability and
 * the command line. `moon run core-ts:typecheck` checks this file: each `@ts-expect-error` marks a program that the
 * types must reject.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { z } from "zod";

import { CallFailureError, catalogOf, createSession, defineApp, defineCapability, getHandle, ok, renderCatalog, runCli } from "../src/index.ts";
import type { Result } from "../src/index.ts";
import { boil, descale, fill, Kettle, kettle, statusGet, toJsonSchema, warmSet } from "./kettle.ts";
import type { Status } from "./kettle.ts";

/** A kettle with water in it. */
function filledKettle(litres = 1): Kettle {
  const filled = new Kettle();
  filled.change({ litres });
  return filled;
}

test("the kettle writes a catalog that conforms and is in canonical form", () => {
  const text = renderCatalog(kettle, { toJsonSchema });
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
});

test("the catalog has the targets, the audiences and the members of each capability", () => {
  const catalog = catalogOf(kettle, { toJsonSchema });
  assert.deepEqual(Object.keys(catalog.targets), ["app", "panel", "cli", "mcp"]);
  assert.deepEqual(catalog.targets.panel, { bindings: ["typescript"], description: "The buttons and the display on the base of the kettle." });
  assert.deepEqual(catalog.targets.cli, { bindings: ["cli"] });

  const status = catalog.capabilities["kettle.status.get"];
  assert.deepEqual(status?.audience, ["app", "panel", "cli", "mcp"]);
  assert.equal(status?.readOnly, true);
  assert.deepEqual(status?.output, { $ref: "#/$defs/KettleStatus" });
  assert.deepEqual(status?.state, { $ref: "#/$defs/KettleStatus" });
  assert.equal(status?.input, undefined);
  assert.equal(status?.failures, undefined);

  assert.deepEqual(catalog.capabilities["kettle.descale"], { description: "Remove the limescale. The water must be cool.", audience: ["app"] });
  assert.equal(catalog.capabilities["kettle.boil"]?.readOnly, undefined);
  assert.equal(catalog.capabilities["kettle.boil"]?.state, undefined);
});

test("a named schema is a type in $defs, and each use of it is a reference", () => {
  const catalog = catalogOf(kettle, { toJsonSchema });
  assert.deepEqual(Object.keys(catalog.$defs ?? {}).sort(), ["Drink", "Empty", "KettleStatus"]);
  assert.deepEqual(catalog.$defs?.Drink, { type: "string", enum: ["green-tea", "white-tea", "coffee", "baby-milk"] });
  assert.deepEqual(catalog.capabilities["kettle.boil"]?.failures, { Empty: { $ref: "#/$defs/Empty" } });
  assert.deepEqual(catalog.capabilities["kettle.warm.set"]?.failures, { Empty: { $ref: "#/$defs/Empty" } });
  assert.deepEqual(catalog.capabilities["kettle.warm.set"]?.input?.properties, { drink: { $ref: "#/$defs/Drink" } });

  const overflow = catalog.capabilities["kettle.fill"]?.failures?.Overflow;
  assert.deepEqual(overflow?.required, ["_tag", "capacity"]);
});

test("two different schemas with the same name stop the catalog", () => {
  const First = z.enum(["a", "b"]).meta({ id: "Choice" });
  const Second = z.enum(["c", "d"]).meta({ id: "Choice" });
  const app = defineApp({
    targets: { mcp: { bindings: ["mcp"] } },
    capabilities: [
      defineCapability({ id: "probe.first", description: "Use the first choice.", audience: ["mcp"], input: z.object({ choice: First }), run: () => ok(null) }),
      defineCapability({ id: "probe.second", description: "Use the second choice.", audience: ["mcp"], input: z.object({ choice: Second }), run: () => ok(null) }),
    ],
  });
  assert.throws(() => catalogOf(app, { toJsonSchema }), /probe\.second: two different schemas have the name Choice/);
});

test("a session gives values, failures of the capability and call failures", async () => {
  const session = createSession(kettle, { target: "mcp", context: { kettle: new Kettle() }, toJsonSchema });
  assert.deepEqual(await session.invoke("kettle.boil", {}), { ok: false, error: { _tag: "Empty" } });
  assert.deepEqual(await session.invoke("kettle.fill", { litres: 1 }), { ok: true, value: null });
  assert.deepEqual(await session.invoke("kettle.fill", { litres: 1 }), { ok: false, error: { _tag: "Overflow", capacity: 1.7 } });
  assert.deepEqual(await session.invoke("kettle.boil", {}), { ok: true, value: { celsius: 100 } });

  const tooMuch = await session.invoke("kettle.fill", { litres: 5 });
  assert.ok("kind" in tooMuch);
  assert.equal(tooMuch.kind, "invalid-input");
  assert.match(tooMuch.message, /^litres: /);

  const lemonade = await session.invoke("kettle.warm.set", { drink: "lemonade" });
  assert.ok("kind" in lemonade);
  assert.equal(lemonade.kind, "invalid-input");

  const outside = await session.invoke("kettle.descale", {});
  assert.ok("kind" in outside);
  assert.equal(outside.kind, "unknown-capability");
  await session.dispose();
});

test("availability comes from the context, and a call to an unavailable capability fails as unavailable", async () => {
  const context = { kettle: filledKettle() };
  const session = createSession(kettle, { target: "app", context, toJsonSchema });
  const handle = getHandle(session.handles, descale);
  assert.deepEqual(handle.availability.getSnapshot(), { available: true });

  const seen: unknown[] = [];
  const subscription = handle.availability.subscribe((value) => seen.push(value));
  await session.invoke("kettle.boil", {});
  assert.deepEqual(seen, [{ available: false, reason: "The water is too hot." }]);
  assert.deepEqual(await session.invoke("kettle.descale", {}), { kind: "unavailable", message: "The water is too hot." });
  const error = await handle.execute({}).catch((caught: unknown) => caught);
  assert.ok(error instanceof CallFailureError);
  assert.equal(error.kind, "unavailable");

  context.kettle.change({ celsius: 20 });
  assert.deepEqual(await handle.execute({}), { ok: true, value: null });
  subscription.unsubscribe();
  await session.dispose();
});

test("a handle gives the state as copies, and each change", async () => {
  const context = { kettle: filledKettle() };
  const session = createSession(kettle, { target: "app", context, toJsonSchema });
  const snapshot = getHandle(session.handles, statusGet).snapshot;
  assert.ok(snapshot !== undefined);
  assert.deepEqual(snapshot.getSnapshot(), { litres: 1, celsius: 20 });

  const seen: Status[] = [];
  const subscription = snapshot.subscribe((value) => seen.push(value));
  assert.equal(context.kettle.statusListeners, 1);
  await session.invoke("kettle.boil", {});
  await session.invoke("kettle.warm.set", { drink: "coffee" });
  assert.deepEqual(seen, [
    { litres: 1, celsius: 100 },
    { litres: 1, celsius: 95, keepWarm: "coffee" },
  ]);

  const copy = snapshot.getSnapshot();
  copy.litres = 0;
  const received = seen.at(-1);
  assert.ok(received !== undefined);
  received.celsius = 0;
  assert.deepEqual(context.kettle.status, { litres: 1, celsius: 95, keepWarm: "coffee" });

  subscription.unsubscribe();
  assert.equal(context.kettle.statusListeners, 0);
  await session.invoke("kettle.warm.set", { drink: "green-tea" });
  assert.equal(seen.length, 2);

  assert.equal(session.handles.get("kettle.boil")?.snapshot, undefined);
  await session.dispose();
});

test("getHandle gives a handle with the types of its capability", async () => {
  const session = createSession(kettle, { target: "app", context: { kettle: new Kettle() }, toJsonSchema });

  const boiling = getHandle(session.handles, boil);
  const empty: Result<{ celsius: number }, { readonly _tag: "Empty" }> = await boiling.execute({});
  assert.deepEqual(empty, { ok: false, error: { _tag: "Empty" } });

  const filling = getHandle(session.handles, fill);
  const filled: Result<null, { readonly _tag: "Overflow"; readonly capacity: number }> = await filling.execute({ litres: 1 });
  assert.deepEqual(filled, { ok: true, value: null });

  const warming = getHandle(session.handles, warmSet);
  const warmed: Result<null, { readonly _tag: "Empty" }> = await warming.execute({ drink: "white-tea" });
  assert.deepEqual(warmed, { ok: true, value: null });

  const status = getHandle(session.handles, statusGet);
  const value: Result<Status, never> = await status.execute({});
  const snapshot: Status | undefined = status.snapshot?.getSnapshot();
  assert.deepEqual(value, { ok: true, value: snapshot });
  assert.equal(snapshot?.keepWarm, "white-tea");

  // These calls do not run. `moon run core-ts:typecheck` checks that each one is an error.
  const wrongCalls = (boiled: Result<{ celsius: number }, { readonly _tag: "Empty" }>) => [
    // @ts-expect-error The input of kettle.fill has `litres`, a number.
    filling.execute({ litres: "one" }),
    // @ts-expect-error The drink is one of the values of `Drink`.
    warming.execute({ drink: "lemonade" }),
    // @ts-expect-error The status has no `volume`.
    status.snapshot?.getSnapshot().volume,
    // @ts-expect-error The value of kettle.boil has only `celsius`.
    boiled.ok ? boiled.value.litres : undefined,
    // @ts-expect-error The only failure of kettle.boil is Empty.
    boiled.ok || boiled.error._tag === "Overflow",
  ];
  void wrongCalls;
  await session.dispose();
});

test("getHandle gives an always unavailable handle for a capability outside the view", async () => {
  const session = createSession(kettle, { target: "panel", context: { kettle: new Kettle() }, toJsonSchema });
  assert.deepEqual([...session.handles.keys()].sort(), ["kettle.boil", "kettle.status.get"]);
  assert.deepEqual(Object.keys(session.view.capabilities).sort(), ["kettle.boil", "kettle.status.get"]);

  const warming = getHandle(session.handles, warmSet);
  assert.equal(session.handles.has(warmSet.id), false);
  assert.equal(warming.id, "kettle.warm.set");
  assert.deepEqual(warming.availability.getSnapshot(), { available: false, reason: "There is no capability kettle.warm.set." });
  assert.equal(warming.snapshot, undefined);
  for (const call of [warming.execute({ drink: "coffee" }), warming.invokeExternal({ drink: "coffee" })]) {
    const error = await call.catch((caught: unknown) => caught);
    assert.ok(error instanceof CallFailureError);
    assert.equal(error.kind, "unknown-capability");
  }
  await session.dispose();
});

test("the command line resolves flags through named types, and changes the context", async () => {
  const context = { kettle: new Kettle() };
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const code = await runCli(kettle, { name: "kettle", version: "0.1.0", context, toJsonSchema }, args, {
      stdout: (text) => out.push(text),
      stderr: () => undefined,
    });
    const stdout: unknown = out.length === 0 ? undefined : JSON.parse(out.join("\n"));
    return { code, stdout };
  };

  assert.deepEqual(await run("kettle", "boil"), { code: 1, stdout: { _tag: "Empty" } });
  assert.equal((await run("kettle", "fill", "--litres", "5")).code, 3);
  assert.deepEqual(await run("kettle", "fill", "--litres", "1.5"), { code: 0, stdout: null });
  assert.equal((await run("kettle", "warm", "set", "--drink", "lemonade")).code, 3);
  assert.equal((await run("kettle", "warm", "set", "--drink", "baby-milk")).code, 0);
  assert.deepEqual(context.kettle.status, { litres: 1.5, celsius: 40, keepWarm: "baby-milk" });
  assert.deepEqual(await run("kettle", "status", "get"), { code: 0, stdout: { litres: 1.5, celsius: 40, keepWarm: "baby-milk" } });
  assert.equal((await run("kettle", "descale")).code, 2);
});
