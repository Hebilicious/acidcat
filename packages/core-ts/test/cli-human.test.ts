import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { cliLayout, cliOutputChoice, defaultCliOutput } from "../src/cli-human.ts";
import { cliAlias, cliFormat, defineApp, defineCapability, defineEvent, fail, ok, runCli } from "../src/index.ts";
import type { CliCommand, CliForm, CliFormat, CliOutput, ToJsonSchema } from "../src/index.ts";

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

const app = defineApp({ targets: { cli: { bindings: ["cli"], cli: { aliases: { "--now": cliAlias(clock) } } } }, capabilities: [read, clock], events: [tick] });

const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodType)) throw new Error("The probe has only Zod schemas.");
  return z.toJSONSchema(schema, { unrepresentable: "any" });
};

const runWith = async (output: CliOutput | undefined, args: readonly string[], terminal?: CliForm, commands?: readonly CliCommand<{}>[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(app, { name: "probe", version: "0.0.0", context: {}, toJsonSchema, output, commands }, args, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    output: terminal,
  });
  return { code, out, err };
};

const run = async (formats: readonly CliFormat[], args: readonly string[]) => await runWith({ default: "auto", formats }, args, "human");

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

const PROBE_JSON = JSON.stringify({ name: "attic", celsius: 21 }, null, 2);

const PROBE_TEXT = "name     attic\ncelsius  21";

test("without the option output, the command line writes JSON, also on a terminal, and --output is an unknown argument", async () => {
  assert.deepEqual(await runWith(undefined, ["probe", "read"], "human"), { code: 0, out: [PROBE_JSON], err: [] });
  assert.deepEqual(await runWith(undefined, ["--output", "human", "probe", "read"], "human"), { code: 2, out: [], err: ["There is no command human probe read."] });
});

test("output flags are anywhere in the arguments, the last one wins, and an output flag can take -h", async () => {
  const output: CliOutput = {
    default: "json",
    flags: [
      { names: ["-h", "--human"], form: "human" },
      { names: ["--json", "--no-human"], form: "json" },
      { names: ["--format", "-f"], values: { text: "human", json: "json" } },
    ],
  };
  assert.deepEqual(await runWith(output, ["-h", "probe", "read"]), { code: 0, out: [PROBE_TEXT], err: [] });
  assert.deepEqual(await runWith(output, ["probe", "read", "--human", "--json"]), { code: 0, out: [PROBE_JSON], err: [] });
  assert.deepEqual(await runWith(output, ["probe", "read", "--format=text"]), { code: 0, out: [PROBE_TEXT], err: [] });
  assert.deepEqual(await runWith(output, ["probe", "read", "-f"]), { code: 3, out: [], err: ["The option -f must be text or json."] });
  const help = await runWith(output, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out.join("\n"), /^Usage: probe <command> \[flags\]$/m);
  assert.match(
    help.out.join("\n"),
    /\n\nOutput:\n {2}-h, --human {2}Write the human form\.\n {2}--json, --no-human {2}Write JSON\.\n {2}--format, -f <text\|json> {2}The form of the output: text is the human form and json is JSON\.$/,
  );
});

test("an application command gets its arguments unchanged and the chosen form, and output flags before its name choose the form", async () => {
  const seen: { readonly args: readonly string[]; readonly output: CliForm | undefined }[] = [];
  const deploy: CliCommand<{}> = {
    name: "deploy",
    description: "Deploy the probe.",
    run: (args, io) => {
      seen.push({ args, output: io.output });
      return 0;
    },
  };
  const output: CliOutput = {
    default: "json",
    flags: [
      { names: ["--json"], form: "json" },
      { names: ["--format", "-f"], values: { text: "human", json: "json" } },
    ],
  };
  await runWith(output, ["deploy", "--json", "-f", "prod"], undefined, [deploy]);
  await runWith(output, ["-f", "text", "deploy", "--json"], undefined, [deploy]);
  assert.deepEqual(seen, [
    { args: ["--json", "-f", "prod"], output: "json" },
    { args: ["--json"], output: "human" },
  ]);
});

test("output flags stop at --", () => {
  const flags = [{ names: ["--json"], form: "json" }] as const;
  assert.deepEqual(cliOutputChoice(flags, ["probe", "read", "--json", "--", "--json"], []), { form: "json", args: ["probe", "read", "--", "--json"] });
});

test("the default form is json, and auto gives the human form only on a terminal", async () => {
  const human = [{ names: ["--human"], form: "human" }] as const;
  assert.deepEqual(await runWith({ flags: human }, ["probe", "read"], "human"), { code: 0, out: [PROBE_JSON], err: [] });
  assert.deepEqual(await runWith({ flags: human }, ["probe", "read", "--human"], "human"), { code: 0, out: [PROBE_TEXT], err: [] });
  assert.deepEqual(await runWith({ default: "auto" }, ["probe", "read"], "human"), { code: 0, out: [PROBE_TEXT], err: [] });
  assert.deepEqual(await runWith({ default: "auto" }, ["probe", "read"]), { code: 0, out: [PROBE_JSON], err: [] });
});

test("the command line stops when it starts if an output flag has a name that is not valid or that is taken", async () => {
  const fails = (names: readonly string[], message: string) => assert.rejects(runWith({ flags: [{ names, form: "json" }] }, ["probe", "read"]), { message });
  await fails(["--cursor"], "The output flag --cursor has the same name as the flag --cursor of watch.");
  await fails(["--now"], "The output flag --now has the same name as the flag alias --now.");
  await fails(["--broken"], "The output flag --broken has the same name as a flag of the capability probe.read.");
  await fails(["--json", "--json"], "The output flag --json has the same name as another output flag.");
  await fails(["format"], "The output flag format is not a valid name. Give --<word> or -<letter or digit>.");
  await fails(["-ab"], "The output flag -ab is not a valid name. Give --<word> or -<letter or digit>.");
  await fails(["--version"], "The output flag --version has the same name as the flag --version.");
});
