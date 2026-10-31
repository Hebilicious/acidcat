import assert from "node:assert/strict";
import { test } from "node:test";

import { isJsonObject } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { mcpHandshake } from "../src/index.ts";

const SERVER_INFO = { "io.modelcontextprotocol/serverInfo": { name: "stub", version: "1.0.0" } };

/** The requests that reach the stub, and the stub: a server of revision 2026-07-28 that rejects one origin. */
function stub() {
  const seen: { headers: Headers; body: JsonObject }[] = [];
  const handler = async (request: Request): Promise<Response> => {
    if (request.headers.get("Origin") === "https://evil.example") return new Response(null, { status: 403 });
    const body: unknown = request.method === "POST" ? await request.json() : {};
    if (!isJsonObject(body)) throw new Error("the body is not an object");
    seen.push({ headers: request.headers, body });
    const meta = { ...SERVER_INFO };
    const results: JsonObject = {
      "server/discover": { _meta: meta, resultType: "complete", ttlMs: 0, cacheScope: "private", supportedVersions: ["2026-07-28"], capabilities: { tools: { listChanged: true } }, instructions: "Use the stub." },
      "tools/list": { _meta: meta, resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ name: "stub.echo" }] },
      "tools/call": { _meta: meta, resultType: "complete", content: [{ type: "text", text: "{}" }] },
    };
    const params = isJsonObject(body["params"]) ? body["params"] : {};
    if (body["method"] === "tools/call" && params["name"] !== "stub.echo") {
      return Response.json({ jsonrpc: "2.0", id: body["id"], error: { code: -32602, message: "Tool not found" } });
    }
    return Response.json({ jsonrpc: "2.0", id: body["id"], result: results[String(body["method"])] });
  };
  return { seen, handler: mcpHandshake(handler) };
}

const post = (message: object, headers: Record<string, string> = {}) =>
  new Request("https://stub.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });

const bodyOf = async (response: Response): Promise<JsonObject> => {
  const body: unknown = await response.json();
  if (!isJsonObject(body)) throw new Error("the body is not an object");
  return body;
};

test("initialize gives the result of server/discover in the form of the handshake", async () => {
  const { seen, handler } = stub();
  const response = await handler(post({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Mcp-Session-Id"), null);
  assert.deepEqual(await bodyOf(response), {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "stub", version: "1.0.0" }, instructions: "Use the stub." },
  });
  assert.equal(seen[0]?.body["method"], "server/discover");
  assert.equal(seen[0]?.headers.get("MCP-Protocol-Version"), "2026-07-28");
  assert.equal(seen[0]?.headers.get("Mcp-Method"), "server/discover");

  const latest = await bodyOf(await handler(post({ id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } })));
  assert.equal(isJsonObject(latest["result"]) ? latest["result"]["protocolVersion"] : undefined, "2025-11-25");
});

test("tools/list and tools/call go to the handler, and their results lose the members of revision 2026-07-28", async () => {
  const { seen, handler } = stub();
  const listed = await bodyOf(await handler(post({ id: 1, method: "tools/list" }, { "MCP-Protocol-Version": "2025-06-18" })));
  assert.deepEqual(listed, { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "stub.echo" }] } });
  const called = await bodyOf(await handler(post({ id: "a", method: "tools/call", params: { name: "stub.echo", arguments: {} } }, { "MCP-Protocol-Version": "2025-11-25" })));
  assert.deepEqual(called, { jsonrpc: "2.0", id: "a", result: { content: [{ type: "text", text: "{}" }] } });
  const call = seen[1];
  assert.equal(call?.headers.get("Mcp-Name"), "stub.echo");
  const params = isJsonObject(call?.body["params"]) ? call.body["params"] : {};
  assert.deepEqual(params["_meta"], { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} });
  const unknown = await handler(post({ id: 3, method: "tools/call", params: { name: "stub.hidden" } }, { "MCP-Protocol-Version": "2025-11-25" }));
  assert.equal(unknown.status, 200);
  assert.deepEqual(await bodyOf(unknown), { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Tool not found" } });
});

test("ping, notifications and unknown methods are answered after the handler screens them", async () => {
  const { seen, handler } = stub();
  assert.deepEqual(await bodyOf(await handler(post({ id: 1, method: "ping" }))), { jsonrpc: "2.0", id: 1, result: {} });
  const notified = await handler(post({ method: "notifications/initialized" }));
  assert.equal(notified.status, 202);
  const unknown = await bodyOf(await handler(post({ id: 2, method: "resources/list" })));
  assert.deepEqual(unknown, { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found: resources/list" } });
  assert.equal(seen.length, 3);
  const rejected = await handler(post({ id: 3, method: "initialize" }, { Origin: "https://evil.example" }));
  assert.equal(rejected.status, 403);
});

test("requests that are not of a revision with a handshake go to the handler unchanged", async () => {
  const { seen, handler } = stub();
  const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
  await handler(post({ id: 1, method: "tools/list", params: meta }, { "MCP-Protocol-Version": "2026-07-28" }));
  await handler(post({ id: 2, method: "tools/list", params: meta }));
  await handler(post({ id: 3, method: "tools/list" }, { "MCP-Protocol-Version": "2000-01-01" }));
  assert.deepEqual(seen.map(({ headers }) => headers.get("MCP-Protocol-Version")), ["2026-07-28", null, "2000-01-01"]);
  assert.deepEqual(seen.map(({ body }) => body["id"]), [1, 2, 3]);
});
