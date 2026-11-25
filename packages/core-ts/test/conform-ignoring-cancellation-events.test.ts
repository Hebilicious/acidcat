import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";

import { httpHandler, mcpHandler } from "../src/index.ts";
import { deadline, didNotSettle, failures, timeout } from "./deadline.ts";
import { fixture, Holds, options, WatchersThatIgnoreCancellation } from "./fixture.ts";
import { bundledProgram } from "./bundled-program.ts";

test("acid-cat conform fails only the cancellation checks of events of an implementation whose subscriptions ignore cancellation", { timeout }, async (t) => {
  const watchersIgnoring = () => options(new Holds(), new WatchersThatIgnoreCancellation());
  const mcp = mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...watchersIgnoring() });
  const served = await serve({
    "/mcp": mcp,
    "/api": httpHandler(fixture, { allowedOrigins: [], base: "/api", ...watchersIgnoring() }),
  });
  try {
    const runs = await Promise.all([
      conform({ signal: t.signal, mcp: `${served.url}/mcp`, deadline }),
      conform({ signal: t.signal, mcpStdio: [process.execPath, bundledProgram("test/fixture-mcp-stdio-watch-ignoring-cancellation.ts")], deadline }),
      conform({ signal: t.signal, http: `${served.url}/api`, deadline }),
      conform({ signal: t.signal, cli: [process.execPath, bundledProgram("test/fixture-cli-watch-ignoring-cancellation.ts")], deadline }),
    ]);
    const failed = runs.flat().filter((result) => !result.passed);
    assert.deepEqual(failed.map((result) => `${result.surface}: ${result.name}`).sort(), [
      "cli: an interrupt cancels watch with exit code 130",
      "http: each subscription gets the things that happen, and closing one stream cancels only its subscription",
      "mcp-stdio events: two subscriptions at the same time each get their own messages, and cancelling one leaves the other",
      "mcp: two subscriptions at the same time each get their own messages, and cancelling one leaves the other",
    ], failures(failed));
    for (const result of failed) assert.match(result.detail ?? "", didNotSettle);
  } finally {
    await served.close();
    await mcp.close();
  }
});
