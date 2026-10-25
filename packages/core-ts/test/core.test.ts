import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { z } from "zod";

import { CallFailureError, catalogOf, createSession, defineApp, defineCapability, httpHandler, installWebMcp, mcpHandler, ok, renderCatalog, runCli } from "../src/index.ts";
import type { App, CliCommand, CliOptions, ModelContextTool, Outcome } from "../src/index.ts";
import { fixture, heldApp, Holds, options, readJson, Switch, toJsonSchema } from "./fixture.ts";
import type { Context } from "./fixture.ts";

test("the application writes a catalog that conforms", () => {
  const text = renderCatalog(fixture, { toJsonSchema });
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
});

test("an input that is a union of objects is an object schema, and the catalog conforms", () => {
  const ById = z.object({ id: z.number().int() }).meta({ id: "ById" });
  const app = defineApp({
    targets: { mcp: { bindings: ["mcp"] } },
    capabilities: [
      defineCapability({
        id: "probe.find",
        description: "Find a record by name or by id.",
        audience: ["mcp"],
        input: z.union([z.object({ name: z.string() }), ById]),
        run: () => ok(null),
      }),
    ],
  });
  const text = renderCatalog(app, { toJsonSchema });
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
  assert.equal(catalogOf(app, { toJsonSchema }).capabilities["probe.find"]?.input?.type, "object");
});

/** The kind of a call failure, or `undefined` for a result. */
const kindOf = (outcome: Outcome<unknown, unknown>) => ("kind" in outcome ? outcome.kind : undefined);

test("a call gives a value, a failure or a call failure", async () => {
  const session = createSession(fixture, { target: "mcp", ...options() });
  assert.deepEqual(await session.invoke("fixture.echo", { text: "hi" }), { ok: true, value: { text: "hi" } });
  assert.deepEqual(await session.invoke("fixture.refuse", {}), { ok: false, error: { _tag: "Refused", reason: "No." } });
  assert.equal(kindOf(await session.invoke("fixture.echo", { text: 1 })), "invalid-input");
  assert.deepEqual(await session.invoke("fixture.crash", {}), { kind: "internal", message: "The capability failed." });
  assert.equal(kindOf(await session.invoke("fixture.hidden", {})), "unknown-capability");
  assert.equal(kindOf(await session.invoke("fixture.missing", {})), "unknown-capability");
  await session.dispose();
});

test("handles follow the TypeScript binding", async () => {
  const session = createSession(fixture, { target: "app", ...options() });
  const echo = session.handles.get("fixture.echo");
  const crash = session.handles.get("fixture.crash");
  assert.ok(echo !== undefined && crash !== undefined);
  assert.deepEqual(await echo.invokeExternal({ text: "hi" }), { ok: true, value: { text: "hi" } });
  const error = await crash.invokeExternal({}).catch((caught: unknown) => caught);
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
  const held = session.invoke("fixture.hold", { key: "cancelled" }, { signal: controller.signal });
  controller.abort();
  assert.equal(kindOf(await held), "cancelled");

  const pending = session.invoke("fixture.hold", { key: "pending" });
  await session.dispose();
  assert.equal(kindOf(await pending), "cancelled");
  assert.equal(kindOf(await session.invoke("fixture.echo", { text: "x" })), "cancelled");
});

test("a session subscribes to the availabilities only while it has listeners", async () => {
  const context = options();
  const switcher = context.context.switch;
  const session = createSession(fixture, { target: "app", ...context });
  assert.equal(switcher.subscribers, 0);

  let changes = 0;
  const first = session.onChange(() => (changes += 1));
  const second = session.onChange(() => undefined);
  assert.equal(switcher.subscribers, 1);
  switcher.set(false);
  assert.equal(changes, 1);
  first.unsubscribe();
  assert.equal(switcher.subscribers, 1);
  second.unsubscribe();
  assert.equal(switcher.subscribers, 0);

  const toggle = session.handles.get("fixture.toggle");
  assert.ok(toggle !== undefined);
  const handle = toggle.availability.subscribe(() => undefined);
  assert.equal(switcher.subscribers, 1);
  handle.unsubscribe();
  assert.equal(switcher.subscribers, 0);

  session.onChange(() => undefined);
  assert.equal(switcher.subscribers, 1);
  await session.dispose();
  assert.equal(switcher.subscribers, 0);
  session.onChange(() => undefined);
  assert.equal(switcher.subscribers, 0);
});

test("MCP gives the view and each outcome", async () => {
  const handler = mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], ...options() });
  const Reply = z.object({
    result: z
      .object({
        tools: z.array(z.object({ name: z.string(), annotations: z.object({ readOnlyHint: z.boolean() }) })).optional(),
        structuredContent: z.unknown().optional(),
        isError: z.boolean().optional(),
        content: z.tuple([z.object({ text: z.string() })]).optional(),
      })
      .optional(),
    error: z.object({ code: z.number() }).optional(),
  });
  const rpc = async (method: string, params: object = {}) =>
    readJson(
      await handler(
        new Request("https://fixture.example/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", "mcp-method": method, "mcp-protocol-version": "2026-07-28" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
        }),
      ),
      Reply,
    );
  const tools = (await rpc("tools/list")).result?.tools ?? [];
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["fixture.crash", "fixture.echo", "fixture.held", "fixture.hold", "fixture.refuse", "fixture.release", "fixture.switch.set", "fixture.toggle"]);
  assert.equal(tools.find((tool) => tool.name === "fixture.echo")?.annotations.readOnlyHint, true);
  const value = await rpc("tools/call", { name: "fixture.echo", arguments: { text: "hi" } });
  assert.deepEqual(value.result?.structuredContent, { text: "hi" });
  const failure = await rpc("tools/call", { name: "fixture.refuse", arguments: {} });
  assert.equal(failure.result?.isError, true);
  const content = failure.result?.content;
  assert.ok(content !== undefined);
  assert.deepEqual(JSON.parse(content[0].text), { ok: false, error: { _tag: "Refused", reason: "No." } });
  assert.equal((await rpc("tools/call", { name: "fixture.hidden", arguments: {} })).error?.code, -32602);
  assert.equal((await handler(new Request("https://fixture.example/mcp"))).status, 405);
});

test("MCP gives the instructions of the options, or else the description of the application", async () => {
  const discover = async (instructions?: string) => {
    const handler = mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], instructions, ...options() });
    const response = await handler(
      new Request("https://fixture.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "mcp-method": "server/discover", "mcp-protocol-version": "2026-07-28" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
      }),
    );
    return (await readJson(response, z.object({ result: z.object({ instructions: z.string().optional() }) }))).result.instructions;
  };
  assert.equal(await discover(), fixture.description);
  assert.equal(await discover("Use fixture.echo to test the server."), "Use fixture.echo to test the server.");
});

test("HTTP gives each outcome its status code", async () => {
  const handler = httpHandler(fixture, { allowedOrigins: [], base: "/api", ...options() });
  const post = (id: string, body: unknown) =>
    handler(new Request(`https://fixture.example/api/capabilities/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await post("fixture.echo", { text: "hi" })).status, 200);
  assert.equal((await post("fixture.echo", { text: 1 })).status, 422);
  assert.equal((await post("fixture.hidden", {})).status, 404);
  assert.equal((await post("fixture.crash", {})).status, 500);
  const list = await readJson(await handler(new Request("https://fixture.example/api/capabilities")), z.array(z.object({ id: z.string() })));
  assert.ok(!list.some((entry) => entry.id === "fixture.hidden"));
});

/** A `createContext` that counts the contexts it makes and the contexts that the handler releases. */
function countedContexts() {
  const counts = { created: 0, released: 0 };
  const createContext = (): Context & AsyncDisposable => {
    counts.created += 1;
    return { switch: new Switch(), holds: new Holds(), [Symbol.asyncDispose]: async () => void (counts.released += 1) };
  };
  return { counts, createContext };
}

test("with createContext, each MCP request that passes the screening has its own context", async () => {
  const { counts, createContext } = countedContexts();
  const handler = mcpHandler(fixture, { name: "fixture", version: "0.0.0", allowedOrigins: [], toJsonSchema, createContext });
  const rpc = (method: string, params: object = {}) =>
    handler(
      new Request("https://fixture.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "mcp-method": method, "mcp-protocol-version": "2026-07-28" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
      }),
    );
  await rpc("tools/call", { name: "fixture.switch.set", arguments: { on: false } });
  const { result } = await readJson(await rpc("tools/list"), z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) }));
  assert.ok(result.tools.some((tool) => tool.name === "fixture.toggle"));
  assert.deepEqual(counts, { created: 2, released: 2 });

  assert.equal((await handler(new Request("https://fixture.example/mcp"))).status, 405);
  const tooLarge = new Request("https://fixture.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(1_048_577) });
  assert.equal((await handler(tooLarge)).status, 413);
  assert.deepEqual(counts, { created: 2, released: 2 });
});

test("with createContext, each HTTP request that passes the screening has its own context", async () => {
  const { counts, createContext } = countedContexts();
  const handler = httpHandler(fixture, { allowedOrigins: [], base: "/api", toJsonSchema, createContext });
  const set = await handler(
    new Request("https://fixture.example/api/capabilities/fixture.switch.set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: false }) }),
  );
  assert.equal(set.status, 200);
  const list = await readJson(await handler(new Request("https://fixture.example/api/capabilities")), z.array(z.object({ id: z.string(), available: z.boolean() })));
  assert.equal(list.find((entry) => entry.id === "fixture.toggle")?.available, true);
  assert.deepEqual(counts, { created: 2, released: 2 });

  assert.equal((await handler(new Request("https://fixture.example/api/capabilities", { method: "PUT" }))).status, 405);
  const tooLarge = new Request("https://fixture.example/api/capabilities/fixture.echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "x".repeat(1_048_577),
  });
  assert.equal((await handler(tooLarge)).status, 413);
  assert.deepEqual(counts, { created: 2, released: 2 });
});

test("the abort of an HTTP request cancels its call", async () => {
  const { app, started, seen } = heldApp();
  const handler = httpHandler(app, { allowedOrigins: [], toJsonSchema, context: undefined });
  const controller = new AbortController();
  const answer = handler(
    new Request("https://fixture.example/capabilities/held.wait", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal }),
  );

  await started;
  controller.abort();
  const response = await answer;
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { kind: "cancelled", message: "The call was cancelled." });
  assert.equal(seen.aborted, true);
});

test("the abort of an MCP request cancels its call", async () => {
  const { app, started, seen } = heldApp();
  const handler = mcpHandler(app, { name: "held", version: "0.0.0", allowedOrigins: [], toJsonSchema, context: undefined });
  const controller = new AbortController();
  const answer = handler(
    new Request("https://fixture.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-method": "tools/call", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "held.wait", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
      }),
      signal: controller.signal,
    }),
  );

  await started;
  controller.abort();
  const { result } = await readJson(await answer, z.object({ result: z.object({ isError: z.boolean(), content: z.tuple([z.object({ text: z.string() })]) }) }));
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { kind: "cancelled", message: "The call was cancelled." });
  assert.equal(seen.aborted, true);
});

/** Run the command line of an application with arguments, and keep what it writes. */
async function commandLine(app: App<Context>, cliOptions: CliOptions<Context>, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(app, cliOptions, args, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

test("the command line gives each outcome its exit code", async () => {
  const run = (...args: string[]) => commandLine(fixture, { name: "fixture", version: "0.0.0", ...options() }, ...args);
  const echo = await run("fixture", "echo", "--text", "hi");
  assert.equal(echo.code, 0);
  assert.deepEqual(JSON.parse(echo.stdout), { text: "hi" });
  assert.equal((await run("fixture", "refuse")).code, 1);
  assert.equal((await run("nope")).code, 2);
  assert.equal((await run("call", "fixture.hidden")).code, 2);
  assert.equal((await run("fixture", "echo")).code, 3);
  assert.equal((await run("fixture", "flags", "--mode", "fast", "--ratio", "soon")).code, 3);
  assert.equal((await run("fixture", "crash")).code, 5);
  assert.equal((await run("--help")).code, 0);
});

/** A command of the application. It uses the context, and writes its first argument. */
const position: CliCommand<Context> = {
  name: "position",
  description: "Write the position of the switch.",
  run: (args, { context, stdout }) => {
    stdout(`${args[0]}: ${context.switch.getSnapshot().available ? "on" : "off"}`);
    return 0;
  },
};

test("a command of the application runs beside the commands of the capabilities, and the help lists it", async () => {
  const run = (...args: string[]) => commandLine(fixture, { name: "fixture", version: "0.0.0", ...options(), commands: [position] }, ...args);
  assert.deepEqual(await run("position", "switch"), { code: 0, stdout: "switch: on", stderr: "" });
  assert.equal((await run("fixture", "echo", "--text", "hi")).code, 0);
  assert.match((await run("--help")).stdout, /\n {2}list\n {2}position {2}Write the position of the switch\.$/);
});

test("the help gives the description of the options, else the description of the application, else its title", async () => {
  const firstLine = async (app: App<Context>, description?: string) =>
    (await commandLine(app, { name: "fixture", version: "0.0.0", ...options(), description }, "--help")).stdout.split("\n")[0];
  assert.equal(await firstLine(fixture, "Own."), "Own.");
  assert.equal(await firstLine(fixture), fixture.description);
  assert.equal(await firstLine({ ...fixture, description: undefined }), fixture.title);
});

test("a command of the application must not have the name of another command", async () => {
  const named = (name: string): CliCommand<Context> => ({ name, description: "A command.", run: () => 0 });
  const run = (commands: CliCommand<Context>[]) => commandLine(fixture, { name: "fixture", version: "0.0.0", ...options(), commands }, "list");
  for (const name of ["call", "list", "fixture"]) {
    await assert.rejects(run([named(name)]), new RegExp(`The command ${name} of the application`));
  }
  await assert.rejects(run([named("report"), named("report")]), /The command report of the application/);
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
  const installed = installWebMcp(session, { host });
  assert.ok(installed !== undefined);
  await settle();
  assert.equal(installed.status.getSnapshot().phase, "ready");
  assert.ok(tools.has("fixture.hidden"));
  const echo = tools.get("fixture.echo");
  assert.ok(echo !== undefined);
  assert.deepEqual(await echo.execute({ text: "hi" }), { ok: true, value: { text: "hi" } });

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
