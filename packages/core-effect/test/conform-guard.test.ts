import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";
import type { ConformOptions } from "@acid-cat/cli";

type WebMcpInstall = Exclude<ConformOptions["webmcp"], string | undefined>;
import { Effect, Exit, Layer, Scope } from "effect";

import { Http, Mcp, Session, WebMcp } from "../src/index.ts";
import { fixtureLayer } from "./fixture.ts";
import { fixtureIgnoringCancellation, fixtureNeverAnswering } from "./fixture-ignoring.ts";

test("acid-cat conform reports an implementation that ignores cancellation, and ends", async () => {
  const services = Layer.fresh(fixtureLayer);
  const app = fixtureIgnoringCancellation;
  const served = await serve({
    "/mcp": Mcp.toWebHandler(app, services, { name: "fixture", version: "0.0.0", allowedOrigins: [] }),
    "/api": Http.toWebHandler(app, services, { allowedOrigins: [], base: "/api" }),
  });
  try {
    const results = await conform({
      guard: 5_000,
      mcp: `${served.url}/mcp`,
      http: `${served.url}/api`,
      cli: [process.execPath, new URL("./fixture-ignoring-cli.ts", import.meta.url).pathname],
      webmcp: async (modelContext) => {
        const scope = Effect.runSync(Scope.make());
        await Effect.runPromise(
          Effect.gen(function* () {
            const session = yield* Session.make(app, { target: "app" });
            yield* WebMcp.install(session, { host: modelContext });
          }).pipe(Scope.provide(scope), Effect.provide(Layer.fresh(fixtureLayer))),
        );
        return () => Effect.runPromise(Scope.close(scope, Exit.void));
      },
    });
    const failed = results.filter((result) => !result.passed).map((result) => `${result.binding}: ${result.name}`).sort();
    assert.deepEqual(failed, [
      "cli: an interrupt cancels the call with exit code 130",
      "http properties: cancelling a call affects only that call",
      "mcp properties: cancelling a call affects only that call",
      "webmcp: the signal of the host cancels a call, as an AbortError",
    ]);
    for (const result of results.filter((each) => !each.passed)) assert.match(result.detail ?? "", /within 5000 ms, the guard of acid-cat conform/, result.name);
  } finally {
    await served.close();
  }
});

/** The checks that call fixture.echo with an input that it accepts, by binding. */
const echoChecks = {
  mcp: ["mcp: a value is a tool result with structured content", "mcp properties: concurrent calls each get exactly their own outcome"],
  http: ["http: a value has the status 200", "http properties: concurrent calls each get exactly their own outcome"],
  cli: ["cli: a value goes to standard output with exit code 0", "cli: call gives the value of a capability"],
  webmcp: ["webmcp: a value resolves as a result"],
};

for (const binding of ["mcp", "http", "cli", "webmcp"] as const) {
  test(`acid-cat conform reports an implementation whose fixture.echo never answers through ${binding}, and ends`, async () => {
    const app = fixtureNeverAnswering;
    const services = Layer.fresh(fixtureLayer);
    const served = await serve({
      "/mcp": Mcp.toWebHandler(app, services, { name: "fixture", version: "0.0.0", allowedOrigins: [] }),
      "/api": Http.toWebHandler(app, services, { allowedOrigins: [], base: "/api" }),
    });
    try {
      const results = await conform({
        guard: 5_000,
        ...(binding === "mcp" ? { mcp: `${served.url}/mcp` } : {}),
        ...(binding === "http" ? { http: `${served.url}/api` } : {}),
        ...(binding === "cli" ? { cli: [process.execPath, new URL("./fixture-silent-cli.ts", import.meta.url).pathname] } : {}),
        ...(binding === "webmcp"
          ? {
              webmcp: (async (modelContext) => {
                const scope = Effect.runSync(Scope.make());
                await Effect.runPromise(
                  Effect.gen(function* () {
                    const session = yield* Session.make(app, { target: "app" });
                    yield* WebMcp.install(session, { host: modelContext });
                  }).pipe(Scope.provide(scope), Effect.provide(Layer.fresh(fixtureLayer))),
                );
                return () => {
                  void Effect.runPromise(Scope.close(scope, Exit.void));
                };
              }) satisfies WebMcpInstall,
            }
          : {}),
      });
      const failed = results.filter((result) => !result.passed).map((result) => `${result.binding}: ${result.name}`).sort();
      assert.deepEqual(failed, [...echoChecks[binding]].sort());
      for (const result of results.filter((each) => !each.passed)) assert.match(result.detail ?? "", /within 5000 ms, the guard of acid-cat conform/, result.name);
    } finally {
      await served.close();
    }
  });
}
