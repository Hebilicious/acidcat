import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import type { z } from "zod";

import { aircon, fanSet, firmwareUpdate, modeSet, Offline, PoweredOff, powerSet, Status, output, statusChanged, statusGet, toJsonSchema, Unit } from "../core-ts/aircon.ts";
import { CallFailureError, catalogOf, createSession, renderCatalog, runCli } from "@acid-cat/core-ts";
import type { Result } from "@acid-cat/core-ts";
import { OFFLINE, OUTPUT_ERROR, OUTPUT_FLAG_LINES, POWERED_OFF_LAYOUT, SCHEDULE_LAYOUT, STATUS_OFF, STATUS_ON } from "./human.ts";
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

test("the aliases of the command line call their capabilities with their fixed input", async () => {
  const unit = new Unit();
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const code = await runCli(aircon, { name: "aircon", version: "0.1.0", context: { unit }, toJsonSchema }, args, { stdout: (text) => out.push(text), stderr: () => undefined });
    return { code, stdout: out.join("\n") };
  };
  assert.equal((await cli("--on")).code, 0);
  assert.equal(unit.state.power, true);
  assert.partialDeepStrictEqual(JSON.parse((await cli("status")).stdout), { power: true });
  assert.partialDeepStrictEqual(JSON.parse((await cli("--", "status")).stdout), { power: true }, "a first -- is not an argument");
  assert.equal((await cli("--off")).code, 0);
  assert.equal(unit.state.power, false);
  assert.equal((await cli("--on", "--on", "false")).code, 3);
  assert.partialDeepStrictEqual(JSON.parse((await cli()).stdout), { power: false }, "the default alias is status");
  const list: unknown = JSON.parse((await cli("list")).stdout);
  assert.ok(Array.isArray(list));
  assert.partialDeepStrictEqual(list.find((item: unknown) => typeof item === "object" && item !== null && "id" in item && item.id === "aircon.power.set"), {
    aliases: ["aircon --off", "aircon --on"],
  });
});

test("the alias follow of the command line writes each change of the status", async () => {
  const unit = new Unit();
  const interrupt = new AbortController();
  const lines: string[] = [];
  const followed = runCli(aircon, { name: "aircon", version: "0.1.0", context: { unit }, toJsonSchema }, ["follow"], {
    stdout: (text) => {
      lines.push(text);
      interrupt.abort();
    },
    stderr: () => undefined,
    signal: interrupt.signal,
  });
  const session = createSession(aircon, { target: "cli", context: { unit }, toJsonSchema });
  // The subscription can start after the first change, so change the status until an occurrence comes.
  for (let on = true; lines.length === 0; on = !on) {
    await session.invoke("aircon.power.set", { on });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await followed, 130);
  await session.dispose();
  const [first = ""] = lines;
  assert.partialDeepStrictEqual(JSON.parse(first), { name: "aircon.status.changed" });
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

test("the command line writes the human form with its output flags", async () => {
  const cli = (...args: string[]) => run(new URL("../core-ts/cli.ts", import.meta.url).pathname, ...args);
  const [status, short, inline, defaultAlias, poweredOff, schedule, list, unknown, json, plain, xml] = await Promise.all([
    cli("status", "--output", "human"),
    cli("-o", "human", "status"),
    cli("--output=human", "status"),
    cli("-o", "human"),
    cli("aircon", "mode", "set", "--output", "human", "--mode", "heat"),
    cli("aircon", "schedule", "set", "--days", "mon", "--days", "fri", "--hours", "7", "--hours", "18", "--output=human"),
    cli("list", "-o", "human"),
    cli("call", "nope", "--output", "human"),
    cli("--output", "json", "aircon", "status", "get"),
    cli("aircon", "status", "get"),
    cli("status", "--output", "xml"),
  ]);
  for (const human of [status, short, inline, defaultAlias]) assert.deepEqual([human.code, human.stdout], [0, `${STATUS_OFF}\n`]);
  assert.ok((await cli("--help")).stdout.endsWith(`\n\nOutput:\n${OUTPUT_FLAG_LINES}\n`));
  assert.deepEqual([poweredOff.code, poweredOff.stdout], [1, `${POWERED_OFF_LAYOUT}\n`]);
  assert.deepEqual([schedule.code, schedule.stdout], [0, `${SCHEDULE_LAYOUT}\n`]);
  assert.equal(list.code, 0);
  assert.ok(list.stdout.startsWith("Capabilities\n  aircon status get "));
  assert.ok(list.stdout.includes("\nEvents\n  watch aircon.status.changed"));
  assert.equal(unknown.code, 2);
  assert.ok(unknown.stderr.startsWith("error (unknown-capability): "));
  assert.deepEqual([json.code, json.stdout], [0, plain.stdout]);
  assert.deepEqual([xml.code, xml.stdout, xml.stderr], [3, "", `${OUTPUT_ERROR}\n`]);

  const onTerminal = async (unit: Unit, ...args: string[]) => {
    const out: string[] = [];
    const code = await runCli(aircon, { name: "aircon", version: "0.1.0", context: { unit }, toJsonSchema, output }, args, {
      stdout: (text) => out.push(text),
      stderr: () => undefined,
      output: "human",
    });
    return { code, stdout: out.join("\n") };
  };
  assert.deepEqual(await onTerminal(new Unit(), "status"), { code: 0, stdout: STATUS_OFF });
  assert.deepEqual(await onTerminal(new Unit(), "status", "--json"), { code: 0, stdout: plain.stdout.trimEnd() });
  assert.deepEqual(await onTerminal(new Unit(), "--json"), { code: 0, stdout: plain.stdout.trimEnd() }, "the default alias with an output flag");
  const offline = new Unit();
  offline.change({ online: false });
  assert.deepEqual(await onTerminal(offline, "aircon", "status", "get"), { code: 1, stdout: OFFLINE });
});

function finish(child: ChildProcessByStdio<null, Readable, Readable>): Promise<{ readonly code: number | null; readonly stdout: string }> {
  let stdout = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

test("the TypeScript command line controls the unit of a server, and watch follows its changes", async (context) => {
  const server = spawn(process.execPath, [new URL("../core-ts/serve.ts", import.meta.url).pathname], { stdio: ["ignore", "pipe", "inherit"] });
  context.after(() => server.kill());
  const url = await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    let text = "";
    server.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")).trim());
    });
  });
  const cliPath = new URL("../core-ts/cli.ts", import.meta.url).pathname;
  const remote = (...args: string[]) => spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, AIRCON_URL: url }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });

  assert.equal((await finish(remote("aircon", "power", "set", "--on"))).code, 0);
  const status = await finish(remote("aircon", "status", "get"));
  assert.equal(status.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), { power: true });
  assert.partialDeepStrictEqual(JSON.parse((await run(cliPath, "aircon", "status", "get")).stdout), { power: false });
  assert.equal((await finish(remote("--output", "human", "aircon", "status", "get"))).stdout, `${STATUS_ON}\n`);

  const watch = remote("watch", "aircon.status.changed");
  context.after(() => watch.kill());
  let watched = "";
  watch.stdout.setEncoding("utf-8").on("data", (chunk: string) => (watched += chunk));
  const humanWatch = remote("--output", "human", "watch", "aircon.status.changed");
  context.after(() => humanWatch.kill());
  let humanWatched = "";
  humanWatch.stdout.setEncoding("utf-8").on("data", (chunk: string) => (humanWatched += chunk));
  for (let turn = 0; !watched.includes("\n") || !humanWatched.includes("\n"); turn++) {
    assert.ok(turn < 100, "watch writes an occurrence");
    assert.equal((await finish(remote("aircon", "fan", "set", "--speed", turn % 2 === 0 ? "low" : "high"))).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const line = watched.slice(0, watched.indexOf("\n"));
  assert.partialDeepStrictEqual(JSON.parse(line), { name: "aircon.status.changed", data: { power: true } });
  assert.match(line, /"fan":"(low|high)"/);
  assert.match(humanWatched.slice(0, humanWatched.indexOf("\n")), /^on · cool · fan (low|high) · target 22°C · room 25°C$/);
  const exited = new Promise<number | null>((resolve) => watch.on("close", resolve));
  watch.kill("SIGINT");
  assert.equal(await exited, 130);
});

test("aircon.status.export writes a file through the command line", async (context) => {
  const folder = await mkdtemp(join(tmpdir(), "aircon-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "status.json");
  assert.equal((await run(new URL("../core-ts/cli.ts", import.meta.url).pathname, "aircon", "status", "export", "--path", file)).code, 0);
  assert.partialDeepStrictEqual(JSON.parse(await readFile(file, "utf-8")), { power: false });
});
