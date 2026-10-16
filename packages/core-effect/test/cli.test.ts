import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Command } from "effect/cli";

import { Cli } from "../src/index.ts";
import { fixture } from "./fixture.ts";

const program = (file: string) => (...args: string[]) => {
  const run = spawnSync(process.execPath, [new URL(file, import.meta.url).pathname, ...args], {
    encoding: "utf-8",
    timeout: 20_000,
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

const cli = program("./fixture-cli.ts");
/** The command line with the flag `--switch` of the application. The services of the capabilities depend on it. */
const cliWithFlag = program("./fixture-cli-flags.ts");
/** The command line with the command `position` of the application, and a description in the options. */
const cliWithCommand = program("./fixture-cli-commands.ts");

const toggle = (stdout: string) =>
  (JSON.parse(stdout) as { id: string; available: boolean }[]).find((entry) => entry.id === "fixture.toggle");

test("a value goes to standard output with exit code 0", () => {
  const run = cli("fixture", "echo", "--text", "hi");
  assert.equal(run.code, 0);
  assert.deepEqual(JSON.parse(run.stdout), { text: "hi" });
});

test("a failure goes to standard output with exit code 1", () => {
  const run = cli("fixture", "refuse");
  assert.equal(run.code, 1);
  assert.deepEqual(JSON.parse(run.stdout), { _tag: "Refused", reason: "No." });
});

test("each call failure has its exit code", () => {
  assert.equal(cli("call", "fixture.echo", '{"text":1}').code, 3);
  assert.equal(cli("call", "fixture.hidden").code, 2);
  const crash = cli("fixture", "crash");
  assert.equal(crash.code, 5);
  assert.match(crash.stderr, /"kind":"internal"/);
});

test("an unknown command and a missing flag have exit codes", () => {
  assert.equal(cli("nope").code, 2);
  assert.equal(cli("fixture", "echo").code, 3);
});

test("list gives the capabilities of the view", () => {
  const ids = (JSON.parse(cli("list").stdout) as { id: string }[]).map((entry) => entry.id);
  assert.ok(ids.includes("fixture.echo"));
  assert.ok(!ids.includes("fixture.hidden"));
});

test("a flag of the application decides the services of the capabilities", () => {
  assert.equal(toggle(cliWithFlag("list").stdout)?.available, true);
  assert.equal(toggle(cliWithFlag("--switch", "false", "list").stdout)?.available, false);
});

test("a command that the application changed keeps the exit codes", () => {
  assert.equal(cliWithFlag("--switch", "false", "fixture", "echo", "--text", "hi").code, 0);
  assert.equal(cliWithFlag("--switch", "false", "nope").code, 2);
  assert.equal(cliWithFlag("--switch", "false", "fixture", "echo").code, 3);
});

test("an interrupt as soon as a call holds cancels the call with exit code 130", async () => {
  const directory = mkdtempSync(join(tmpdir(), "core-effect-cli-"));
  try {
    for (let run = 0; run < 10; run++) {
      const marker = join(directory, `held-${run}`);
      const child = spawn(process.execPath, [new URL("./fixture-cli.ts", import.meta.url).pathname, "fixture", "hold", "--key", "k", "--marker", marker]);
      const watcher = watch(directory, (_, name) => {
        if (name === `held-${run}`) child.kill("SIGINT");
      });
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (...exit) => resolve(exit)));
      watcher.close();
      assert.deepEqual({ code, signal }, { code: 130, signal: null });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a command of the application runs beside the commands of the capabilities", () => {
  const run = cliWithCommand("position", "switch");
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), "switch: on");
  assert.equal(cliWithCommand("fixture", "echo", "--text", "hi").code, 0);
});

test("the help gives the description of the options and the commands of the application", () => {
  const help = cliWithCommand("--help").stdout;
  assert.match(help, /DESCRIPTION\n {2}The fixture, with a command of its own\./);
  assert.match(help, /\n {2}position +Write the position of the switch\./);
});

test("the description of the command line is the option, else the description of the application, else its title", () => {
  const options = { name: "fixture", version: "0.0.0" };
  assert.equal(Cli.command(fixture, { ...options, description: "Own." }).description, "Own.");
  assert.equal(Cli.command(fixture, options).description, fixture.description);
  assert.equal(Cli.command({ ...fixture, description: undefined }, options).description, fixture.title);
});

test("a command of the application must not have the name of another command", () => {
  const options = { name: "fixture", version: "0.0.0" };
  const named = (name: string) => Command.make(name);
  for (const name of ["call", "list", "fixture"]) {
    assert.throws(() => Cli.command(fixture, { ...options, commands: [named(name)] }), new RegExp(`The command ${name} of the application`));
  }
  assert.throws(() => Cli.command(fixture, { ...options, commands: [named("report"), named("report")] }), /The command report of the application/);
});
