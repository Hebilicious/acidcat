import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { INTERRUPT_GRACE_MS } from "@acid-cat/spec-ts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Schema } from "effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { App, Capability, Cli } from "../src/index.ts";
import { CliListing, decodeText } from "./decode.ts";
import { fixture } from "./fixture.ts";
import { run } from "./run.ts";
import { bundledProgram } from "./bundled-program.ts";
import { until } from "./until.ts";
import type { Waiter } from "./until.ts";

const commandLine = (file: string) => (...args: string[]) => run(bundledProgram(file), ...args);

const cli = commandLine("test/fixture-cli.ts");
const cliWithFlag = commandLine("test/fixture-cli-flags.ts");
const cliWithCommand = commandLine("test/fixture-cli-commands.ts");

const cliWithRepeated = commandLine("test/fixture-cli-repeated.ts");

const cliWithInherited = commandLine("test/fixture-cli-inherited.ts");

const PROBE = fileURLToPath(new URL("interrupt-probe.ts", import.meta.url));

async function interruptedIgnoring(t: Waiter, command: readonly string[], interrupts: 1 | 2) {
  const directory = mkdtempSync(join(tmpdir(), "core-effect-interrupt-"));
  const marker = join(directory, "held");
  const record = join(directory, "exit");
  const fixture = bundledProgram("test/fixture-cli-ignoring-interruption.ts");
  const child = spawn(process.execPath, ["--import", PROBE, fixture, ...command, "--key", "k", "--marker", marker], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, INTERRUPT_PROBE_RECORD: record, ...(interrupts === 2 ? { INTERRUPT_PROBE_HOLD: marker } : {}) },
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (...exit) => resolve(exit)));
  let ended: [number | null, NodeJS.Signals | null] | undefined;
  void exited.then((exit) => (ended = exit));
  const waitFor = async (path: string, state: string) => {
    await until(t, () => existsSync(path) || ended !== undefined, Boolean, { what: `the marker file when it ${state}` });
    if (!existsSync(path)) throw new Error(`The call exited before it wrote its marker file when it ${state}. ${stderr}`);
  };
  try {
    await waitFor(marker, "started to hold");
    let interrupted = Date.now();
    child.kill("SIGINT");
    if (interrupts === 2) {
      await waitFor(`${marker}.received`, "received the first interrupt");
      interrupted = Date.now();
      child.kill("SIGINT");
      writeFileSync(`${marker}.go`, "");
    }
    const [code, signal] = await until(t, () => ended, (exit) => exit !== undefined, { next: () => exited, what: "the exit of the process" });
    const exit = existsSync(record) ? readFileSync(record, "utf-8") : undefined;
    return { code, signal, stderr, exit, elapsed: Date.now() - interrupted };
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
  test("a required repeated flag must occur, an empty JSON array gives no items, and the usage marks the repeated flags", async () => {
    const [missing, empty, list] = await Promise.all([
      cliWithRepeated("probe", "plan"),
      cliWithRepeated("probe", "plan", "--days", "mon", "--hours", "[]"),
      cliWithRepeated("list"),
    ]);
    assert.equal(missing.code, 3);
    assert.deepEqual(JSON.parse(empty.stdout), { days: ["mon"], hours: [] });
    assert.match(list.stdout, /"usage":"probe probe plan --days <mon\|tue>\.\.\. \[--hours <integer>\.\.\.\]"/);
  });

  test("a flag of the application decides the services of the capabilities, and the commands keep their exit codes", async () => {
    const [on, off, echo, unknown, missing] = await Promise.all([
      cliWithFlag("list"),
      cliWithFlag("--switch", "false", "list"),
      cliWithFlag("--switch", "false", "fixture", "echo", "--text", "hi"),
      cliWithFlag("--switch", "false", "nope"),
      cliWithFlag("--switch", "false", "fixture", "echo"),
    ]);
    assert.equal(toggle(on.stdout)?.available, true);
    assert.equal(toggle(off.stdout)?.available, false);
    assert.deepEqual([echo.code, unknown.code, missing.code], [0, 2, 3]);
  });

  test("call with input that is not JSON gives unknown-capability, then unavailable, before invalid-input", async () => {
    const [unknown, unavailable, invalid] = await Promise.all([
      cliWithFlag("call", "fixture.nothing", "{bad"),
      cliWithFlag("--switch", "false", "call", "fixture.toggle", "{bad"),
      cliWithFlag("call", "fixture.echo", "{bad"),
    ]);
    assert.deepEqual([unknown.code, unavailable.code, invalid.code], [2, 4, 3]);
  });

  test("an interrupt as soon as a call holds cancels the call with exit code 130, and writes cancelled to standard error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "core-effect-cli-"));
    const interrupted = async (run: number) => {
      const marker = join(directory, `held-${run}`);
      const child = spawn(process.execPath, [bundledProgram("test/fixture-cli.ts"), "fixture", "hold", "--key", "k", "--marker", marker]);
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

  test("a call or a subscription that ignores the interrupt exits with 130 after the grace period, or at once after a second interrupt", async (t) => {
    const commands = [["fixture", "hold"], ["watch", "fixture.watch"]] as const;
    const runs = await Promise.all(commands.flatMap((command) => [interruptedIgnoring(t, command, 1), interruptedIgnoring(t, command, 2)]));
    for (const [index, run] of runs.entries()) {
      const what = `${commands[Math.floor(index / 2)]?.join(" ")} with ${index % 2 === 0 ? "one interrupt" : "two interrupts"}`;
      const exit = index % 2 === 0 ? "exit after interrupt 1" : "exit during interrupt 2";
      assert.deepEqual({ ...run, elapsed: undefined }, { code: 130, signal: null, stderr: "", exit, elapsed: undefined }, what);
      if (index % 2 === 0) assert.ok(run.elapsed >= INTERRUPT_GRACE_MS, `${what}: exited ${run.elapsed} ms after the interrupt, before the grace period`);
    }
  });

  test("a command of the application runs beside the commands of the capabilities, and the help describes it", async () => {
    const [position, echo, help] = await Promise.all([cliWithCommand("position", "switch"), cliWithCommand("fixture", "echo", "--text", "hi"), cliWithCommand("--help")]);
    assert.equal(position.code, 0);
    assert.equal(position.stdout.trim(), "switch: on");
    assert.equal(echo.code, 0);
    assert.match(help.stdout, /DESCRIPTION\n {2}The fixture, with a command of its own\./);
    assert.match(help.stdout, /\n {2}position +Write the position of the switch\.\n\nALIASES\n/);
  });

  test("a first -- is not an argument, and a -- after the first argument is an argument", async () => {
    const [plain, dashed, extra, value] = await Promise.all([
      cli("say", "--text", "hi"),
      cli("--", "say", "--text", "hi"),
      cli("fixture", "echo", "--text", "hi", "--"),
      cli("fixture", "echo", "--text", "--"),
    ]);
    assert.equal(plain.code, 0);
    assert.deepEqual(dashed, plain);
    assert.deepEqual([extra.code, extra.stdout], [3, ""]);
    assert.deepEqual([value.code, JSON.parse(value.stdout)], [0, { text: "--" }]);
  });

  test("the help lists the aliases, and a flag alias with --help gives the usage of the alias", async () => {
    const [help, helloHelp] = await Promise.all([cli("--help"), cli("--hello", "--help")]);
    assert.match(help.stdout, /\nALIASES\n {2}--hello\n {2}broken-ticks \[--cursor <string>\] \[--max-age-ms <integer>\]\n {2}echoes '<json>' \[--cursor <string>\] \[--max-age-ms <integer>\]\n {2}fixed-note \[--loud\]\n {2}fixture \[--count <integer>\][^\n]*\n {2}held-keys\n {2}notes '<json>'\n {2}notes add --text <string> \[--loud\]\n {2}notes loud --text <string>\n {2}quick \[--count <integer>\][^\n]*\n {2}raw '<json>'\n {2}say --text <string>\n {2}shout hello\n {2}ticks \[--gap <integer>\] \[--key <string>\] \[--cursor <string>\] \[--max-age-ms <integer>\]\n$/);
    assert.doesNotMatch(help.stdout, /alias --hello/);
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

  test("a usage error writes the help and the error to standard error, and help and version still go to standard output", async () => {
    const [unknownFlag, rootHelp, rootShort, commandShort, version] = await Promise.all([
      cli("fixture", "echo", "--nope", "x"),
      cli("--help"),
      cli("-h"),
      cli("fixture", "echo", "-h"),
      cli("--version"),
    ]);
    assert.deepEqual([unknownFlag.code, unknownFlag.stdout], [3, ""]);
    assert.match(unknownFlag.stderr, /^Usage: fixture fixture echo --text <string>\n[\s\S]*Unrecognized flag: --nope/);
    for (const help of [rootHelp, rootShort]) {
      assert.equal(help.code, 0);
      assert.match(help.stdout, /USAGE/);
    }
    assert.equal(commandShort.code, 0);
    assert.match(commandShort.stdout, /^Usage: fixture fixture echo --text <string>\n/);
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
  for (const name of ["call", "list", "fixture", "say", "shout"]) {
    assert.throws(() => Cli.command(fixture, { ...options, commands: [named(name)] }), new RegExp(`The command ${name} of the application`));
  }
  assert.throws(() => Cli.command(fixture, { ...options, commands: [named("report"), named("report")] }), /The command report of the application/);
});

test("App.alias writes options.cli, with one default command alias at most", () => {
  const ping = Capability.make({ id: "probe.ping", description: "Ping.", audience: ["cli"], run: () => Effect.succeed(null) });
  const write = (aliases: { readonly [name: string]: App.Alias }) =>
    App.document(App.make({ targets: { cli: { surfaces: ["cli"], cli: { aliases } } }, capabilities: [ping] })).targets.cli?.options;
  assert.deepEqual(write({ ping: App.aliasDefault(ping), "--ping": App.alias(ping) }), {
    cli: { aliases: { ping: { capability: "probe.ping" }, "--ping": { capability: "probe.ping" } }, default: "ping" },
  });
  assert.throws(() => write({ ping: App.aliasDefault(ping), pong: App.aliasDefault(ping) }), /the aliases ping, pong are all default aliases/);
  assert.throws(() => write({ "--ping": App.aliasDefault(ping) }), /the default alias --ping is a flag alias/);
});

test("the command line stops when it starts if an alias breaks a rule", () => {
  const ping = Capability.make({ id: "probe.ping", description: "Ping.", audience: ["cli"], run: () => Effect.succeed(null) });
  const appOf = (aliases: { readonly [name: string]: unknown }) =>
    App.make({ targets: { cli: { surfaces: ["cli"], options: { cli: { aliases } } } }, capabilities: [ping] });
  const options = { name: "probe", version: "0.0.0" };
  assert.throws(() => Cli.command(appOf({ list: { capability: "probe.ping" } }), options), /the alias list has the name of a command/);
  assert.throws(() => Cli.command(appOf({ "probe ping": { capability: "probe.ping" } }), options), /the alias probe ping has the path of the command of a capability/);
  assert.throws(() => Cli.command(appOf({ gone: { capability: "probe.gone" } }), options), /the alias gone refers to probe.gone/);
  assert.doesNotThrow(() => Cli.command(appOf({ ping: { capability: "probe.ping" } }), options));
  assert.doesNotThrow(() => Cli.command(appOf({ probe: { capability: "probe.ping" } }), options));
});

test("the command line stops when it starts if a flag alias, or a flag of the default alias, has the name of a global flag", async () => {
  const Input = Schema.Struct({ switch: Schema.optionalKey(Schema.Boolean), text: Schema.optionalKey(Schema.String) });
  const ping = Capability.make({ id: "probe.ping", description: "Ping.", audience: ["cli"], input: Input, run: () => Effect.succeed(null) });
  const switchFlag = GlobalFlag.Setting("switch")({ flag: Flag.Boolean("switch") });
  const start = (cli: { readonly aliases: { readonly [name: string]: { readonly capability: string } }; readonly default?: string }) => {
    const app = App.make({ targets: { cli: { surfaces: ["cli"], options: { cli } } }, capabilities: [ping] });
    const command = Cli.command(app, { name: "probe", version: "0.0.0" }).pipe(Command.withGlobalFlags([switchFlag]));
    return Effect.runPromiseExit(Cli.runCommand(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)));
  };
  for (const name of ["--log-level", "--completions", "--switch", "--no-switch"]) {
    const exit = await start({ aliases: { [name]: { capability: "probe.ping" } } });
    assert.ok(Exit.isFailure(exit), `${name} stops the command line`);
    assert.match(Cause.pretty(exit.cause), new RegExp(`The alias ${name} has the name of a flag of the command line`));
  }
  const exit = await start({ aliases: { ping: { capability: "probe.ping" } }, default: "ping" });
  assert.ok(Exit.isFailure(exit), "the flag --switch of the default alias stops the command line");
  assert.match(Cause.pretty(exit.cause), /The default alias ping has the flag --switch, which is a flag of the command line/);
});

test("the path of a capability must not be the start of the path of another capability", () => {
  const capability = (id: string) => Capability.make({ id, description: id, audience: ["cli"], run: () => Effect.succeed(null) });
  const appOf = (...ids: string[]) => App.make({ targets: { cli: { surfaces: ["cli"] } }, capabilities: ids.map(capability) });
  const options = { name: "aircon", version: "0.0.0" };
  assert.throws(() => Cli.command(appOf("aircon.status", "aircon.status.get"), options), /The command aircon status is also the start of the command aircon status get/);
  assert.throws(() => Cli.command(appOf("aircon.status.get", "aircon"), options), /The command aircon is also the start of the command aircon status get/);
  assert.doesNotThrow(() => Cli.command(appOf("aircon.status.get", "aircon.statusbar.get", "aircon.power.set"), options));
});
