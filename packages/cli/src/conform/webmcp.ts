/**
 * Conformance checks for the WebMCP binding (spec/bindings/webmcp.md).
 *
 * The checks act as the WebMCP host: they give the page a `modelContext`, record the tools that the binding registers,
 * and call them. The page can run in a browser, or the implementation can install itself on the host in the same
 * process.
 */
import { REFERENCE, visitObjects } from "@acid-cat/spec";
import type { JsonObject } from "@acid-cat/spec";

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
  /** Call a tool. If `cancelAfter` is given, abort the signal of the call after that many milliseconds. */
  call(name: string, input: unknown, cancelAfter?: number): Promise<ToolCall>;
}

/**
 * Make a test host. The function uses no imports and no outer variables, because the browser driver sends its
 * source text to the page.
 */
export function createTestHost(): TestHost {
  type Tool = RecordedTool & { execute(input: unknown, options: { signal: AbortSignal }): Promise<unknown> };
  const registered = new Map<string, Tool>();
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
    async call(name, input, cancelAfter) {
      const tool = registered.get(name);
      if (tool === undefined) return { missing: true };
      const controller = new AbortController();
      if (cancelAfter !== undefined) setTimeout(() => controller.abort(), cancelAfter);
      try {
        return { resolved: await tool.execute(input, { signal: controller.signal }) };
      } catch (error) {
        const { name: errorName, kind, message } = error as { name?: unknown; kind?: unknown; message?: unknown };
        return { rejected: { name: String(errorName), kind, message: String(message) } };
      }
    },
  };
}

/** The view from the checks: the tools of the page, and calls to them. */
export interface WebMcpDriver {
  tools(): Promise<RecordedTool[]>;
  call(name: string, input: unknown, cancelAfter?: number): Promise<ToolCall>;
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
    call: async (name, input, cancelAfter) => copy(await host.call(name, input, cancelAfter)),
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
    call: (name, input, cancelAfter) =>
      page.evaluate(
        ([name, input, cancelAfter]) => (window as unknown as Window).__acidCatConform.call(name, input, cancelAfter),
        [name, input, cancelAfter] as const,
      ),
    close: () => browser.close(),
  };
}

/** Wait until `condition` is true. Give up after `timeout` milliseconds. */
async function eventually(condition: () => Promise<boolean>, what: string, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > end) throw new Error(`after ${timeout} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
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

const names = async (driver: WebMcpDriver) => sorted((await driver.tools()).map((tool) => tool.name));

export async function checkWebMcp(driver: WebMcpDriver): Promise<Checks> {
  const checks = new Checks("webmcp");
  const view = fixture.capabilities;
  const expected = idsOf(TARGET);

  await checks.run("each available capability of the view is a tool", `${RULE}#tools`, async () => {
    await eventually(async () => JSON.stringify(await names(driver)) === JSON.stringify(expected), `the tools must be ${expected.join(", ")}`);
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
    const call = await driver.call("fixture.slow", { milliseconds: 60_000 }, 50);
    expect("rejected" in call, `the call must reject, got ${JSON.stringify(call)}`);
    expectEqual(call.rejected.kind, "cancelled", "kind");
    expectEqual(call.rejected.name, "AbortError", "name");
  });
  await checks.run("a tool is removed while its capability is unavailable, and registered again after", `${RULE}#tools`, async () => {
    await driver.call("fixture.switch.set", { on: false });
    await eventually(async () => !(await names(driver)).includes("fixture.toggle"), "fixture.toggle must be removed");
    await driver.call("fixture.switch.set", { on: true });
    await eventually(async () => (await names(driver)).includes("fixture.toggle"), "fixture.toggle must be registered again");
  });

  return checks;
}
