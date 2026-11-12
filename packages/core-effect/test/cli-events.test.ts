import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Schema } from "effect";

import { decodeText } from "./decode.ts";
import { run } from "./run.ts";

const file = new URL("./events-cli.ts", import.meta.url).pathname;

const cli = (...args: string[]) => run(file, ...args);

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

// Each test below starts processes. The tests run at the same time, and the runs of a test wait at the same time.
describe("the command line of an application with events", { concurrency: true }, () => {
  test("list gives the capabilities, then the events, each with its kind and its usage", async () => {
    const list = await cli("list");
    assert.equal(list.code, 0);
    const entries = decodeText(Schema.Array(Entry), list.stdout);
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

  test("watch writes each occurrence as one line of JSON, and exits with 0 when the subscription completes", async () => {
    const [timed, counted] = await Promise.all([cli("watch", "feed.timed", "--every", "5", "--count", "3"), cli("watch", "feed.counted", '{"a":1,"b":2}')]);
    assert.equal(timed.code, 0, timed.stderr);
    assert.deepEqual(
      occurrences(timed.stdout).map(({ name, data }) => ({ name, data })),
      [0, 1, 2].map((index) => ({ name: "feed.timed", data: { index } })),
    );
    assert.equal(timed.stderr, "");

    assert.equal(counted.code, 0, counted.stderr);
    assert.deepEqual(
      occurrences(counted.stdout).map(({ eventId }) => eventId),
      ["a", "b"],
    );
  });

  test("a subscription that cannot start has the exit code of its call failure", async () => {
    const [hidden, missing, invalid, notJson] = await Promise.all([
      cli("watch", "feed.hidden"),
      cli("watch", "feed.timed"),
      cli("watch", "feed.counted", '{"a":"x"}'),
      cli("watch", "feed.counted", "nope"),
    ]);
    assert.equal(hidden.code, 2);
    assert.equal(missing.code, 3);
    assert.equal(invalid.code, 3);
    assert.match(invalid.stderr, /"kind":"invalid-input"/);
    assert.equal(invalid.stdout, "");
    assert.equal(notJson.code, 3);
  });

  test("--cursor and --max-age-ms give where the subscription resumes, in the flags form and in the JSON form", async () => {
    const [flags, none, jsonForm] = await Promise.all([
      cli("watch", "feed.resumed", "--cursor", "abc", "--max-age-ms", "50"),
      cli("watch", "feed.resumed"),
      cli("watch", "feed.counted", '{"a":1}', "--cursor", "x", "--max-age-ms", "0"),
    ]);
    assert.equal(flags.code, 0, flags.stderr);
    const [occurrence] = occurrences(flags.stdout);
    assert.deepEqual(occurrence?.data, { cursor: "abc", maxAgeMs: 50 });
    assert.deepEqual(occurrences(none.stdout)[0]?.data, {});

    assert.equal(jsonForm.code, 0, jsonForm.stderr);
    assert.equal(occurrences(jsonForm.stdout).length, 1);
  });

  test("a --max-age-ms that is not a non-negative integer exits with 3", async () => {
    const [notAnInteger, fraction, negative, jsonForm] = await Promise.all([
      cli("watch", "feed.resumed", "--max-age-ms", "nope"),
      cli("watch", "feed.resumed", "--max-age-ms", "1.5"),
      cli("watch", "feed.resumed", "--max-age-ms", "-1"),
      cli("watch", "feed.counted", "{}", "--max-age-ms", "x"),
    ]);
    assert.deepEqual([notAnInteger.code, fraction.code, negative.code, jsonForm.code], [3, 3, 3, 3]);
    assert.equal(negative.stdout, "");
    assert.deepEqual(JSON.parse(negative.stderr), { kind: "invalid-input", message: "--max-age-ms must not be negative." });
  });

  test("the program stops with an error when it starts if an input property of an event is named cursor or max-age-ms", async () => {
    const reserved = new URL("./events-cli-reserved.ts", import.meta.url).pathname;
    await Promise.all(
      ["cursor", "max-age-ms"].map(async (name) => {
        const started = await run(reserved, name, "list");
        assert.notEqual(started.code, 0);
        assert.equal(started.stdout, "");
        assert.match(started.stderr, new RegExp(`has a property ${name}, which is a flag of watch`));
      }),
    );
  });
});
