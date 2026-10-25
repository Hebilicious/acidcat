import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import type { z } from "zod";

import { aircon, firmwareUpdate, modeSet, Offline, PoweredOff, powerSet, Status, statusGet, toJsonSchema, Unit } from "../core-ts/aircon.ts";
import { CallFailureError, catalogOf, createSession, getHandle, renderCatalog, runCli } from "@acid-cat/core-ts";
import type { Result } from "@acid-cat/core-ts";
import { shape, writtenText } from "./shape.ts";

test("the code writes a catalog that conforms and agrees with the Pkl catalog", () => {
  const text = renderCatalog(aircon, { toJsonSchema });
  assert.deepEqual(check(JSON.parse(text), text).errors, []);
  assert.deepEqual(shape(catalogOf(aircon, { toJsonSchema })), shape(JSON.parse(writtenText)));
});

test("the unit works through a session and the command line", async () => {
  const unit = new Unit();
  const session = createSession(aircon, { target: "mcp", context: { unit }, toJsonSchema });
  assert.deepEqual(await session.invoke("aircon.mode.set", { mode: "heat" }), { ok: false, error: { _tag: "PoweredOff" } });
  assert.deepEqual(await session.invoke("aircon.power.set", { on: true }), { ok: true, value: null });
  const invalid = await session.invoke("aircon.temperature.set", { celsius: 40 });
  assert.ok("kind" in invalid, "a temperature outside 16 to 31 is a call failure");
  assert.equal(invalid.kind, "invalid-input");
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
  const { snapshot } = getHandle(session.handles, statusGet);
  assert.ok(snapshot, "aircon.status.get has state");
  const off: z.infer<typeof Status> = { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 };
  assert.deepEqual(snapshot.getSnapshot(), off);
  const seen: z.infer<typeof Status>[] = [];
  snapshot.subscribe((value) => seen.push(value));
  await session.invoke("aircon.power.set", { on: true });
  assert.deepEqual(seen, [{ ...off, power: true }]);
  snapshot.getSnapshot().power = false;
  assert.equal(unit.state.power, true);
  assert.equal(getHandle(session.handles, powerSet).snapshot, undefined);
  await session.dispose();
});

test("getHandle gives a handle with the types of its capability", async () => {
  const session = createSession(aircon, { target: "app", context: { unit: new Unit() }, toJsonSchema });
  const power = getHandle(session.handles, powerSet);
  const powered: Result<null, z.infer<typeof Offline>> = await power.execute({ on: true });
  assert.deepEqual(powered, { ok: true, value: null });

  const mode = getHandle(session.handles, modeSet);
  const moded: Result<null, z.infer<typeof Offline> | z.infer<typeof PoweredOff>> = await mode.execute({ mode: "heat" });
  assert.deepEqual(moded, { ok: true, value: null });

  const status = getHandle(session.handles, statusGet);
  const value: Result<z.infer<typeof Status>, z.infer<typeof Offline>> = await status.execute({});
  const snapshot: z.infer<typeof Status> | undefined = status.snapshot?.getSnapshot();
  assert.deepEqual(value, { ok: true, value: snapshot });

  // These calls do not run. `moon run core-ts:typecheck` checks that each one is an error.
  const wrongCalls = () => {
    // @ts-expect-error The input of aircon.power.set has `on`, a boolean.
    void power.execute({ on: "yes" });
    // @ts-expect-error The mode is one of the values of `Mode`.
    void mode.execute({ mode: "boil" });
    // @ts-expect-error The status has no `humidity`.
    void status.snapshot?.getSnapshot().humidity;
  };
  void wrongCalls;
  await session.dispose();
});

test("getHandle gives an always unavailable handle for a capability outside the view", async () => {
  const session = createSession(aircon, { target: "taskbar", context: { unit: new Unit() }, toJsonSchema });
  const firmware = getHandle(session.handles, firmwareUpdate);
  assert.equal(session.handles.has(firmwareUpdate.id), false);
  assert.equal(firmware.id, "aircon.firmware.update");
  assert.deepEqual(firmware.availability.getSnapshot(), { available: false, reason: "There is no capability aircon.firmware.update." });
  assert.equal(firmware.snapshot, undefined);
  for (const call of [firmware.execute({}), firmware.invokeExternal({})]) {
    const error = await call.catch((caught: unknown) => caught);
    assert.ok(error instanceof CallFailureError);
    assert.equal(error.kind, "unknown-capability");
  }
  await session.dispose();
});

test("the command line runs a capability, and a flag follows a $ref to its type", () => {
  const cli = new URL("../core-ts/cli.ts", import.meta.url).pathname;
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf-8", timeout: 20_000 });
  const status = run("aircon", "status", "get");
  assert.equal(status.status, 0);
  assert.deepEqual(JSON.parse(status.stdout), { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 });
  const poweredOff = run("aircon", "mode", "set", "--mode", "heat");
  assert.equal(poweredOff.status, 1);
  assert.deepEqual(JSON.parse(poweredOff.stdout), { _tag: "PoweredOff" });
  assert.equal(run("aircon", "mode", "set", "--mode", "boil").status, 3);
});
