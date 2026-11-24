import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import conformanceFixture from "@acid-cat/cli/conformance/fixture.acidcat.json" with { type: "json" };
import { isJsonObject } from "@acid-cat/spec-ts";
import { z } from "zod";

import { AVAILABLE, CallFailureError, catalogOf, cliAlias, cliAliasDefault, createSession, defineApp, defineCapability, httpHandler, installWebMcp, mcpHandler, ok, renderCatalog, runCli } from "../src/index.ts";
import type { App, CliAlias, CliCommand, CliOptions, ModelContextTool, Outcome } from "../src/index.ts";
import { fixture, Holds, options, readJson, Switch, toJsonSchema, Watchers } from "./fixture.ts";
import type { Context } from "./fixture.ts";
import { until } from "../../../test-support/until.ts";

const SCHEMA_MEMBERS = new Set(["input", "output", "failures", "state", "payload"]);

function withoutSchemas(catalog: unknown): unknown {
  if (!isJsonObject(catalog)) return catalog;
  const items = (member: unknown) =>
    isJsonObject(member) ? Object.fromEntries(Object.entries(member).map(([id, item]) => [id, isJsonObject(item) ? Object.fromEntries(Object.entries(item).filter(([key]) => !SCHEMA_MEMBERS.has(key))) : item])) : member;
  return { ...catalog, $defs: Object.keys(isJsonObject(catalog["$defs"]) ? catalog["$defs"] : {}), capabilities: items(catalog["capabilities"]), events: items(catalog["events"]) };
}

test("the application writes a catalog that conforms, with the members of the conformance fixture", () => {
  const text = renderCatalog(fixture, { toJsonSchema });
  const catalog: unknown = JSON.parse(text);
  assert.deepEqual(check(catalog, text), { errors: [], warnings: [] });
  assert.deepEqual(withoutSchemas(catalog), withoutSchemas(conformanceFixture));
  assert.deepEqual(catalogOf(fixture, { toJsonSchema }).capabilities["fixture.note"]?.input, { description: "The note.", $ref: "#/$defs/Note" });
});

test("an input that is a union of objects is an object schema, and the catalog conforms", () => {
  const ById = z.object({ id: z.number().int() }).meta({ id: "ById" });
  const app = defineApp({
    targets: { mcp: { surfaces: ["mcp"] } },
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

const kindOf = (outcome: Outcome<unknown, unknown>) => ("kind" in outcome ? outcome.kind : undefined);

test("a call gives a value, a failure or a call failure", async () => {
  const session = createSession(fixture, { target: "mcp", ...options() });
  assert.deepEqual(await session.invoke("fixture.echo", { text: "hi" }), { ok: true, value: { text: "hi" } });
  assert.deepEqual(await session.invoke("fixture.refuse", {}), { ok: false, error: { _tag: "Refused", reason: "No." } });
  const invalid = await session.invoke("fixture.echo", { text: 1 });
  assert.ok("kind" in invalid);
  assert.equal(invalid.kind, "invalid-input");
  assert.match(invalid.message, /^text: /);
  assert.deepEqual(await session.invoke("fixture.crash", {}), { kind: "internal", message: "The capability failed." });
  assert.equal(kindOf(await session.invoke("fixture.hidden", {})), "unknown-capability");
  assert.equal(kindOf(await session.invoke("fixture.missing", {})), "unknown-capability");
  await session.dispose();
});

test("handles follow the TypeScript surface", async () => {
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
  const toggle = session.handles.get("fixture.toggle");
  assert.ok(toggle !== undefined);
  const unavailable = await toggle.invokeExternal({}).catch((caught: unknown) => caught);
  assert.ok(unavailable instanceof CallFailureError);
  assert.equal(unavailable.kind, "unavailable");
  context.context.switch.set(true);
  assert.deepEqual(await toggle.invokeExternal({}), { ok: true, value: null });

  const controller = new AbortController();
  const held = session.invoke("fixture.hold", { key: "cancelled" }, { signal: controller.signal });
  controller.abort();
  assert.equal(kindOf(await held), "cancelled");

  const pending = session.invoke("fixture.hold", { key: "pending" });
  await session.dispose();
  assert.equal(kindOf(await pending), "cancelled");
  assert.equal(kindOf(await session.invoke("fixture.echo", { text: "x" })), "cancelled");
});

test("an input schema that throws is internal, with no internal data, and the call does not reject", async () => {
  const defects: string[] = [];
  const app = defineApp({
    targets: { mcp: { surfaces: ["mcp"] } },
    capabilities: [
      defineCapability({
        id: "probe.throws",
        description: "The input schema throws.",
        audience: ["mcp"],
        input: z.object({ n: z.number() }).refine(() => {
          throw new Error("secret");
        }),
        run: () => ok(null),
      }),
    ],
  });
  await using session = createSession(app, { target: "mcp", toJsonSchema, context: {}, onDefect: (id) => defects.push(id) });
  assert.deepEqual(await session.invoke("probe.throws", { n: 1 }), { kind: "internal", message: "The capability failed." });
  assert.deepEqual(defects, ["probe.throws"]);
});

test("an abort during input validation cancels the call, and the provider does not run", async () => {
  let runs = 0;
  let validationStarted = () => {};
  const started = new Promise<void>((resolve) => (validationStarted = resolve));
  let finishValidation = () => {};
  const finished = new Promise<void>((resolve) => (finishValidation = resolve));
  const app = defineApp({
    targets: { mcp: { surfaces: ["mcp"] } },
    capabilities: [
      defineCapability({
        id: "probe.slow",
        description: "The input schema waits.",
        audience: ["mcp"],
        input: z.object({}).refine(async () => {
          validationStarted();
          await finished;
          return true;
        }),
        run: () => {
          runs += 1;
          return ok(null);
        },
      }),
    ],
  });
  await using session = createSession(app, { target: "mcp", toJsonSchema, context: {} });
  const controller = new AbortController();
  const call = session.invoke("probe.slow", {}, { signal: controller.signal });
  await started;
  controller.abort();
  finishValidation();
  assert.deepEqual(await call, { kind: "cancelled", message: "The call was cancelled." });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runs, 0);
});

test("an abort while the session reads the availability cancels the call", async () => {
  const controller = new AbortController();
  let abortedInRun: boolean | undefined;
  const app = defineApp({
    targets: { mcp: { surfaces: ["mcp"] } },
    capabilities: [
      defineCapability({
        id: "probe.aborts",
        description: "Reading the availability aborts the call.",
        audience: ["mcp"],
        availability: () => ({
          getSnapshot: () => {
            controller.abort();
            return AVAILABLE;
          },
          subscribe: () => ({ unsubscribe() {} }),
        }),
        run: (_input, { signal }) => {
          abortedInRun = signal.aborted;
          return ok(null);
        },
      }),
    ],
  });
  await using session = createSession(app, { target: "mcp", toJsonSchema, context: {} });
  assert.deepEqual(await session.invoke("probe.aborts", {}, { signal: controller.signal }), { kind: "cancelled", message: "The call was cancelled." });
  assert.notEqual(abortedInRun, false);
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

test("MCP gives the instructions of the options", async () => {
  const discover = async (instructions: string) => {
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
  assert.equal(await discover("Use fixture.echo to test the server."), "Use fixture.echo to test the server.");
});

test("HTTP: a body that is not JSON is invalid-input only after cancelled, unknown-capability and unavailable", async () => {
  const context = options();
  const handler = httpHandler(fixture, { allowedOrigins: [], base: "/api", ...context });
  const post = (id: string, signal?: AbortSignal) =>
    handler(new Request(`https://fixture.example/api/capabilities/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json", ...(signal === undefined ? {} : { signal }) }));
  const kind = async (response: Response) => (await readJson(response, z.object({ kind: z.string() }))).kind;
  const invalid = await post("fixture.echo");
  assert.equal(invalid.status, 422);
  assert.equal(await kind(invalid), "invalid-input");
  const unknown = await post("fixture.hidden");
  assert.equal(unknown.status, 404);
  assert.equal(await kind(unknown), "unknown-capability");
  assert.equal(await kind(await post("%E0")), "unknown-capability");
  context.context.switch.set(false);
  const unavailable = await post("fixture.toggle");
  assert.equal(unavailable.status, 503);
  assert.equal(await kind(unavailable), "unavailable");
  assert.equal(await kind(await post("fixture.hidden", AbortSignal.abort())), "cancelled");
});

test("HTTP: a path that is not under base is an unknown route", async () => {
  const handler = httpHandler(fixture, { allowedOrigins: [], base: "/api", ...options() });
  assert.equal((await handler(new Request("https://fixture.example/api/capabilities"))).status, 200);
  for (const path of ["/zzz/capabilities", "/apix/capabilities", "/zzz/catalog", "/zzz/events"]) {
    assert.equal((await handler(new Request(`https://fixture.example${path}`))).status, 404, path);
  }
  const call = await handler(new Request("https://fixture.example/zzz/capabilities/fixture.echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(call.status, 404);
});

function countedContexts() {
  const counts = { created: 0, released: 0 };
  const createContext = (): Context & AsyncDisposable => {
    counts.created += 1;
    return { switch: new Switch(), holds: new Holds(), watchers: new Watchers(), [Symbol.asyncDispose]: async () => void (counts.released += 1) };
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

async function commandLine<C>(app: App<C>, cliOptions: CliOptions<C>, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(app, cliOptions, args, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

test("call with input that is not JSON gives unknown-capability, then unavailable, before invalid-input", async () => {
  const context = options();
  context.context.switch.set(false);
  const run = (...args: string[]) => commandLine(fixture, { name: "fixture", version: "0.0.0", ...context }, ...args);
  assert.equal((await run("call", "fixture.nothing", "{bad")).code, 2);
  assert.equal((await run("call", "fixture.toggle", "{bad")).code, 4);
  assert.equal((await run("call", "fixture.echo", "{bad")).code, 3);
});

test("a required repeated flag must occur, an empty JSON array gives no items, and the usage gives the enum of a $ref item", async () => {
  const Day = z.enum(["mon", "tue"]).meta({ id: "Day" });
  const app = defineApp({
    targets: { cli: { surfaces: ["cli"] } },
    capabilities: [
      defineCapability({
        id: "probe.plan",
        description: "Return the days and the hours.",
        audience: ["cli"],
        input: z.object({ days: z.array(Day), hours: z.array(z.number().int()).optional() }),
        output: z.object({ days: z.array(Day), hours: z.array(z.number().int()).optional() }),
        run: (input) => ok(input),
      }),
    ],
  });
  const run = (...args: string[]) => commandLine(app, { name: "probe", version: "0.0.0", context: undefined, toJsonSchema }, ...args);
  assert.equal((await run("probe", "plan")).code, 3);
  assert.deepEqual(JSON.parse((await run("probe", "plan", "--days", "mon", "--hours", "[]")).stdout), { days: ["mon"], hours: [] });
  assert.match((await run("list")).stdout, /"usage":"probe probe plan --days <mon\|tue>\.\.\. \[--hours <integer>\.\.\.\]"/);
});

const position: CliCommand<Context> = {
  name: "position",
  description: "Write the position of the switch.",
  run: (args, { context, stdout }) => {
    stdout(`${args[0]}: ${context.switch.getSnapshot().available ? "on" : "off"}`);
    return 0;
  },
};

test("a command of the application runs beside the commands of the capabilities, and the help lists it with its description", async () => {
  const run = (...args: string[]) => commandLine(fixture, { name: "fixture", version: "0.0.0", ...options(), commands: [position] }, ...args);
  assert.deepEqual(await run("position", "switch"), { code: 0, stdout: "switch: on", stderr: "" });
  assert.equal((await run("fixture", "echo", "--text", "hi")).code, 0);
  assert.match((await run("--help")).stdout, /\n {2}list\n {2}watch <id> \[flags\] \[--cursor <string>\] \[--max-age-ms <integer>\]\n {2}position {2}Write the position of the switch\.\n\nAliases:\n/);
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
  for (const name of ["call", "list", "watch", "fixture", "say", "shout"]) {
    await assert.rejects(run([named(name)]), new RegExp(`The command ${name} of the application`));
  }
  await assert.rejects(run([named("report"), named("report")]), /The command report of the application/);
  const watchCapability = defineApp({ targets: { cli: { surfaces: ["cli"] } }, capabilities: [defineCapability({ id: "watch.start", description: "Start.", audience: ["cli"], run: () => ok(null) })] });
  await assert.rejects(commandLine(watchCapability, { name: "probe", version: "0.0.0", ...options() }, "list"), /watch start/);
});

test("the help lists the aliases, and only the name of a flag alias selects it", async () => {
  const run = (...args: string[]) => commandLine(fixture, { name: "fixture", version: "0.0.0", ...options() }, ...args);
  assert.match((await run("--help")).stdout, /\nAliases:\n {2}--hello\n {2}broken-ticks \[--cursor <string>\] \[--max-age-ms <integer>\]\n {2}echoes '<json>' \[--cursor <string>\] \[--max-age-ms <integer>\]\n {2}fixed-note \[--loud\]\n {2}fixture \[--count <integer>\][^\n]*\n {2}held-keys\n {2}notes '<json>'\n {2}notes add --text <string> \[--loud\]\n {2}notes loud --text <string>\n {2}quick \[--count <integer>\][^\n]*\n {2}raw '<json>'\n {2}say --text <string>\n {2}shout hello\n {2}ticks \[--gap <integer>\] \[--key <string>\] \[--cursor <string>\] \[--max-age-ms <integer>\]$/);
  assert.equal((await run("alias --hello")).code, 2);
  assert.equal((await run("--hello", "--text", "x")).code, 3);
});

test("a flag is a property of the input itself, not a name that every object inherits", async () => {
  const calls: unknown[] = [];
  const app = defineApp<Context>({
    targets: { cli: { surfaces: ["cli"], options: { cli: { aliases: { go: { capability: "probe.name", input: { constructor: "fixed" } } } } } } },
    capabilities: [
      defineCapability({
        id: "probe.name",
        description: "Echo.",
        audience: ["cli"],
        input: z.object({ constructor: z.string(), text: z.string().optional() }),
        run: (input) => {
          calls.push(input);
          return ok(input);
        },
      }),
    ],
  });
  const run = (...args: string[]) => commandLine(app, { name: "probe", version: "0.0.0", ...options() }, ...args);
  assert.deepEqual(JSON.parse((await run("go")).stdout), { constructor: "fixed" });
  assert.equal((await run("go", "--constructor", '"changed"')).code, 3);
  assert.equal((await run("go", "--toString", "x")).code, 3);
  assert.equal((await run("probe", "name", "--constructor", "own", "--toString", "x")).code, 3);
  assert.equal((await run("probe", "name", "--text", "no constructor")).code, 3);
  assert.deepEqual(calls, [{ constructor: "fixed" }]);
});

test("the command line stops when it starts if an alias breaks a rule", async () => {
  const app = (aliases: { readonly [name: string]: unknown }) =>
    defineApp<Context>({
      targets: { cli: { surfaces: ["cli"], options: { cli: { aliases } } } },
      capabilities: [defineCapability({ id: "probe.ping", description: "Ping.", audience: ["cli"], run: () => ok(null) })],
    });
  const run = (aliases: { readonly [name: string]: unknown }) => commandLine(app(aliases), { name: "probe", version: "0.0.0", ...options() }, "list");
  await assert.rejects(run({ list: { capability: "probe.ping" } }), /the alias list has the name of a command/);
  await assert.rejects(run({ "probe ping": { capability: "probe.ping" } }), /the alias probe ping has the path of the command of a capability/);
  await assert.rejects(run({ gone: { capability: "probe.gone" } }), /the alias gone refers to probe.gone/);
  assert.equal((await run({ ping: { capability: "probe.ping" } })).code, 0);
  assert.equal((await run({ probe: { capability: "probe.ping" } })).code, 0);
});

test("cliAlias writes options.cli, with one default command alias at most", () => {
  const ping = defineCapability({ id: "probe.ping", description: "Ping.", audience: ["cli"], run: () => ok(null) });
  const write = (aliases: Record<string, CliAlias>) =>
    catalogOf(defineApp({ targets: { cli: { surfaces: ["cli"], cli: { aliases } } }, capabilities: [ping] }), { toJsonSchema }).targets.cli?.options;
  assert.deepEqual(write({ ping: cliAliasDefault(ping), "--ping": cliAlias(ping) }), {
    cli: { aliases: { ping: { capability: "probe.ping" }, "--ping": { capability: "probe.ping" } }, default: "ping" },
  });
  assert.throws(() => write({ ping: cliAliasDefault(ping), pong: cliAliasDefault(ping) }), /the aliases ping, pong are all default aliases/);
  assert.throws(() => write({ "--ping": cliAliasDefault(ping) }), /the default alias --ping is a flag alias/);
});

test("the command line stops when it starts if the path of a capability is the start of the path of another", async () => {
  const probe = (id: string) => defineCapability({ id, description: "A probe.", audience: ["cli"], run: () => ok(null) });
  const app = (...ids: string[]) => defineApp<Context>({ targets: { cli: { surfaces: ["cli"] } }, capabilities: ids.map(probe) });
  const run = (...ids: string[]) => commandLine(app(...ids), { name: "probe", version: "0.0.0", ...options() }, "list");
  await assert.rejects(run("aircon.status", "aircon.status.get"), {
    message: "The command aircon status is also the start of the command aircon status get. A shared prefix only contains other commands.",
  });
  await assert.rejects(run("aircon.status.get", "aircon.status"), /The command aircon status is also the start of the command aircon status get\./);
  assert.equal((await run("aircon.status.get", "aircon.statuses", "aircon.power.set")).code, 0);
});

test("WebMCP: a failed update keeps the last tools, and retry registers them again", async (t) => {
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
  const context = options();
  const session = createSession(fixture, { target: "app", ...context });
  const installed = installWebMcp(session, { host });
  assert.ok(installed !== undefined);
  const phase = () => installed.status.getSnapshot().phase;
  await until(t, phase, (seen) => seen === "ready");
  assert.ok(tools.has("fixture.hidden"));

  context.context.switch.set(false);
  await until(t, () => !tools.has("fixture.toggle"));

  refuse.add("fixture.toggle");
  context.context.switch.set(true);
  await until(t, phase, (seen) => seen === "failed");
  assert.ok(tools.has("fixture.echo"));

  refuse.clear();
  installed.retry();
  await until(t, () => tools.has("fixture.toggle"));
  assert.equal(phase(), "ready");

  await installed.dispose();
  assert.equal(tools.size, 0);
  assert.equal(installed.status.getSnapshot().phase, "disposed");
  assert.equal(installWebMcp(session), undefined);
});

