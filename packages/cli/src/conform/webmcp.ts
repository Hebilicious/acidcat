/**
 * Conformance checks for the WebMCP binding (spec/bindings/webmcp.md).
 *
 * The checks act as the WebMCP host: they give the page a `modelContext`, record the tools that the binding registers,
 * and call them. The page can run in a browser, or the implementation can install itself on the host in the same
 * process.
 */
import { REFERENCE, visitObjects } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { Checks, expect, expectEqual, fixture, idsOf, sorted } from "./check.ts";

const RULE = "spec/bindings/webmcp.md";

/** The target of the fixture that has the WebMCP binding. */
const TARGET = "app";

/** A tool as the host records it. */
export interface RecordedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** What a call to a tool gives: the value that `execute` resolves with, or the error that it rejects with. */
export type ToolCall =
  | { readonly resolved: unknown }
  | { readonly rejected: { readonly name: string; readonly kind: unknown; readonly message: string } }
  | { readonly missing: true };

/** The host that the checks give to the page. */
export interface TestHost {
  readonly modelContext: {
    registerTool(tool: object, options: { readonly signal: AbortSignal }): void;
  };
  tools(): RecordedTool[];
  /** The number of changes of the tools so far. Each registration and each removal is one change. */
  version(): number;
  /** Resolve with the number of changes when it is more than `after`. */
  changed(after: number): Promise<number>;
  /** Call a tool, and wait for its outcome. */
  call(name: string, input: unknown): Promise<ToolCall>;
  /** Start a call to a tool, and give its number. `cancel` and `result` take the number. */
  start(name: string, input: unknown): number;
  /** Abort the signal of a call that `start` started. */
  cancel(call: number): void;
  /** The outcome of a call that `start` started. */
  result(call: number): Promise<ToolCall>;
}

/**
 * Make a test host. The function uses no imports and no outer variables, because the browser driver sends its
 * source text to the page.
 */
export function createTestHost(): TestHost {
  type Tool = RecordedTool & { execute(input: unknown, options: { signal: AbortSignal }): Promise<unknown> };
  const registered = new Map<string, Tool>();
  let version = 0;
  const waiting = new Set<() => void>();
  const change = () => {
    version += 1;
    waiting.forEach((wake) => wake());
  };
  const calls = new Map<number, { readonly controller: AbortController; readonly result: Promise<ToolCall> }>();
  const run = async (name: string, input: unknown, signal: AbortSignal): Promise<ToolCall> => {
    const tool = registered.get(name);
    if (tool === undefined) return { missing: true };
    try {
      return { resolved: await tool.execute(input, { signal }) };
    } catch (error) {
      const { name: errorName, kind, message } = error as { name?: unknown; kind?: unknown; message?: unknown };
      return { rejected: { name: String(errorName), kind, message: String(message) } };
    }
  };
  return {
    modelContext: {
      registerTool(tool, options) {
        const recorded = tool as Tool;
        registered.set(recorded.name, recorded);
        change();
        options.signal.addEventListener("abort", () => {
          if (registered.get(recorded.name) !== recorded) return;
          registered.delete(recorded.name);
          change();
        });
      },
    },
    tools: () =>
      [...registered.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    version: () => version,
    changed: (after) =>
      new Promise((resolve) => {
        const wake = () => {
          if (version <= after) return;
          waiting.delete(wake);
          resolve(version);
        };
        waiting.add(wake);
        wake();
      }),
    call: (name, input) => run(name, input, new AbortController().signal),
    start(name, input) {
      const controller = new AbortController();
      const number = calls.size + 1;
      calls.set(number, { controller, result: run(name, input, controller.signal) });
      return number;
    },
    cancel: (call) => calls.get(call)?.controller.abort(),
    result: (call) => calls.get(call)?.result ?? Promise.resolve({ missing: true }),
  };
}

/** The view from the checks: the tools of the page, and calls to them. */
export interface WebMcpDriver {
  tools(): Promise<RecordedTool[]>;
  version(): Promise<number>;
  changed(after: number): Promise<number>;
  call(name: string, input: unknown): Promise<ToolCall>;
  start(name: string, input: unknown): Promise<number>;
  cancel(call: number): Promise<void>;
  result(call: number): Promise<ToolCall>;
  close(): Promise<void>;
}

/**
 * Install the implementation on a host in the same process. Return a function that removes it, or nothing. The
 * implementation serves the `app` target of the fixture, with its switch on.
 */
export type WebMcpInstall = (
  modelContext: TestHost["modelContext"],
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

/** A driver for an implementation in the same process. Values pass through JSON, as they do from a page. */
export async function processDriver(install: WebMcpInstall): Promise<WebMcpDriver> {
  const host = createTestHost();
  const remove = await install(host.modelContext);
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    tools: async () => copy(host.tools()),
    version: async () => host.version(),
    changed: (after) => host.changed(after),
    call: async (name, input) => copy(await host.call(name, input)),
    start: async (name, input) => host.start(name, input),
    cancel: async (call) => host.cancel(call),
    result: async (call) => copy(await host.result(call)),
    close: async () => {
      if (typeof remove === "function") await remove();
    },
  };
}

/** A driver for a page in Chromium, through Playwright. The page loads with the test host as its `modelContext`. */
export async function browserDriver(url: string): Promise<WebMcpDriver> {
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "acid-cat conform --webmcp needs Playwright and Chromium: `pnpm add -D playwright`, then `pnpm exec playwright install chromium`.",
    );
  }
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(`
    window.__acidCatConform = (${createTestHost.toString()})();
    for (const scope of [document, navigator]) {
      Object.defineProperty(scope, "modelContext", { value: window.__acidCatConform.modelContext, configurable: true });
    }
  `);
  await page.goto(url);
  type Window = { __acidCatConform: TestHost };
  return {
    tools: async () => {
      if (errors.length > 0) throw new Error(`The page has errors: ${errors.join("; ")}`);
      return page.evaluate(() => (window as unknown as Window).__acidCatConform.tools());
    },
    version: () => page.evaluate(() => (window as unknown as Window).__acidCatConform.version()),
    changed: (after) => page.evaluate((after) => (window as unknown as Window).__acidCatConform.changed(after), after),
    call: (name, input) =>
      page.evaluate(([name, input]) => (window as unknown as Window).__acidCatConform.call(name, input), [name, input] as const),
    start: (name, input) =>
      page.evaluate(([name, input]) => (window as unknown as Window).__acidCatConform.start(name, input), [name, input] as const),
    cancel: (call) => page.evaluate((call) => (window as unknown as Window).__acidCatConform.cancel(call), call),
    result: (call) => page.evaluate((call) => (window as unknown as Window).__acidCatConform.result(call), call),
    close: () => browser.close(),
  };
}

/**
 * Wait until the tools of the page agree with `condition`. The check reads the tools after each change of them, and
 * fails after `MAXIMUM_CHANGES` changes. If the tools do not change, it fails when `guard` ends: the guard keeps a page
 * that never changes from stopping the checks, and it is not part of what the check tests.
 */
async function untilTools(driver: WebMcpDriver, condition: (tools: readonly RecordedTool[]) => boolean, what: string): Promise<void> {
  for (let changes = 0; ; changes++) {
    const version = await driver.version();
    if (condition(await driver.tools())) return;
    if (changes === MAXIMUM_CHANGES) throw new Error(`after ${MAXIMUM_CHANGES} changes of the tools: ${what}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<"guard">((resolve) => (timer = setTimeout(() => resolve("guard"), GUARD)));
    const next = await Promise.race([driver.changed(version), guard]);
    clearTimeout(timer);
    if (next === "guard") throw new Error(`the tools did not change: ${what}`);
  }
}

const MAXIMUM_CHANGES = 100;
const GUARD = 30_000;

/** The keys that fixture.held gives through a tool. */
async function heldKeys(driver: WebMcpDriver): Promise<readonly string[]> {
  const call = await driver.call("fixture.held", {});
  expect("resolved" in call, `fixture.held gave ${JSON.stringify(call)}`);
  return ((call.resolved as { value?: { keys?: readonly string[] } }).value?.keys ?? []) as readonly string[];
}

/** Call fixture.held until `condition` is true. The number of calls is a guard, as in `untilTools`. */
async function untilHeld(driver: WebMcpDriver, condition: (held: readonly string[]) => boolean, what: string): Promise<void> {
  for (let read = 1; ; read++) {
    if (condition(await heldKeys(driver))) return;
    if (read === 2_000) throw new Error(`after 2000 reads of fixture.held: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** True if each `$ref` of a schema refers to a type in its own `$defs` (spec/catalog.md#bundling). */
function isBundled(schema: JsonObject): boolean {
  const types = (schema.$defs ?? {}) as JsonObject;
  let bundled = true;
  visitObjects(schema, (node) => {
    if (typeof node.$ref !== "string") return;
    const name = REFERENCE.exec(node.$ref)?.[1];
    if (name === undefined || !(name in types)) bundled = false;
  });
  return bundled;
}

export async function checkWebMcp(driver: WebMcpDriver): Promise<Checks> {
  const checks = new Checks("webmcp");
  const view = fixture.capabilities;
  const expected = idsOf(TARGET);

  await checks.run("each available capability of the view is a tool", `${RULE}#tools`, async () => {
    await untilTools(driver, (tools) => JSON.stringify(sorted(tools.map((tool) => tool.name))) === JSON.stringify(expected), `the tools must be ${expected.join(", ")}`);
  });
  await checks.run("a tool has the description and the bundled input schema of its capability", `${RULE}#tools`, async () => {
    for (const tool of await driver.tools()) {
      expectEqual(tool.description, view[tool.name]?.description, `description of ${tool.name}`);
      // Each implementation writes its schemas from its own code. Compare what the fixture fixes: an object, its
      // properties and its required properties, with no reference outside the schema.
      const schema = tool.inputSchema as JsonObject;
      const input = (view[tool.name]?.input ?? {}) as JsonObject;
      expectEqual(schema.type, "object", `type of the input schema of ${tool.name}`);
      expectEqual(sorted(Object.keys(schema.properties ?? {})), sorted(Object.keys(input.properties ?? {})), `properties of ${tool.name}`);
      expectEqual(sorted((schema.required as string[] | undefined) ?? []), sorted((input.required as string[] | undefined) ?? []), `required properties of ${tool.name}`);
      expect(isBundled(schema), `the input schema of ${tool.name} must be bundled`);
    }
  });
  await checks.run("a value resolves as a result", `${RULE}#tools`, async () => {
    expectEqual(await driver.call("fixture.echo", { text: "hello" }), { resolved: { ok: true, value: { text: "hello" } } }, "outcome");
  });
  await checks.run("a failure resolves as a result", `${RULE}#tools`, async () => {
    const call = await driver.call("fixture.refuse", {});
    expect("resolved" in call, `the call must resolve, got ${JSON.stringify(call)}`);
    expectEqual((call.resolved as { error?: { _tag?: string } }).error?._tag, "Refused", "_tag");
  });
  for (const [name, capability, input, kind, errorName] of [
    ["a defect rejects with the kind internal", "fixture.crash", {}, "internal", undefined],
    ["invalid input rejects with the kind invalid-input, as a TypeError", "fixture.echo", { text: 1 }, "invalid-input", "TypeError"],
  ] as const) {
    await checks.run(name, `${RULE}#tools`, async () => {
      const call = await driver.call(capability, input);
      expect("rejected" in call, `the call must reject, got ${JSON.stringify(call)}`);
      expectEqual(call.rejected.kind, kind, "kind");
      if (errorName !== undefined) expectEqual(call.rejected.name, errorName, "name");
    });
  }
  await checks.run("the signal of the host cancels a call, as an AbortError", `${RULE}#tools`, async () => {
    const key = `webmcp-cancel-${crypto.randomUUID()}`;
    const started = await driver.start("fixture.hold", { key });
    await untilHeld(driver, (held) => held.includes(key), `the call must hold ${key}`);
    await driver.cancel(started);
    const call = await driver.result(started);
    expect("rejected" in call, `the call must reject, got ${JSON.stringify(call)}`);
    expectEqual(call.rejected.kind, "cancelled", "kind");
    expectEqual(call.rejected.name, "AbortError", "name");
    await untilHeld(driver, (held) => !held.includes(key), `the cancelled call must stop holding ${key}`);
  });
  await checks.run("a tool is removed while its capability is unavailable, and registered again after", `${RULE}#tools`, async () => {
    const toggle = (tools: readonly RecordedTool[]) => tools.some((tool) => tool.name === "fixture.toggle");
    await driver.call("fixture.switch.set", { on: false });
    await untilTools(driver, (tools) => !toggle(tools), "fixture.toggle must be removed");
    await driver.call("fixture.switch.set", { on: true });
    await untilTools(driver, toggle, "fixture.toggle must be registered again");
  });

  return checks;
}
