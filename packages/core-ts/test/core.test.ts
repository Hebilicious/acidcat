import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";

import { CallFailureError, createSession, httpHandler, installWebMcp, mcpHandler, renderCatalog, runCli } from "../src/index.ts";
import type { ModelContextTool } from "../src/index.ts";
import { fixture, options, Switch, toJsonSchema } from "./fixture.ts";

test("the application writes a catalog that conforms", () => {
  const text = renderCatalog(fixture, { toJsonSchema });
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
});

test("a call gives a value, a failure or a call failure", async () => {
  const session = createSession(fixture, { target: "mcp", ...options() });
  assert.deepEqual(await session.invoke("fixture.echo", { text: "hi" }), { ok: true, value: { text: "hi" } });
  assert.deepEqual(await session.invoke("fixture.refuse", {}), { ok: false, error: { _tag: "Refused", reason: "No." } });
  assert.equal(((await session.invoke("fixture.echo", { text: 1 })) as { kind: string }).kind, "invalid-input");
  assert.deepEqual(await session.invoke("fixture.crash", {}), { kind: "internal", message: "The capability failed." });
  assert.equal(((await session.invoke("fixture.hidden", {})) as { kind: string }).kind, "unknown-capability");
  assert.equal(((await session.invoke("fixture.missing", {})) as { kind: string }).kind, "unknown-capability");
  await session.dispose();
});

test("handles follow the TypeScript binding", async () => {
  const session = createSession(fixture, { target: "app", ...options() });
  const echo = session.handles.get("fixture.echo")!;
  assert.deepEqual(await echo.invokeExternal({ text: "hi" }), { ok: true, value: { text: "hi" } });
  const error = await session.handles.get("fixture.crash")!.invokeExternal({}).catch((caught: unknown) => caught);
  assert.ok(error instanceof CallFailureError);
  assert.equal(error.kind, "internal");
  await session.dispose();
});

test("availability, cancellation and closing", async () => {
  const context = options();
  const session = createSession(fixture, { target: "mcp", ...context });
  let changes = 0;
  session.onChange(() => (changes += 1));
  context.context.switch.set(false);
  assert.equal(changes, 1);
  assert.deepEqual(await session.invoke("fixture.toggle", {}), { kind: "unavailable", message: "The switch is off." });

  const controller = new AbortController();
  const slow = session.invoke("fixture.slow", { milliseconds: 60_000 }, { signal: controller.signal });
  controller.abort();
  assert.equal(((await slow) as { kind: string }).kind, "cancelled");

  const pending = session.invoke("fixture.slow", { milliseconds: 60_000 });
  await session.dispose();
  assert.equal(((await pending) as { kind: string }).kind, "cancelled");
  assert.equal(((await session.invoke("fixture.echo", { text: "x" })) as { kind: string }).kind, "cancelled");
});

test("MCP gives the view and each outcome", async () => {
  const handler = mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...options() });
  const rpc = async (method: string, params: object = {}) =>
    (await (
      await handler(
        new Request("https://fixture.example/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", "mcp-method": method, "mcp-protocol-version": "2026-07-28" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      )
    ).json()) as { result?: any; error?: { code: number } };
  const tools = (await rpc("tools/list")).result.tools as { name: string; annotations: { readOnlyHint: boolean }; outputSchema?: object }[];
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["fixture.crash", "fixture.echo", "fixture.refuse", "fixture.slow", "fixture.toggle"]);
  assert.equal(tools.find((tool) => tool.name === "fixture.echo")!.annotations.readOnlyHint, true);
  const value = await rpc("tools/call", { name: "fixture.echo", arguments: { text: "hi" } });
  assert.deepEqual(value.result.structuredContent, { text: "hi" });
  const failure = await rpc("tools/call", { name: "fixture.refuse", arguments: {} });
  assert.equal(failure.result.isError, true);
  assert.deepEqual(JSON.parse(failure.result.content[0].text), { ok: false, error: { _tag: "Refused", reason: "No." } });
  assert.equal((await rpc("tools/call", { name: "fixture.hidden", arguments: {} })).error?.code, -32602);
  assert.equal((await handler(new Request("https://fixture.example/mcp"))).status, 405);
});

test("HTTP gives each outcome its status code", async () => {
  const handler = httpHandler(fixture, { allowedOrigins: [], base: "/api", ...options() });
  const post = (id: string, body: unknown) =>
    handler(new Request(`https://fixture.example/api/capabilities/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await post("fixture.echo", { text: "hi" })).status, 200);
  assert.equal((await post("fixture.echo", { text: 1 })).status, 422);
  assert.equal((await post("fixture.hidden", {})).status, 404);
  assert.equal((await post("fixture.crash", {})).status, 500);
  const list = (await (await handler(new Request("https://fixture.example/api/capabilities"))).json()) as { id: string }[];
  assert.ok(!list.some((entry) => entry.id === "fixture.hidden"));
});

test("the command line gives each outcome its exit code", async () => {
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(fixture, { name: "fixture", version: "0.0.0", ...options() }, args, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  };
  const echo = await run("fixture", "echo", "--text", "hi");
  assert.equal(echo.code, 0);
  assert.deepEqual(JSON.parse(echo.stdout), { text: "hi" });
  assert.equal((await run("fixture", "refuse")).code, 1);
  assert.equal((await run("nope")).code, 2);
  assert.equal((await run("call", "fixture.hidden")).code, 2);
  assert.equal((await run("fixture", "echo")).code, 3);
  assert.equal((await run("fixture", "slow", "--milliseconds", "soon")).code, 3);
  assert.equal((await run("fixture", "crash")).code, 5);
  assert.equal((await run("--help")).code, 0);
});

test("WebMCP tools follow availability, and a failed update keeps the last tools", async () => {
  const tools = new Map<string, ModelContextTool>();
  const refuse = new Set<string>();
  const host = {
    registerTool(tool: ModelContextTool, { signal }: { signal: AbortSignal }) {
      if (refuse.has(tool.name)) return Promise.reject(new Error(`refused ${tool.name}`));
      tools.set(tool.name, tool);
      signal.addEventListener("abort", () => tools.delete(tool.name));
      return undefined;
    },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const context = options();
  const session = createSession(fixture, { target: "app", ...context });
  const installed = installWebMcp(session, { host })!;
  await settle();
  assert.equal(installed.status.getSnapshot().phase, "ready");
  assert.ok(tools.has("fixture.hidden"));
  assert.deepEqual(await tools.get("fixture.echo")!.execute({ text: "hi" }), { ok: true, value: { text: "hi" } });

  context.context.switch.set(false);
  await settle();
  assert.ok(!tools.has("fixture.toggle"));

  refuse.add("fixture.toggle");
  context.context.switch.set(true);
  await settle();
  assert.equal(installed.status.getSnapshot().phase, "failed");
  assert.ok(tools.has("fixture.echo"));

  refuse.clear();
  installed.retry();
  await settle();
  assert.ok(tools.has("fixture.toggle"));

  await installed.dispose();
  assert.equal(tools.size, 0);
  assert.equal(installed.status.getSnapshot().phase, "disposed");
  assert.equal(installWebMcp(session), undefined);
});

void Switch;
