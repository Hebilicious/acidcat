import assert from "node:assert/strict";
import { test } from "node:test";

import { conform } from "@acid-cat/cli";

import { deadline, didNotSettle } from "./deadline.ts";

test("acid-cat conform fails the interrupt check of a command line that never writes its marker, and goes on", async () => {
  const results = await conform({ cli: [process.execPath, new URL("./fixture-cli-without-marker.ts", import.meta.url).pathname], deadline });
  const interrupt = results.find((result) => result.name === "an interrupt cancels the call with exit code 130");
  assert.equal(interrupt?.passed, false);
  assert.match(interrupt.detail ?? "", new RegExp(`${didNotSettle.source}: waiting until the call writes its marker file`));
  const after = results.slice(results.indexOf(interrupt) + 1);
  assert.deepEqual(
    after.map((result) => `${result.passed ? "passed" : "failed"}: ${result.name}`),
    [
      "passed: each flag gives the value of its property, and a repeated flag gives one item for each occurrence",
      "passed: a repeated flag that occurs once with JSON text of an array gives that array",
      "passed: call gives the value of a capability",
      "passed: list gives the view: the capabilities, then the events",
      "passed: list gives the usage of each capability and each event, with its flags",
      "passed: watch writes each occurrence as one line of JSON, and exits with 0 when the subscription is complete",
      "passed: watch with --cursor starts after the cursor",
      "passed: watch writes an occurrence after a gap with truncated: true",
      "passed: watch writes internal to standard error with exit code 5 after a defect",
      "passed: watch with invalid input has exit code 3",
      "passed: watch with a missing required flag has exit code 3",
      "passed: watch of an event outside the view has exit code 2",
      "passed: watch with a --max-age-ms that is not an integer has exit code 3",
      "passed: watch with a --max-age-ms that is a fraction has exit code 3",
      "passed: an interrupt cancels watch with exit code 130",
    ],
  );
  assert.deepEqual(results.filter((result) => !result.passed), [interrupt]);
});
