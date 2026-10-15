import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";
import type { Check, ConformOptions } from "@acid-cat/cli";
import { Effect, Exit, Layer, Scope } from "effect";

import { App, Http, Mcp, Session, WebMcp } from "../src/index.ts";
import { fixtureLayer, type Holds, type Switch } from "./fixture.ts";
import { fixtureIgnoringCancellation, fixtureNeverAnswering } from "./fixture-ignoring.ts";

type Binding = "mcp" | "http" | "cli" | "webmcp";

/**
 * The guard of each binding. Each one is the time that one check of a broken implementation takes to fail, so these
 * tests take about that long for each failing check. The guard must also be long enough for the checks that pass. A
 * check of the command line starts a Node.js process, which takes more than a second on a busy machine. Through MCP and
 * HTTP, the property of concurrent calls makes some hundred requests in one check, which took more than 2 seconds on a
 * CI runner. WebMCP has no such check.
 */
const GUARDS: { readonly [B in Binding]: number } = { mcp: 5_000, http: 5_000, cli: 5_000, webmcp: 2_000 };

/** Run acid-cat conform through one binding of a broken implementation. */
async function conformThrough(binding: Binding, app: App.App<Holds | Switch>, cliEntry: string): Promise<readonly Check[]> {
  const services = Layer.fresh(fixtureLayer);
  const served = await serve({
    "/mcp": Mcp.toWebHandler(app, services, { name: "fixture", version: "0.0.0", allowedOrigins: [] }),
    "/api": Http.toWebHandler(app, services, { allowedOrigins: [], base: "/api" }),
  });
  const webmcp: Exclude<ConformOptions["webmcp"], string | undefined> = async (modelContext) => {
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
  };
  try {
    return await conform({
      guard: GUARDS[binding],
      ...(binding === "mcp" ? { mcp: `${served.url}/mcp` } : {}),
      ...(binding === "http" ? { http: `${served.url}/api` } : {}),
      ...(binding === "cli" ? { cli: [process.execPath, new URL(cliEntry, import.meta.url).pathname] } : {}),
      ...(binding === "webmcp" ? { webmcp } : {}),
    });
  } finally {
    await served.close();
  }
}

/** Check that exactly the expected checks failed, each at the guard. */
function failedAtGuard(results: readonly Check[], binding: Binding, expected: readonly string[]): void {
  const failed = results.filter((result) => !result.passed);
  assert.deepEqual(failed.map((result) => `${result.binding}: ${result.name}`).sort(), [...expected].sort());
  const guard = new RegExp(`within ${GUARDS[binding]} ms, the guard of acid-cat conform`);
  for (const result of failed) assert.match(result.detail ?? "", guard, result.name);
}

/** The check of cancellation, by binding. */
const cancellationChecks: { readonly [B in Binding]: readonly string[] } = {
  mcp: ["mcp properties: cancelling a call affects only that call"],
  http: ["http properties: cancelling a call affects only that call"],
  cli: ["cli: an interrupt cancels the call with exit code 130"],
  webmcp: ["webmcp: the signal of the host cancels a call, as an AbortError"],
};

/** The checks that call fixture.echo with an input that it accepts, by binding. */
const echoChecks: { readonly [B in Binding]: readonly string[] } = {
  mcp: ["mcp: a value is a tool result with structured content", "mcp properties: concurrent calls each get exactly their own outcome"],
  http: ["http: a value has the status 200", "http properties: concurrent calls each get exactly their own outcome"],
  cli: ["cli: a value goes to standard output with exit code 0", "cli: call gives the value of a capability"],
  webmcp: ["webmcp: a value resolves as a result"],
};

for (const binding of ["mcp", "http", "cli", "webmcp"] as const) {
  test(`acid-cat conform reports an implementation that ignores cancellation through ${binding}, and ends`, async () => {
    failedAtGuard(await conformThrough(binding, fixtureIgnoringCancellation, "./fixture-ignoring-cli.ts"), binding, cancellationChecks[binding]);
  });

  test(`acid-cat conform reports an implementation whose fixture.echo never answers through ${binding}, and ends`, async () => {
    failedAtGuard(await conformThrough(binding, fixtureNeverAnswering, "./fixture-silent-cli.ts"), binding, echoChecks[binding]);
  });
}
