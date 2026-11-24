import { REFERENCE, visitObjects } from "@acid-cat/spec-ts";

import { isArrayOf, isObject, isStringArray, memberOf, parseJson } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { abortable, Checks, expect, expectEqual, fixture, idsOf, sorted, until } from "./check.ts";

const RULE = "spec/surfaces/webmcp.md";

const TARGET = "app";

export interface RecordedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface HostTool extends RecordedTool {
  execute(input: unknown, options: { readonly signal: AbortSignal }): Promise<unknown>;
}

export type ToolCall =
  | { readonly resolved: unknown }
  | { readonly rejected: { readonly name: string; readonly kind: unknown; readonly message: string } }
  | { readonly missing: true };

export interface TestHost {
  readonly modelContext: {
    registerTool(tool: HostTool, options: { readonly signal: AbortSignal }): void;
  };
  tools(): RecordedTool[];
  call(name: string, input: unknown, id?: string): Promise<ToolCall>;
  cancel(id: string): void;
}

/** The function uses no imports and no outer variables, because the browser driver sends its source text to the page. */
export function createTestHost(): TestHost {
  const registered = new Map<string, HostTool>();
  const calls = new Map<string, AbortController>();
  return {
    modelContext: {
      registerTool(tool, options) {
        registered.set(tool.name, tool);
        options.signal.addEventListener("abort", () => {
          if (registered.get(tool.name) === tool) registered.delete(tool.name);
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
        const hasMembers = typeof error === "object" && error !== null;
        const errorName = hasMembers && "name" in error ? error.name : undefined;
        const kind = hasMembers && "kind" in error ? error.kind : undefined;
        const message = hasMembers && "message" in error ? error.message : undefined;
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

export interface WebMcpDriver {
  tools(signal: AbortSignal): Promise<RecordedTool[]>;
  call(name: string, input: unknown, options?: { readonly signal?: AbortSignal; readonly cancel?: AbortSignal }): Promise<ToolCall>;
  close(): Promise<void>;
}

function toolsOf(value: unknown): RecordedTool[] {
  const isTool = (tool: unknown): tool is JsonObject & { readonly name: string; readonly description: string } =>
    isObject(tool) && typeof tool.name === "string" && typeof tool.description === "string";
  if (!isArrayOf(value, isTool)) throw new Error(`the host must give a list of tools, got ${JSON.stringify(value)}`);
  return value.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

function toolCallOf(value: unknown): ToolCall {
  if (isObject(value)) {
    if (value.missing === true) return { missing: true };
    if ("resolved" in value) return { resolved: value.resolved };
    const rejected = value.rejected;
    if (isObject(rejected) && typeof rejected.name === "string" && typeof rejected.message === "string") {
      return { rejected: { name: rejected.name, kind: rejected.kind, message: rejected.message } };
    }
  }
  throw new Error(`the host must give a tool call, got ${JSON.stringify(value)}`);
}

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

export async function processDriver(install: WebMcpInstall): Promise<WebMcpDriver> {
  const host = createTestHost();
  const remove = await install(host.modelContext);
  const copy = (value: unknown): unknown => parseJson(JSON.stringify(value));
  return driverOf({
    tools: async () => toolsOf(copy(host.tools())),
    call: async (name, input, id) => toolCallOf(copy(await host.call(name, input, id))),
    cancel: async (id) => host.cancel(id),
    close: async () => {
      if (typeof remove === "function") await remove();
    },
  });
}

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
  const host = (method: string, ...args: unknown[]) =>
    page.evaluate<unknown>(`window.__acidCatConform.${method}(${args.map((arg) => JSON.stringify(arg) ?? "undefined").join(", ")})`);
  return driverOf({
    tools: async () => {
      if (errors.length > 0) throw new Error(`The page has errors: ${errors.join("; ")}`);
      return toolsOf(await host("tools"));
    },
    call: async (name, input, id) => toolCallOf(await host("call", name, input, id)),
    cancel: async (id) => {
      await host("cancel", id);
    },
    close: () => browser.close(),
  });
}

function isBundled(schema: JsonObject): boolean {
  const types = isObject(schema.$defs) ? schema.$defs : {};
  let bundled = true;
  visitObjects(schema, (node) => {
    if (typeof node.$ref !== "string") return;
    const name = REFERENCE.exec(node.$ref)?.[1];
    if (name === undefined || !Object.hasOwn(types, name)) bundled = false;
  });
  return bundled;
}

const requiredOf = (schema: JsonObject): readonly string[] => (isStringArray(schema.required) ? schema.required : []);

function expectSameInputShape(tool: string, schema: JsonObject, input: JsonObject): void {
  expectEqual(schema.type, "object", `type of the input schema of ${tool}`);
  expectEqual(sorted(Object.keys(schema.properties ?? {})), sorted(Object.keys(input.properties ?? {})), `properties of ${tool}`);
  expectEqual(sorted(requiredOf(schema)), sorted(requiredOf(input)), `required properties of ${tool}`);
}

const names = async (driver: WebMcpDriver, signal: AbortSignal) => sorted((await driver.tools(signal)).map((tool) => tool.name));

async function heldKeys(driver: WebMcpDriver, signal: AbortSignal): Promise<readonly string[]> {
  const call = await driver.call("fixture.held", {}, { signal });
  expect("resolved" in call, `fixture.held gave ${JSON.stringify(call)}`);
  const keys = memberOf(memberOf(call.resolved, "value"), "keys");
  expect(isStringArray(keys), `fixture.held gave ${JSON.stringify(call)}, with no list of keys`);
  return keys;
}

export async function checkWebMcp(driver: WebMcpDriver, options: { readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("webmcp", options.deadline);
  const capabilities = fixture.capabilities;
  const expected = idsOf(TARGET);

  await checks.run("each available capability of the target is a tool", `${RULE}#tools`, async (signal) => {
    await until(`the tools are ${expected.join(", ")}`, () => names(driver, signal), (tools) => JSON.stringify(tools) === JSON.stringify(expected), signal);
  });
  await checks.run("a tool has the description and the bundled input schema of its capability", `${RULE}#tools`, async (signal) => {
    for (const tool of await driver.tools(signal)) {
      expectEqual(tool.description, capabilities[tool.name]?.description, `description of ${tool.name}`);
      const schema = tool.inputSchema;
      expect(isObject(schema), `the input schema of ${tool.name} must be an object`);
      expectSameInputShape(tool.name, schema, capabilities[tool.name]?.input ?? {});
      expect(isBundled(schema), `the input schema of ${tool.name} must be bundled`);
    }
  });
  await checks.run("a value resolves as a result", `${RULE}#tools`, async (signal) => {
    expectEqual(await driver.call("fixture.echo", { text: "hello" }, { signal }), { resolved: { ok: true, value: { text: "hello" } } }, "outcome");
  });
  await checks.run("a failure resolves as a result", `${RULE}#tools`, async (signal) => {
    const call = await driver.call("fixture.refuse", {}, { signal });
    expect("resolved" in call, `the call must resolve, got ${JSON.stringify(call)}`);
    expectEqual(memberOf(memberOf(call.resolved, "error"), "_tag"), "Refused", "_tag");
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
