import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { conform } from "@acid-cat/cli";
import type { Check } from "@acid-cat/cli";
import { writeFile } from "node:fs/promises";

import { Effect, Exit, Layer, Option, Schedule, Scope } from "effect";

import { Http, Mcp, Session, WebMcp } from "../src/index.ts";
import * as NodeServer from "../src/NodeServer.ts";
import * as NodeWebhook from "../src/NodeWebhook.ts";
import { fixture, fixtureLayer, holdsLayer, POLL, switchLayer, watchersLayer, WEBHOOK_LIMITS } from "./fixture.ts";
import { testCertificate } from "./webhook-receiver.ts";

const principalOf = (request: Request) => Effect.succeed(Option.fromNullishOr(/^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]));

function assertConforms(results: readonly Check[], minimum: number) {
  const failed = results.filter((result) => !result.passed);
  assert.deepEqual(failed, [], failed.map((result) => `${result.binding}: ${result.name}: ${result.detail}`).join("\n"));
  assert.deepEqual(results.filter((result) => result.warning === true), []);
  assert.ok(results.length >= minimum, `${results.length} checks, expected ${minimum} or more`);
}

const CONFORM_TIMEOUT = 120_000;

const certificate = testCertificate();
const writeMarker = (path: string) => Effect.promise(() => writeFile(path, ""));
const mcp = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), {
  name: "fixture",
  version: "0.0.0",
  allowedOrigins: [],
  poll: POLL,
  principal: principalOf,
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
        "/cli": Http.toWebHandler(fixture, Layer.fresh(Layer.mergeAll(switchLayer, holdsLayer(writeMarker), watchersLayer(writeMarker))), {
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
});

describe("the Effect core passes acid-cat conform", { concurrency: true }, () => {
  test("through MCP over HTTP, with the handshake, poll and webhook delivery", { timeout: CONFORM_TIMEOUT }, async () => {
    assertConforms(await conform({ mcp: `${url}/mcp`, mcpHandshake: true, poll: POLL, webhook: { principal: "conform", otherPrincipal: "conform-other", ...certificate, ...WEBHOOK_LIMITS } }), 60);
  });

  test("through MCP over stdio", { timeout: CONFORM_TIMEOUT }, async () => {
    assertConforms(await conform({ mcpStdio: [process.execPath, new URL("./fixture-mcp-stdio.ts", import.meta.url).pathname], poll: POLL }), 50);
  });

  test("through HTTP", { timeout: CONFORM_TIMEOUT }, async () => {
    assertConforms(await conform({ http: `${url}/api` }), 20);
  });

  test("through the command line", { timeout: CONFORM_TIMEOUT }, async () => {
    assertConforms(await conform({ cli: [process.execPath, new URL("./fixture-cli.ts", import.meta.url).pathname] }), 20);
  });

  test("through the command line that calls a server", { timeout: CONFORM_TIMEOUT }, async () => {
    assertConforms(await conform({ cli: [process.execPath, new URL("./fixture-cli-remote.ts", import.meta.url).pathname, `${url}/cli`] }), 20);
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
