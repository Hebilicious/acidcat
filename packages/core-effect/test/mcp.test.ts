import assert from "node:assert/strict";
import { test } from "node:test";

import { Deferred, Effect, Layer, Schema } from "effect";

import { Mcp } from "../src/index.ts";
import { countedFixtureLayer, fixture, fixtureLayer, heldApp, recordingApp } from "./fixture.ts";

const ORIGIN = "https://fixture.example";

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
