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

/** The checks of one run of `acid-cat conform`: no failure, no warning, and at least `minimum` checks, so that a binding cannot pass by running no checks. */
function assertConforms(results: readonly Check[], minimum: number) {
  const failed = results.filter((result) => !result.passed);
  assert.deepEqual(failed, [], failed.map((result) => `${result.binding}: ${result.name}: ${result.detail}`).join("\n"));
  assert.deepEqual(results.filter((result) => result.warning === true), []);
  assert.ok(results.length >= minimum, `${results.length} checks, expected ${minimum} or more`);
}

// One server serves the MCP and HTTP bindings to the tests below, and the HTTP binding of the target `cli` at `/cli` to the
// command line that calls a server. Each binding has its own test, so that a slow binding
// shows in the test report. The tests run at the same time, so the file takes the time of the slowest binding. Each
// binding has its own services of the fixture, so that the checks of one binding do not change the state of another.
describe("the TypeScript core passes acid-cat conform", { concurrency: true }, () => {
  const certificate = testCertificate();
  let mcp: McpHandler | undefined;
  let served: Served | undefined;
  let url = "";

  before(async () => {
    // A short wait before each new attempt of a delivery, so that the check of retries ends soon.
    const webhooks = webhookDelivery({ allowPrivateNetworks: true, ca: certificate.cert, retryDelayMs: () => 50, ...WEBHOOK_LIMITS });
    mcp = mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...options(), poll: POLL, principal: principalOf, webhooks });
    // The server writes the markers of the command line that calls it, because the server runs the calls. A watch does
    // not keep the process of the tests running.
    const mark = (path: string) => writeFile(path, "");
    const cli = httpHandler(fixture, { allowedOrigins: [], target: "cli", base: "/cli", ...options(new Holds(mark), new Watchers(mark, false)) });
    served = await serve({ "/mcp": mcpHandshake(mcp), "/api": httpHandler(fixture, { allowedOrigins: [], base: "/api", ...options() }), "/cli": cli }, { port: 0 });
    url = served.url;
  });

  after(async () => {
    await served?.close();
    await mcp?.close();
  });

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

  test("through the command line that calls a server", async () => {
    assertConforms(await conform({ cli: [process.execPath, new URL("./fixture-cli-remote.ts", import.meta.url).pathname, `${url}/cli`] }), 20);
  });

  test("through WebMCP, on a model context in Node.js", async () => {
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
