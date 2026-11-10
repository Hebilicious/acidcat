import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

import { Schema } from "effect";

import { decodeText } from "./decode.ts";

const file = new URL("./events-cli.ts", import.meta.url).pathname;

const cli = (...args: string[]) => {
  const run = spawnSync(process.execPath, [file, ...args], { encoding: "utf-8", timeout: 20_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

/** The lines of standard output, each decoded as an occurrence. */
const occurrences = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => decodeText(Schema.Struct({ eventId: Schema.String, name: Schema.String, timestamp: Schema.String, data: Schema.Unknown }), line));

const Entry = Schema.Struct({
  kind: Schema.Literals(["capability", "event"]),
  id: Schema.String,
  description: Schema.String,
  usage: Schema.String,
  available: Schema.optionalKey(Schema.Boolean),
});

test("list gives the capabilities, then the events, each with its kind and its usage", () => {
  const run = cli("list");
  assert.equal(run.code, 0);
  const entries = decodeText(Schema.Array(Entry), run.stdout);
  assert.deepEqual(
    entries.map(({ kind, id }) => `${kind} ${id}`),
    ["capability feed.publish", "event feed.ticked", "event feed.counted", "event feed.timed", "event feed.resumed", "event feed.crashing", "event feed.disagreeing"],
  );
  const usage = Object.fromEntries(entries.map((entry) => [entry.id, entry.usage]));
  const resume = "[--cursor <string>] [--max-age-ms <integer>]";
  assert.equal(usage["feed.ticked"], `feed watch feed.ticked [--room <string>] ${resume}`);
  assert.equal(usage["feed.counted"], `feed watch feed.counted '<json>' ${resume}`);
  assert.equal(usage["feed.timed"], `feed watch feed.timed --every <integer> [--count <integer>] ${resume}`);
  assert.equal(usage["feed.crashing"], `feed watch feed.crashing ${resume}`);
  assert.equal(entries.find((entry) => entry.kind === "event")?.available, undefined);
});

test("watch writes each occurrence as one line of JSON, and exits with 0 when the subscription completes", () => {
  const timed = cli("watch", "feed.timed", "--every", "5", "--count", "3");
  assert.equal(timed.code, 0, timed.stderr);
  assert.deepEqual(
    occurrences(timed.stdout).map(({ name, data }) => ({ name, data })),
    [0, 1, 2].map((index) => ({ name: "feed.timed", data: { index } })),
  );
  assert.equal(timed.stderr, "");

  const counted = cli("watch", "feed.counted", '{"a":1,"b":2}');
  assert.equal(counted.code, 0, counted.stderr);
  assert.deepEqual(
    occurrences(counted.stdout).map(({ eventId }) => eventId),
    ["a", "b"],
  );
});

test("a subscription that cannot start has the exit code of its call failure", () => {
  assert.equal(cli("watch", "feed.hidden").code, 2);
  assert.equal(cli("watch", "feed.timed").code, 3);
  const invalid = cli("watch", "feed.counted", '{"a":"x"}');
  assert.equal(invalid.code, 3);
  assert.match(invalid.stderr, /"kind":"invalid-input"/);
  assert.equal(invalid.stdout, "");
  assert.equal(cli("watch", "feed.counted", "nope").code, 3);
});

test("a failure of the provider writes internal to standard error, and exits with 5", () => {
  const run = cli("watch", "feed.crashing");
  assert.equal(run.code, 5);
  assert.equal(occurrences(run.stdout).length, 1);
  const lines = run.stderr.trim().split("\n");
  assert.deepEqual(JSON.parse(lines.at(-1) ?? ""), { kind: "internal", message: "The event failed." });
});

test("an interrupt cancels the subscription, and exits with 130 and nothing on standard error", async () => {
  const child = spawn(process.execPath, [file, "watch", "feed.timed", "--every", "20"]);
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes("\n")) child.kill("SIGINT");
  });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (...exit) => resolve(exit)));
  assert.deepEqual({ code, signal }, { code: 130, signal: null });
  assert.equal(stderr, "");
  assert.ok(occurrences(stdout).length >= 1);
});

test("--cursor and --max-age-ms give where the subscription resumes, in the flags form and in the JSON form", () => {
  const flags = cli("watch", "feed.resumed", "--cursor", "abc", "--max-age-ms", "50");
  assert.equal(flags.code, 0, flags.stderr);
  const [occurrence] = occurrences(flags.stdout);
  assert.deepEqual(occurrence?.data, { cursor: "abc", maxAgeMs: 50 });
  assert.deepEqual(occurrences(cli("watch", "feed.resumed").stdout)[0]?.data, {});

  const jsonForm = cli("watch", "feed.counted", '{"a":1}', "--cursor", "x", "--max-age-ms", "0");
  assert.equal(jsonForm.code, 0, jsonForm.stderr);
  assert.equal(occurrences(jsonForm.stdout).length, 1);
});

test("a --max-age-ms that is not a non-negative integer exits with 3", () => {
  for (const value of ["nope", "1.5", "-1"]) assert.equal(cli("watch", "feed.resumed", "--max-age-ms", value).code, 3, value);
  const negative = cli("watch", "feed.resumed", "--max-age-ms", "-1");
  assert.equal(negative.stdout, "");
  assert.deepEqual(JSON.parse(negative.stderr), { kind: "invalid-input", message: "--max-age-ms must not be negative." });
  assert.equal(cli("watch", "feed.counted", "{}", "--max-age-ms", "x").code, 3);
});

test("the program stops with an error when it starts if an input property of an event is named cursor or max-age-ms", () => {
  const reserved = new URL("./events-cli-reserved.ts", import.meta.url).pathname;
  for (const name of ["cursor", "max-age-ms"]) {
    const run = spawnSync(process.execPath, [reserved, name, "list"], { encoding: "utf-8", timeout: 20_000 });
    assert.notEqual(run.status, 0);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, new RegExp(`has a property ${name}, which is a flag of watch`));
  }
});
