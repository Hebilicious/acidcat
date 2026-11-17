import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";

import { cliOutputChoice, cliOutputErrors, defaultCliOutput } from "../src/cli-human.ts";

const Form = z.enum(["human", "json"]);
const Flag = z.union([z.object({ names: z.array(z.string()), form: Form }), z.object({ names: z.array(z.string()), values: z.record(z.string(), Form) })]);
const Words = z.array(z.string());
const Cases = z.object({
  auto: z.array(z.object({ isTerminal: z.boolean(), env: z.record(z.string(), z.string()), form: Form })),
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
