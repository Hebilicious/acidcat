import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";

import { httpHandler, mcpHandler } from "../src/index.ts";
import { deadline, didNotSettle } from "./deadline.ts";
import { fixture, Holds, options, WatchersThatIgnoreCancellation } from "./fixture.ts";

test("acid-cat conform fails only the cancellation checks of events of an implementation whose subscriptions ignore cancellation", async () => {
  const watchersIgnoring = () => options(new Holds(), new WatchersThatIgnoreCancellation());
  const mcp = mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...watchersIgnoring() });
  const served = await serve({
    "/mcp": mcp,
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
    for (const result of failed) assert.match(result.detail ?? "", didNotSettle);
  } finally {
    await served.close();
    // The poll leases of the MCP handler have timers. Close them, so that the process can exit.
    await mcp.close();
  }
});
