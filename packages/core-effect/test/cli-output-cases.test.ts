import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Schema } from "effect";

import { formOf, outputChoice, outputErrors } from "../src/internal/human.ts";

const Form = Schema.Literals(["human", "json"]);
const Words = Schema.Array(Schema.String);
const Flag = Schema.Union([Schema.Struct({ names: Words, form: Form }), Schema.Struct({ names: Words, values: Schema.Record(Schema.String, Form) })]);
const Cases = Schema.Struct({
  auto: Schema.Array(Schema.Struct({ isTerminal: Schema.Boolean, env: Schema.Record(Schema.String, Schema.String), form: Form })),
  problems: Schema.Struct({
    others: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    cases: Schema.Array(Schema.Struct({ flags: Schema.Array(Flag), messages: Words })),
  }),
  choices: Schema.Struct({
    flags: Schema.Array(Flag),
    cases: Schema.Array(
      Schema.Union([
        Schema.Struct({ args: Words, commands: Words, error: Schema.String }),
        Schema.Struct({ args: Words, commands: Words, form: Schema.NullOr(Form), rest: Words }),
      ]),
    ),
  }),
});

const cases = Schema.decodeUnknownSync(Schema.fromJsonString(Cases))(readFileSync(new URL("fixtures/cli-output-cases.json", import.meta.url), "utf8"));

test("the automatic form gives the form of the model in each case", () => {
  for (const { isTerminal, env, form } of cases.auto) assert.equal(formOf(isTerminal, env), form, JSON.stringify({ isTerminal, env }));
});

test("the check of the output flags gives the messages of the model in each case", () => {
  const others = new Map(cases.problems.others);
  for (const { flags, messages } of cases.problems.cases) assert.deepEqual(outputErrors(flags, others), messages, JSON.stringify(flags));
});

test("the output flags in the arguments give the form, the arguments or the error of the model in each case", () => {
  const { flags } = cases.choices;
  for (const expected of cases.choices.cases) {
    const wanted = "error" in expected ? { error: expected.error } : { form: expected.form ?? undefined, args: expected.rest };
    assert.deepEqual(outputChoice(flags, expected.args, expected.commands), wanted, JSON.stringify(expected));
  }
});
