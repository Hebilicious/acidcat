import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import type { CatalogDocument } from "@acid-cat/spec-ts";

import { aircon, toJsonSchema, Unit } from "../examples/aircon.ts";
import { catalogOf, createSession, renderCatalog, runCli } from "../src/index.ts";

const written = JSON.parse(readFileSync(new URL("../../../examples/aircon.acidcat.json", import.meta.url), "utf-8")) as CatalogDocument;

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
  const text = renderCatalog(aircon, { toJsonSchema });
  assert.deepEqual(check(JSON.parse(text), text).errors, []);
  assert.deepEqual(shape(catalogOf(aircon, { toJsonSchema })), shape(written));
});

test("the unit works through a session and the command line", async () => {
  const unit = new Unit();
  const session = createSession(aircon, { target: "mcp", context: { unit }, toJsonSchema });
  assert.deepEqual(await session.invoke("aircon.mode.set", { mode: "heat" }), { ok: false, error: { _tag: "PoweredOff" } });
  assert.deepEqual(await session.invoke("aircon.power.set", { on: true }), { ok: true, value: null });
  assert.equal(((await session.invoke("aircon.temperature.set", { celsius: 40 })) as { kind: string }).kind, "invalid-input");
  await session.dispose();

  const out: string[] = [];
  const code = await runCli(aircon, { name: "aircon", version: "0.1.0", context: { unit }, toJsonSchema }, ["aircon", "mode", "set", "--mode", "heat"], {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
  });
  assert.equal(code, 0);
  assert.equal(unit.state.mode, "heat");
});

test("a handle gives the state as copies, and each change", async () => {
  const unit = new Unit();
  const session = createSession(aircon, { target: "app", context: { unit }, toJsonSchema });
  const snapshot = session.handles.get("aircon.status.get")!.snapshot!;
  assert.equal((snapshot.getSnapshot() as { power: boolean }).power, false);
  const seen: unknown[] = [];
  snapshot.subscribe((value) => seen.push(value));
  await session.invoke("aircon.power.set", { on: true });
  assert.equal((seen.at(-1) as { power: boolean }).power, true);
  (snapshot.getSnapshot() as { power: boolean }).power = false;
  assert.equal(unit.state.power, true);
  assert.equal(session.handles.get("aircon.power.set")!.snapshot, undefined);
  await session.dispose();
});
