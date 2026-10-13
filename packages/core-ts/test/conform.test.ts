import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";

import { createSession, httpHandler, installWebMcp, mcpHandler } from "../src/index.ts";
import { fixture, options } from "./fixture.ts";

test("the TypeScript core passes acid-cat conform through all its bindings", async () => {
  const shared = options();
  const served = await serve({
    "/mcp": mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...shared }),
    "/api": httpHandler(fixture, { allowedOrigins: [], base: "/api", ...shared }),
  });
  try {
    const results = await conform({
      mcp: `${served.url}/mcp`,
      http: `${served.url}/api`,
      cli: [process.execPath, new URL("./fixture-cli.ts", import.meta.url).pathname],
      webmcp: (modelContext) => {
        const session = createSession(fixture, { target: "app", ...options() });
        const installation = installWebMcp(session, { host: modelContext })!;
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
