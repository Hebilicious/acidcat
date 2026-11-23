import assert from "node:assert/strict";
import { test } from "node:test";

import { isJsonObject } from "@acid-cat/spec-ts";
import { Deferred, Effect, Layer, Schema } from "effect";

import { Mcp } from "../src/index.ts";
import { countedFixtureLayer, fixture, fixtureLayer, heldApp, recordingApp } from "./fixture.ts";

const ORIGIN = "https://fixture.example";

function mcpRequest(method: string, params: object = {}, name?: string, others: Record<string, string> = {}) {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
    ...others,
  });
  if (name !== undefined) headers.set("mcp-name", name);
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
  });
}

const Answer = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const Discovery = Schema.Struct({ instructions: Schema.optional(Schema.String) });
const Tools = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });
const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  content: Schema.NonEmptyArray(Schema.Struct({ text: Schema.String })),
});

const resultOf = <S extends Schema.Decoder<unknown>>(schema: S, answer: typeof Answer.Type): S["Type"] =>
  Schema.decodeUnknownSync(schema)(answer.result);

const answerOf = async (response: Response) => Schema.decodeUnknownSync(Answer)(await response.json());

test("server/discover gives the instructions of the options", async () => {
  const instructed = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), {
    name: "fixture",
    version: "0.0.0",
    allowedOrigins: [ORIGIN],
    instructions: "Use fixture.echo to test the server.",
  });
  const response = await instructed(mcpRequest("server/discover"));
  assert.equal(resultOf(Discovery, await answerOf(response)).instructions, "Use fixture.echo to test the server.");
});

test("with per-request services, each request that passes the screening has its own services", async () => {
  const { counts, layer } = countedFixtureLayer();
  const perRequest = Mcp.toWebHandler(fixture, layer, { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN], services: "per-request" });

  const set = mcpRequest("tools/call", { name: "fixture.switch.set", arguments: { on: false } }, "fixture.switch.set", { "Mcp-Param-On": "false" });
  assert.equal((await perRequest(set)).status, 200);
  const { tools } = resultOf(Tools, await answerOf(await perRequest(mcpRequest("tools/list"))));
  assert.ok(tools.some((tool) => tool.name === "fixture.toggle"));
  assert.deepEqual(counts, { built: 2, released: 2 });

  assert.equal((await perRequest(new Request(`${ORIGIN}/mcp`, { method: "GET" }))).status, 405);
  assert.deepEqual(counts, { built: 2, released: 2 });
});

test("Mcp.handle screens the request", async () => {
  const options = { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN] };
  const answer = (request: Request) => Effect.runPromise(Mcp.handle(fixture, request, options).pipe(Effect.provide(fixtureLayer)));
  assert.equal((await answer(new Request(`${ORIGIN}/mcp`, { method: "GET" }))).status, 405);
  const foreign = mcpRequest("tools/list");
  foreign.headers.set("Origin", "https://evil.example");
  assert.equal((await answer(foreign)).status, 403);
  assert.equal((await answer(mcpRequest("tools/list"))).status, 200);
});

test("with per-request services, the abort of a request cancels its call", async () => {
  const { app, started, interrupted } = heldApp();
  const handler = Mcp.toWebHandler(app, Layer.empty, { name: "held", version: "0.0.0", allowedOrigins: [ORIGIN], services: "per-request" });
  const controller = new AbortController();
  const answer = handler(new Request(mcpRequest("tools/call", { name: "held.wait", arguments: {} }, "held.wait"), { signal: controller.signal }));

  await Effect.runPromise(Deferred.await(started));
  controller.abort();
  const result = resultOf(ToolResult, await answerOf(await answer));
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { kind: "cancelled", message: "The call was cancelled." });
  assert.equal(Deferred.isDoneUnsafe(interrupted), true);
});

for (const services of ["shared", "per-request"] as const) {
  test(`with ${services} services, a refused request builds no services`, async () => {
    const { counts, layer } = countedFixtureLayer();
    const handler = Mcp.toWebHandler(fixture, layer, { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN], maximumBytes: 16, services });
    const post = (headers: HeadersInit, body: string) => handler(new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body }));

    assert.equal((await handler(new Request(`${ORIGIN}/mcp`))).status, 405);
    assert.equal((await post({ "Content-Type": "application/json", Origin: "https://evil.example" }, "{}")).status, 403);
    assert.equal((await post({ "Content-Type": "text/plain" }, "{}")).status, 415);
    assert.equal((await post({ "Content-Type": "application/json" }, JSON.stringify({ jsonrpc: "2.0", id: 1 }))).status, 413);
    assert.equal((await post({ "Content-Type": "application/json" }, "{")).status, 400);
    assert.deepEqual(counts, { built: 0, released: 0 });
  });

  test(`with ${services} services, a request that is already aborted does not start its call`, async () => {
    const { app, record } = recordingApp();
    const handler = Mcp.toWebHandler(app, Layer.empty, { name: "recorded", version: "0.0.0", allowedOrigins: [ORIGIN], services });
    const request = mcpRequest("tools/call", { name: "recorded.run", arguments: {} }, "recorded.run");
    const result = resultOf(ToolResult, await answerOf(await handler(new Request(request, { signal: AbortSignal.abort() }))));

    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { kind: "cancelled", message: "The call was cancelled." });
    assert.equal(record.ran, false);
  });
}

const CARD_URL = `${ORIGIN}/mcp/server-card`;

test("the Server Card gives the name, the version, the description of the catalog and the URL of the server, with CORS and cache headers", async () => {
  const handler = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), { name: "fixture", version: "1.2.3", allowedOrigins: [], serverCard: { name: "dev.acid-cat/fixture" } });
  try {
    const response = await handler(new Request(CARD_URL));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/mcp-server-card+json");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Access-Control-Expose-Headers"), "ETag");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
    assert.deepEqual(await response.json(), {
      $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
      name: "dev.acid-cat/fixture",
      version: "1.2.3",
      description: fixture.description,
      remotes: [{ type: "streamable-http", url: `${ORIGIN}/mcp`, supportedProtocolVersions: ["2026-07-28"] }],
    });
    const unchanged = await handler(new Request(CARD_URL, { headers: { "If-None-Match": response.headers.get("ETag") ?? "" } }));
    assert.equal(unchanged.status, 304);
    assert.equal((await handler(new Request(CARD_URL, { method: "OPTIONS" }))).status, 204);
    const post = await handler(new Request(CARD_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    assert.deepEqual([post.status, post.headers.get("Allow")], [405, "GET, OPTIONS"]);
    const behindTls = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), { name: "fixture", version: "1.2.3", allowedOrigins: [], serverCard: { name: "dev.acid-cat/fixture", url: "https://mcp.example.com/mcp" } });
    const given: unknown = await (await behindTls(new Request("http://10.0.0.1:3000/mcp/server-card"))).json();
    await behindTls.dispose();
    const givenRemotes = isJsonObject(given) ? given.remotes : undefined;
    assert.equal(Array.isArray(givenRemotes) && isJsonObject(givenRemotes[0]) ? givenRemotes[0].url : undefined, "https://mcp.example.com/mcp");
    const legacy: unknown = await (await Mcp.withHandshake(handler)(new Request(CARD_URL))).json();
    const remotes = isJsonObject(legacy) ? legacy.remotes : undefined;
    assert.deepEqual(Array.isArray(remotes) && isJsonObject(remotes[0]) ? remotes[0].supportedProtocolVersions : undefined, ["2026-07-28", "2025-11-25", "2025-06-18"]);
  } finally {
    await handler.dispose();
  }
});

test("with no Server Card, a GET request to its URL gets 404, and a card that breaks the rules makes the server fail when it starts", async () => {
  const handler = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), { name: "fixture", version: "0.0.0", allowedOrigins: [] });
  try {
    assert.equal((await handler(new Request(CARD_URL))).status, 404);
  } finally {
    await handler.dispose();
  }
  const starts = (serverCard: Mcp.ServerCardSettings) => () => Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), { name: "fixture", version: "0.0.0", allowedOrigins: [], serverCard });
  assert.throws(starts({ name: "fixture" }), TypeError);
  assert.throws(starts({ name: "dev.acid-cat/fixture", description: "x".repeat(101) }), TypeError);
  assert.throws(starts({ name: "dev.acid-cat/fixture", url: "ftp://mcp.example.com/mcp" }), TypeError);
  assert.throws(() => Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), { name: "fixture", version: "^1.2.3", allowedOrigins: [], serverCard: { name: "dev.acid-cat/fixture" } }), /not a range/);
});

test("webhook signing keys or egress ranges with no Server Card make the server fail when it starts", () => {
  const signingKey = { kty: "OKP", crv: "Ed25519", kid: "one", d: "A".repeat(43) } as const;
  const sender: Mcp.WebhookSender = () => Effect.die("The test sends no webhook.");
  for (const webhooks of [{ sender, signingKeys: [signingKey] }, { sender, egressIpRanges: ["203.0.113.0/24"] }]) {
    assert.throws(() => Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), { name: "fixture", version: "0.0.0", allowedOrigins: [], webhooks }), /need a Server Card/);
    assert.throws(() => Mcp.withEvents(fixture, Layer.fresh(fixtureLayer), () => Promise.resolve(new Response()), { allowedOrigins: [], webhooks }), /need one/);
  }
});
