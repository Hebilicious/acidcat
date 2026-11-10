import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";

import { createSession, httpHandler, installWebMcp, mcpHandler } from "../src/index.ts";
import { fixture, Holds, HoldsThatIgnoreCancellation, options, WatchersThatIgnoreCancellation } from "./fixture.ts";

/** The checks that must fail end at this deadline. Each other check settles long before it. */
const deadline = 10_000;

const ignoring = () => options(new HoldsThatIgnoreCancellation());

test("acid-cat conform fails only the cancellation checks of an implementation that ignores cancellation, and returns", async () => {
  const served = await serve({
    "/mcp": mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...ignoring() }),
    "/api": httpHandler(fixture, { allowedOrigins: [], base: "/api", ...ignoring() }),
  });
  try {
    const runs = await Promise.all([
      conform({ mcp: `${served.url}/mcp`, deadline }),
      conform({ http: `${served.url}/api`, deadline }),
      conform({ cli: [process.execPath, new URL("./fixture-cli-ignoring-cancellation.ts", import.meta.url).pathname], deadline }),
      conform({
        webmcp: (modelContext) => {
          const session = createSession(fixture, { target: "app", ...ignoring() });
          const installation = installWebMcp(session, { host: modelContext });
          assert.ok(installation !== undefined);
          return async () => {
            await installation.dispose();
            await session.dispose();
          };
        },
        deadline,
      }),
    ]);
    const failed = runs.flat().filter((result) => !result.passed);
    assert.deepEqual(failed.map((result) => `${result.binding}: ${result.name}`).sort(), [
      "cli: an interrupt cancels the call with exit code 130",
      "http properties: cancelling a call affects only that call",
      "mcp properties: cancelling a call affects only that call",
      "webmcp: the signal of the host cancels a call, as an AbortError",
    ]);
    for (const result of failed) assert.match(result.detail ?? "", /^did not settle within 10000 ms/);
  } finally {
    await served.close();
  }
});

test("acid-cat conform fails only the cancellation checks of events of an implementation whose subscriptions ignore cancellation", async () => {
  const watchersIgnoring = () => options(new Holds(), new WatchersThatIgnoreCancellation());
  const served = await serve({
    "/mcp": mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...watchersIgnoring() }),
    "/api": httpHandler(fixture, { allowedOrigins: [], base: "/api", ...watchersIgnoring() }),
  });
  try {
    const runs = await Promise.all([
      conform({ mcp: `${served.url}/mcp`, deadline }),
      conform({ mcpStdio: [process.execPath, new URL("./fixture-mcp-stdio-watch-ignoring-cancellation.ts", import.meta.url).pathname], deadline }),
      conform({ http: `${served.url}/api`, deadline }),
      conform({ cli: [process.execPath, new URL("./fixture-cli-watch-ignoring-cancellation.ts", import.meta.url).pathname], deadline }),
    ]);
    const failed = runs.flat().filter((result) => !result.passed);
    assert.deepEqual(failed.map((result) => `${result.binding}: ${result.name}`).sort(), [
      "cli: an interrupt cancels watch with exit code 130",
      "http: a subscription gets the things that happen, and closing the stream cancels it",
      "http: cancelling one subscription leaves the other subscriptions running",
      "mcp-stdio events: events/stream gets the things that happen, and cancelling it ends the subscription",
      "mcp-stdio events: two subscriptions at the same time each get their own messages, and cancelling one leaves the other",
      "mcp: events/stream gets the things that happen, and cancelling it ends the subscription",
      "mcp: two subscriptions at the same time each get their own messages, and cancelling one leaves the other",
    ]);
    for (const result of failed) assert.match(result.detail ?? "", /^did not settle within 10000 ms/);
  } finally {
    await served.close();
  }
});

test("acid-cat conform fails the interrupt check of a command line that never writes its marker, and goes on", async () => {
  const results = await conform({ cli: [process.execPath, new URL("./fixture-cli-without-marker.ts", import.meta.url).pathname], deadline });
  const interrupt = results.find((result) => result.name === "an interrupt cancels the call with exit code 130");
  assert.equal(interrupt?.passed, false);
  assert.match(interrupt.detail ?? "", /^did not settle within 10000 ms: waiting until the call writes its marker file/);
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
