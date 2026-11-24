import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { z } from "zod";

import { CallFailureError, catalogOf, createSession, defineApp, defineCapability, ok, renderCatalog, runCli } from "../src/index.ts";
import type { Result } from "../src/index.ts";
import { boil, fill, Kettle, kettle, statusGet, toJsonSchema, warmSet } from "./kettle.ts";
import type { Status } from "./kettle.ts";

function filledKettle(litres = 1): Kettle {
  const filled = new Kettle();
  filled.change({ litres });
  return filled;
}

test("the catalog has the targets, the audiences and the members of each capability", () => {
  const catalog = catalogOf(kettle, { toJsonSchema });
  assert.deepEqual(Object.keys(catalog.targets), ["app", "panel", "cli", "mcp"]);
  assert.deepEqual(catalog.targets.panel, { surfaces: ["typescript"], description: "The buttons and the display on the base of the kettle." });
  assert.deepEqual(catalog.targets.cli, { surfaces: ["cli"] });

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

test("the kettle writes a catalog that conforms, where a named schema is a type in $defs and each use of it is a reference", () => {
  const text = renderCatalog(kettle, { toJsonSchema });
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
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
    targets: { mcp: { surfaces: ["mcp"] } },
    capabilities: [
      defineCapability({ id: "probe.first", description: "Use the first choice.", audience: ["mcp"], input: z.object({ choice: First }), run: () => ok(null) }),
      defineCapability({ id: "probe.second", description: "Use the second choice.", audience: ["mcp"], input: z.object({ choice: Second }), run: () => ok(null) }),
    ],
  });
  assert.throws(() => catalogOf(app, { toJsonSchema }), /probe\.second: two different schemas have the name Choice/);
});

test("a handle gives the state as copies, and each change", async () => {
  const context = { kettle: filledKettle() };
  const session = createSession(kettle, { target: "app", context, toJsonSchema });
  const snapshot = session.handle(statusGet).snapshot;
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

test("session.handle gives a handle with the types of its capability", async () => {
  const session = createSession(kettle, { target: "app", context: { kettle: new Kettle() }, toJsonSchema });

  const boiling = session.handle(boil);
  const empty: Result<{ celsius: number }, { readonly _tag: "Empty" }> = await boiling.execute({});
  assert.deepEqual(empty, { ok: false, error: { _tag: "Empty" } });

  const filling = session.handle(fill);
  const filled: Result<null, { readonly _tag: "Overflow"; readonly capacity: number }> = await filling.execute({ litres: 1 });
  assert.deepEqual(filled, { ok: true, value: null });

  const warming = session.handle(warmSet);
  const warmed: Result<null, { readonly _tag: "Empty" }> = await warming.execute({ drink: "white-tea" });
  assert.deepEqual(warmed, { ok: true, value: null });

  const status = session.handle(statusGet);
  const value: Result<Status, never> = await status.execute({});
  const snapshot: Status | undefined = status.snapshot?.getSnapshot();
  assert.deepEqual(value, { ok: true, value: snapshot });
  assert.equal(snapshot?.keepWarm, "white-tea");

  const wrongCalls = (boiled: Result<{ celsius: number }, { readonly _tag: "Empty" }>) => {
    void [
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
  };
  void wrongCalls;
  await session.dispose();
});

test("session.handle gives an always unavailable handle for a capability outside the target", async () => {
  const session = createSession(kettle, { target: "panel", context: { kettle: new Kettle() }, toJsonSchema });
  assert.deepEqual([...session.handles.keys()].sort(), ["kettle.boil", "kettle.status.get"]);
  assert.deepEqual(Object.keys(session.catalog.capabilities).sort(), ["kettle.boil", "kettle.status.get"]);

  const warming = session.handle(warmSet);
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

test("session.handle serves only the capability object of the application, and a capability with no input gets an empty object", async () => {
  const seen: unknown[] = [];
  const probe = defineCapability({
    id: "probe.empty",
    description: "Record the input.",
    audience: ["app"],
    run: (input) => {
      seen.push(input);
      return ok(null);
    },
  });
  const app = defineApp({ targets: { app: { surfaces: ["typescript"] } }, capabilities: [probe] });
  const session = createSession(app, { target: "app", context: undefined, toJsonSchema });

  assert.deepEqual(await session.handle(probe).execute({}), { ok: true, value: null });
  assert.deepEqual(await session.invoke("probe.empty", { extra: 1 }), { ok: true, value: null });
  assert.deepEqual(seen, [{}, {}]);

  const copy = defineCapability({ id: "probe.empty", description: "Another capability with the same id.", audience: ["app"], run: () => ok(null) });
  const other = session.handle(copy);
  assert.equal(other.availability.getSnapshot().available, false);
  const error = await other.execute({}).catch((caught: unknown) => caught);
  assert.ok(error instanceof CallFailureError);
  assert.equal(error.kind, "unknown-capability");
  await session.dispose();
});

test("session.call checks an input that is not trusted with the schema of the capability, and gives a typed result", async () => {
  const session = createSession(kettle, { target: "app", context: { kettle: filledKettle(1) }, toJsonSchema });

  const filled: Result<null, { readonly _tag: "Overflow"; capacity: number }> = await session.call(fill, { litres: 0.5 });
  assert.deepEqual(filled, { ok: true, value: null });
  assert.deepEqual(await session.call(fill, { litres: 0.5 }), { ok: false, error: { _tag: "Overflow", capacity: 1.7 } });
  const status: Result<Status, never> = await session.call(statusGet, { ignored: true });
  assert.equal(status.ok, true);

  for (const input of [{ litres: "a lot" }, { litres: 99 }, "two litres"]) {
    const error = await session.call(fill, input).catch((caught: unknown) => caught);
    assert.ok(error instanceof CallFailureError);
    assert.equal(error.kind, "invalid-input");
  }

  const copy = defineCapability({ id: "kettle.boil", description: "Another capability with the same id.", audience: ["app"], run: () => ok(null) });
  const outside = await session.call(copy, {}).catch((caught: unknown) => caught);
  assert.ok(outside instanceof CallFailureError);
  assert.equal(outside.kind, "unknown-capability");
  await session.dispose();
});

test("await using closes the session at the end of its block", async () => {
  let signal: AbortSignal | undefined;
  {
    await using session = createSession(kettle, { target: "app", context: { kettle: new Kettle() }, toJsonSchema });
    signal = session.signal;
    assert.equal(signal.aborted, false);
  }
  assert.equal(signal.aborted, true);
});

test("the command line resolves a flag through a named type", async () => {
  const context = { kettle: filledKettle() };
  const code = await runCli(kettle, { name: "kettle", version: "0.1.0", context, toJsonSchema }, ["kettle", "warm", "set", "--drink", "baby-milk"], { stdout: () => undefined, stderr: () => undefined });
  assert.equal(code, 0);
  assert.equal(context.kettle.status.keepWarm, "baby-milk");
});

test("the functions of a session work when code takes them off the session", async () => {
  const { call, dispose, handle, invoke, onChange, signal } = createSession(kettle, { target: "app", context: { kettle: new Kettle() }, toJsonSchema });
  assert.deepEqual(await call(fill, { litres: 1 }), { ok: true, value: null });
  assert.deepEqual(await invoke("kettle.boil", {}), { ok: true, value: { celsius: 100 } });
  assert.equal(handle(statusGet).id, "kettle.status.get");
  onChange(() => undefined).unsubscribe();
  await dispose();
  assert.equal(signal.aborted, true);
});
