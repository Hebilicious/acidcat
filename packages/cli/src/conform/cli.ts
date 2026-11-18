import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isArrayOf, isObject, memberOf, parseJson } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { abortable, Checks, eventIdsOf, expect, expectEqual, expectOccurrence, idsOf, sorted, until } from "./check.ts";
import type { Define } from "./check.ts";

const RULE = "spec/bindings/cli.md";

const USAGES: { readonly [id: string]: string } = {
  "fixture.crash": "fixture crash",
  "fixture.echo": "fixture echo --text <string>",
  "fixture.flags": "fixture flags --mode <fast|slow> [--count <integer>] [--extra <json>] [--label <string>] [--ratio <number>] [--steps <integer>...] [--tags <string>...] [--verbose]",
  "fixture.held": "fixture held",
  "fixture.hold": "fixture hold --key <string> [--marker <string>]",
  "fixture.note": "fixture note --text <string> [--loud]",
  "fixture.raw": "call fixture.raw '<json>'",
  "fixture.refuse": "fixture refuse",
  "fixture.release": "fixture release --key <string>",
  "fixture.switch.set": "fixture switch set --on",
  "fixture.toggle": "fixture toggle",
  "fixture.signal": "fixture signal --key <string> --value <string>",
  "fixture.watching": "fixture watching",
};

const EVENT_USAGES: { readonly [id: string]: string } = {
  "fixture.broken": "watch fixture.broken [--cursor <string>] [--max-age-ms <integer>]",
  "fixture.echoes": "watch fixture.echoes '<json>' [--cursor <string>] [--max-age-ms <integer>]",
  "fixture.ticks": "watch fixture.ticks --count <integer> [--gap <integer>] [--key <string>] [--cursor <string>] [--max-age-ms <integer>]",
  "fixture.watch": "watch fixture.watch --key <string> [--marker <string>] [--cursor <string>] [--max-age-ms <integer>]",
};

const ALIAS_USAGES: { readonly [id: string]: readonly string[] } = {
  "fixture.echo": ["--hello", "say --text <string>", "shout hello"],
  "fixture.flags": [
    "fixture [--count <integer>] [--extra <json>] [--label <string>] [--ratio <number>] [--steps <integer>...] [--tags <string>...] [--verbose]",
    "quick [--count <integer>] [--extra <json>] [--label <string>] [--ratio <number>] [--steps <integer>...] [--tags <string>...] [--verbose]",
  ],
  "fixture.held": ["held-keys"],
  "fixture.note": ["fixed-note [--loud]", "notes add --text <string> [--loud]", "notes loud --text <string>"],
  "fixture.raw": ["notes '<json>'", "raw '<json>'"],
};

const EVENT_ALIAS_USAGES: { readonly [id: string]: readonly string[] } = {
  "fixture.broken": ["broken-ticks [--cursor <string>] [--max-age-ms <integer>]"],
  "fixture.echoes": ["echoes '<json>' [--cursor <string>] [--max-age-ms <integer>]"],
  "fixture.ticks": ["ticks [--gap <integer>] [--key <string>] [--cursor <string>] [--max-age-ms <integer>]"],
};

const ALIASES = `${RULE}#aliases`;

type Entry = JsonObject & { readonly id: string };

const isEntry = (value: unknown): value is Entry => isObject(value) && typeof value.id === "string";

function entriesOf(stdout: string): readonly Entry[] {
  const list = parseJson(stdout);
  if (!isArrayOf(list, isEntry)) throw new Error(`list must give a list of objects with an id, got ${JSON.stringify(list)}`);
  return list;
}

interface Run {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The rejection is observed here too, so that a check that stops waiting first, for example at the deadline, records a
 * failure and does not end the process with an unhandled rejection.
 */
function start(command: readonly string[], args: readonly string[], signal: AbortSignal) {
  const [program, ...programArgs] = command;
  if (program === undefined) throw new Error("the command that starts the command line is empty");
  const child = spawn(program, [...programArgs, ...args], { stdio: ["ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL" });
  const run = new Promise<Run>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(signal.aborted ? new Error(`waiting until the command line exits: ${args.join(" ")}`) : error));
    child.on("close", (code, exitSignal) => resolve({ code, signal: exitSignal, stdout, stderr }));
  });
  run.catch(() => undefined);
  return { child, run };
}

async function expectUsageError(result: Promise<Run>, code: number): Promise<void> {
  const { code: actual, stdout } = await result;
  expectEqual(actual, code, "exit code");
  expectEqual(stdout, "", "standard output");
}

function occurrencesIn(stdout: string, id: string) {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => expectOccurrence(parseJson(line), id));
}

type Listed = (signal: AbortSignal) => Promise<readonly Entry[]>;

export async function checkCli(command: readonly string[], options: { readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("cli", options.deadline);
  const run = (signal: AbortSignal, ...args: string[]) => start(command, args, signal).run;
  const listing = start(command, ["list"], AbortSignal.timeout(options.deadline)).run.then((result) => entriesOf(result.stdout));
  listing.catch(() => undefined);
  const listed: Listed = (signal) => abortable(listing, signal);

  await checks.concurrently((check) => {
    check("a value goes to standard output with exit code 0", `${RULE}#outcomes`, async (signal) => {
      const result = await run(signal, "fixture", "echo", "--text", "hello");
      expectEqual(result.code, 0, "exit code");
      expectEqual(parseJson(result.stdout), { text: "hello" }, "standard output");
    });
    check("a failure goes to standard output with exit code 1", `${RULE}#outcomes`, async (signal) => {
      const result = await run(signal, "fixture", "refuse");
      expectEqual(result.code, 1, "exit code");
      expectEqual(memberOf(parseJson(result.stdout), "_tag"), "Refused", "_tag");
    });
    check("a defect goes to standard error with exit code 5", `${RULE}#outcomes`, async (signal) => {
      const result = await run(signal, "fixture", "crash");
      expectEqual(result.code, 5, "exit code");
      expect(/"kind":"internal"/.test(result.stderr), "standard error must contain the call failure");
    });
    for (const [name, args, code] of [
      ["an unknown command has exit code 2", ["nothing"], 2],
      ["an unknown word after an alias that is the default of a shared prefix has exit code 2", ["fixture", "nope"], 2],
      ["the first word of two-word aliases alone, with no one-word alias, has exit code 2", ["shout"], 2],
      ["an unknown second word after the first word of two-word aliases has exit code 2", ["shout", "nope"], 2],
      ["an unknown second word after a one-word alias with two-word aliases has exit code 2", ["notes", "nope"], 2],
      ["a capability outside the view has exit code 2", ["call", "fixture.hidden"], 2],
      ["a capability outside the view with input that is not JSON has exit code 2", ["call", "fixture.hidden", "{bad"], 2],
      ["a missing required flag has exit code 3", ["fixture", "echo"], 3],
      ["an unknown flag has exit code 3", ["fixture", "echo", "--text", "hello", "--nope", "x"], 3],
      ["a flag that is not valid has exit code 3", ["fixture", "flags", "--mode", "fast", "--ratio", "soon"], 3],
      ["an item of a repeated flag that is not valid has exit code 3", ["fixture", "flags", "--mode", "fast", "--steps", "1", "--steps", "soon"], 3],
      ["an item of a repeated flag as JSON text that is not valid has exit code 3", ["fixture", "flags", "--mode", "fast", "--steps", '[1,"soon"]'], 3],
      ["invalid input through call has exit code 3", ["call", "fixture.echo", '{"text":1}'], 3],
    ] as const) {
      check(name, `${RULE}#outcomes`, async (signal) => {
        await expectUsageError(run(signal, ...args), code);
      });
    }
  });
  await checks.run("an interrupt cancels the call with exit code 130", `${RULE}#commands`, async (signal) => {
    const directory = await mkdtemp(join(tmpdir(), "acid-cat-conform-"));
    const marker = join(directory, "held");
    try {
      const { child, run } = start(command, ["fixture", "hold", "--key", "interrupt", "--marker", marker], signal);
      const ended = () => child.exitCode !== null || child.signalCode !== null;
      const state = await until("the call writes its marker file", async () => (existsSync(marker) ? "marked" : ended() ? "ended" : "waiting"), (each) => each !== "waiting", signal);
      if (state === "marked") child.kill("SIGINT");
      const result = await run;
      expect(state === "marked", `the call must hold before the interrupt, but the command line ended with ${result.code}: ${result.stderr}`);
      expect(result.signal === null, `the process must exit, not end by the signal ${result.signal}`);
      expectEqual(result.code, 130, "exit code");
      expectEqual(result.stdout, "", "standard output");
      await until("the call ends and deletes its marker file", async () => !existsSync(marker), (ended) => ended, signal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await checks.concurrently((check) => {
    check("each flag gives the value of its property, and a repeated flag gives one item for each occurrence", `${RULE}#commands`, async (signal) => {
      const scalars = ["--mode", "slow", "--count", "3", "--ratio=0.5", "--label", "x", "--verbose", "--extra", '{"a":1}'];
      const repeated = ["--steps", "2", "--tags", '["a"]', "--steps=1", "--tags", "b"];
      const result = await run(signal, "fixture", "flags", ...scalars, ...repeated);
      expectEqual(result.code, 0, "exit code");
      const expected = { mode: "slow", count: 3, ratio: 0.5, label: "x", verbose: true, extra: { a: 1 }, steps: [2, 1], tags: ['["a"]', "b"] };
      // The order of the members of an object has no meaning in JSON.
      const output = parseJson(result.stdout);
      expect(isDeepStrictEqual(output, expected), `standard output: expected ${JSON.stringify(expected)}, got ${JSON.stringify(output)}`);
    });
    check("a repeated flag that occurs once with JSON text of an array gives that array", `${RULE}#commands`, async (signal) => {
      const result = await run(signal, "fixture", "flags", "--steps", "[2,1]", "--mode", "fast", "--verbose", '--tags=["a","b"]');
      expectEqual(result.code, 0, "exit code");
      const expected = { mode: "fast", verbose: true, steps: [2, 1], tags: ["a", "b"] };
      const output = parseJson(result.stdout);
      expect(isDeepStrictEqual(output, expected), `standard output: expected ${JSON.stringify(expected)}, got ${JSON.stringify(output)}`);
    });
    check("a first argument -- is ignored", `${RULE}#commands`, async (signal) => {
      const result = await run(signal, "--", "fixture", "echo", "--text", "hello");
      expectEqual(result.code, 0, `exit code, with standard error ${JSON.stringify(result.stderr)}`);
      expectEqual(parseJson(result.stdout), { text: "hello" }, "standard output");
    });
    check("call gives the value of a capability", `${RULE}#commands`, async (signal) => {
      const result = await run(signal, "call", "fixture.echo", '{"text":"hello"}');
      expectEqual(result.code, 0, "exit code");
      expectEqual(parseJson(result.stdout), { text: "hello" }, "standard output");
    });
    check("list gives the view: the capabilities, then the events", `${RULE}#commands`, async (signal) => {
      const entries = await listed(signal);
      const ids = (kind: string) => entries.filter((entry) => entry.kind === kind).map((entry) => entry.id);
      expectEqual(sorted(ids("capability")), idsOf("cli"), "the ids of the items with kind: capability");
      expectEqual(sorted(ids("event")), eventIdsOf("cli"), "the ids of the items with kind: event");
      expectEqual(entries.length, ids("capability").length + ids("event").length, "the number of items with a kind");
      const firstEvent = entries.findIndex((entry) => entry.kind === "event");
      expect(firstEvent === -1 || entries.slice(firstEvent).every((entry) => entry.kind === "event"), "the events must come after the capabilities");
    });
    check("list gives the usage of each capability and each event, with its flags", `${RULE}#commands`, async (signal) => {
      const entries = await listed(signal);
      for (const { id, kind, usage } of entries) {
        expect(typeof usage === "string", `${id} must have a usage`);
        const [program, ...rest] = usage.split(" ");
        expect(program !== "" && rest.length > 0, `the usage of ${id} must start with the name of the program, got ${JSON.stringify(usage)}`);
        expectEqual(rest.join(" "), kind === "event" ? EVENT_USAGES[id] : USAGES[id], `usage of ${id} after the name of the program`);
      }
    });
    checkHelp(check, command, listed);
    checkAliases(check, command, listed);
    checkWatch(check, command);
  });
  await checkWatchInterrupt(checks, command);
  return checks;
}

function checkHelp(check: Define, command: readonly string[], listed: Listed): void {
  const run = (signal: AbortSignal, ...args: string[]) => start(command, args, signal).run;
  const entry = (entries: readonly Entry[], id: string) => {
    const found = entries.find((each) => each.id === id);
    if (found === undefined || typeof found.usage !== "string" || typeof found.description !== "string") throw new Error(`list must give ${id} with its usage and its description`);
    return { usage: found.usage, description: found.description, aliases: isArrayOf(found.aliases, (alias) => typeof alias === "string") ? found.aliases : [] };
  };
  const expectHelp = (result: Run, usage: string, description: string) => {
    expectEqual(result.code, 0, `exit code, with standard error ${JSON.stringify(result.stderr)}`);
    expectEqual(result.stdout, `Usage: ${usage}\n\n${description}\n`, "standard output");
    expectEqual(result.stderr, "", "standard error");
  };
  const commandList = (entries: readonly Entry[], prefix: string) =>
    ["Commands:", ...entries.filter((each) => each.kind === "capability" && each.id.startsWith(`${prefix}.`)).map((each) => `  ${String(each.usage)}`), ""].join("\n");

  check("--help after the path of a command writes the help of the capability", `${RULE}#commands`, async (signal) => {
    const entries = await listed(signal);
    const helps = ["fixture.raw", "fixture.switch.set"].map((id) => ({ id, args: [...id.split("."), "--help"] }));
    helps.push({ id: "fixture.echo", args: ["fixture", "echo", "--text", "hello", "--help"] });
    await Promise.all(
      helps.map(async ({ id, args }) => {
        const { usage, description } = entry(entries, id);
        expectHelp(await run(signal, ...args), usage, description);
      }),
    );
  });
  check("--help after the name of an alias writes the help of the alias", ALIASES, async (signal) => {
    const entries = await listed(signal);
    await Promise.all(
      ([["say", "fixture.echo"], ["notes add", "fixture.note"], ["ticks", "fixture.ticks"]] as const).map(async ([name, id]) => {
        const { aliases, description } = entry(entries, id);
        const usage = aliases.find((each) => {
          const rest = each.split(" ").slice(1).join(" ");
          return rest === name || rest.startsWith(`${name} `);
        });
        expect(usage !== undefined, `list must give the usage of the alias ${name} of ${id}`);
        expectHelp(await run(signal, ...name.split(" "), "--help"), usage, description);
      }),
    );
  });
  check("--help after watch and the id of an event writes the help of the event", `${RULE}#events`, async (signal) => {
    const { usage, description } = entry(await listed(signal), "fixture.ticks");
    expectHelp(await run(signal, "watch", "fixture.ticks", "--help"), usage, description);
  });
  check("--help after a shared prefix writes its command list to standard output", `${RULE}#commands`, async (signal) => {
    const entries = await listed(signal);
    const result = await run(signal, "fixture", "switch", "--help");
    expectEqual(result.code, 0, `exit code, with standard error ${JSON.stringify(result.stderr)}`);
    expectEqual(result.stdout, commandList(entries, "fixture.switch"), "standard output of fixture switch --help");
    expectEqual(result.stderr, "", "standard error");
  });
  const expectUnknown = async (signal: AbortSignal, ...args: string[]) => {
    const entries = await listed(signal);
    const result = await run(signal, ...args);
    expectEqual(result.code, 2, "exit code");
    expectEqual(result.stdout, "", "standard output");
    expectEqual(result.stderr, commandList(entries, "fixture.switch"), "standard error");
  };
  check("a shared prefix alone writes its command list to standard error with exit code 2", `${RULE}#commands`, (signal) =>
    expectUnknown(signal, "fixture", "switch"),
  );
  check("a shared prefix and a flag that is not --help write its command list to standard error with exit code 2", `${RULE}#commands`, (signal) =>
    expectUnknown(signal, "fixture", "switch", "--on"),
  );
}

function checkAliases(check: Define, command: readonly string[], listed: Listed): void {
  const run = (signal: AbortSignal, ...args: string[]) => start(command, args, signal).run;
  const expectOutput = (result: Run, expected: JsonObject) => {
    expectEqual(result.code, 0, `exit code, with standard error ${JSON.stringify(result.stderr)}`);
    const output = parseJson(result.stdout);
    expect(isDeepStrictEqual(output, expected), `standard output: expected ${JSON.stringify(expected)}, got ${JSON.stringify(output)}`);
  };

  check("a command alias calls its capability with the flags", ALIASES, async (signal) => {
    expectOutput(await run(signal, "say", "--text", "hi"), { text: "hi" });
  });
  check("a flag alias calls its capability with its fixed input", ALIASES, async (signal) => {
    expectOutput(await run(signal, "--hello"), { text: "hello" });
  });
  check("the input of an alias is its fixed input with the properties of the flags", ALIASES, async (signal) => {
    expectOutput(await run(signal, "quick", "--count", "2", "--steps", "1", "--steps", "2"), { mode: "fast", count: 2, steps: [1, 2] });
  });
  check("an alias of a capability whose input schema has no properties takes the input as JSON text", ALIASES, async (signal) => {
    expectOutput(await run(signal, "raw", '{"a":[1]}'), { a: [1] });
    expectOutput(await run(signal, "raw"), {});
  });
  check("the flags of an alias come from the type that the $ref of the input schema refers to, whatever other keys it has", ALIASES, async (signal) => {
    expectOutput(await run(signal, "fixed-note"), { text: "fixed" });
    expectOutput(await run(signal, "fixed-note", "--loud"), { text: "fixed", loud: true });
  });
  check("an alias of a capability with no input takes no argument", ALIASES, async (signal) => {
    const result = await run(signal, "held-keys");
    expectEqual(result.code, 0, `exit code, with standard error ${JSON.stringify(result.stderr)}`);
    expect(isArrayOf(memberOf(parseJson(result.stdout), "keys"), (key) => typeof key === "string"), `standard output must have the keys, got ${result.stdout}`);
  });
  check("a two-word alias calls its capability with the flags", ALIASES, async (signal) => {
    expectOutput(await run(signal, "notes", "add", "--text", "hi"), { text: "hi" });
  });
  check("the input of a two-word alias is its fixed input with the properties of the flags", ALIASES, async (signal) => {
    expectOutput(await run(signal, "notes", "loud", "--text", "hi"), { text: "hi", loud: true });
    expectOutput(await run(signal, "shout", "hello"), { text: "HELLO" });
  });
  check("a one-word alias runs when the second argument is not the second word of a two-word alias", ALIASES, async (signal) => {
    expectOutput(await run(signal, "notes"), {});
    expectOutput(await run(signal, "notes", '{"a":1}'), { a: 1 });
  });
  check("an alias that is the default of a shared prefix runs with the prefix alone, and with flags", ALIASES, async (signal) => {
    expectOutput(await run(signal, "fixture"), { mode: "slow" });
    expectOutput(await run(signal, "fixture", "--count", "2"), { mode: "slow", count: 2 });
  });
  check("a command under a shared prefix with a default alias keeps its path", ALIASES, async (signal) => {
    expectOutput(await run(signal, "fixture", "echo", "--text", "hi"), { text: "hi" });
  });
  const ticks = async (signal: AbortSignal, ...args: string[]) => {
    const result = await run(signal, "ticks", ...args);
    expectEqual(result.code, 0, `exit code, with standard error ${JSON.stringify(result.stderr)}`);
    return occurrencesIn(result.stdout, "fixture.ticks");
  };
  const tickData = async (signal: AbortSignal, ...args: string[]) => (await ticks(signal, ...args)).map((occurrence) => occurrence.data);
  check("an alias of an event subscribes with its fixed input, and takes --cursor, --max-age-ms and a flag value in the form --name=value", ALIASES, async (signal) => {
    expectEqual(await tickData(signal), [{ n: 1 }, { n: 2 }], "the data of the occurrences");
    expectEqual(
      await tickData(signal, "--cursor", "1", "--max-age-ms", "60000", "--key=--cursor"),
      [{ n: 2 }],
      "the data of the occurrences after the cursor 1, with the key --cursor",
    );
  });
  check("an alias of an event takes the flags of the input of its event", ALIASES, async (signal) => {
    expectEqual(
      (await ticks(signal, "--gap", "2")).map((occurrence) => [occurrence.data, occurrence.truncated ?? null]),
      [[{ n: 1 }, null], [{ n: 2 }, true]],
      "the data and truncated of the occurrences",
    );
  });
  check("an alias of an event whose input schema has no properties takes the input as JSON text", ALIASES, async (signal) => {
    const echoes = async (...args: string[]) => {
      const result = await run(signal, "echoes", ...args);
      expectEqual(result.code, 0, `exit code, with standard error ${JSON.stringify(result.stderr)}`);
      return occurrencesIn(result.stdout, "fixture.echoes").map((occurrence) => occurrence.data);
    };
    expectEqual(await echoes('{"a":1}'), [{ a: 1 }], "the data of the occurrences");
    expectEqual(await echoes(), [{}], "the data of the occurrences with no input");
  });
  check("an alias of an event writes internal to standard error with exit code 5 after a defect", ALIASES, async (signal) => {
    const result = await run(signal, "broken-ticks");
    expectEqual(result.code, 5, "exit code");
    expectEqual(occurrencesIn(result.stdout, "fixture.broken").map((occurrence) => occurrence.data), [{ n: 1 }], "the data of the occurrences");
    expect(/"kind":"internal"/.test(result.stderr), `standard error must contain the call failure internal, got ${JSON.stringify(result.stderr)}`);
  });
  check("the default alias runs with no arguments", ALIASES, async (signal) => {
    expectOutput(await run(signal), { mode: "fast" });
  });
  check("the default alias takes the flags when the first argument is a flag", ALIASES, async (signal) => {
    expectOutput(await run(signal, "--count", "2", "--verbose"), { mode: "fast", count: 2, verbose: true });
  });
  check("--help writes the help, and does not run the default alias", ALIASES, async (signal) => {
    const result = await run(signal, "--help");
    expectEqual(result.code, 0, `exit code, with standard error ${JSON.stringify(result.stderr)}`);
    expectEqual(result.stderr, "", "standard error");
    expect(result.stdout.trim() !== "", "standard output must have the help");
    expect(!result.stdout.trimStart().startsWith("{"), `standard output must be the help, not the output of the default alias, got ${JSON.stringify(result.stdout)}`);
  });
  for (const [name, args, code] of [
    ["a flag of a property of the fixed input has exit code 3", ["quick", "--mode", "slow"], 3],
    ["a flag of a property of the fixed input of an alias of an event has exit code 3", ["ticks", "--count", "3"], 3],
    ["a flag that the default alias does not have has exit code 3", ["--nothing"], 3],
    ["a missing required flag of an alias has exit code 3", ["say"], 3],
    ["an alias with input that is not JSON has exit code 3", ["raw", "{"], 3],
    ["an alias of an event with input that is not JSON has exit code 3", ["echoes", "{"], 3],
    ["JSON text to an alias of a capability whose input schema refers to a type with properties has exit code 3", ["fixed-note", '{"text":"override"}'], 3],
    ["an argument to an alias of a capability with no input has exit code 3", ["held-keys", "{}"], 3],
  ] as const) {
    check(name, ALIASES, async (signal) => {
      expectEqual((await run(signal, ...args)).code, code, "exit code");
    });
  }
  check("list gives the usage of the aliases of each capability", ALIASES, async (signal) => {
    const entries = await listed(signal);
    for (const { id, kind, aliases } of entries) {
      const expected = kind === "capability" ? ALIAS_USAGES[id] : EVENT_ALIAS_USAGES[id];
      if (expected === undefined) {
        expect(aliases === undefined, `${id} has no alias, so its item must not have aliases, got ${JSON.stringify(aliases)}`);
        continue;
      }
      expect(isArrayOf(aliases, (usage) => typeof usage === "string"), `the aliases of ${id} must be a list of strings, got ${JSON.stringify(aliases)}`);
      const rest = aliases.map((usage) => usage.split(" ").slice(1).join(" "));
      expectEqual(rest, expected, `the usage of the aliases of ${id} after the name of the program`);
    }
  });
}

const EVENTS = `${RULE}#events`;

function checkWatch(check: Define, command: readonly string[]): void {
  const run = (signal: AbortSignal, ...args: string[]) => start(command, args, signal).run;
  check("watch writes each occurrence as one line of JSON, and exits with 0 when the subscription is complete", EVENTS, async (signal) => {
    const result = await run(signal, "watch", "fixture.ticks", "--count", "2");
    expectEqual(result.code, 0, "exit code");
    expectEqual(
      occurrencesIn(result.stdout, "fixture.ticks").map((occurrence) => occurrence.data),
      [{ n: 1 }, { n: 2 }],
      "the data of the occurrences",
    );
    expectEqual(result.stderr, "", "standard error");
  });
  check("watch with --cursor starts after the cursor, and takes a flag value that starts with - in the form --name=value", EVENTS, async (signal) => {
    const result = await run(signal, "watch", "fixture.ticks", "--count", "3", "--cursor", "1", "--max-age-ms", "60000", "--key=--cursor");
    expectEqual(result.code, 0, "exit code");
    expectEqual(
      occurrencesIn(result.stdout, "fixture.ticks").map((occurrence) => [occurrence.data, occurrence.cursor]),
      [[{ n: 2 }, "2"], [{ n: 3 }, "3"]],
      "the data and the cursor of the occurrences",
    );
  });
  check("watch writes an occurrence after a gap with truncated: true", EVENTS, async (signal) => {
    const result = await run(signal, "watch", "fixture.ticks", "--count", "3", "--gap", "2");
    expectEqual(result.code, 0, "exit code");
    expectEqual(
      occurrencesIn(result.stdout, "fixture.ticks").map((occurrence) => [occurrence.data, occurrence.truncated ?? null]),
      [[{ n: 1 }, null], [{ n: 2 }, true], [{ n: 3 }, null]],
      "the data and truncated of the occurrences",
    );
  });
  check("watch writes internal to standard error with exit code 5 after a defect", EVENTS, async (signal) => {
    const result = await run(signal, "watch", "fixture.broken");
    expectEqual(result.code, 5, "exit code");
    expectEqual(occurrencesIn(result.stdout, "fixture.broken").map((occurrence) => occurrence.data), [{ n: 1 }], "the data of the occurrences");
    expect(/"kind":"internal"/.test(result.stderr), `standard error must contain the call failure internal, got ${JSON.stringify(result.stderr)}`);
  });
  for (const [name, args, code] of [
    ["watch with no event id has exit code 3", ["watch"], 3],
    ["watch with invalid input has exit code 3", ["watch", "fixture.ticks", "--count", "101"], 3],
    ["watch with a missing required flag has exit code 3", ["watch", "fixture.ticks"], 3],
    ["watch with an unknown flag has exit code 3", ["watch", "fixture.ticks", "--count", "1", "--nope", "x"], 3],
    ["watch of an event outside the view has exit code 2", ["watch", "fixture.secret"], 2],
    ["watch with a --max-age-ms that is not an integer has exit code 3", ["watch", "fixture.ticks", "--count", "1", "--max-age-ms", "soon"], 3],
    ["watch with a --max-age-ms that is a fraction has exit code 3", ["watch", "fixture.ticks", "--count", "1", "--max-age-ms", "1.5"], 3],
  ] as const) {
    check(name, EVENTS, async (signal) => {
      await expectUsageError(run(signal, ...args), code);
    });
  }
}

async function checkWatchInterrupt(checks: Checks, command: readonly string[]): Promise<void> {
  await checks.run("an interrupt cancels watch with exit code 130", EVENTS, async (signal) => {
    const directory = await mkdtemp(join(tmpdir(), "acid-cat-conform-"));
    const marker = join(directory, "watching");
    try {
      const { child, run: watched } = start(command, ["watch", "fixture.watch", "--key", "interrupt", "--marker", marker], signal);
      const ended = () => child.exitCode !== null || child.signalCode !== null;
      const state = await until("the subscription writes its marker file", async () => (existsSync(marker) ? "marked" : ended() ? "ended" : "waiting"), (each) => each !== "waiting", signal);
      if (state === "marked") child.kill("SIGINT");
      const result = await watched;
      expect(state === "marked", `the subscription must start before the interrupt, but the command line ended with ${result.code}: ${result.stderr}`);
      expect(result.signal === null, `the process must exit, not end by the signal ${result.signal}`);
      expectEqual(result.code, 130, "exit code");
      expectEqual(result.stdout, "", "standard output");
      expectEqual(result.stderr, "", "standard error");
      await until("the subscription ends and deletes its marker file", async () => !existsSync(marker), (ended) => ended, signal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
