import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { test } from "node:test";

import { check } from "@acid-cat/cli";

import type { Run } from "./run.ts";
import { shape, writtenText } from "./shape.ts";

/** The program of the air conditioner on the Rust core. The task `test-rust` builds it before the tests. */
const aircon = new URL("target/debug/aircon", new URL("../core-rust/", import.meta.url)).pathname;

/** Run the program with the arguments, and give its exit code and its output when it exits. */
function run(...args: string[]): Promise<Run> {
  return finish(spawn(aircon, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }));
}

/** The exit code and the output of a program when it exits. */
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

test("the Rust command line controls the unit of a server, and watch follows its changes", async (context) => {
  const server = spawn(aircon, ["serve"], { stdio: ["ignore", "pipe", "inherit"] });
  context.after(() => server.kill());
  const url = await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    // The first line of standard output is the URL. It can come in more than one chunk.
    let text = "";
    server.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")).trim());
    });
  });
  // With AIRCON_URL, the command line sends each call and each subscription to the server.
  const remote = (...args: string[]) => spawn(aircon, ["cli", ...args], { env: { ...process.env, AIRCON_URL: url }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });

  assert.equal((await finish(remote("aircon", "power", "set", "--on"))).code, 0);
  const status = await finish(remote("aircon", "status", "get"));
  assert.equal(status.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), { power: true });
  // The unit of the server changed, not the unit of a new process.
  assert.partialDeepStrictEqual(JSON.parse((await run("cli", "aircon", "status", "get")).stdout), { power: false });

  const watch = remote("watch", "aircon.status.changed");
  context.after(() => watch.kill());
  let watched = "";
  watch.stdout.setEncoding("utf-8").on("data", (chunk: string) => (watched += chunk));
  // Change the fan until the subscription writes its first occurrence: a change before the subscription starts is
  // not in it.
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
