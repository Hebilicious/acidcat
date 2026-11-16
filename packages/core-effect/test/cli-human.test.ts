import assert from "node:assert/strict";
import { test } from "node:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Layer, Schema, Stdio } from "effect";

import { App, Capability, Cli } from "../src/index.ts";

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

const probe = App.make({ targets: { cli: { bindings: ["cli"] } }, capabilities: [level] });

const runHuman = (formats: readonly App.Format[], ...args: string[]) =>
  Effect.gen(function* () {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const captured = { ...console, log: (text: string) => stdout.push(text), error: (text: string) => stderr.push(text) };
    const before = process.exitCode;
    yield* Cli.run(probe, { name: "probe", version: "0.0.0", formats }).pipe(
      Effect.provideService(Console.Console, captured),
      Effect.provide(Layer.provideMerge(Layer.effect(Stdio.Stdio, Effect.map(Effect.service(Stdio.Stdio), (stdio) => ({ ...stdio, args: Effect.succeed(args) }))), NodeServices.layer)),
    );
    const code = process.exitCode;
    process.exitCode = before;
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  });

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
      runHuman([throws], "--output", "human", "probe", "level"),
      runHuman([otherSchema], "--output", "human", "probe", "level"),
      runHuman([App.format(level, ({ level }) => `level ${level}`)], "--output", "human", "probe", "level"),
    ]),
  );
  assert.deepEqual(thrown, { code: 0, stdout: "level  3", stderr: "" });
  assert.deepEqual(notDecoded, { code: 0, stdout: "level  3", stderr: "" });
  assert.deepEqual(formatted, { code: 0, stdout: "level 3", stderr: "" });
});

test("the command line stops when it starts if two formats have one id, or a format is not in the view", () => {
  const options = (formats: readonly App.Format[]) => ({ name: "probe", version: "0.0.0", formats });
  const format = App.format(level, ({ level }) => String(level));
  assert.throws(() => Cli.command(probe, options([format, format])), /There are two formats for probe.level/);
  const hidden = Capability.make({ id: "probe.hidden", description: "Hide.", audience: ["mcp"], run: () => Effect.succeed(null) });
  assert.throws(() => Cli.command(probe, options([App.format(hidden, () => "")])), /probe.hidden refers to a capability that is not in the view/);
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
  ].join("\n");
  assert.equal(Cli.layout(value), expected);
  assert.equal(Cli.layout(null), "");
});
