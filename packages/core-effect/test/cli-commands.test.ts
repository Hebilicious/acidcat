import assert from "node:assert/strict";
import { test } from "node:test";

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, Schema } from "effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { App, Capability, Cli } from "../src/index.ts";
import { fixture } from "./fixture.ts";

const options = { name: "fixture", version: "0.0.0" };

const probe = (id: string, input?: Capability.AnySchema) =>
  Capability.make({ id, description: id, audience: ["cli"], ...(input === undefined ? {} : { input }), run: () => Effect.succeed(null) });
const probes = (...capabilities: ReturnType<typeof probe>[]) => App.make({ targets: { cli: { bindings: ["cli"] } }, capabilities });

test("two commands with the same path stop the program when it starts", () => {
  for (const name of ["fixture", "list", "call"]) {
    assert.throws(() => Cli.command(fixture, { ...options, commands: [Cli.declare(name, {})] }), /Two commands of the command line have the path fixture/);
  }
  assert.throws(
    () => Cli.command(fixture, { ...options, commands: [Cli.declare("solve", {}), Cli.declare("solve", {})] }),
    /Two commands of the command line have the path fixture solve\./,
  );
});

test("two commands with the same path at a lower level stop the program", () => {
  const tools = Cli.declare("tools", {}, undefined, { subcommands: [Cli.declare("x", {}), Cli.declare("x", {})] });
  assert.throws(() => Cli.command(fixture, { ...options, commands: [tools] }), /Two commands of the command line have the path fixture tools x\./);
  assert.throws(() => Cli.command(probes(probe("a.b"), probe("a.b.c")), options), /Two commands of the command line have the path fixture a b\./);
});

test("a flag of a capability with the name of a global flag stops the program when it starts", () => {
  const text = GlobalFlag.Setting("text")({ flag: Flag.String("text").pipe(Flag.optional) });
  assert.throws(() => Cli.command(fixture, { ...options, globalFlags: [text] }), /The flag --text of fixture.echo has the same name as a global flag/);
  assert.throws(
    () => Cli.command(probes(probe("probe.ask", Schema.Struct({ help: Schema.Boolean }))), options),
    /The flag --help of probe.ask has the same name as a global flag/,
  );
});

test("a flag or an alias of a command of the application with the name of a global flag stops the program", () => {
  const solve = (flag: Flag.Flag<boolean>) => Cli.declare("solve", { flag }, () => Effect.void);
  assert.throws(() => Cli.command(fixture, { ...options, commands: [solve(Flag.Boolean("help"))] }), /The flag --help of the command solve/);
  assert.throws(() => Cli.command(fixture, { ...options, commands: [solve(Flag.Boolean("json").pipe(Flag.withAlias("h")))] }), /The flag --h of the command solve/);
  const json = GlobalFlag.Setting("json")({ flag: Flag.Boolean("json") });
  assert.throws(() => Cli.command(fixture, { ...options, globalFlags: [json], commands: [solve(Flag.Boolean("json"))] }), /The flag --json of the command solve/);
  const nested = Cli.declare("tools", {}, undefined, { subcommands: [solve(Flag.Boolean("version"))] });
  assert.throws(() => Cli.command(fixture, { ...options, commands: [nested] }), /The flag --version of the command solve/);
});

test("two flags of one command, or two global flags, with one name stop the program", () => {
  assert.throws(
    () => Cli.command(fixture, { ...options, commands: [Cli.declare("solve", { a: Flag.Boolean("same"), b: Flag.String("same") })] }),
    /Two flags of the command solve have the name same\./,
  );
  const first = GlobalFlag.Setting("first")({ flag: Flag.String("url").pipe(Flag.optional) });
  const second = GlobalFlag.Setting("second")({ flag: Flag.String("url").pipe(Flag.optional) });
  assert.throws(() => Cli.command(fixture, { ...options, globalFlags: [first, second] }), /Two global flags of the command line have the name url\./);
});

test("commands and flags with different names make a command line", () => {
  const solve = Cli.declare("solve", { json: Flag.Boolean("json") }, () => Effect.void, { subcommands: [Cli.declare("again", {})] });
  assert.equal(Cli.command(fixture, { ...options, commands: [solve] }).name, "fixture");
});

/** The help of the root command, as `--help` shows it. */
async function rootHelp(app: App.App<never>, description?: string): Promise<string> {
  const lines: string[] = [];
  const console = { ...globalThis.console, log: (...parts: unknown[]) => void lines.push(parts.join(" ")) };
  await Effect.runPromise(
    Command.runWith(Cli.command(app, { ...options, ...(description === undefined ? {} : { description }) }), options)(["--help"]).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(Console.Console, console as never),
    ),
  );
  return lines.join("\n");
}

test("the root help shows the description of the command line, then the description of the application, then its title", async () => {
  const capabilities = [probe("probe.ask")];
  const targets = { cli: { bindings: ["cli"] } };
  const described = App.make({ title: "Probe", description: "An application that probes.", targets, capabilities });
  assert.match(await rootHelp(described, "Probe from the terminal."), /Probe from the terminal\./);
  assert.match(await rootHelp(described), /An application that probes\./);
  assert.match(await rootHelp(App.make({ title: "Probe", targets, capabilities })), /Probe/);
});
