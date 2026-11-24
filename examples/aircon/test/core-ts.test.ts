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

import { aircon, fanSet, powerSet, Status, output, statusChanged, statusGet, toJsonSchema, Unit } from "../core-ts/aircon.ts";
import { catalogOf, createSession, renderCatalog, runCli } from "@acid-cat/core-ts";
import { OFFLINE, SCHEDULE_LAYOUT, STATUS_OFF, STATUS_ON } from "./human.ts";
import { bundledProgram } from "./bundled-program.ts";
import { run, tracked } from "./run.ts";
import { firstLine, startServer, subscriptionProxy } from "./server.ts";
import { assertHelp } from "./help.ts";
import { shape, writtenText } from "./shape.ts";

const OFF: z.infer<typeof Status> = { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 };

test("the code writes a catalog that conforms and agrees with the Pkl catalog", () => {
  const text = renderCatalog(aircon, { toJsonSchema });
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
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

test("the unit works through a session, and a handle gives the state as copies, and each change", async () => {
  const unit = new Unit();
  await using session = createSession(aircon, { target: "mcp", context: { unit }, toJsonSchema });
  const { snapshot } = session.handle(statusGet);
  assert.ok(snapshot, "aircon.status.get has state");
  assert.deepEqual(snapshot.getSnapshot(), OFF);
  const seen: z.infer<typeof Status>[] = [];
  snapshot.subscribe((value) => seen.push(value));
  assert.deepEqual(await session.invoke("aircon.mode.set", { mode: "heat" }), { ok: false, error: { _tag: "PoweredOff" } });
  assert.deepEqual(await session.invoke("aircon.power.set", { on: true }), { ok: true, value: null });
  assert.deepEqual(seen, [{ ...OFF, power: true }]);
  snapshot.getSnapshot().power = false;
  assert.equal(unit.state.power, true);
  assert.equal(session.handle(powerSet).snapshot, undefined);
  const invalid = await session.invoke("aircon.temperature.set", { celsius: 40 });
  assert.ok("kind" in invalid, "a temperature outside 16 to 31 is a call failure");
  assert.equal(invalid.kind, "invalid-input");
  assert.deepEqual(await session.invoke("aircon.schedule.set", { days: ["sat"] }), { ok: true, value: { days: ["sat"], hours: [7] } }, "the default hour is 7");
  for (const input of [{ days: ["noon"] }, { days: ["mon"], hours: [24] }]) {
    const outside = await session.invoke("aircon.schedule.set", input);
    assert.equal("kind" in outside && outside.kind, "invalid-input", JSON.stringify(input));
  }
});

async function cli(unit: Unit, ...args: string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const out: string[] = [];
  const code = await runCli(aircon, { name: "aircon", version: "0.1.0", context: { unit }, toJsonSchema }, args, { stdout: (text) => out.push(text), stderr: () => undefined });
  return { code, stdout: out.join("\n") };
}

test("each alias of the command line calls its capability with its fixed input", async () => {
  const unit = new Unit();
  assert.equal((await cli(unit, "--on")).code, 0);
  assert.equal(unit.state.power, true);
  assert.partialDeepStrictEqual(JSON.parse((await cli(unit, "status")).stdout), { power: true });
  assert.equal((await cli(unit, "--off")).code, 0);
  assert.equal(unit.state.power, false);
  assert.partialDeepStrictEqual(JSON.parse((await cli(unit)).stdout), { power: false }, "the default alias is status");
  assert.equal((await cli(unit, "fan", "high")).code, 0);
  assert.equal(unit.state.fan, "high");
  assert.equal((await cli(unit, "fan", "auto")).code, 0);
  assert.equal(unit.state.fan, "auto");
  assert.equal((await cli(unit, "fan", "--speed", "low")).code, 0);
  assert.equal(unit.state.fan, "low");
  assert.equal((await cli(unit, "aircon", "power", "--on")).code, 0);
  assert.equal(unit.state.power, true);
});

test("the alias follow of the command line writes each change of the status", async () => {
  const unit = new Unit();
  const before = unit.statusListeners;
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
  while (unit.statusListeners === before) await new Promise(setImmediate);
  await using session = createSession(aircon, { target: "cli", context: { unit }, toJsonSchema });
  await session.invoke("aircon.power.set", { on: true });
  assert.equal(await followed, 130);
  const [first = ""] = lines;
  assert.partialDeepStrictEqual(JSON.parse(first), { name: "aircon.status.changed" });
});

const program = bundledProgram("core-ts/cli.ts");

test("the command line runs a capability, writes JSON on one line when standard output is not a terminal, and a flag follows a $ref to its type", async () => {
  const [status, poweredOff] = await Promise.all([run(program, "aircon", "status", "get"), run(program, "aircon", "mode", "set", "--mode", "heat")]);
  assert.equal(status.code, 0);
  assert.equal(status.stdout, `${JSON.stringify(OFF)}\n`);
  assert.equal(poweredOff.code, 1);
  assert.equal(poweredOff.stdout, `${JSON.stringify({ _tag: "PoweredOff" })}\n`);
});

test("the command line writes the human form with its output flags, and on a terminal by default", async () => {
  const [status, schedule, list, unknown] = await Promise.all([
    run(program, "status", "--output", "human"),
    run(program, "aircon", "schedule", "set", "--days", "mon", "--days", "fri", "--hours", "7", "--hours", "18", "--output=human"),
    run(program, "list", "-o", "human"),
    run(program, "call", "nope", "-o", "human"),
  ]);
  assert.deepEqual([status.code, status.stdout], [0, `${STATUS_OFF}\n`]);
  assert.deepEqual([schedule.code, schedule.stdout], [0, `${SCHEDULE_LAYOUT}\n`]);
  assert.equal(list.code, 0);
  assert.ok(list.stdout.startsWith("Capabilities\n  aircon status get "));
  assert.ok(list.stdout.includes("\nEvents\n  watch aircon.status.changed"));
  assert.equal(unknown.code, 2);
  assert.ok(unknown.stderr.startsWith("error (unknown-capability): "));

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
  const json = await onTerminal(new Unit(), "status", "--json");
  assert.deepEqual([json.code, JSON.parse(json.stdout)], [0, OFF]);
  assert.deepEqual(await onTerminal(new Unit(), "--json"), json, "the default alias with an output flag");
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
  const url = await startServer(context, process.execPath, [bundledProgram("core-ts/serve.ts")]);
  const client = (target: string) => (...args: string[]) => tracked(spawn(process.execPath, [program, ...args], { env: { ...process.env, AIRCON_URL: target }, stdio: ["ignore", "pipe", "pipe"] }));
  const remote = client(url);

  assert.equal((await finish(remote("aircon", "power", "set", "--on"))).code, 0);
  const status = await finish(remote("aircon", "status", "get"));
  assert.equal(status.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), { power: true });
  assert.partialDeepStrictEqual(JSON.parse((await run(program, "aircon", "status", "get")).stdout), { power: false });
  assert.equal((await finish(remote("--output", "human", "aircon", "status", "get"))).stdout, `${STATUS_ON}\n`);

  const proxy = await subscriptionProxy(context, url);
  const watcher = client(proxy.url);
  const watch = watcher("watch", "aircon.status.changed");
  const lines = Promise.all([firstLine(watch, context), firstLine(watcher("--output", "human", "watch", "aircon.status.changed"), context)]);
  await proxy.started(2);
  assert.equal((await finish(remote("aircon", "fan", "set", "--speed", "high"))).code, 0);
  const [line, human] = await lines;
  assert.partialDeepStrictEqual(JSON.parse(line), { name: "aircon.status.changed", data: { power: true, fan: "high" } });
  assert.equal(human, "on · cool · fan high · target 22°C · room 25°C");
  const exited = new Promise<number | null>((resolve) => watch.on("close", resolve));
  watch.kill("SIGINT");
  assert.equal(await exited, 130);
});

test("aircon.status.export writes a file through the command line", async (context) => {
  const folder = await mkdtemp(join(tmpdir(), "aircon-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "status.json");
  assert.equal((await run(program, "aircon", "status", "export", "--path", file)).code, 0);
  assert.partialDeepStrictEqual(JSON.parse(await readFile(file, "utf-8")), { power: false });
});

test("the command line writes the command list of a shared prefix", async () => {
  await assertHelp((...args) => run(program, ...args));
});
