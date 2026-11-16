import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

import { conform } from "@acid-cat/cli";
import type { Check } from "@acid-cat/cli";

import { createSession, httpHandler, installWebMcp, mcpHandler, mcpHandshake } from "../src/index.ts";
import type { McpHandler } from "../src/index.ts";
import { serve, webhookDelivery } from "../src/node.ts";
import type { Served } from "../src/node.ts";
import { fixture, Holds, options, POLL, principalOf, Watchers, WEBHOOK_LIMITS } from "./fixture.ts";
import { testCertificate } from "./webhook-receiver.ts";

function assertConforms(results: readonly Check[], minimum: number) {
  const failed = results.filter((result) => !result.passed);
  assert.deepEqual(failed, [], failed.map((result) => `${result.binding}: ${result.name}: ${result.detail}`).join("\n"));
  assert.deepEqual(results.filter((result) => result.warning === true), []);
  assert.ok(results.length >= minimum, `${results.length} checks, expected ${minimum} or more`);
}

const CONFORM_TIMEOUT = 120_000;

describe("the TypeScript core passes acid-cat conform", { concurrency: true }, () => {
  const certificate = testCertificate();
  let mcp: McpHandler | undefined;
  let served: Served | undefined;
  let url = "";

  before(async () => {
    const webhooks = webhookDelivery({ allowPrivateNetworks: true, ca: certificate.cert, retryDelayMs: () => 50, ...WEBHOOK_LIMITS });
    mcp = mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...options(), poll: POLL, principal: principalOf, webhooks });
    const mark = (path: string) => writeFile(path, "");
    const cli = httpHandler(fixture, { allowedOrigins: [], target: "cli", base: "/cli", ...options(new Holds(mark), new Watchers(mark, false)) });
    served = await serve({ "/mcp": mcpHandshake(mcp), "/api": httpHandler(fixture, { allowedOrigins: [], base: "/api", ...options() }), "/cli": cli }, { port: 0 });
    url = served.url;
  });

  after(async () => {
    await served?.close();
    await mcp?.close();
  });

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
    assertConforms(results, 5);
  });
});
