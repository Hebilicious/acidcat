import assert from "node:assert/strict";
import { test } from "node:test";

import { isJsonObject } from "@acid-cat/spec-ts";

import { mcpHandler, mcpHandshake } from "../src/index.ts";
import type { McpSettings } from "../src/index.ts";
import { webhookDelivery } from "../src/node.ts";
import { fixture, options } from "./fixture.ts";

const CARD_URL = "https://fixture.example/mcp/server-card";

const cardHandler = (settings: Partial<McpSettings> = {}) =>
  mcpHandler(fixture, { name: "fixture", version: "1.2.3", allowedOrigins: [], ...options(), serverCard: { name: "dev.acid-cat/fixture" }, ...settings });

test("the Server Card gives the name, the version, the description of the catalog and the URL of the server, with CORS and cache headers", async () => {
  const handler = cardHandler();
  const response = await handler(new Request(CARD_URL));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/mcp-server-card+json");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type, If-None-Match");
  assert.equal(response.headers.get("Access-Control-Expose-Headers"), "ETag");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
  assert.deepEqual(await response.json(), {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "dev.acid-cat/fixture",
    version: "1.2.3",
    description: fixture.description,
    remotes: [{ type: "streamable-http", url: "https://fixture.example/mcp", supportedProtocolVersions: ["2026-07-28"] }],
  });
  const etag = response.headers.get("ETag") ?? "";
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  const unchanged = await handler(new Request(CARD_URL, { headers: { "If-None-Match": etag } }));
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  const preflight = await handler(new Request(CARD_URL, { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Headers"), "Content-Type, If-None-Match");
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
  const unchanged = await wrapped(new Request(CARD_URL, { headers: { "If-None-Match": response.headers.get("ETag") ?? "" } }));
  assert.equal(unchanged.status, 304);
  await handler.close();
});

test("a Server Card with a URL gives that URL, for a server behind a platform that ends TLS", async () => {
  const handler = cardHandler({ serverCard: { name: "dev.acid-cat/fixture", url: "https://mcp.example.com/mcp" } });
  const card: unknown = await (await handler(new Request("http://10.0.0.1:3000/mcp/server-card"))).json();
  assert.ok(isJsonObject(card) && Array.isArray(card["remotes"]) && isJsonObject(card["remotes"][0]));
  assert.equal(card["remotes"][0]["url"], "https://mcp.example.com/mcp");
  await handler.close();
});

test("with no Server Card, a GET request to its URL gets 404", async () => {
  const handler = cardHandler({ serverCard: undefined });
  assert.equal((await handler(new Request(CARD_URL))).status, 404);
  await handler.close();
});

test("with webhook delivery and no signing keys or egress ranges, the Server Card has no extensionsInfo", async () => {
  const handler = cardHandler({ webhooks: webhookDelivery() });
  const card: unknown = await (await handler(new Request(CARD_URL))).json();
  assert.ok(isJsonObject(card) && Array.isArray(card["remotes"]) && isJsonObject(card["remotes"][0]) && !("extensionsInfo" in card["remotes"][0]));
  await handler.close();
});

test("a card name that is not in reverse-DNS form, a description longer than 100 characters, or a URL that is not http or https, makes mcpHandler throw", () => {
  assert.throws(() => cardHandler({ serverCard: { name: "dev.acid-cat/fixture", url: "ftp://mcp.example.com/mcp" } }), TypeError);
  assert.throws(() => cardHandler({ serverCard: { name: "fixture" } }), TypeError);
  assert.throws(() => cardHandler({ serverCard: { name: "dev.acid-cat/fixture", description: "x".repeat(101) } }), TypeError);
});
