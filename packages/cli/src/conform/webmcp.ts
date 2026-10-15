/**
 * Conformance checks for the WebMCP binding (spec/bindings/webmcp.md).
 *
 * The checks act as the WebMCP host: they give the page a `modelContext`, record the tools that the binding registers,
 * and call them. The page can run in a browser, or the implementation can install itself on the host in the same
 * process.
 */
import { REFERENCE, visitObjects } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { Checks, Deadline, expect, expectEqual, fixture, GUARD, idsOf, sorted } from "./check.ts";
import type { Guard } from "./check.ts";

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
  /** Resolve with the number of changes when it is more than `after`. The signal stops the wait. */
  changed(after: number, signal?: AbortSignal): Promise<number>;
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
    changed: (after, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const stop = () => {
          waiting.delete(wake);
          reject(signal?.reason);
        };
        const wake = () => {
          if (version <= after) return;
          waiting.delete(wake);
          signal?.removeEventListener("abort", stop);
          resolve(version);
        };
        signal?.addEventListener("abort", stop, { once: true });
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
  /** The signal stops the wait. A page in a browser cannot take it, so its wait ends when the page closes. */
  changed(after: number, signal?: AbortSignal): Promise<number>;
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
    changed: (after, signal) => host.changed(after, signal),
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
export async function browserDriver(url: string, guard: number = GUARD): Promise<WebMcpDriver> {
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
  await page.goto(url, { timeout: guard }).catch(async (error: unknown) => {
    await browser.close();
    throw error;
  });
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
 * Wait until the tools of the page agree with `condition`. The check reads the tools after each change of them, until
 * one deadline for the whole wait: changes of the tools do not start it again.
 */
async function untilTools(driver: WebMcpDriver, deadline: Deadline, condition: (tools: readonly RecordedTool[]) => boolean, what: string): Promise<void> {
  for (;;) {
    const version = await deadline.within(driver.version(), `the tools: ${what}`);
    if (condition(await deadline.within(driver.tools(), `the tools: ${what}`))) return;
    await deadline.within(driver.changed(version, deadline.signal), `the tools: ${what}`);
  }
}

/** Start a call to a tool, until the deadline. A call that starts after the deadline is cancelled at once. */
function startTool(driver: WebMcpDriver, deadline: Deadline, name: string, input: unknown): Promise<number> {
  const starting = driver.start(name, input);
  return deadline.within(starting, `the call to ${name}`).catch((error: unknown) => {
    void starting.then((late) => driver.cancel(late)).catch(() => undefined);
    throw error;
  });
}

/**
 * Call a tool until the deadline. If the deadline comes first, cancel the call, so that it does not run on in the
 * page.
 */
async function callTool(driver: WebMcpDriver, deadline: Deadline, name: string, input: unknown): Promise<ToolCall> {
  const started = await startTool(driver, deadline, name, input);
  try {
    return await deadline.within(driver.result(started), `the call to ${name}`);
  } catch (error) {
    await driver.cancel(started).catch(() => undefined);
    throw error;
  }
}

/** The keys that fixture.held gives through a tool. */
async function heldKeys(driver: WebMcpDriver, deadline: Deadline): Promise<readonly string[]> {
  const call = await callTool(driver, deadline, "fixture.held", {});
  const result = "resolved" in call ? (call.resolved as { readonly ok?: unknown; readonly value?: { readonly keys?: unknown } }) : undefined;
  expect(result?.ok === true && Array.isArray(result.value?.keys), `fixture.held gave ${JSON.stringify(call)}`);
  return result.value!.keys as readonly string[];
}

/** Call fixture.held until `condition` is true, until the deadline. */
const untilHeld = (driver: WebMcpDriver, deadline: Deadline, condition: (held: readonly string[]) => boolean, what: string) =>
  deadline.until(() => heldKeys(driver, deadline), condition, what);

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


export async function checkWebMcp(driver: WebMcpDriver, guard: Guard = GUARD): Promise<Checks> {
  const checks = new Checks("webmcp", guard);
  const view = fixture.capabilities;
  const expected = idsOf(TARGET);

  await checks.run("each available capability of the view is a tool", `${RULE}#tools`, async (deadline) => {
    await untilTools(driver, deadline, (tools) => JSON.stringify(sorted(tools.map((tool) => tool.name))) === JSON.stringify(expected), `the tools ${expected.join(", ")}`);
  });
  await checks.run("a tool has the description and the bundled input schema of its capability", `${RULE}#tools`, async (deadline) => {
    for (const tool of await deadline.within(driver.tools(), "the tools")) {
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
  await checks.run("a value resolves as a result", `${RULE}#tools`, async (deadline) => {
    expectEqual(await callTool(driver, deadline, "fixture.echo", { text: "hello" }), { resolved: { ok: true, value: { text: "hello" } } }, "outcome");
  });
  await checks.run("a failure resolves as a result", `${RULE}#tools`, async (deadline) => {
    const call = await callTool(driver, deadline, "fixture.refuse", {});
    expect("resolved" in call, `the call must resolve, got ${JSON.stringify(call)}`);
    expectEqual((call.resolved as { error?: { _tag?: string } }).error?._tag, "Refused", "_tag");
  });
  for (const [name, capability, input, kind, errorName] of [
    ["a defect rejects with the kind internal", "fixture.crash", {}, "internal", undefined],
    ["invalid input rejects with the kind invalid-input, as a TypeError", "fixture.echo", { text: 1 }, "invalid-input", "TypeError"],
  ] as const) {
    await checks.run(name, `${RULE}#tools`, async (deadline) => {
      const call = await callTool(driver, deadline, capability, input);
      expect("rejected" in call, `the call must reject, got ${JSON.stringify(call)}`);
      expectEqual(call.rejected.kind, kind, "kind");
      if (errorName !== undefined) expectEqual(call.rejected.name, errorName, "name");
    });
  }
  await checks.run("the signal of the host cancels a call, as an AbortError", `${RULE}#tools`, async (deadline) => {
    const key = `webmcp-cancel-${crypto.randomUUID()}`;
    const started = await startTool(driver, deadline, "fixture.hold", { key });
    try {
      await untilHeld(driver, deadline, (held) => held.includes(key), `the call that holds ${key}`);
      await deadline.within(driver.cancel(started), `the cancellation of the call that holds ${key}`);
      const call = await deadline.within(driver.result(started), `the cancelled call that held ${key}`);
      expect("rejected" in call, `the call must reject, got ${JSON.stringify(call)}`);
      expectEqual(call.rejected.kind, "cancelled", "kind");
      expectEqual(call.rejected.name, "AbortError", "name");
      await untilHeld(driver, deadline, (held) => !held.includes(key), `the stop of the cancelled call that held ${key}`);
    } finally {
      // A call that the implementation did not stop would hold forever. Release it, so that the checks can end. The
      // release has its own deadline, because the deadline of the check can be over.
      const cleanup = new Deadline(deadline.guard);
      await callTool(driver, cleanup, "fixture.release", { key }).catch(() => undefined);
      cleanup.end();
    }
  });
  await checks.run("a tool is removed while its capability is unavailable, and registered again after", `${RULE}#tools`, async (deadline) => {
    const toggle = (tools: readonly RecordedTool[]) => tools.some((tool) => tool.name === "fixture.toggle");
    await callTool(driver, deadline, "fixture.switch.set", { on: false });
    await untilTools(driver, deadline, (tools) => !toggle(tools), "the removal of fixture.toggle");
    await callTool(driver, deadline, "fixture.switch.set", { on: true });
    await untilTools(driver, deadline, toggle, "the registration of fixture.toggle");
  });

  return checks;
}
