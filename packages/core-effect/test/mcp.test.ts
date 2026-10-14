import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Layer } from "effect";

import { Mcp } from "../src/index.ts";
import { countedSwitchLayer, fixture, switchLayer } from "./fixture.ts";

const ORIGIN = "https://fixture.example";
const handler = Mcp.toWebHandler(fixture, Layer.fresh(switchLayer), { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN] });

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

async function mcp(method: string, params: object = {}, name?: string) {
  const response = await handler(mcpRequest(method, params, name));
  assert.equal(response.status, 200);
  return (await response.json()) as { result?: any; error?: { code: number; message: string } };
}

const call = (name: string, args: object) => mcp("tools/call", { name, arguments: args }, name);

test("tools/list gives the available capabilities of the view, with their schemas and hints", async () => {
  const { result } = await mcp("tools/list");
  const tools = result.tools as { name: string; inputSchema: object; outputSchema?: object; annotations: { readOnlyHint?: boolean } }[];
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "fixture.crash",
    "fixture.echo",
    "fixture.refuse",
    "fixture.slow",
    "fixture.switch.set",
    "fixture.toggle",
  ]);
  const echo = tools.find((tool) => tool.name === "fixture.echo")!;
  assert.equal(echo.annotations.readOnlyHint, true);
  assert.equal((echo.outputSchema as { type?: string }).type, "object");
});

test("tools/call gives each outcome in the form of the binding", async () => {
  const value = await call("fixture.echo", { text: "hi" });
  assert.deepEqual(value.result.structuredContent, { text: "hi" });
  assert.equal(value.result.isError ?? false, false);

  const failure = await call("fixture.refuse", {});
  assert.equal(failure.result.isError, true);
  assert.deepEqual(JSON.parse(failure.result.content[0].text), { ok: false, error: { _tag: "Refused", reason: "No." } });

  const crash = await call("fixture.crash", {});
  assert.deepEqual(JSON.parse(crash.result.content[0].text), { kind: "internal", message: "The capability failed." });
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
  assert.equal(((await notJson.json()) as { error: { code: number } }).error.code, -32700);
});

test("with per-request services, each request that passes the screening has its own services", async () => {
  const { counts, layer } = countedSwitchLayer();
  const perRequest = Mcp.toWebHandler(fixture, layer, { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN], services: "per-request" });

  const set = mcpRequest("tools/call", { name: "fixture.switch.set", arguments: { on: false } }, "fixture.switch.set");
  assert.equal((await perRequest(set)).status, 200);
  const { result } = (await (await perRequest(mcpRequest("tools/list"))).json()) as { result: { tools: { name: string }[] } };
  assert.ok(result.tools.some((tool) => tool.name === "fixture.toggle"));
  assert.deepEqual(counts, { built: 2, released: 2 });

  assert.equal((await perRequest(new Request(`${ORIGIN}/mcp`, { method: "GET" }))).status, 405);
  assert.deepEqual(counts, { built: 2, released: 2 });
});

test("Mcp.handle screens the request", async () => {
  const options = { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN] };
  const answer = (request: Request) => Effect.runPromise(Mcp.handle(fixture, request, options).pipe(Effect.provide(switchLayer)));
  assert.equal((await answer(new Request(`${ORIGIN}/mcp`, { method: "GET" }))).status, 405);
  const foreign = mcpRequest("tools/list");
  foreign.headers.set("Origin", "https://evil.example");
  assert.equal((await answer(foreign)).status, 403);
  assert.equal((await answer(mcpRequest("tools/list"))).status, 200);
});
