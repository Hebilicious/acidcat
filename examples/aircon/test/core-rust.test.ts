import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { type TestContext, test } from "node:test";

import { check } from "@acid-cat/cli";

import { OUTPUT_ERROR, OUTPUT_FLAG_LINES, POWERED_OFF_LAYOUT, SCHEDULE_LAYOUT, STATUS_OFF, STATUS_ON } from "./human.ts";
import type { Run } from "./run.ts";
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
  const [status, poweredOff, unknownMode] = await Promise.all([cli("aircon", "status", "get"), cli("aircon", "mode", "set", "--mode", "heat"), cli("aircon", "mode", "set", "--mode", "boil")]);
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout), { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 });
  assert.equal(poweredOff.code, 1);
  assert.deepEqual(JSON.parse(poweredOff.stdout), { _tag: "PoweredOff" });
  assert.equal(unknownMode.code, 3);
});

test("the Rust command line takes one repeated flag for each item, or JSON text of the array", async () => {
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

test("the Rust command line writes the human form with its output flags", async () => {
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
  assert.ok(list.stdout.startsWith("Capabilities\n  aircon status get "), list.stdout);
  assert.ok(list.stdout.includes("\nEvents\n  watch aircon.status.changed"), list.stdout);
  assert.equal(unknown.code, 2);
  assert.ok(unknown.stderr.startsWith("error (unknown-capability): "), unknown.stderr);
  assert.deepEqual([json.code, json.stdout], [0, plain.stdout]);
  assert.deepEqual([xml.code, xml.stdout, xml.stderr], [3, "", `${OUTPUT_ERROR}\n`]);
});

async function startRemote(context: TestContext) {
  const server = spawn(aircon, ["serve"], { stdio: ["ignore", "pipe", "inherit"] });
  context.after(() => server.kill());
  const url = await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    let text = "";
    server.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")).trim());
    });
  });
  return (...args: string[]) => spawn(aircon, ["cli", ...args], { env: { ...process.env, AIRCON_URL: url }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
}

test("the Rust command line has the aliases of the catalog", async (context) => {
  const remote = await startRemote(context);
  const on = await finish(remote("--on"));
  assert.equal(on.code, 0, on.stderr);
  const status = await finish(remote("status"));
  assert.equal(status.code, 0, status.stderr);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), { power: true });
  assert.equal((await finish(remote("--off"))).code, 0);
  assert.partialDeepStrictEqual(JSON.parse((await finish(remote("status"))).stdout), { power: false });
  assert.equal((await finish(remote("--on", "--on"))).code, 3);
  const fallback = await finish(remote());
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.partialDeepStrictEqual(JSON.parse(fallback.stdout), { power: false }, "the default alias is status");
  const list = await cli("list");
  assert.match(list.stdout, /"aliases": \[\n\s*"aircon --off",\n\s*"aircon --on"\n\s*\]/);
  assert.match(list.stdout, /"aliases": \[\n\s*"aircon follow \[--cursor <string>\] \[--max-age-ms <integer>\]"\n\s*\]/);
  assert.match((await cli("--help")).stdout, /\nAliases:\n {2}--off\n {2}--on\n {2}follow \[--cursor <string>\] \[--max-age-ms <integer>\]\n {2}status\n\nOutput:\n/);

  const follow = remote("follow");
  context.after(() => follow.kill());
  let followed = "";
  follow.stdout.setEncoding("utf-8").on("data", (chunk: string) => (followed += chunk));
  // Change the status until the subscription writes its first occurrence: a change before the subscription starts is
  // not in it.
  for (let turn = 0; !followed.includes("\n"); turn++) {
    assert.ok(turn < 100, "follow writes an occurrence");
    assert.equal((await finish(remote(turn % 2 === 0 ? "--on" : "--off"))).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.partialDeepStrictEqual(JSON.parse(followed.slice(0, followed.indexOf("\n"))), { name: "aircon.status.changed" });
  const exited = new Promise<number | null>((resolve) => follow.on("close", resolve));
  follow.kill("SIGINT");
  assert.equal(await exited, 130);
});

test("the Rust command line controls the unit of a server, and watch follows its changes", async (context) => {
  const remote = await startRemote(context);

  assert.equal((await finish(remote("aircon", "power", "set", "--on"))).code, 0);
  const status = await finish(remote("aircon", "status", "get"));
  assert.equal(status.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), { power: true });
  assert.partialDeepStrictEqual(JSON.parse((await run("cli", "aircon", "status", "get")).stdout), { power: false });

  const watch = remote("watch", "aircon.status.changed");
  context.after(() => watch.kill());
  let watched = "";
  watch.stdout.setEncoding("utf-8").on("data", (chunk: string) => (watched += chunk));
  for (let turn = 0; !watched.includes("\n"); turn++) {
    assert.ok(turn < 100, "watch writes an occurrence");
    assert.equal((await finish(remote("aircon", "fan", "set", "--speed", turn % 2 === 0 ? "low" : "high"))).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const line = watched.slice(0, watched.indexOf("\n"));
  assert.partialDeepStrictEqual(JSON.parse(line), { name: "aircon.status.changed", data: { power: true } });
  assert.match(line, /"fan":"(low|high)"/);
  const exited = new Promise<number | null>((resolve) => watch.on("close", resolve));
  watch.kill("SIGINT");
  assert.equal(await exited, 130);
});

test("the Rust command line writes the human form of a server's value and occurrences", async (context) => {
  const remote = await startRemote(context);
  const status = await finish(remote("--output", "human", "aircon", "status", "get"));
  assert.deepEqual([status.code, status.stdout], [0, (await cli("--output", "human", "aircon", "status", "get")).stdout]);

  const watch = remote("--output", "human", "watch", "aircon.status.changed");
  context.after(() => watch.kill());
  let watched = "";
  watch.stdout.setEncoding("utf-8").on("data", (chunk: string) => (watched += chunk));
  for (let turn = 0; !watched.includes("\n"); turn++) {
    assert.ok(turn < 100, "watch writes an occurrence");
    assert.equal((await finish(remote(turn % 2 === 0 ? "--on" : "--off"))).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok([STATUS_ON, STATUS_OFF].includes(watched.slice(0, watched.indexOf("\n"))), watched);
});

test("aircon.status.export writes a file through the command line", async (context) => {
  const folder = await mkdtemp(join(tmpdir(), "aircon-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "status.json");
  assert.equal((await cli("aircon", "status", "export", "--path", file)).code, 0);
  assert.partialDeepStrictEqual(JSON.parse(await readFile(file, "utf-8")), { power: false });
});
