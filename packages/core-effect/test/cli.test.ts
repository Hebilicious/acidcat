import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { Effect } from "effect";
import { Command } from "effect/cli";

import { App, Capability, Cli } from "../src/index.ts";
import { CliListing, decodeText } from "./decode.ts";
import { fixture } from "./fixture.ts";
import { run } from "./run.ts";

const program = (file: string) => (...args: string[]) => run(new URL(file, import.meta.url).pathname, ...args);

/** The command line with the flag `--switch` of the application. The services of the capabilities depend on it. */
const cliWithFlag = program("./fixture-cli-flags.ts");
/** The command line with the command `position` of the application, and a description in the options. */
const cliWithCommand = program("./fixture-cli-commands.ts");

/** The command line with a required repeated flag and an optional repeated flag. */
const cliWithRepeated = program("./fixture-cli-repeated.ts");

const toggle = (stdout: string) =>
  decodeText(CliListing, stdout)
    .flatMap((entry) => (entry.kind === "capability" ? [entry] : []))
    .find((entry) => entry.id === "fixture.toggle");

// Each test below starts processes. The tests run at the same time, and the runs of a test wait at the same time.
describe("the command line of an application", { concurrency: true }, () => {
  test("a repeated flag gives its items in order, or JSON text of the array, and a required one must occur", async () => {
    const [plan, once, missing, jsonText, notAnItem, notAnInteger, list] = await Promise.all([
      cliWithRepeated("probe", "plan", "--days", "tue", "--hours=9", "--days", "mon"),
      cliWithRepeated("probe", "plan", "--days", "mon"),
      cliWithRepeated("probe", "plan"),
      cliWithRepeated("probe", "plan", "--days", '["tue","mon"]', "--hours", "[]"),
      cliWithRepeated("probe", "plan", "--days", '["sun"]'),
      cliWithRepeated("probe", "plan", "--days", "mon", "--hours", "late"),
      cliWithRepeated("list"),
    ]);
    assert.equal(plan.code, 0);
    assert.deepEqual(JSON.parse(plan.stdout), { days: ["tue", "mon"], hours: [9] });
    assert.deepEqual(JSON.parse(once.stdout), { days: ["mon"] });
    assert.equal(missing.code, 3);
    assert.deepEqual(JSON.parse(jsonText.stdout), { days: ["tue", "mon"], hours: [] });
    assert.equal(notAnItem.code, 3);
    assert.equal(notAnInteger.code, 3);
    assert.match(list.stdout, /"usage": "probe probe plan --days <mon\|tue>\.\.\. \[--hours <integer>\.\.\.\]"/);
  });

  test("a flag of the application decides the services of the capabilities", async () => {
    const [on, off] = await Promise.all([cliWithFlag("list"), cliWithFlag("--switch", "false", "list")]);
    assert.equal(toggle(on.stdout)?.available, true);
    assert.equal(toggle(off.stdout)?.available, false);
  });

  test("a command that the application changed keeps the exit codes", async () => {
    const runs = await Promise.all([
      cliWithFlag("--switch", "false", "fixture", "echo", "--text", "hi"),
      cliWithFlag("--switch", "false", "nope"),
      cliWithFlag("--switch", "false", "fixture", "echo"),
    ]);
    assert.deepEqual(runs.map((run) => run.code), [0, 2, 3]);
  });

  test("an interrupt as soon as a call holds cancels the call with exit code 130", async () => {
    const directory = mkdtempSync(join(tmpdir(), "core-effect-cli-"));
    // Each run sends the interrupt as soon as the call writes its marker file. Ten runs make a race more likely to show.
    const interrupted = async (run: number) => {
      const marker = join(directory, `held-${run}`);
      const child = spawn(process.execPath, [new URL("./fixture-cli.ts", import.meta.url).pathname, "fixture", "hold", "--key", "k", "--marker", marker]);
      const watcher = watch(directory, (_, name) => {
        if (name === `held-${run}`) child.kill("SIGINT");
      });
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (...exit) => resolve(exit)));
      watcher.close();
      return { code, signal };
    };
    try {
      const runs = await Promise.all(Array.from({ length: 10 }, (_, run) => interrupted(run)));
      assert.deepEqual(runs, Array.from({ length: 10 }, () => ({ code: 130, signal: null })));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a command of the application runs beside the commands of the capabilities", async () => {
    const [position, echo] = await Promise.all([cliWithCommand("position", "switch"), cliWithCommand("fixture", "echo", "--text", "hi")]);
    assert.equal(position.code, 0);
    assert.equal(position.stdout.trim(), "switch: on");
    assert.equal(echo.code, 0);
  });

  test("the help gives the description of the options and the commands of the application", async () => {
    const help = (await cliWithCommand("--help")).stdout;
    assert.match(help, /DESCRIPTION\n {2}The fixture, with a command of its own\./);
    assert.match(help, /\n {2}position +Write the position of the switch\./);
  });
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

test("the path of a capability must not be the start of the path of another capability", () => {
  const capability = (id: string) => Capability.make({ id, description: id, audience: ["cli"], run: () => Effect.succeed(null) });
  const appOf = (...ids: string[]) => App.make({ targets: { cli: { bindings: ["cli"] } }, capabilities: ids.map(capability) });
  const options = { name: "aircon", version: "0.0.0" };
  assert.throws(() => Cli.command(appOf("aircon.status", "aircon.status.get"), options), /The command aircon status is also the start of the command aircon status get/);
  assert.throws(() => Cli.command(appOf("aircon.status.get", "aircon"), options), /The command aircon is also the start of the command aircon status get/);
  assert.doesNotThrow(() => Cli.command(appOf("aircon.status.get", "aircon.statusbar.get", "aircon.power.set"), options));
});
