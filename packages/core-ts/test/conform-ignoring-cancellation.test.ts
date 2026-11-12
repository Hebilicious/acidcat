import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";

import { createSession, httpHandler, installWebMcp, mcpHandler } from "../src/index.ts";
import { deadline, didNotSettle } from "./deadline.ts";
import { fixture, HoldsThatIgnoreCancellation, options } from "./fixture.ts";

const ignoring = () => options(new HoldsThatIgnoreCancellation());

test("acid-cat conform fails only the cancellation checks of an implementation that ignores cancellation, and returns", async () => {
  const mcp = mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...ignoring() });
  const served = await serve({
    "/mcp": mcp,
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
    for (const result of failed) assert.match(result.detail ?? "", didNotSettle);
  } finally {
    await served.close();
    // The poll leases of the MCP handler have timers. Close them, so that the process can exit.
    await mcp.close();
  }
});
