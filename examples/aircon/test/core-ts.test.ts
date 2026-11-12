import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import type { z } from "zod";

import { aircon, fanSet, firmwareUpdate, modeSet, Offline, PoweredOff, powerSet, Status, statusChanged, statusGet, toJsonSchema, Unit } from "../core-ts/aircon.ts";
import { CallFailureError, catalogOf, createSession, renderCatalog, runCli } from "@acid-cat/core-ts";
import type { Result } from "@acid-cat/core-ts";
import { run } from "./run.ts";
import { shape, writtenText } from "./shape.ts";

test("the code writes a catalog that conforms and agrees with the Pkl catalog", () => {
  const text = renderCatalog(aircon, { toJsonSchema });
  assert.deepEqual(check(JSON.parse(text), text).errors, []);
  assert.deepEqual(shape(catalogOf(aircon, { toJsonSchema })), shape(JSON.parse(writtenText)));
});

test("aircon.status.changed gives the new status after each change, and nothing for a change to the same status", async () => {
  const unit = new Unit();
  await using session = createSession(aircon, { target: "app", context: { unit }, toJsonSchema });
  const before = unit.statusListeners;
  const occurrences = await session.eventHandle(statusChanged).subscribe({});
  await session.call(powerSet, { on: true });
  await session.call(powerSet, { on: true });
  await session.call(fanSet, { speed: "high" });
  const power = await occurrences.next();
  const fan = await occurrences.next();
  assert.equal(power.done, false);
  assert.equal(power.value?.name, "aircon.status.changed");
  assert.deepEqual(power.value?.data, { power: true, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 });
  assert.deepEqual(fan.value?.data, { power: true, mode: "cool", fan: "high", targetCelsius: 22, roomCelsius: 25 });
  await occurrences.return();
  assert.equal(unit.statusListeners, before, "the subscription stops listening when it ends");
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
  const { snapshot } = session.handle(statusGet);
  assert.ok(snapshot, "aircon.status.get has state");
  const off: z.infer<typeof Status> = { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 };
  assert.deepEqual(snapshot.getSnapshot(), off);
  const seen: z.infer<typeof Status>[] = [];
  snapshot.subscribe((value) => seen.push(value));
  await session.invoke("aircon.power.set", { on: true });
  assert.deepEqual(seen, [{ ...off, power: true }]);
  snapshot.getSnapshot().power = false;
  assert.equal(unit.state.power, true);
  assert.equal(session.handle(powerSet).snapshot, undefined);
  await session.dispose();
});

test("session.handle gives a handle with the types of its capability", async () => {
  const session = createSession(aircon, { target: "app", context: { unit: new Unit() }, toJsonSchema });
  const power = session.handle(powerSet);
  const powered: Result<null, z.infer<typeof Offline>> = await power.execute({ on: true });
  assert.deepEqual(powered, { ok: true, value: null });

  const mode = session.handle(modeSet);
  const moded: Result<null, z.infer<typeof Offline> | z.infer<typeof PoweredOff>> = await mode.execute({ mode: "heat" });
  assert.deepEqual(moded, { ok: true, value: null });

  const status = session.handle(statusGet);
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

test("session.handle gives an always unavailable handle for a capability outside the view", async () => {
  const session = createSession(aircon, { target: "taskbar", context: { unit: new Unit() }, toJsonSchema });
  const firmware = session.handle(firmwareUpdate);
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

test("the command line runs a capability, and a flag follows a $ref to its type", async () => {
  const cli = (...args: string[]) => run(new URL("../core-ts/cli.ts", import.meta.url).pathname, ...args);
  const [status, poweredOff, unknownMode] = await Promise.all([cli("aircon", "status", "get"), cli("aircon", "mode", "set", "--mode", "heat"), cli("aircon", "mode", "set", "--mode", "boil")]);
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout), { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 });
  assert.equal(poweredOff.code, 1);
  assert.deepEqual(JSON.parse(poweredOff.stdout), { _tag: "PoweredOff" });
  assert.equal(unknownMode.code, 3);
});

test("an array input takes one repeated flag for each item, or JSON text of the array", async () => {
  const cli = (...args: string[]) => run(new URL("../core-ts/cli.ts", import.meta.url).pathname, ...args);
  const [schedule, once, jsonText, notADay, notAnHour, list] = await Promise.all([
    cli("aircon", "schedule", "set", "--days", "mon", "--days", "fri", "--hours", "7", "--hours=18"),
    cli("aircon", "schedule", "set", "--days", "sat"),
    cli("aircon", "schedule", "set", "--days", '["tue","thu"]', "--hours", "[6]"),
    cli("aircon", "schedule", "set", "--days", '["noon"]'),
    cli("aircon", "schedule", "set", "--days", "mon", "--hours", "24"),
    cli("list"),
  ]);
  assert.equal(schedule.code, 0);
  assert.deepEqual(JSON.parse(schedule.stdout), { days: ["mon", "fri"], hours: [7, 18] });
  assert.deepEqual(JSON.parse(once.stdout), { days: ["sat"], hours: [7] });
  assert.deepEqual(JSON.parse(jsonText.stdout), { days: ["tue", "thu"], hours: [6] });
  assert.equal(notADay.code, 3);
  assert.equal(notAnHour.code, 3);
  assert.match(list.stdout, /"usage": "aircon aircon schedule set --days <mon\|tue\|wed\|thu\|fri\|sat\|sun>\.\.\. \[--hours <integer>\.\.\.\]"/);
});
