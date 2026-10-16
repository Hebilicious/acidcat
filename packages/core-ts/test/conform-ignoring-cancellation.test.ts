import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";

import { createSession, httpHandler, installWebMcp, mcpHandler } from "../src/index.ts";
import { fixture, HoldsThatIgnoreCancellation, options } from "./fixture.ts";

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
          const installation = installWebMcp(session, { host: modelContext })!;
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

test("acid-cat conform fails the interrupt check of a command line that never writes its marker, and goes on", async () => {
  const results = await conform({ cli: [process.execPath, new URL("./fixture-cli-without-marker.ts", import.meta.url).pathname], deadline });
  const interrupt = results.find((result) => result.name === "an interrupt cancels the call with exit code 130");
  assert.equal(interrupt?.passed, false);
  assert.match(interrupt.detail ?? "", /^did not settle within 10000 ms: waiting until the call writes its marker file/);
  const after = results.slice(results.indexOf(interrupt) + 1);
  assert.deepEqual(
    after.map((result) => `${result.passed ? "passed" : "failed"}: ${result.name}`),
    ["passed: call gives the value of a capability", "passed: list gives the view", "passed: list gives the usage of each capability, with its flags"],
  );
  assert.deepEqual(results.filter((result) => !result.passed), [interrupt]);
});
