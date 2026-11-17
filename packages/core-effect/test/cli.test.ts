import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";

import { INTERRUPT_GRACE_MS } from "@acid-cat/spec-ts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Schema } from "effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { App, Capability, Cli } from "../src/index.ts";
import { CliListing, decodeText } from "./decode.ts";
import { fixture } from "./fixture.ts";
import { run } from "./run.ts";

const program = (file: string) => (...args: string[]) => run(new URL(file, import.meta.url).pathname, ...args);

const cli = program("./fixture-cli.ts");
const cliWithFlag = program("./fixture-cli-flags.ts");
const cliWithCommand = program("./fixture-cli-commands.ts");

const cliWithRepeated = program("./fixture-cli-repeated.ts");

const cliWithInherited = program("./fixture-cli-inherited.ts");

const DEADLINE_MS = 10_000;
const SECOND_INTERRUPT_MS = 100;

async function interruptedHold(interrupts: 1 | 2) {
  const directory = mkdtempSync(join(tmpdir(), "core-effect-interrupt-"));
  const marker = join(directory, "held");
  const fixture = new URL("./fixture-cli-ignoring-interruption.ts", import.meta.url).pathname;
  const child = spawn(process.execPath, [fixture, "fixture", "hold", "--key", "k", "--marker", marker], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (...exit) => resolve(exit)));
  try {
    const start = Date.now();
    while (!existsSync(marker)) {
      if (Date.now() - start > DEADLINE_MS) throw new Error(`The call did not write its marker file. ${stderr}`);
      await pause(10);
    }
    const interrupted = Date.now();
    child.kill("SIGINT");
    // Unix merges a signal that is still pending with the next one of the same kind.
    if (interrupts === 2) {
      await pause(SECOND_INTERRUPT_MS);
      child.kill("SIGINT");
    }
    const ended = await Promise.race([exited, pause(DEADLINE_MS, "running" as const)]);
    const [code, signal] = ended === "running" ? [null, null] : ended;
    return { code, signal, stderr, elapsed: Date.now() - interrupted, running: ended === "running" };
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
}

const toggle = (stdout: string) =>
  decodeText(CliListing, stdout)
    .flatMap((entry) => (entry.kind === "capability" ? [entry] : []))
    .find((entry) => entry.id === "fixture.toggle");

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

  test("call with input that is not JSON gives unknown-capability, then unavailable, before invalid-input", async () => {
    const [unknown, unavailable, invalid] = await Promise.all([
      cliWithFlag("call", "fixture.nothing", "{bad"),
      cliWithFlag("--switch", "false", "call", "fixture.toggle", "{bad"),
      cliWithFlag("call", "fixture.echo", "{bad"),
    ]);
    assert.deepEqual([unknown.code, unavailable.code, invalid.code], [2, 4, 3]);
  });

  test("a command that the application changed keeps the exit codes", async () => {
    const runs = await Promise.all([
      cliWithFlag("--switch", "false", "fixture", "echo", "--text", "hi"),
      cliWithFlag("--switch", "false", "nope"),
      cliWithFlag("--switch", "false", "fixture", "echo"),
    ]);
    assert.deepEqual(runs.map((run) => run.code), [0, 2, 3]);
  });

  test("an interrupt as soon as a call holds cancels the call with exit code 130, and writes cancelled to standard error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "core-effect-cli-"));
    const interrupted = async (run: number) => {
      const marker = join(directory, `held-${run}`);
      const child = spawn(process.execPath, [new URL("./fixture-cli.ts", import.meta.url).pathname, "fixture", "hold", "--key", "k", "--marker", marker]);
      let stderr = "";
      child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
      const watcher = watch(directory, (_, name) => {
        if (name !== `held-${run}`) return;
        watcher.close();
        child.kill("SIGINT");
      });
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (...exit) => resolve(exit)));
      watcher.close();
      return { code, signal, stderr };
    };
    try {
      const runs = await Promise.all(Array.from({ length: 10 }, (_, run) => interrupted(run)));
      const cancelled = JSON.stringify({ kind: "cancelled", message: "The call was cancelled." });
      assert.deepEqual(runs, Array.from({ length: 10 }, () => ({ code: 130, signal: null, stderr: `${cancelled}\n` })));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a call that ignores the interrupt exits with 130 after the grace period, or at once after a second interrupt", async () => {
    const [once, twice] = await Promise.all([interruptedHold(1), interruptedHold(2)]);
    assert.deepEqual({ ...once, elapsed: undefined }, { code: 130, signal: null, stderr: "", elapsed: undefined, running: false });
    assert.ok(once.elapsed >= INTERRUPT_GRACE_MS, `exited ${once.elapsed} ms after the interrupt, before the grace period`);
    assert.deepEqual({ ...twice, elapsed: undefined }, { code: 130, signal: null, stderr: "", elapsed: undefined, running: false });
    assert.ok(twice.elapsed < INTERRUPT_GRACE_MS, `exited ${twice.elapsed} ms after two interrupts, not at once`);
  });

  test("a command of the application runs beside the commands of the capabilities", async () => {
    const [position, echo] = await Promise.all([cliWithCommand("position", "switch"), cliWithCommand("fixture", "echo", "--text", "hi")]);
    assert.equal(position.code, 0);
    assert.equal(position.stdout.trim(), "switch: on");
    assert.equal(echo.code, 0);
  });

  test("a first -- is not an argument", async () => {
    const [plain, dashed] = await Promise.all([cli("say", "--text", "hi"), cli("--", "say", "--text", "hi")]);
    assert.equal(plain.code, 0);
    assert.deepEqual(dashed, plain);
  });

  test("the help gives the description of the options and the commands of the application", async () => {
    const help = (await cliWithCommand("--help")).stdout;
    assert.match(help, /DESCRIPTION\n {2}The fixture, with a command of its own\./);
    assert.match(help, /\n {2}position +Write the position of the switch\.\n\nALIASES\n/);
  });

  test("the help lists the aliases, and <alias> --help gives the usage of the alias", async () => {
    const [help, sayHelp, helloHelp] = await Promise.all([cli("--help"), cli("say", "--help"), cli("--hello", "--help")]);
    assert.match(help.stdout, /\nALIASES\n {2}--hello\n {2}broken-ticks \[--cursor <string>\] \[--max-age-ms <integer>\]\n {2}echoes '<json>' \[--cursor <string>\] \[--max-age-ms <integer>\]\n {2}fixed-note \[--loud\]\n {2}held-keys\n {2}quick \[--count <integer>\][^\n]*\n {2}raw '<json>'\n {2}say --text <string>\n {2}ticks \[--gap <integer>\] \[--key <string>\] \[--cursor <string>\] \[--max-age-ms <integer>\]\n$/);
    assert.doesNotMatch(help.stdout, /alias --hello/);
    assert.deepEqual(sayHelp, { code: 0, stdout: "Usage: fixture say --text <string>\n\nReturn the input text.\n", stderr: "" });
    assert.equal(helloHelp.stdout, "Usage: fixture --hello\n\nReturn the input text.\n");
  });

  test("a usage error of a flag alias shows the alias as the user gives it, and no other name selects the alias", async () => {
    const [unknownFlag, otherName] = await Promise.all([cli("--hello", "--text", "x"), cli("alias --hello")]);
    assert.equal(unknownFlag.code, 3);
    assert.equal(unknownFlag.stdout, "");
    assert.match(unknownFlag.stderr, /\nUSAGE\n {2}fixture --hello \[flags\]\n/);
    assert.match(unknownFlag.stderr, /Unrecognized flag: --text in command fixture --hello\n/);
    assert.equal(otherName.code, 2);
    assert.match(otherName.stderr, /Unknown subcommand "alias --hello" for "fixture"/);
  });

  test("a flag is a property of the input itself, not a name that every object inherits", async () => {
    const [fixed, changed, alias, command, missing] = await Promise.all([
      cliWithInherited("go"),
      cliWithInherited("go", "--constructor", '"changed"'),
      cliWithInherited("go", "--toString", "x"),
      cliWithInherited("probe", "name", "--constructor", "own", "--toString", "x"),
      cliWithInherited("probe", "name", "--text", "no constructor"),
    ]);
    assert.deepEqual(JSON.parse(fixed.stdout), { constructor: "fixed" });
    assert.equal(changed.code, 3);
    assert.equal(alias.code, 3);
    assert.equal(command.code, 3);
    assert.equal(missing.code, 3);
  });

  test("the input schema of fixture.note is a $ref with a description beside it", () => {
    assert.deepEqual(App.document(fixture).capabilities["fixture.note"]?.input, { $ref: "#/$defs/Note", description: "The note." });
  });

  test("a usage error writes the help and the error to standard error, and help and version still go to standard output", async () => {
    const [unknownFlag, missingFlag, unknownCommand] = await Promise.all([
      cli("fixture", "echo", "--nope", "x"),
      cli("fixture", "echo"),
      cli("fixture", "nothing"),
    ]);
    assert.deepEqual(
      [unknownFlag, missingFlag, unknownCommand].map((run) => [run.code, run.stdout]),
      [[3, ""], [3, ""], [2, ""]],
    );
    assert.match(unknownFlag.stderr, /USAGE\n {2}fixture fixture echo[\s\S]*Unrecognized flag: --nope/);

    const requests = await Promise.all([cli("--help"), cli("-h"), cli("fixture", "echo", "--help"), cli("fixture", "echo", "-h")]);
    for (const help of requests) {
      assert.equal(help.code, 0);
      assert.match(help.stdout, /USAGE/);
    }
    const version = await cli("--version");
    assert.equal(version.code, 0);
    assert.match(version.stdout, /0\.0\.0/);
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
  for (const name of ["call", "list", "fixture", "say"]) {
    assert.throws(() => Cli.command(fixture, { ...options, commands: [named(name)] }), new RegExp(`The command ${name} of the application`));
  }
  assert.throws(() => Cli.command(fixture, { ...options, commands: [named("report"), named("report")] }), /The command report of the application/);
});

test("App.alias writes options.cli, with one default command alias at most", () => {
  const ping = Capability.make({ id: "probe.ping", description: "Ping.", audience: ["cli"], run: () => Effect.succeed(null) });
  const write = (aliases: { readonly [name: string]: App.Alias }) =>
    App.document(App.make({ targets: { cli: { bindings: ["cli"], cli: { aliases } } }, capabilities: [ping] })).targets.cli?.options;
  assert.deepEqual(write({ ping: App.aliasDefault(ping), "--ping": App.alias(ping) }), {
    cli: { aliases: { ping: { capability: "probe.ping" }, "--ping": { capability: "probe.ping" } }, default: "ping" },
  });
  assert.throws(() => write({ ping: App.aliasDefault(ping), pong: App.aliasDefault(ping) }), /the aliases ping, pong are all default aliases/);
  assert.throws(() => write({ "--ping": App.aliasDefault(ping) }), /the default alias --ping is a flag alias/);
});

test("the command line stops when it starts if an alias breaks a rule", () => {
  const ping = Capability.make({ id: "probe.ping", description: "Ping.", audience: ["cli"], run: () => Effect.succeed(null) });
  const appOf = (aliases: { readonly [name: string]: unknown }) =>
    App.make({ targets: { cli: { bindings: ["cli"], options: { cli: { aliases } } } }, capabilities: [ping] });
  const options = { name: "probe", version: "0.0.0" };
  assert.throws(() => Cli.command(appOf({ list: { capability: "probe.ping" } }), options), /the alias list has the name of a command/);
  assert.throws(() => Cli.command(appOf({ probe: { capability: "probe.ping" } }), options), /the alias probe has the name of the first word/);
  assert.throws(() => Cli.command(appOf({ gone: { capability: "probe.gone" } }), options), /the alias gone refers to probe.gone/);
  assert.doesNotThrow(() => Cli.command(appOf({ ping: { capability: "probe.ping" } }), options));
});

test("the command line stops when it starts if a flag alias has the name of a global flag", async () => {
  const ping = Capability.make({ id: "probe.ping", description: "Ping.", audience: ["cli"], run: () => Effect.succeed(null) });
  const switchFlag = GlobalFlag.Setting("switch")({ flag: Flag.Boolean("switch") });
  const start = (name: string) => {
    const app = App.make({ targets: { cli: { bindings: ["cli"], options: { cli: { aliases: { [name]: { capability: "probe.ping" } } } } } }, capabilities: [ping] });
    const command = Cli.command(app, { name: "probe", version: "0.0.0" }).pipe(Command.withGlobalFlags([switchFlag]));
    return Effect.runPromiseExit(Cli.runCommand(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)));
  };
  for (const name of ["--log-level", "--completions", "--switch", "--no-switch"]) {
    const exit = await start(name);
    assert.ok(Exit.isFailure(exit), `${name} stops the command line`);
    assert.match(Cause.pretty(exit.cause), new RegExp(`The alias ${name} has the name of a flag of the command line`));
  }
});

test("the command line stops when it starts if a flag of the default alias has the name of a global flag", async () => {
  const Input = Schema.Struct({ switch: Schema.optionalKey(Schema.Boolean), text: Schema.optionalKey(Schema.String) });
  const ping = Capability.make({ id: "probe.ping", description: "Ping.", audience: ["cli"], input: Input, run: () => Effect.succeed(null) });
  const switchFlag = GlobalFlag.Setting("switch")({ flag: Flag.Boolean("switch") });
  const start = () => {
    const aliases = { ping: { capability: "probe.ping" } };
    const app = App.make({ targets: { cli: { bindings: ["cli"], options: { cli: { aliases, default: "ping" } } } }, capabilities: [ping] });
    const command = Cli.command(app, { name: "probe", version: "0.0.0" }).pipe(Command.withGlobalFlags([switchFlag]));
    return Effect.runPromiseExit(Cli.runCommand(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)));
  };
  const exit = await start();
  assert.ok(Exit.isFailure(exit), "the flag --switch of the default alias stops the command line");
  assert.match(Cause.pretty(exit.cause), /The default alias ping has the flag --switch, which is a flag of the command line/);
});

test("the path of a capability must not be the start of the path of another capability", () => {
  const capability = (id: string) => Capability.make({ id, description: id, audience: ["cli"], run: () => Effect.succeed(null) });
  const appOf = (...ids: string[]) => App.make({ targets: { cli: { bindings: ["cli"] } }, capabilities: ids.map(capability) });
  const options = { name: "aircon", version: "0.0.0" };
  assert.throws(() => Cli.command(appOf("aircon.status", "aircon.status.get"), options), /The command aircon status is also the start of the command aircon status get/);
  assert.throws(() => Cli.command(appOf("aircon.status.get", "aircon"), options), /The command aircon is also the start of the command aircon status get/);
  assert.doesNotThrow(() => Cli.command(appOf("aircon.status.get", "aircon.statusbar.get", "aircon.power.set"), options));
});
