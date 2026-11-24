import assert from "node:assert/strict";
import { test } from "node:test";

import { isJsonObject } from "@acid-cat/spec-ts";

import { defineApp, defineCapability, mcpHandler, mcpHandshake, ok } from "../src/index.ts";
import type { McpSettings } from "../src/index.ts";
import { webhookDelivery } from "../src/node.ts";
import { fixture, options, toJsonSchema } from "./fixture.ts";

const CARD_URL = "https://fixture.example/mcp/server-card";

const cardHandler = (settings: Partial<McpSettings> = {}) =>
  mcpHandler(fixture, { name: "fixture", version: "1.2.3", allowedOrigins: [], ...options(), serverCard: { name: "dev.acid-cat/fixture" }, ...settings });

test("the Server Card gives the configured name, the version, the description of the catalog and the URL of the server, with CORS and cache headers, and other methods than GET and OPTIONS get 405", async () => {
  const handler = cardHandler();
  const response = await handler(new Request(CARD_URL));
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
  const etag = response.headers.get("ETag") ?? "";
  const unchanged = await handler(new Request(CARD_URL, { headers: { "If-None-Match": etag } }));
  assert.deepEqual([unchanged.status, unchanged.headers.get("ETag")], [304, etag]);
  assert.deepEqual(await response.json(), {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "dev.acid-cat/fixture",
    version: "1.2.3",
    description: fixture.description,
    remotes: [{ type: "streamable-http", url: "https://fixture.example/mcp", supportedProtocolVersions: ["2026-07-28"] }],
  });
  const post = await handler(new Request(CARD_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET, OPTIONS");
  await handler.close();
});

test("behind mcpHandshake, the Server Card also gives the revisions of the handshake", async () => {
  const handler = cardHandler();
  const wrapped = mcpHandshake(handler);
  const response = await wrapped(new Request(CARD_URL));
  const card: unknown = await response.json();
  const remotes = isJsonObject(card) ? card["remotes"] : undefined;
  assert.deepEqual(Array.isArray(remotes) && isJsonObject(remotes[0]) ? remotes[0]["supportedProtocolVersions"] : undefined, ["2026-07-28", "2025-11-25", "2025-06-18"]);
  await handler.close();
});

test("a Server Card with a URL gives that URL, for a server behind a platform that ends TLS", async () => {
  const handler = cardHandler({ serverCard: { name: "dev.acid-cat/fixture", url: "https://mcp.example.com/mcp" } });
  const card: unknown = await (await handler(new Request("http://10.0.0.1:3000/mcp/server-card"))).json();
  assert.ok(isJsonObject(card) && Array.isArray(card["remotes"]) && isJsonObject(card["remotes"][0]));
  assert.equal(card["remotes"][0]["url"], "https://mcp.example.com/mcp");
  await handler.close();
});

const cardOf = async (response: Response) => {
  assert.equal(response.status, 200);
  const card: unknown = await response.json();
  assert.ok(isJsonObject(card));
  return card;
};

test("with no settings, the server serves a Server Card with the default name, and the catalog description or a fallback", async () => {
  const handler = cardHandler({ serverCard: undefined });
  const card = await cardOf(await handler(new Request(CARD_URL)));
  assert.deepEqual([card["name"], card["version"], card["description"]], ["example.fixture/fixture", "1.2.3", fixture.description]);
  assert.equal((await cardOf(await handler(new Request("http://127.0.0.1:3000/mcp/server-card"))))["name"], "local/fixture");
  await handler.close();
  const app = defineApp({
    targets: { mcp: { surfaces: ["mcp"] } },
    capabilities: [defineCapability({ id: "probe.run", description: "Run the probe.", audience: ["mcp"], run: () => ok(null) })],
  });
  const noDescription = mcpHandler(app, { name: "probe server", version: "0.0.0", allowedOrigins: [], context: undefined, toJsonSchema });
  const fallback = await cardOf(await noDescription(new Request("http://localhost:3000/mcp/server-card")));
  assert.deepEqual([fallback["name"], fallback["description"]], ["localhost/probe-server", "probe server"]);
  await noDescription.close();
});

test("with the Server Card off, a GET request to its URL gets 404, and a version range starts", async () => {
  const handler = cardHandler({ serverCard: false, version: "^1.2.3" });
  assert.equal((await handler(new Request(CARD_URL))).status, 404);
  await handler.close();
});

test("with webhook delivery and no signing keys or egress ranges, the Server Card has no extensionsInfo", async () => {
  const handler = cardHandler({ webhooks: webhookDelivery() });
  const card: unknown = await (await handler(new Request(CARD_URL))).json();
  assert.ok(isJsonObject(card) && Array.isArray(card["remotes"]) && isJsonObject(card["remotes"][0]) && !("extensionsInfo" in card["remotes"][0]));
  await handler.close();
});

test("a card name that is not in reverse-DNS form, a description longer than 100 characters, a URL that is not http or https, or a version range, makes mcpHandler throw", () => {
  for (const url of ["ftp://mcp.example.com/mcp", "http://%"]) assert.throws(() => cardHandler({ serverCard: { url } }), TypeError, url);
  assert.throws(() => cardHandler({ serverCard: { name: "fixture" } }), TypeError);
  assert.throws(() => cardHandler({ serverCard: { description: "x".repeat(101) } }), TypeError);
  assert.throws(() => cardHandler({ serverCard: undefined, version: "^1.2.3" }), /not a range/);
});

test("webhook signing keys or egress ranges with the Server Card off make mcpHandler throw", () => {
  const signingKey = { kty: "OKP", crv: "Ed25519", kid: "one", d: "A".repeat(43) } as const;
  for (const webhooks of [webhookDelivery({ signingKeys: [signingKey] }), webhookDelivery({ egressIpRanges: ["203.0.113.0/24"] })]) {
    assert.throws(() => cardHandler({ serverCard: false, webhooks }), /need a Server Card/);
  }
});
