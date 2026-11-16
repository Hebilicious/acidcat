import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { cliLayout, defaultCliOutput } from "../src/cli-human.ts";
import { cliFormat, defineApp, defineCapability, defineEvent, fail, ok, runCli } from "../src/index.ts";
import type { CliFormat, ToJsonSchema } from "../src/index.ts";

const Probe = z.object({ name: z.string(), celsius: z.number() });
const Broken = z.object({ _tag: z.literal("Broken"), part: z.string() });

const read = defineCapability({
  id: "probe.read",
  description: "Read the probe.",
  audience: ["cli"],
  input: z.object({ broken: z.boolean().optional() }),
  output: Probe,
  failures: { Broken },
  run: ({ broken }) => (broken === true ? fail({ _tag: "Broken", part: "sensor" }) : ok({ name: "attic", celsius: 21 })),
});

const clock = defineCapability({ id: "probe.clock", description: "Read the clock of the probe.", audience: ["cli"], output: z.date(), run: () => ok(new Date(0)) });

const tick = defineEvent({
  id: "probe.tick",
  description: "A tick of the probe occurred.",
  audience: ["cli"],
  async *subscribe() {
    yield { data: {} };
  },
});

const app = defineApp({ targets: { cli: { bindings: ["cli"] } }, capabilities: [read, clock], events: [tick] });

const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodType)) throw new Error("The probe has only Zod schemas.");
  return z.toJSONSchema(schema, { unrepresentable: "any" });
};

const run = async (formats: readonly CliFormat[], args: readonly string[]) => {
  const out: string[] = [];
  const code = await runCli(app, { name: "probe", version: "0.0.0", context: {}, toJsonSchema, formats }, ["--output", "human", ...args], {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
  });
  return { code, out };
};

const writes = async (formats: readonly CliFormat[], ...args: string[]) => (await run(formats, args)).out;

const cli = async (formats: readonly CliFormat[], ...args: string[]) => {
  const { code, out } = await run(formats, args);
  return { code, stdout: out.join("\n") };
};

test("the form of the output is human only on a terminal, with no CI and no coding agent", () => {
  assert.equal(defaultCliOutput(true, {}), "human");
  assert.equal(defaultCliOutput(true, { CLAUDECODE: "1" }), "json");
  assert.equal(defaultCliOutput(true, { CI: "true" }), "json");
  assert.equal(defaultCliOutput(true, { CLAUDECODE: "0" }), "human");
  assert.equal(defaultCliOutput(false, {}), "json");
});

test("a formatter that throws, and a value that does not decode, give the generic layout with the same exit code", async () => {
  const throwing = [
    cliFormat(read, {
      value: () => {
        throw new Error("The formatter failed.");
      },
      failures: {
        Broken: () => {
          throw new Error("The formatter failed.");
        },
      },
    }),
    cliFormat(clock, () => "a date"),
  ];
  assert.deepEqual(await cli(throwing, "probe", "read"), { code: 0, stdout: "name     attic\ncelsius  21" });
  assert.deepEqual(await cli(throwing, "probe", "read", "--broken"), { code: 1, stdout: "_tag  Broken\npart  sensor" });
  assert.deepEqual(await cli(throwing, "probe", "clock"), { code: 0, stdout: "1970-01-01T00:00:00.000Z" }, "the JSON form of a date is not a date");
});

test("the formatter of an event with no payload schema gets an empty object, and an empty text writes nothing", async () => {
  assert.deepEqual(await writes([cliFormat(tick, () => "tick!")], "watch", "probe.tick"), ["tick!"]);
  assert.deepEqual(await writes([cliFormat(read, () => "")], "probe", "read"), []);
});

test("two formats for one id, and a formatter of an unknown failure, are errors", async () => {
  await assert.rejects(cli([cliFormat(read, () => "one"), cliFormat(read, () => "two")], "probe", "read"), /Two formats are for probe\.read/);
  assert.throws(() => cliFormat(read, { failures: Object.fromEntries([["Bogus", () => "x"]]) }), /The capability probe\.read has no failure Bogus\./);
});

test("a formatter has the types of the value and the failures of its capability", () => {
  const wrong = () => [
    // @ts-expect-error probe.read has no failure Brokn.
    cliFormat(read, { failures: { Brokn: () => "" } }),
    // @ts-expect-error probe.clock has no failures.
    cliFormat(clock, { failures: { Bogus: () => "" } }),
    // @ts-expect-error The value of probe.read has no property kelvin.
    cliFormat(read, (probe) => String(probe.kelvin)),
  ];
  void wrong;
});

test("the generic layout writes nested objects, tables and other arrays", () => {
  const value = {
    name: "attic",
    on: true,
    tags: ["roof", "dry"],
    limits: { low: 5, high: null, alarms: [] },
    readings: [
      { at: "07:00", celsius: 18.5 },
      { at: "12:00", celsius: 24, note: ["sun", "open"] },
    ],
    log: [{ event: "start", detail: { by: "timer" } }, "restart"],
    extra: {},
    notes: [{ label: "a", note: null }],
  };
  assert.equal(
    cliLayout(value),
    [
      "name  attic",
      "on    true",
      "tags  roof, dry",
      "limits:",
      "  low     5",
      "  high    null",
      "  alarms  (none)",
      "readings:",
      "  at     celsius  note",
      "  07:00  18.5",
      "  12:00  24       sun, open",
      "log:",
      "  - event  start",
      "    detail:",
      "      by  timer",
      "  - restart",
      "extra:",
      "  (empty)",
      "notes:",
      "  label  note",
      "  a      null",
    ].join("\n"),
  );
  assert.equal(cliLayout(null), "");
});
