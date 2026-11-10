import assert from "node:assert/strict";
import { test } from "node:test";

import { conform } from "@acid-cat/cli";
import { Effect, Exit, Layer, Option, Schedule, Scope } from "effect";

import { Http, Mcp, Session, WebMcp } from "../src/index.ts";
import * as NodeServer from "../src/NodeServer.ts";
import * as NodeWebhook from "../src/NodeWebhook.ts";
import { fixture, fixtureLayer, POLL } from "./fixture.ts";
import { testCertificate } from "./webhook-receiver.ts";

/** The principal of a request in the conformance tests: the token of the header `Authorization: Bearer <principal>`. */
const principalOf = (request: Request) => Effect.succeed(Option.fromNullishOr(/^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]));

test("the Effect core passes acid-cat conform through all its bindings", async () => {
  const services = Layer.fresh(fixtureLayer);
  const certificate = testCertificate();
  const mcp = Mcp.toWebHandler(fixture, services, {
    name: "fixture",
    version: "0.0.0",
    allowedOrigins: [],
    poll: POLL,
    principal: principalOf,
    // A short wait before each new attempt of a delivery, so that the check of retries ends soon.
    webhooks: { sender: NodeWebhook.sender({ allowPrivateNetworks: true, ca: certificate.cert }), retryDelays: Schedule.spaced("50 millis") },
  });
  const server = Effect.runSync(Scope.make());
  const served = await Effect.runPromise(
    NodeServer.serve(
      {
        "/mcp": Mcp.withHandshake(mcp),
        "/api": Http.toWebHandler(fixture, services, { allowedOrigins: [], base: "/api" }),
      },
      { port: 0 },
    ).pipe(Scope.provide(server)),
  );
  try {
    const results = await conform({
      mcp: `${served.url}/mcp`,
      mcpHandshake: true,
      poll: POLL,
      webhook: { principal: "conform", ...certificate },
      mcpStdio: [process.execPath, new URL("./fixture-mcp-stdio.ts", import.meta.url).pathname],
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
    assert.deepEqual(results.filter((result) => result.warning === true), []);
    assert.ok(results.length > 150);
  } finally {
    await Effect.runPromise(Scope.close(server, Exit.void));
    await mcp.dispose();
  }
});
