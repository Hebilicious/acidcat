/**
 * Conformance checks for the WebMCP binding (spec/bindings/webmcp.md).
 *
 * The checks act as the WebMCP host: they give the page a `modelContext`, record the tools that the binding registers,
 * and call them. The page can run in a browser, or the implementation can install itself on the host in the same
 * process.
 */
import { REFERENCE, visitObjects } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { abortable, Checks, expect, expectEqual, fixture, idsOf, sorted, until } from "./check.ts";

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
  /** Call a tool. With an `id`, `cancel` can abort the signal of the call. */
  call(name: string, input: unknown, id?: string): Promise<ToolCall>;
  /** Abort the signal of the call that has this `id`, if it runs. */
  cancel(id: string): void;
}

/**
 * Make a test host. The function uses no imports and no outer variables, because the browser driver sends its
 * source text to the page.
 */
export function createTestHost(): TestHost {
  type Tool = RecordedTool & { execute(input: unknown, options: { signal: AbortSignal }): Promise<unknown> };
  const registered = new Map<string, Tool>();
  const calls = new Map<string, AbortController>();
  return {
    modelContext: {
      registerTool(tool, options) {
        const recorded = tool as Tool;
        registered.set(recorded.name, recorded);
        options.signal.addEventListener("abort", () => {
          if (registered.get(recorded.name) === recorded) registered.delete(recorded.name);
        });
      },
    },
    tools: () =>
      [...registered.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    async call(name, input, id) {
      const tool = registered.get(name);
      if (tool === undefined) return { missing: true };
      const controller = new AbortController();
      if (id !== undefined) calls.set(id, controller);
      try {
        return { resolved: await tool.execute(input, { signal: controller.signal }) };
      } catch (error) {
        const { name: errorName, kind, message } = error as { name?: unknown; kind?: unknown; message?: unknown };
        return { rejected: { name: String(errorName), kind, message: String(message) } };
      } finally {
        if (id !== undefined) calls.delete(id);
      }
    },
    cancel(id) {
      calls.get(id)?.abort();
    },
  };
}

/** The view from the checks: the tools of the page, and calls to them. */
export interface WebMcpDriver {
  tools(signal: AbortSignal): Promise<RecordedTool[]>;
  /**
   * Call a tool. When `cancel` aborts, the host aborts the signal of the call, and the driver waits for what the tool
   * gives. When `signal` aborts, the host aborts the signal of the call, and the driver stops waiting.
   */
  call(name: string, input: unknown, options?: { readonly signal?: AbortSignal; readonly cancel?: AbortSignal }): Promise<ToolCall>;
  close(): Promise<void>;
}

/** A test host as a driver reaches it: in the same process, or in a page. */
interface HostAccess {
  tools(): Promise<RecordedTool[]>;
  call(name: string, input: unknown, id: string): Promise<ToolCall>;
  cancel(id: string): Promise<void>;
  close(): Promise<void>;
}

let lastCall = 0;

function driverOf(host: HostAccess): WebMcpDriver {
  return {
    tools: (signal) => abortable(host.tools(), signal),
    call: (name, input, { signal, cancel } = {}) => {
      const id = String(++lastCall);
      const stop = () => void host.cancel(id).catch(() => undefined);
      signal?.addEventListener("abort", stop, { once: true });
      cancel?.addEventListener("abort", stop, { once: true });
      const call = host.call(name, input, id).finally(() => {
        signal?.removeEventListener("abort", stop);
        cancel?.removeEventListener("abort", stop);
      });
      return signal === undefined ? call : abortable(call, signal);
    },
    close: () => host.close(),
  };
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
  return driverOf({
    tools: async () => copy(host.tools()),
    call: async (name, input, id) => copy(await host.call(name, input, id)),
    cancel: async (id) => host.cancel(id),
    close: async () => {
      if (typeof remove === "function") await remove();
    },
  });
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
  return driverOf({
    tools: async () => {
      if (errors.length > 0) throw new Error(`The page has errors: ${errors.join("; ")}`);
      return page.evaluate(() => (window as unknown as Window).__acidCatConform.tools());
    },
    call: (name, input, id) =>
      page.evaluate(([name, input, id]) => (window as unknown as Window).__acidCatConform.call(name, input, id), [name, input, id] as const),
    cancel: (id) => page.evaluate((id) => (window as unknown as Window).__acidCatConform.cancel(id), id),
    close: () => browser.close(),
  });
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

const names = async (driver: WebMcpDriver, signal: AbortSignal) => sorted((await driver.tools(signal)).map((tool) => tool.name));

/** The keys of the calls that hold now, as fixture.held gives them through the host. */
async function heldKeys(driver: WebMcpDriver, signal: AbortSignal): Promise<readonly string[]> {
  const call = await driver.call("fixture.held", {}, { signal });
  expect("resolved" in call, `fixture.held gave ${JSON.stringify(call)}`);
  return (call.resolved as { readonly value: { readonly keys: readonly string[] } }).value.keys;
}

export async function checkWebMcp(driver: WebMcpDriver, options: { readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("webmcp", options.deadline);
  const view = fixture.capabilities;
  const expected = idsOf(TARGET);

  await checks.run("each available capability of the view is a tool", `${RULE}#tools`, async (signal) => {
    await until(`the tools are ${expected.join(", ")}`, () => names(driver, signal), (tools) => JSON.stringify(tools) === JSON.stringify(expected), signal);
  });
  await checks.run("a tool has the description and the bundled input schema of its capability", `${RULE}#tools`, async (signal) => {
    for (const tool of await driver.tools(signal)) {
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
  await checks.run("a value resolves as a result", `${RULE}#tools`, async (signal) => {
    expectEqual(await driver.call("fixture.echo", { text: "hello" }, { signal }), { resolved: { ok: true, value: { text: "hello" } } }, "outcome");
  });
  await checks.run("a failure resolves as a result", `${RULE}#tools`, async (signal) => {
    const call = await driver.call("fixture.refuse", {}, { signal });
    expect("resolved" in call, `the call must resolve, got ${JSON.stringify(call)}`);
    expectEqual((call.resolved as { error?: { _tag?: string } }).error?._tag, "Refused", "_tag");
  });
  for (const [name, capability, input, kind, errorName] of [
    ["a defect rejects with the kind internal", "fixture.crash", {}, "internal", undefined],
    ["invalid input rejects with the kind invalid-input, as a TypeError", "fixture.echo", { text: 1 }, "invalid-input", "TypeError"],
  ] as const) {
    await checks.run(name, `${RULE}#tools`, async (signal) => {
      const call = await driver.call(capability, input, { signal });
      expect("rejected" in call, `the call must reject, got ${JSON.stringify(call)}`);
      expectEqual(call.rejected.kind, kind, "kind");
      if (errorName !== undefined) expectEqual(call.rejected.name, errorName, "name");
    });
  }
  await checks.run("the signal of the host cancels a call, as an AbortError", `${RULE}#tools`, async (signal) => {
    const key = "cancel";
    const cancel = new AbortController();
    const call = driver.call("fixture.hold", { key }, { signal, cancel: cancel.signal });
    void call.catch(() => undefined);
    const read = () => heldKeys(driver, signal);
    try {
      await until(`fixture.held gives ${key}`, read, (held) => held.includes(key), signal);
      cancel.abort();
      const result = await call;
      expect("rejected" in result, `the call must reject, got ${JSON.stringify(result)}`);
      expectEqual(result.rejected.kind, "cancelled", "kind");
      expectEqual(result.rejected.name, "AbortError", "name");
      await until("the cancelled call stops holding", read, (held) => !held.includes(key), signal);
    } finally {
      await driver.call("fixture.release", { key }, { signal: AbortSignal.timeout(options.deadline) }).catch(() => undefined);
    }
  });
  await checks.run("a tool is removed while its capability is unavailable, and registered again after", `${RULE}#tools`, async (signal) => {
    const toggle = (present: boolean) => (tools: readonly string[]) => tools.includes("fixture.toggle") === present;
    await driver.call("fixture.switch.set", { on: false }, { signal });
    await until("fixture.toggle is removed", () => names(driver, signal), toggle(false), signal);
    await driver.call("fixture.switch.set", { on: true }, { signal });
    await until("fixture.toggle is registered again", () => names(driver, signal), toggle(true), signal);
  });

  return checks;
}
