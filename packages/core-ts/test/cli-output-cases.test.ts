import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";

import { cliOutputChoice, cliOutputErrors, cliOutputFlagHelp, cliOutputRun, defaultCliOutput } from "../src/cli-human.ts";
import type { CliOutputFlag } from "../src/cli-human.ts";

const Form = z.enum(["human", "json"]);
const Words = z.array(z.string());
const Env = z.record(z.string(), z.string());
const Flag = z
  .union([z.object({ names: Words, form: Form }), z.object({ names: Words, values: z.array(z.tuple([z.string(), Form])) })])
  .transform((flag): CliOutputFlag => ("form" in flag ? flag : { names: flag.names, values: Object.fromEntries(flag.values) }));
const Cases = z.object({
  auto: z.array(z.object({ isTerminal: z.boolean(), env: Env, form: Form })),
  problems: z.object({ others: z.array(z.tuple([z.string(), z.string()])), cases: z.array(z.object({ flags: z.array(Flag), messages: Words })) }),
  choices: z.object({
    flags: z.array(Flag),
    cases: z.array(
      z.union([
        z.object({ args: Words, commands: Words, error: z.string() }),
        z.object({ args: Words, commands: Words, form: Form.nullable(), rest: Words }),
      ]),
    ),
  }),
  decisions: z.object({
    flags: z.array(Flag),
    cases: z.array(
      z.intersection(
        z.object({ default: z.enum(["auto", "json"]), isTerminal: z.boolean(), env: Env, args: Words }),
        z.union([z.object({ exitCode: z.number(), error: z.string() }), z.object({ form: Form, rest: Words })]),
      ),
    ),
  }),
  help: z.array(z.object({ flag: Flag, line: z.string() })),
});

const cases = Cases.parse(JSON.parse(readFileSync(new URL("fixtures/cli-output-cases.json", import.meta.url), "utf8")));

test("the automatic form gives the form of the model in each case", () => {
  for (const { isTerminal, env, form } of cases.auto) assert.equal(defaultCliOutput(isTerminal, env), form, JSON.stringify({ isTerminal, env }));
});

test("the check of the output flags gives the messages of the model in each case", () => {
  const others = new Map(cases.problems.others);
  for (const { flags, messages } of cases.problems.cases) assert.deepEqual(cliOutputErrors(flags, others), messages, JSON.stringify(flags));
});

test("the output flags in the arguments give the form, the arguments or the error of the model in each case", () => {
  const { flags } = cases.choices;
  for (const expected of cases.choices.cases) {
    const wanted = "error" in expected ? { error: expected.error } : { form: expected.form ?? undefined, args: expected.rest };
    assert.deepEqual(cliOutputChoice(flags, expected.args, expected.commands), wanted, JSON.stringify(expected));
  }
});

test("the output flag, the default and the automatic form give the form or the exit code of the model in each case", () => {
  const { flags } = cases.decisions;
  for (const expected of cases.decisions.cases) {
    const wanted = "error" in expected ? { exitCode: expected.exitCode, error: expected.error } : { form: expected.form, args: expected.rest };
    const actual = cliOutputRun(flags, expected.args, [], expected.default, () => defaultCliOutput(expected.isTerminal, expected.env));
    assert.deepEqual(actual, wanted, JSON.stringify(expected));
  }
});

test("the help of each output flag is the line of the model", () => {
  for (const { flag, line } of cases.help) assert.equal(cliOutputFlagHelp(flag), line, JSON.stringify(flag));
});
