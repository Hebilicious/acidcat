import assert from "node:assert/strict";
import { test } from "node:test";

import { Deferred, Effect, Layer, Schema } from "effect";

import { Mcp } from "../src/index.ts";
import { countedFixtureLayer, fixture, fixtureLayer, heldApp, recordingApp } from "./fixture.ts";

const ORIGIN = "https://fixture.example";
const handler = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN] });

/** One MCP request in the stateless 2026-07-28 revision. */
function mcpRequest(method: string, params: object = {}, name?: string) {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  });
  if (name !== undefined) headers.set("mcp-name", name);
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
  });
}

/** A JSON-RPC answer. Each test decodes `result` with the schema of the method. */
const Answer = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const Discovery = Schema.Struct({ instructions: Schema.optional(Schema.String) });
const Tools = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      outputSchema: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
      annotations: Schema.Struct({ readOnlyHint: Schema.optional(Schema.Boolean) }),
    }),
  ),
});
const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.NonEmptyArray(Schema.Struct({ text: Schema.String })),
});

/** The `result` of an answer, decoded with `schema`. */
const resultOf = <S extends Schema.Decoder<unknown>>(schema: S, answer: typeof Answer.Type): S["Type"] =>
  Schema.decodeUnknownSync(schema)(answer.result);

/** The JSON-RPC answer of a response. */
const answerOf = async (response: Response) => Schema.decodeUnknownSync(Answer)(await response.json());

async function mcp(method: string, params: object = {}, name?: string) {
  const response = await handler(mcpRequest(method, params, name));
  assert.equal(response.status, 200);
  return answerOf(response);
}

const call = (name: string, args: object) => mcp("tools/call", { name, arguments: args }, name);

test("server/discover gives the instructions of the options, or else the description of the application", async () => {
  assert.equal(resultOf(Discovery, await mcp("server/discover")).instructions, fixture.description);
  const instructed = Mcp.toWebHandler(fixture, Layer.fresh(fixtureLayer), {
    name: "fixture",
    version: "0.0.0",
    allowedOrigins: [ORIGIN],
    instructions: "Use fixture.echo to test the server.",
  });
  const response = await instructed(mcpRequest("server/discover"));
  assert.equal(resultOf(Discovery, await answerOf(response)).instructions, "Use fixture.echo to test the server.");
});

test("tools/list gives the available capabilities of the view, with their schemas and hints", async () => {
  const { tools } = resultOf(Tools, await mcp("tools/list"));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "fixture.crash",
    "fixture.echo",
    "fixture.held",
    "fixture.hold",
    "fixture.refuse",
    "fixture.release",
    "fixture.switch.set",
    "fixture.toggle",
  ]);
  const echo = tools.find((tool) => tool.name === "fixture.echo");
  assert.ok(echo !== undefined);
  assert.equal(echo.annotations.readOnlyHint, true);
  assert.equal(echo.outputSchema?.type, "object");
});

test("tools/call gives each outcome in the form of the binding", async () => {
  const value = resultOf(ToolResult, await call("fixture.echo", { text: "hi" }));
  assert.deepEqual(value.structuredContent, { text: "hi" });
  assert.equal(value.isError ?? false, false);

  const failure = resultOf(ToolResult, await call("fixture.refuse", {}));
  assert.equal(failure.isError, true);
  assert.deepEqual(JSON.parse(failure.content[0].text), { ok: false, error: { _tag: "Refused", reason: "No." } });

  const crash = resultOf(ToolResult, await call("fixture.crash", {}));
  assert.deepEqual(JSON.parse(crash.content[0].text), { kind: "internal", message: "The capability failed." });
});

test("a tool outside the view is an unknown tool", async () => {
  const hidden = await call("fixture.hidden", {});
  assert.equal(hidden.error?.code, -32602);
});

test("requests are rejected before the protocol is read", async () => {
  const post = (init: RequestInit) => handler(new Request(`${ORIGIN}/mcp`, { method: "POST", ...init }));
  assert.equal((await handler(new Request(`${ORIGIN}/mcp`))).status, 405);
  assert.equal((await post({ headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await post({ headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await post({ headers: { "Content-Type": "application/json" }, body: "x".repeat(1_048_577) })).status, 413);
  const notJson = await post({ headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(notJson.status, 400);
  assert.equal((await answerOf(notJson)).error?.code, -32700);
});

test("with per-request services, each request that passes the screening has its own services", async () => {
  const { counts, layer } = countedFixtureLayer();
  const perRequest = Mcp.toWebHandler(fixture, layer, { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN], services: "per-request" });

  const set = mcpRequest("tools/call", { name: "fixture.switch.set", arguments: { on: false } }, "fixture.switch.set");
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

  test(`with ${services} services, the abort of a request cancels its call`, async () => {
    const { app, started, interrupted } = heldApp();
    const handler = Mcp.toWebHandler(app, Layer.empty, { name: "held", version: "0.0.0", allowedOrigins: [ORIGIN], services });
    const controller = new AbortController();
    const answer = handler(new Request(mcpRequest("tools/call", { name: "held.wait", arguments: {} }, "held.wait"), { signal: controller.signal }));

    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    const result = resultOf(ToolResult, await answerOf(await answer));
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { kind: "cancelled", message: "The call was cancelled." });
    assert.equal(Deferred.isDoneUnsafe(interrupted), true);
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

/** One MCP request of a revision with a handshake. `version` is the `MCP-Protocol-Version` header, if any. */
const handshakePost = (message: object, version?: string) =>
  handler(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...(version === undefined ? {} : { "mcp-protocol-version": version }) },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    }),
  );

const Initialized = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.Unknown,
  serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
  instructions: Schema.optional(Schema.String),
});

test("the server serves the initialize handshake of earlier revisions with no state", async () => {
  const initialized = resultOf(Initialized, await answerOf(await handshakePost({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })));
  assert.deepEqual(initialized, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "fixture", version: "0.0.0" },
    instructions: fixture.description,
  });
  const latest = resultOf(Initialized, await answerOf(await handshakePost({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })));
  assert.equal(latest.protocolVersion, "2025-11-25");

  const notified = await handshakePost({ method: "notifications/initialized" }, "2025-06-18");
  assert.equal(notified.status, 202);
  assert.equal(notified.headers.get("Mcp-Session-Id"), null);

  const listed = await answerOf(await handshakePost({ id: 2, method: "tools/list" }, "2025-06-18"));
  assert.ok(resultOf(Tools, listed).tools.some((tool) => tool.name === "fixture.echo"));
  assert.deepEqual(Object.keys(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(listed.result)), ["tools"]);
  const called = await answerOf(await handshakePost({ id: 3, method: "tools/call", params: { name: "fixture.echo", arguments: { text: "hi" } } }, "2025-11-25"));
  assert.deepEqual(resultOf(ToolResult, called).structuredContent, { text: "hi" });
  const unknown = await handshakePost({ id: 4, method: "tools/call", params: { name: "fixture.hidden", arguments: {} } }, "2025-11-25");
  assert.equal(unknown.status, 200);
  assert.equal((await answerOf(unknown)).error?.code, -32602);
  assert.deepEqual((await answerOf(await handshakePost({ id: 5, method: "ping" }, "2025-11-25"))).result, {});

  const unsupported = await handshakePost({ id: 6, method: "tools/list" }, "2024-01-01");
  assert.equal(unsupported.status, 400);
  assert.equal((await answerOf(unsupported)).error?.code, -32022);
});
