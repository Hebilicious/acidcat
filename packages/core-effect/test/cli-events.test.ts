import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Schema } from "effect";

import { decodeText } from "./decode.ts";
import { run } from "./run.ts";
import type { Stoppable } from "./run.ts";
import { bundledProgram } from "./bundled-program.ts";

const file = bundledProgram("test/events-cli.ts");

const cli = (t: Stoppable, ...args: string[]) => run(t, file, ...args);

const occurrences = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => decodeText(Schema.Struct({ eventId: Schema.String, name: Schema.String, timestamp: Schema.String, data: Schema.Unknown }), line));

describe("the command line of an application with events", { concurrency: true }, () => {
  test("--cursor and --max-age-ms reach the provider, and with neither the provider gets no resume", async (t) => {
    const [flags, none] = await Promise.all([cli(t, "watch", "feed.resumed", "--cursor", "abc", "--max-age-ms", "50"), cli(t, "watch", "feed.resumed")]);
    assert.equal(flags.code, 0, flags.stderr);
    assert.deepEqual(occurrences(flags.stdout)[0]?.data, { cursor: "abc", maxAgeMs: 50 });
    assert.deepEqual(occurrences(none.stdout)[0]?.data, {});
  });

  test("a negative --max-age-ms exits with 3 and writes invalid-input to standard error", async (t) => {
    const negative = await cli(t, "watch", "feed.resumed", "--max-age-ms", "-1");
    assert.equal(negative.code, 3);
    assert.equal(negative.stdout, "");
    assert.deepEqual(JSON.parse(negative.stderr), { kind: "invalid-input", message: "--max-age-ms must not be negative." });
  });

  test("the program stops with an error when it starts if an input property of an event is named cursor or max-age-ms", async (t) => {
    const reserved = bundledProgram("test/events-cli-reserved.ts");
    await Promise.all(
      ["cursor", "max-age-ms"].map(async (name) => {
        const started = await run(t, reserved, name, "list");
        assert.equal(started.code, 5);
        assert.equal(started.stdout, "");
        assert.equal(started.stderr, `The input of the event reserved.changed has a property ${name}, which is a flag of watch.\n`);
      }),
    );
  });
});
