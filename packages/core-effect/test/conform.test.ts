import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { conform } from "@acid-cat/cli";
import type { Check } from "@acid-cat/cli";

import { Effect, Exit, Layer, Option, Schedule, Scope } from "effect";

import { Http, Mcp, Session, WebMcp } from "../src/index.ts";
import * as NodeServer from "../src/NodeServer.ts";
import * as NodeWebhook from "../src/NodeWebhook.ts";
import { fileMarker } from "./file-marker.ts";
import { fixture, fixtureLayer, holdsLayer, POLL, POLL_LEASE_MS, switchLayer, watchersLayer, WEBHOOK_LIMITS } from "./fixture.ts";
import { testCertificate, testSigningKey } from "./webhook-receiver.ts";
import { bundledProgram } from "./bundled-program.ts";

const principalOf = (request: Request) => Effect.succeed(Option.fromNullishOr(/^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]));

function assertConforms(results: readonly Check[], minimum: number) {
  const failed = results.filter((result) => !result.passed);
  assert.deepEqual(failed, [], failed.map((result) => `${result.binding}: ${result.name}: ${result.detail}`).join("\n"));
  assert.deepEqual(results.filter((result) => result.warning === true), []);
  assert.ok(results.length >= minimum, `${results.length} checks, expected ${minimum} or more`);
}

const TASK_TEST_TIMEOUT = Number(process.env.TEST_TIMEOUT_MS ?? Number.POSITIVE_INFINITY);
const CONFORM_TIMEOUT = 2 * TASK_TEST_TIMEOUT;

const certificate = testCertificate();
const mcp = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), {
  name: "fixture",
  version: "0.0.0",
  allowedOrigins: [],
  poll: POLL,
  principal: principalOf,
  webhooks: {
    sender: NodeWebhook.sender({ allowPrivateNetworks: true, ca: certificate.cert }),
    retryDelays: Schedule.spaced("50 millis"),
    ...WEBHOOK_LIMITS,
    signingKeys: [testSigningKey("fixture-1"), testSigningKey("fixture-2")],
    egressIpRanges: ["203.0.113.0/24", "2001:db8::/32"],
  },
});
const mcpLease = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), { name: "fixture", version: "0.0.0", path: "/mcp-lease", allowedOrigins: [], poll: { leaseMs: POLL_LEASE_MS } });
const server = Effect.runSync(Scope.make());
let url = "";

before(async () => {
  const served = await Effect.runPromise(
    NodeServer.serve(
      {
        "/mcp": Mcp.withHandshake(mcp),
        "/mcp-lease": mcpLease,
        "/api": Http.toWebHandler(fixture, Layer.fresh(fixtureLayer), { allowedOrigins: [], base: "/api" }),
        "/cli": Http.toWebHandler(fixture, Layer.fresh(Layer.mergeAll(switchLayer, holdsLayer(fileMarker), watchersLayer(fileMarker))), {
          allowedOrigins: [],
          base: "/cli",
          target: "cli",
        }),
      },
      { port: 0 },
    ).pipe(Scope.provide(server)),
  );
  url = served.url;
});

after(async () => {
  await Effect.runPromise(Scope.close(server, Exit.void));
  await mcp.dispose();
  await mcpLease.dispose();
});

describe("the Effect core passes acid-cat conform", { concurrency: true }, () => {
  test("through MCP over HTTP, with the handshake, poll and webhook delivery", { timeout: CONFORM_TIMEOUT }, async () => {
    const results = await conform({ mcp: `${url}/mcp`, mcpHandshake: true, poll: POLL, pollLease: { mcp: `${url}/mcp-lease`, leaseMs: POLL_LEASE_MS }, webhook: { principal: "conform", otherPrincipal: "conform-other", ...certificate, ...WEBHOOK_LIMITS } });
    assertConforms(results, 60);
    assert.ok(results.some((result) => result.rule === "spec/bindings/mcp.md#server-card"), "the default Server Card is checked");
  });

  test("through MCP over stdio", { timeout: CONFORM_TIMEOUT }, async () => {
    assertConforms(await conform({ mcpStdio: [process.execPath, bundledProgram("test/fixture-mcp-stdio.ts")], poll: POLL }), 50);
  });

  test("through HTTP", { timeout: CONFORM_TIMEOUT }, async () => {
    assertConforms(await conform({ http: `${url}/api` }), 20);
  });

  test("through the command line", { timeout: CONFORM_TIMEOUT }, async () => {
    assertConforms(await conform({ cli: [process.execPath, bundledProgram("test/fixture-cli.ts")] }), 20);
  });

  test("through the command line that calls a server", { timeout: CONFORM_TIMEOUT }, async () => {
    assertConforms(await conform({ cli: [process.execPath, bundledProgram("test/fixture-cli-remote.ts"), `${url}/cli`] }), 20);
  });

  test("through WebMCP, on a model context in Node.js", { timeout: CONFORM_TIMEOUT }, async () => {
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
