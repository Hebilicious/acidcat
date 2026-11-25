import assert from "node:assert/strict";
import { test } from "node:test";

import { conform } from "@acid-cat/cli";

import { deadline, didNotSettle, failures, timeout } from "./deadline.ts";
import { bundledProgram } from "./bundled-program.ts";

test("acid-cat conform fails the interrupt check of a command line that never writes its marker, and goes on", { timeout }, async (t) => {
  const results = await conform({ signal: t.signal, cli: [process.execPath, bundledProgram("test/fixture-cli-without-marker.ts")], deadline });
  const interrupt = results.find((result) => result.name === "an interrupt cancels the call with exit code 130");
  assert.equal(interrupt?.passed, false);
  assert.match(interrupt.detail ?? "", new RegExp(`${didNotSettle.source}: waiting until the call writes its marker file`));
  const after = results.slice(results.indexOf(interrupt) + 1);
  assert.ok(after.length > 0, "the checks after the interrupt check run");
  assert.deepEqual(results.filter((result) => !result.passed), [interrupt], failures(results));
});
