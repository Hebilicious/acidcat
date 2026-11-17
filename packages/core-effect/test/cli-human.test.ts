import assert from "node:assert/strict";
import { test } from "node:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Console, Effect, Exit, Layer, Schema, Stdio } from "effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { App, Capability, Cli } from "../src/index.ts";
import { outputChoice } from "../src/internal/human.ts";

const Level = Schema.Struct({ level: Schema.Number });
const Empty = Schema.TaggedStruct("Empty", {});

const level = Capability.make({
  id: "probe.level",
  description: "Read the level.",
  audience: ["cli"],
  output: Level,
  failures: [Empty],
  run: () => Effect.succeed({ level: 3 }),
});

const fill = Capability.make({
  id: "probe.fill",
  description: "Fill the probe.",
  audience: ["cli"],
  input: Schema.Struct({ litres: Schema.Number }),
  run: () => Effect.succeed(null),
});

const probe = App.make({ targets: { cli: { bindings: ["cli"], cli: { aliases: { "--now": App.alias(level) } } } }, capabilities: [level, fill] });

const runWith = <const Commands extends ReadonlyArray<Command.Command.Any> = readonly []>(
  output: Cli.Output | undefined,
  args: readonly string[],
  stdoutIsTerminal = false,
  commands?: Commands,
) =>
  Effect.gen(function* () {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const captured = { ...console, log: (text: string) => stdout.push(text), error: (text: string) => stderr.push(text) };
    const before = process.exitCode;
    process.exitCode = 0;
    yield* Cli.run(probe, { name: "probe", version: "0.0.0", output, commands }).pipe(
      Effect.provideService(Console.Console, captured),
      Effect.provideService(Cli.Terminal, { stdoutIsTerminal, environment: {} }),
      Effect.provide(Layer.provideMerge(Layer.effect(Stdio.Stdio, Effect.map(Effect.service(Stdio.Stdio), (stdio) => ({ ...stdio, args: Effect.succeed(args) }))), NodeServices.layer)),
    );
    const code = process.exitCode;
    process.exitCode = before;
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  });

const runHuman = (formats: readonly App.Format[], ...args: string[]) => runWith({ default: "human", formats }, args);

test("the form is human only at a terminal with no CI and no coding agent", () => {
  assert.equal(Cli.formOf(true, {}), "human");
  assert.equal(Cli.formOf(true, { CLAUDECODE: "1" }), "json");
  assert.equal(Cli.formOf(true, { CI: "true" }), "json");
  assert.equal(Cli.formOf(true, { CLAUDECODE: "0" }), "human");
  assert.equal(Cli.formOf(false, {}), "json");
});

test("a formatter that throws, or a value that does not decode, gives the generic layout with the same exit code", async () => {
  const throws = App.format(level, () => {
    throw new Error("The formatter breaks.");
  });
  const otherSchema = App.format({ ...level, output: Schema.Struct({ name: Schema.String }) }, ({ name }) => name);
  const [thrown, notDecoded, formatted] = await Effect.runPromise(
    Effect.all([
      runHuman([throws], "probe", "level"),
      runHuman([otherSchema], "probe", "level"),
      runHuman([App.format(level, ({ level }) => `level ${level}`)], "probe", "level"),
    ]),
  );
  assert.deepEqual(thrown, { code: 0, stdout: "level  3", stderr: "" });
  assert.deepEqual(notDecoded, { code: 0, stdout: "level  3", stderr: "" });
  assert.deepEqual(formatted, { code: 0, stdout: "level 3", stderr: "" });
});

test("the command line stops when it starts if two formats have one id, or a format is not in the view", () => {
  const options = (formats: readonly App.Format[]) => ({ name: "probe", version: "0.0.0", output: { formats } });
  const format = App.format(level, ({ level }) => String(level));
  assert.throws(() => Cli.command(probe, options([format, format])), /There are two formats for probe.level/);
  const hidden = Capability.make({ id: "probe.hidden", description: "Hide.", audience: ["mcp"], run: () => Effect.succeed(null) });
  assert.throws(() => Cli.command(probe, options([App.format(hidden, () => "")])), /probe.hidden refers to a capability that is not in the view/);
  assert.throws(() => App.format(level, { failures: Object.fromEntries([["Bogus", () => "x"]]) }), /The capability probe.level has no failure Bogus\./);
});

test("the generic layout writes objects, tables and other arrays", () => {
  const value = {
    name: "unit",
    on: true,
    rooms: ["hall", "kitchen"],
    target: { celsius: 22, fan: null, empty: {} },
    readings: [
      { at: "07:00", celsius: 21.5 },
      { at: "08:00", humidity: 40 },
    ],
    events: [{ kind: "start", details: { by: "timer" } }, "stop", []],
    none: [],
    notes: [{ label: "a", note: null }],
  };
  const expected = [
    "name   unit",
    "on     true",
    "rooms  hall, kitchen",
    "target:",
    "  celsius  22",
    "  fan      null",
    "  empty:",
    "    (empty)",
    "readings:",
    "  at     celsius  humidity",
    "  07:00  21.5",
    "  08:00           40",
    "events:",
    "  - kind  start",
    "    details:",
    "      by  timer",
    "  - stop",
    "  - (none)",
    "none   (none)",
    "notes:",
    "  label  note",
    "  a      null",
  ].join("\n");
  assert.equal(Cli.layout(value), expected);
  assert.equal(Cli.layout(null), "");
});

const LEVEL_JSON = JSON.stringify({ level: 3 }, null, 2);

const LEVEL_TEXT = "level  3";

test("without the option output, the command line writes JSON, also on a terminal, and --output is an unknown argument", async () => {
  const [json, unknown] = await Effect.runPromise(Effect.all([runWith(undefined, ["probe", "level"], true), runWith(undefined, ["--output", "human", "probe", "level"], true)]));
  assert.deepEqual(json, { code: 0, stdout: LEVEL_JSON, stderr: "" });
  assert.deepEqual([unknown.code, unknown.stdout], [2, ""]);
});

test("output flags are anywhere in the arguments, the last one wins, and an output flag can take -h", async () => {
  const output: Cli.Output = {
    default: "json",
    flags: [
      { names: ["-h", "--human"], form: "human" },
      { names: ["--json", "--no-human"], form: "json" },
      { names: ["--format", "-f"], values: { text: "human", json: "json" } },
    ],
  };
  const [short, last, inline, missing, help] = await Effect.runPromise(
    Effect.all([
      runWith(output, ["-h", "probe", "level"]),
      runWith(output, ["probe", "level", "--human", "--json"]),
      runWith(output, ["probe", "level", "--format=text"]),
      runWith(output, ["probe", "level", "-f"]),
      runWith(output, ["--help"]),
    ]),
  );
  assert.deepEqual(short, { code: 0, stdout: LEVEL_TEXT, stderr: "" });
  assert.deepEqual(last, { code: 0, stdout: LEVEL_JSON, stderr: "" });
  assert.deepEqual(inline, { code: 0, stdout: LEVEL_TEXT, stderr: "" });
  assert.deepEqual(missing, { code: 3, stdout: "", stderr: "The option -f must be text or json." });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /USAGE/);
  assert.doesNotMatch(help.stdout, /--help, -h/);
  assert.match(
    help.stdout,
    /\n\nOUTPUT FLAGS\n {2}-h, --human {2}Write the human form\.\n {2}--json, --no-human {2}Write JSON\.\n {2}--format, -f <text\|json> {2}The form of the output: text is the human form and json is JSON\.$/,
  );
});

test("an application command gets its arguments unchanged and the chosen form, and output flags before its name choose the form", async () => {
  const seen: { readonly json: boolean; readonly file: string; readonly form: Cli.Form }[] = [];
  const deploy = Command.make("deploy", { json: Flag.Boolean("json"), file: Flag.String("file").pipe(Flag.withAlias("f")) }, ({ json, file }) =>
    Effect.gen(function* () {
      seen.push({ json, file, form: yield* Cli.outputForm });
    }),
  );
  const output: Cli.Output = {
    default: "json",
    flags: [
      { names: ["--json"], form: "json" },
      { names: ["--format", "-f"], values: { text: "human", json: "json" } },
    ],
  };
  await Effect.runPromise(runWith(output, ["deploy", "--json", "-f", "prod"], false, [deploy]));
  await Effect.runPromise(runWith(output, ["-f", "text", "deploy", "--json", "-f", "stage"], false, [deploy]));
  assert.deepEqual(seen, [
    { json: true, file: "prod", form: "json" },
    { json: true, file: "stage", form: "human" },
  ]);
});

test("output flags stop at --", () => {
  const flags = [{ names: ["--json"], form: "json" }] as const;
  assert.deepEqual(outputChoice(flags, ["probe", "level", "--json", "--", "--json"], []), { form: "json", args: ["probe", "level", "--", "--json"] });
});

test("the command line stops when it starts if an output flag has the name of a flag of effect/cli or of the application", async () => {
  const switchFlag = GlobalFlag.Setting("switch")({ flag: Flag.Boolean("switch") });
  const start = (name: string) => {
    const command = Cli.command(probe, { name: "probe", version: "0.0.0", output: { flags: [{ names: [name], form: "json" }] } }).pipe(Command.withGlobalFlags([switchFlag]));
    return Effect.runPromiseExit(Cli.runCommand(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)));
  };
  for (const name of ["--log-level", "--completions", "--switch", "--no-switch"]) {
    const exit = await start(name);
    assert.ok(Exit.isFailure(exit), `${name} stops the command line`);
    assert.match(Cause.pretty(exit.cause), new RegExp(`The output flag ${name} has the same name as a flag of the command line`));
  }
});

test("the default form is json, human, or auto from the terminal", async () => {
  const results = await Effect.runPromise(
    Effect.all([runWith({ default: "json" }, ["probe", "level"], true), runWith({ default: "human" }, ["probe", "level"]), runWith({}, ["probe", "level"], true), runWith({}, ["probe", "level"])]),
  );
  assert.deepEqual(
    results.map(({ stdout }) => stdout),
    [LEVEL_JSON, LEVEL_TEXT, LEVEL_TEXT, LEVEL_JSON],
  );
});

test("the command line stops when it starts if an output flag has a name that is not valid or that is taken", () => {
  const fails = (names: readonly string[], message: string) =>
    assert.throws(() => Cli.command(probe, { name: "probe", version: "0.0.0", output: { flags: [{ names, form: "json" }] } }), { message });
  fails(["--cursor"], "The output flag --cursor has the same name as the flag --cursor of watch.");
  fails(["--now"], "The output flag --now has the same name as the flag alias --now.");
  fails(["--litres"], "The output flag --litres has the same name as a flag of the capability probe.fill.");
  fails(["--json", "--json"], "The output flag --json has the same name as another output flag.");
  fails(["format"], "The output flag format is not a valid name. Give --<word> or -<letter or digit>.");
  fails(["-ab"], "The output flag -ab is not a valid name. Give --<word> or -<letter or digit>.");
  fails(["--version"], "The output flag --version has the same name as the flag --version.");
});
