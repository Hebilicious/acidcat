import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";

import { check } from "@acid-cat/cli";

import { SCHEDULE_LAYOUT, STATUS_OFF, STATUS_ON } from "./human.ts";
import { assertHelp } from "./help.ts";
import type { Run } from "./run.ts";
import { firstLine, startServer, subscriptionProxy } from "./server.ts";
import { shape, writtenText } from "./shape.ts";

const aircon = new URL("target/debug/aircon", new URL("../core-rust/", import.meta.url)).pathname;

function run(...args: string[]): Promise<Run> {
  return finish(spawn(aircon, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }));
}

function finish(child: ChildProcessByStdio<null, Readable, Readable>): Promise<Run> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const cli = (...args: string[]) => run("cli", ...args);

test("the Rust code writes a catalog that conforms and agrees with the Pkl catalog", async () => {
  const { stdout: text } = await run("catalog");
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
  assert.deepEqual(shape(JSON.parse(text)), shape(JSON.parse(writtenText)));
});

test("the Rust command line runs a capability, and a flag follows a $ref to its type", async () => {
  const [status, poweredOff] = await Promise.all([cli("aircon", "status", "get"), cli("aircon", "mode", "set", "--mode", "heat")]);
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout), { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 });
  assert.equal(poweredOff.code, 1);
  assert.deepEqual(JSON.parse(poweredOff.stdout), { _tag: "PoweredOff" });
});

test("the Rust command line writes the human form with its output flags", async () => {
  const [status, schedule, list, unknown] = await Promise.all([
    cli("status", "--output", "human"),
    cli("aircon", "schedule", "set", "--days", "mon", "--days", "fri", "--hours", "7", "--hours", "18", "--output=human"),
    cli("list", "-o", "human"),
    cli("call", "nope", "-o", "human"),
  ]);
  assert.deepEqual([status.code, status.stdout], [0, `${STATUS_OFF}\n`]);
  assert.deepEqual([schedule.code, schedule.stdout], [0, `${SCHEDULE_LAYOUT}\n`]);
  assert.equal(list.code, 0);
  assert.ok(list.stdout.startsWith("Capabilities\n  aircon status get "), list.stdout);
  assert.ok(list.stdout.includes("\nEvents\n  watch aircon.status.changed"), list.stdout);
  assert.equal(unknown.code, 2);
  assert.ok(unknown.stderr.startsWith("error (unknown-capability): "), unknown.stderr);
});

test("the Rust command line controls the unit of a server, and watch and follow write its changes", async (context) => {
  const url = await startServer(context, aircon, ["serve"]);
  const client = (target: string) => (...args: string[]) => spawn(aircon, ["cli", ...args], { env: { ...process.env, AIRCON_URL: target }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  const remote = client(url);

  assert.equal((await finish(remote("aircon", "power", "set", "--on"))).code, 0);
  const status = await finish(remote("aircon", "status", "get"));
  assert.equal(status.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), { power: true });
  assert.partialDeepStrictEqual(JSON.parse((await cli("aircon", "status", "get")).stdout), { power: false });
  assert.equal((await finish(remote("--output", "human", "aircon", "status", "get"))).stdout, `${STATUS_ON}\n`);

  const proxy = await subscriptionProxy(context, url);
  const watcher = client(proxy.url);
  const watch = watcher("watch", "aircon.status.changed");
  const lines = Promise.all([firstLine(watch, context), firstLine(watcher("--output", "human", "watch", "aircon.status.changed"), context), firstLine(watcher("follow"), context)]);
  await proxy.started(3);
  assert.equal((await finish(remote("aircon", "fan", "set", "--speed", "high"))).code, 0);
  const [line, human, followed] = await lines;
  assert.partialDeepStrictEqual(JSON.parse(line), { name: "aircon.status.changed", data: { power: true, fan: "high" } });
  assert.equal(human, "on · cool · fan high · target 22°C · room 25°C");
  assert.partialDeepStrictEqual(JSON.parse(followed), { name: "aircon.status.changed", data: { fan: "high" } });
  const exited = new Promise<number | null>((resolve) => watch.on("close", resolve));
  watch.kill("SIGINT");
  assert.equal(await exited, 130);
});

test("aircon.status.export writes a file through the command line", async (context) => {
  const folder = await mkdtemp(join(tmpdir(), "aircon-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "status.json");
  assert.equal((await cli("aircon", "status", "export", "--path", file)).code, 0);
  assert.partialDeepStrictEqual(JSON.parse(await readFile(file, "utf-8")), { power: false });
});

test("the Rust command line writes the command list of a shared prefix", async () => {
  await assertHelp(cli);
});
