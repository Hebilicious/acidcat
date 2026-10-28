import assert from "node:assert/strict";
import { test } from "node:test";

import { conform } from "@acid-cat/cli";
import { Effect, Exit, Layer, Scope } from "effect";

import { Http, Mcp, Session, WebMcp } from "../src/index.ts";
import { NodeServer } from "../src/node.ts";
import { fixture, fixtureLayer } from "./fixture.ts";

test("the Effect core passes acid-cat conform through all its bindings", async () => {
  const services = Layer.fresh(fixtureLayer);
  const server = Effect.runSync(Scope.make());
  const served = await Effect.runPromise(
    NodeServer.serve(
      {
        "/mcp": Mcp.toWebHandler(fixture, services, { name: "fixture", version: "0.0.0", allowedOrigins: [] }),
        "/api": Http.toWebHandler(fixture, services, { allowedOrigins: [], base: "/api" }),
      },
      { port: 0 },
    ).pipe(Scope.provide(server)),
  );
  try {
    const results = await conform({
      mcp: `${served.url}/mcp`,
      http: `${served.url}/api`,
      cli: [process.execPath, new URL("./fixture-cli.ts", import.meta.url).pathname],
      webmcp: async (modelContext) => {
        const scope = Effect.runSync(Scope.make());
        await Effect.runPromise(
          Effect.gen(function* () {
            const session = yield* Session.make(fixture, { target: "app" });
            yield* WebMcp.install(session, { host: modelContext });
          }).pipe(Scope.provide(scope), Effect.provide(Layer.fresh(fixtureLayer))),
        );
        return () => Effect.runPromise(Scope.close(scope, Exit.void));
      },
    });
    const failed = results.filter((result) => !result.passed);
    assert.deepEqual(failed, [], failed.map((result) => `${result.binding}: ${result.name}: ${result.detail}`).join("\n"));
    assert.ok(results.length > 40);
  } finally {
    await Effect.runPromise(Scope.close(server, Exit.void));
  }
});
