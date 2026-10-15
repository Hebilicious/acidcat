/**
 * Capabilities whose schemas and program load on demand. `moon run core-effect:typecheck` checks the types in this file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { NodeServices } from "@effect/platform-node";
import { check } from "@acid-cat/cli";
import { CallFailureError } from "@acid-cat/spec-ts";
import { Console, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Schema, Scope, Stdio } from "effect";
import { Command } from "effect/cli";

import { App, Capability, Cli, Handles, Http, Mcp, Session, WebMcp } from "../src/index.ts";

type Probe = typeof import("./lazy-probe.capability.ts");

/** The URL of the probe module for one test, so that the test counts only its own evaluations of it. */
const probeUrl = (name: string) => new URL(`./lazy-probe.capability.ts?case=${name}`, import.meta.url).href;
const evaluations = (url: string) => (globalThis as { lazyProbeEvaluations?: Record<string, number> }).lazyProbeEvaluations?.[url] ?? 0;

const declaration = { id: "plan.generate", description: "Make a plan with some stops.", audience: ["app", "mcp", "cli", "api"], readOnly: true };
const targets = { app: { bindings: ["typescript"] }, mcp: { bindings: ["mcp"] }, cli: { bindings: ["cli"] }, api: { bindings: ["http"] } };

/**
 * A lazy capability of the probe module, with a count of its loads. Before each load it can wait for `gate`, fail
 * `failures` times, or give `undefined` `undefinedTimes` times.
 */
function lazyProbe(name: string, options: { readonly gate?: Deferred.Deferred<void>; readonly failures?: number; readonly undefinedTimes?: number; readonly metadata?: Partial<typeof declaration> } = {}) {
  const url = probeUrl(name);
  const loads = { count: 0, failures: options.failures ?? 0, undefinedTimes: options.undefinedTimes ?? 0 };
  let begun = () => undefined as void;
  /** Resolves when the first load begins. */
  const started = new Promise<void>((resolve) => (begun = resolve));
  const capability = Capability.lazy({ ...declaration, ...options.metadata }, async () => {
    loads.count++;
    begun();
    if (options.gate !== undefined) await Effect.runPromise(Deferred.await(options.gate));
    if (loads.failures > 0) {
      loads.failures--;
      throw new Error("The module did not load.");
    }
    if (loads.undefinedTimes > 0) {
      loads.undefinedTimes--;
      return undefined as unknown as Probe["generate"];
    }
    return ((await import(url)) as Probe).generate;
  });
  const app = App.make({ targets, capabilities: [capability] });
  return { capability, app, loads, url, started };
}

const quiet = Logger.layer([]);

test("opening a session and its handles loads no lazy capability, and the first call loads it once", async () => {
  const { capability, app, loads, url } = lazyProbe("open");
  const session = await Handles.open(app, Layer.empty, { target: "app" });
  try {
    const handles = Handles.tree(session.handles, { plan: { generate: capability } });
    assert.equal(loads.count, 0);
    assert.equal(evaluations(url), 0);
    assert.deepEqual(await handles.plan.generate.execute({ stops: 3 }), { ok: true, value: { stops: 3, label: "3 stops" } });
    assert.deepEqual(await handles.plan.generate.invokeExternal({ stops: 11 }), { ok: false, error: { _tag: "TooFar", stops: 11 } });
    assert.equal(loads.count, 1);
    assert.equal(evaluations(url), 1);
    // @ts-expect-error The input of the lazy capability has the type of the loaded module.
    void (() => handles.plan.generate.execute({ stops: "three" }));
  } finally {
    await session.dispose();
  }
});

test("a cancelled load does not keep the next call from loading, and loads one time for both", async () => {
  const gate = Effect.runSync(Deferred.make<void>());
  const gated = lazyProbe("cancelled", { gate });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(gated.app, { target: "app" });
        const first = yield* Effect.forkScoped(session.invoke("plan.generate", { stops: 1 }), { startImmediately: true });
        yield* Effect.promise(() => gated.started);
        yield* Fiber.interrupt(first);
        assert.equal(gated.loads.count, 1);
        yield* Deferred.succeed(gate, undefined);
        assert.deepEqual(yield* session.invoke("plan.generate", { stops: 2 }), { ok: true, value: { stops: 2, label: "2 stops" } });
        assert.equal(gated.loads.count, 1);
        assert.equal(evaluations(gated.url), 1);
      }),
    ),
  );
});

for (const [name, options] of [
  ["a module that fails", { failures: 1 }],
  ["a module that gives no capability", { undefinedTimes: 1 }],
] as const) {
  test(`${name} is internal one time, then the next call loads again`, async () => {
    const probe = lazyProbe(name.replaceAll(" ", "-"), options);
    const session = await Handles.open(probe.app, Layer.empty, { target: "app" });
    try {
      const handle = session.handles.get("plan.generate")!;
      const failed = await handle.invokeExternal({ stops: 1 }).catch((error: unknown) => error);
      assert.ok(failed instanceof CallFailureError);
      assert.equal(failed.kind, "internal");
      assert.deepEqual(await handle.invokeExternal({ stops: 1 }), { ok: true, value: { stops: 1, label: "1 stops" } });
      assert.equal(probe.loads.count, 2);
    } finally {
      await session.dispose();
    }
  });
}

test("a module whose metadata is not the declaration, or that has state, does not load", async () => {
  const other = lazyProbe("other-description", { metadata: { description: "Something else." } });
  const exit = await Effect.runPromiseExit(Capability.load(other.capability));
  assert.ok(Exit.isFailure(exit) && /description of the module is not the description of the declaration/.test(String(exit.cause)));

  const stateful = Capability.lazy({ id: "plan.status", description: "The status of the planner.", audience: ["app"] }, async () =>
    ((await import(probeUrl("state"))) as Probe).withState as never,
  );
  const stateExit = await Effect.runPromiseExit(Capability.load(stateful));
  assert.ok(Exit.isFailure(stateExit) && /has no state/.test(String(stateExit.cause)));
});

test("the catalog of a loaded lazy application is the catalog of the same capabilities declared at once", async () => {
  const { app, url } = lazyProbe("catalog");
  assert.throws(() => App.render(app), /App.load/);
  await Effect.runPromise(App.load(app));
  const { generate } = (await import(url)) as Probe;
  const eager = App.make({ targets, capabilities: [generate] });
  const text = App.render(app);
  assert.equal(text, App.render(eager));
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
});

test("the view of a target needs only the lazy capabilities of that target", async () => {
  const { capability } = lazyProbe("view");
  const appOnly = Capability.lazy({ id: "plan.hidden", description: "Hidden.", audience: ["app"] }, async () => {
    throw new Error("This module is never loaded.");
  });
  const app = App.make({ targets, capabilities: [capability, appOnly] });
  await Effect.runPromise(App.load(app, { target: "mcp" }));
  assert.deepEqual(Object.keys(App.view(app, "mcp").capabilities), ["plan.generate"]);
});

test("MCP loads the lazy capabilities of its view to list them", async () => {
  const { app, loads } = lazyProbe("mcp");
  const handler = Mcp.toWebHandler(app, Layer.empty, { name: "probe", version: "0.0.0", allowedOrigins: [] });
  const response = await handler(
    new Request("https://probe.local/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-method": "tools/list", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    }),
  );
  const tools = ((await response.json()) as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } }).result.tools;
  assert.deepEqual(tools.map((tool) => [tool.name, tool.inputSchema.required]), [["plan.generate", ["stops"]]]);
  assert.equal(loads.count, 1);
});

/** A WebMCP host that tells when a tool is registered. */
function recordingHost() {
  const tools = new Set<string>();
  const waiters = new Map<string, () => void>();
  const host: WebMcp.ModelContext = {
    registerTool(tool) {
      tools.add(tool.name);
      waiters.get(tool.name)?.();
    },
  };
  const registered = (name: string) => (tools.has(name) ? Promise.resolve() : new Promise<void>((resolve) => waiters.set(name, resolve)));
  return { host, tools, registered };
}

/** Install the WebMCP binding for an application on a host, in a scope that the result closes. */
async function installed(app: App.App<never>, host: WebMcp.ModelContext) {
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.make(app, { target: "app" });
      yield* WebMcp.install(session, { host });
    }).pipe(Scope.provide(scope), Effect.provide(quiet)),
  );
  return () => Effect.runPromise(Scope.close(scope, Exit.void));
}

test("WebMCP registers each lazy capability when it loads, and loads again one that failed", async () => {
  const good = lazyProbe("webmcp-good");
  let attempts = 0;
  const flaky = Capability.lazy({ id: "plan.list", description: "List the plans.", audience: ["app"], readOnly: true }, async () => {
    attempts++;
    if (attempts === 1) throw new Error("The module did not load.");
    return ((await import(probeUrl("webmcp-flaky"))) as Probe).list;
  });
  const { host, tools, registered } = recordingHost();
  const close = await installed(App.make({ targets: { app: { bindings: ["webmcp"] } }, capabilities: [good.capability, flaky] }), host);
  try {
    await registered("plan.generate");
    await registered("plan.list");
    assert.deepEqual([...tools].sort(), ["plan.generate", "plan.list"]);
    assert.equal(attempts, 2);
  } finally {
    await close();
  }
});

test("a load that does not end keeps no other capability from WebMCP", async () => {
  const good = lazyProbe("webmcp-stuck-good");
  const stuck = Capability.lazy({ id: "plan.list", description: "List the plans.", audience: ["app"], readOnly: true }, () =>
    new Promise<Probe["list"]>(() => undefined),
  );
  const { host, tools, registered } = recordingHost();
  const close = await installed(App.make({ targets: { app: { bindings: ["webmcp"] } }, capabilities: [stuck, good.capability] }), host);
  try {
    await registered("plan.generate");
    assert.deepEqual([...tools], ["plan.generate"]);
  } finally {
    await close();
  }
});

test("the HTTP catalog answers internal with the status 500 when a capability of its target does not load", async () => {
  const { app } = lazyProbe("http", { failures: 1 });
  const handler = Http.toWebHandler(app, Layer.empty, { allowedOrigins: [], base: "/api" });
  const response = await Effect.runPromise(Effect.promise(() => handler(new Request("https://probe.local/api/catalog"))).pipe(Effect.provide(quiet)));
  assert.equal(response.status, 500);
  assert.equal(((await response.json()) as { kind: string }).kind, "internal");
  assert.equal((await handler(new Request("https://probe.local/api/catalog"))).status, 200);
});

test("the command line lists a lazy capability with its flags, and a capability that does not load is internal with exit code 5", async () => {
  const { app } = lazyProbe("cli");
  await Effect.runPromise(App.load(app));
  const answers: string[] = [];
  await Effect.runPromise(
    Command.runWith(Cli.command(app, { name: "probe", version: "0.0.0" }), { version: "0.0.0" })(["list"]).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(Cli.Answers, { write: (text) => Effect.sync(() => void answers.push(text)) }),
    ),
  );
  const listed = JSON.parse(answers.join("")) as { id: string; usage: string }[];
  assert.deepEqual(listed.map((entry) => entry.usage), ["probe plan generate --stops <integer>"]);

  const broken = lazyProbe("cli-broken", { failures: 1 });
  const errors: string[] = [];
  const exitCode = process.exitCode;
  try {
    await Effect.runPromise(
      Cli.run(broken.app, { name: "probe", version: "0.0.0" }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, quiet)),
        Effect.provideService(Console.Console, { ...globalThis.console, error: (...parts: unknown[]) => void errors.push(parts.join(" ")) } as never),
      ),
    );
    assert.equal(process.exitCode, 5);
    assert.match(errors.join("\n"), /"kind":"internal"/);
  } finally {
    process.exitCode = exitCode;
  }
});

test("a load that fails the same way again is logged one time", async () => {
  const probe = lazyProbe("logged", { failures: 2 });
  const logged: unknown[] = [];
  const recording = Logger.layer([Logger.make((options) => void logged.push(options.message))]);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(probe.app, { target: "app" });
        assert.equal(((yield* session.invoke("plan.generate", { stops: 1 })) as { kind: string }).kind, "internal");
        assert.equal(((yield* session.invoke("plan.generate", { stops: 1 })) as { kind: string }).kind, "internal");
      }),
    ).pipe(Effect.provide(recording)),
  );
  assert.equal(probe.loads.count, 2);
  assert.equal(logged.length, 1);
});

test("a lazy capability is not a capability with schemas, and its schemas are written one time for both", async () => {
  const { capability } = lazyProbe("types");
  // @ts-expect-error A lazy capability has no schemas, so it is not a capability with its schemas.
  const eager: Capability.Capability<any, any, any, never> = capability;
  void eager;

  const renders = { count: 0 };
  const Counted = Schema.String.check(
    Schema.makeFilter((value: string) => value.length < 100, {
      toJsonSchema: () => {
        renders.count++;
        return { maxLength: 99 };
      },
    }),
  );
  const counted = Capability.lazy({ id: "probe.name.set", description: "Set a name.", audience: ["app"] }, async () =>
    Capability.make({ id: "probe.name.set", description: "Set a name.", audience: ["app"], input: Schema.Struct({ name: Counted }), run: () => Effect.succeed(null) }),
  );
  await Effect.runPromise(Capability.load(counted));
  App.inputJsonSchema(counted);
  App.inputJsonSchema(App.withSchemas(counted));
  assert.equal(renders.count, 1);
});

/**
 * Run the command line of `app` with `args` from the `Stdio` service, which is where `Command.run` reads them, and give
 * the exit code and the answers.
 */
async function runCli(app: App.App<never>, args: readonly string[]) {
  const answers: string[] = [];
  const exitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await Effect.runPromise(
      Cli.run(app, { name: "probe", version: "0.0.0" }).pipe(
        Effect.provideService(Cli.Answers, { write: (text) => Effect.sync(() => void answers.push(text)) }),
        Effect.provide(Stdio.layerTest({ args: Effect.succeed(args) })),
        Effect.provide(Layer.merge(NodeServices.layer, quiet)),
        Effect.provideService(Console.Console, { ...globalThis.console, error: () => undefined, log: () => undefined } as never),
      ),
    );
    return { code: process.exitCode ?? 0, answers };
  } finally {
    process.exitCode = exitCode;
  }
}

/** A lazy capability whose module never loads, with a count of its loads. */
function neverLoads(id: string) {
  const loads = { count: 0 };
  const capability = Capability.lazy({ ...declaration, id }, async () => {
    loads.count++;
    throw new Error("This module does not load.");
  });
  return { capability, loads };
}

test("the command line loads the capability of the command that follows the values of global flags", async () => {
  const generate = lazyProbe("global-flag-values").capability;
  const info = neverLoads("info.plan");
  const app = App.make({ targets, capabilities: [info.capability, generate] });
  for (const args of [
    ["--log-level", "info", "plan", "generate", "--stops", "2"],
    ["--log-level=info", "plan", "generate", "--stops", "2"],
  ]) {
    const { code, answers } = await runCli(app, args);
    assert.equal(code, 0, args.join(" "));
    assert.deepEqual(JSON.parse(answers.join("")), { stops: 2, label: "2 stops" });
  }
  assert.equal(info.loads.count, 0);
});

test("the command line loads for the arguments that Stdio gives, not for the arguments of the process", async () => {
  const generate = lazyProbe("stdio-args").capability;
  const broken = neverLoads("plan.list");
  const app = App.make({ targets, capabilities: [generate, broken.capability] });
  const { code, answers } = await runCli(app, ["plan", "generate", "--stops", "3"]);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(answers.join("")), { stops: 3, label: "3 stops" });
  assert.equal(broken.loads.count, 0);
});
