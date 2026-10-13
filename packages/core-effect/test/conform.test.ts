import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";
import { Layer } from "effect";

import { Graphql, Http, Mcp } from "../src/index.ts";
import { fixture, switchLayer } from "./fixture.ts";

test("the Effect core passes acid-cat conform through all its bindings", async () => {
  const services = Layer.fresh(switchLayer);
  const served = await serve({
    "/mcp": Mcp.toWebHandler(fixture, services, { name: "fixture", version: "0.0.0", allowedOrigins: [] }),
    "/api": Http.toWebHandler(fixture, services, { allowedOrigins: [], base: "/api" }),
    "/graphql": Graphql.toWebHandler(fixture, services, { allowedOrigins: [] }),
  });
  try {
    const results = await conform({
      mcp: `${served.url}/mcp`,
      http: `${served.url}/api`,
      graphql: `${served.url}/graphql`,
      cli: [process.execPath, new URL("./fixture-cli.ts", import.meta.url).pathname],
    });
    const failed = results.filter((result) => !result.passed);
    assert.deepEqual(failed, [], failed.map((result) => `${result.binding}: ${result.name}: ${result.detail}`).join("\n"));
    assert.ok(results.length > 40);
  } finally {
    await served.close();
  }
});
