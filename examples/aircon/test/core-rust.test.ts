import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { before, test } from "node:test";

import { check } from "@acid-cat/cli";

import type { Run } from "./run.ts";
import { shape, writtenText } from "./shape.ts";

const directory = new URL("../core-rust/", import.meta.url).pathname;

/** The program of the air conditioner on the Rust core. `before` builds it. */
const aircon = new URL("target/debug/aircon", new URL("../core-rust/", import.meta.url)).pathname;

before(() => {
  execFileSync("cargo", ["build", "--quiet"], { cwd: directory, stdio: "inherit" });
});

/** Run the program with the arguments, and give its exit code and its output when it exits. */
function run(...args: string[]): Promise<Run> {
  const child = spawn(aircon, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
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

test("the session, the events and the state of the Rust application pass their tests", () => {
  execFileSync("cargo", ["test", "--quiet"], { cwd: directory, stdio: "pipe" });
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
