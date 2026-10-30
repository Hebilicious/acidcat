import assert from "node:assert/strict";
import { test } from "node:test";

import { conform } from "@acid-cat/cli";

import { createSession, httpHandler, installWebMcp, mcpHandler, mcpHandshake } from "../src/index.ts";
import { serve } from "../src/node.ts";
import { fixture, options } from "./fixture.ts";

test("the TypeScript core passes acid-cat conform through all its bindings", async () => {
  const shared = options();
  const served = await serve({
    "/mcp": mcpHandshake(mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...shared })),
    "/api": httpHandler(fixture, { allowedOrigins: [], base: "/api", ...shared }),
  }, { port: 0 });
  try {
    const results = await conform({
      mcp: `${served.url}/mcp`,
      mcpHandshake: true,
      mcpStdio: [process.execPath, new URL("./fixture-mcp-stdio.ts", import.meta.url).pathname],
      http: `${served.url}/api`,
      cli: [process.execPath, new URL("./fixture-cli.ts", import.meta.url).pathname],
      webmcp: (modelContext) => {
        const session = createSession(fixture, { target: "app", ...options() });
        const installation = installWebMcp(session, { host: modelContext });
        assert.ok(installation !== undefined);
        return async () => {
          await installation.dispose();
          await session.dispose();
        };
      },
    });
    const failed = results.filter((result) => !result.passed);
    assert.deepEqual(failed, [], failed.map((result) => `${result.binding}: ${result.name}: ${result.detail}`).join("\n"));
    assert.ok(results.length > 40);
  } finally {
    await served.close();
  }
});
