import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { conform } from "@acid-cat/cli";
import type { Check } from "@acid-cat/cli";
import { Effect, Exit, Layer, Option, Schedule, Scope } from "effect";

import { Http, Mcp, Session, WebMcp } from "../src/index.ts";
import * as NodeServer from "../src/NodeServer.ts";
import * as NodeWebhook from "../src/NodeWebhook.ts";
import { fixture, fixtureLayer, POLL, WEBHOOK_LIMITS } from "./fixture.ts";
import { testCertificate } from "./webhook-receiver.ts";

/** The principal of a request in the conformance tests: the token of the header `Authorization: Bearer <principal>`. */
const principalOf = (request: Request) => Effect.succeed(Option.fromNullishOr(/^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]));

/** The checks of one run of `acid-cat conform`: no failure, no warning, and at least `minimum` checks, so that a binding cannot pass by running no checks. */
function assertConforms(results: readonly Check[], minimum: number) {
  const failed = results.filter((result) => !result.passed);
  assert.deepEqual(failed, [], failed.map((result) => `${result.binding}: ${result.name}: ${result.detail}`).join("\n"));
  assert.deepEqual(results.filter((result) => result.warning === true), []);
  assert.ok(results.length >= minimum, `${results.length} checks, expected ${minimum} or more`);
}

// One server serves the MCP and HTTP bindings to the tests below. Each binding has its own test, so that each one has
// the whole test timeout, and a slow binding shows in the test report. The tests run at the same time, so the file
// takes the time of the slowest binding. Each binding has its own services of the fixture, so that the checks of one
// binding do not change the state of another.
const certificate = testCertificate();
const mcp = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), {
  name: "fixture",
  version: "0.0.0",
  allowedOrigins: [],
  poll: POLL,
  principal: principalOf,
  // A short wait before each new attempt of a delivery, so that the check of retries ends soon.
  webhooks: { sender: NodeWebhook.sender({ allowPrivateNetworks: true, ca: certificate.cert }), retryDelays: Schedule.spaced("50 millis"), ...WEBHOOK_LIMITS },
});
const server = Effect.runSync(Scope.make());
let url = "";

before(async () => {
  const served = await Effect.runPromise(
    NodeServer.serve(
      {
        "/mcp": Mcp.withHandshake(mcp),
        "/api": Http.toWebHandler(fixture, Layer.fresh(fixtureLayer), { allowedOrigins: [], base: "/api" }),
      },
      { port: 0 },
    ).pipe(Scope.provide(server)),
  );
  url = served.url;
});

after(async () => {
  await Effect.runPromise(Scope.close(server, Exit.void));
  await mcp.dispose();
});

describe("the Effect core passes acid-cat conform", { concurrency: true }, () => {
  test("through MCP over HTTP, with the handshake, poll and webhook delivery", async () => {
    assertConforms(await conform({ mcp: `${url}/mcp`, mcpHandshake: true, poll: POLL, webhook: { principal: "conform", otherPrincipal: "conform-other", ...certificate, ...WEBHOOK_LIMITS } }), 60);
  });

  test("through MCP over stdio", async () => {
    assertConforms(await conform({ mcpStdio: [process.execPath, new URL("./fixture-mcp-stdio.ts", import.meta.url).pathname], poll: POLL }), 50);
  });

  test("through HTTP", async () => {
    assertConforms(await conform({ http: `${url}/api` }), 20);
  });

  test("through the command line", async () => {
    assertConforms(await conform({ cli: [process.execPath, new URL("./fixture-cli.ts", import.meta.url).pathname] }), 20);
  });

  test("through WebMCP, on a model context in Node.js", async () => {
    const results = await conform({
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
    assertConforms(results, 5);
  });
});
