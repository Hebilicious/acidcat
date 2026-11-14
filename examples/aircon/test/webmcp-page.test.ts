/**
 * The web page of each TypeScript core, in Chromium through Playwright. The page loads with a test WebMCP host as its
 * `modelContext`. The test acts as a browser agent: it reads the tools of the page and calls them, and it reads what
 * the page shows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { serve } from "@acid-cat/core-ts/node";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { z } from "zod";

import { pageHandler } from "../web/page.ts";
import { writtenText } from "./shape.ts";

/** The capabilities of the target `app` in the catalog, with their descriptions. */
const expectedTools = Object.entries(
  z.object({ capabilities: z.record(z.string(), z.object({ description: z.string(), audience: z.array(z.string()) })) }).parse(JSON.parse(writtenText))
    .capabilities,
)
  .filter(([, capability]) => capability.audience.includes("app"))
  .map(([name, capability]) => ({ name, description: capability.description }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * The test host, as source text for the page. It records the tools that the page registers, and calls them. It gives
 * the outcome of a call as data, so that it passes through `page.evaluate`.
 */
const testHost = `
  const registered = new Map();
  window.__testHost = {
    modelContext: {
      registerTool(tool, options) {
        registered.set(tool.name, tool);
        options.signal.addEventListener("abort", () => {
          if (registered.get(tool.name) === tool) registered.delete(tool.name);
        });
      },
    },
    tools: () => [...registered.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    async call(name, input) {
      const tool = registered.get(name);
      if (tool === undefined) return { missing: true };
      try {
        return { resolved: await tool.execute(input, { signal: new AbortController().signal }) };
      } catch (error) {
        return { rejected: { name: error.name, kind: error.kind, message: error.message } };
      }
    },
  };
  Object.defineProperty(document, "modelContext", { value: window.__testHost.modelContext, configurable: true });
`;

const Tools = z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.looseObject({}) }));
const ToolCall = z.union([
  z.object({ missing: z.literal(true) }),
  z.object({ resolved: z.unknown() }),
  z.object({ rejected: z.object({ name: z.string(), kind: z.string().optional(), message: z.string() }) }),
]);

/** The tools that the page registered, sorted by name. The page is not trusted: Zod checks what it gives. */
const toolsOf = async (page: Page) =>
  Tools.parse(await page.evaluate("window.__testHost.tools()")).sort((a, b) => a.name.localeCompare(b.name));

/** Call a tool of the page, as an agent does. */
const call = async (page: Page, name: string, input: unknown) =>
  ToolCall.parse(await page.evaluate(`window.__testHost.call(${JSON.stringify(name)}, ${JSON.stringify(input)})`));

/** Wait until the page has, or has not, the tool. */
const waitForTool = (page: Page, name: string, present: boolean) =>
  page.waitForFunction(([tool, wanted]) => {
    const host: unknown = Reflect.get(window, "__testHost");
    const tools: unknown = typeof host === "object" && host !== null ? Reflect.get(host, "tools") : undefined;
    const names = typeof tools === "function" ? JSON.stringify(Reflect.apply(tools, host, [])) : "";
    return names.includes(`"name":"${String(tool)}"`) === wanted;
  }, [name, present] as const);

for (const core of ["core-ts", "core-effect"]) {
  test(`the page of ${core} gives a browser agent one WebMCP tool for each available capability of the app view`, async () => {
    const handler = await pageHandler(new URL(`../${core}/page.ts`, import.meta.url));
    await using served = await serve({ "/": handler }, { port: 0 });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(testHost);
      await page.goto(`${served.url}/`);

      // The page shows the core, the status and the status of the tools.
      await page.locator("#webmcp-phase", { hasText: "ready" }).waitFor();
      assert.equal(await page.locator("#core").textContent(), `@acid-cat/${core}`);
      assert.equal(await page.locator("#status-power").textContent(), "off");

      // One tool for each capability of the view, with its description and its bundled input schema.
      const tools = await toolsOf(page);
      assert.deepEqual(
        tools.map(({ name, description }) => ({ name, description })),
        expectedTools,
      );
      assert.deepEqual(tools.find((tool) => tool.name === "aircon.mode.set")?.inputSchema.$defs, {
        Mode: { type: "string", enum: ["cool", "heat", "dry", "fan", "auto"] },
      });

      // A call gives the result in its JSON form, and the page shows the new status.
      assert.deepEqual(await call(page, "aircon.power.set", { on: true }), { resolved: { ok: true, value: null } });
      assert.deepEqual(await call(page, "aircon.temperature.set", { celsius: 24 }), { resolved: { ok: true, value: null } });
      await page.locator("#status-power", { hasText: "on" }).waitFor();
      await page.locator("#status-target", { hasText: "24 °C" }).waitFor();
      assert.deepEqual(await call(page, "aircon.status.get", {}), {
        resolved: { ok: true, value: { power: true, mode: "cool", fan: "auto", targetCelsius: 24, roomCelsius: 25 } },
      });

      // A failure is a result. A call failure rejects with its kind.
      assert.deepEqual(await call(page, "aircon.firmware.update", {}), { resolved: { ok: false, error: { _tag: "UpToDate", version: "1.0.0" } } });
      const invalid = await call(page, "aircon.temperature.set", { celsius: 40 });
      assert.ok("rejected" in invalid, `a temperature outside 16 to 31 rejects, got ${JSON.stringify(invalid)}`);
      assert.equal(invalid.rejected.kind, "invalid-input");

      // The controls of the page call the same session, and the agent sees the change.
      await page.locator("#fan").selectOption("high");
      await page.locator("#status-fan", { hasText: "high" }).waitFor();
      assert.equal(await page.locator("#result").textContent(), "Done.");

      // While the unit is offline, the firmware update is unavailable: its tool goes, and comes back after.
      await page.locator("#online").uncheck();
      await waitForTool(page, "aircon.firmware.update", false);
      await page.locator('#tools li[data-id="aircon.firmware.update"][data-available="false"]').waitFor();
      await page.locator("#webmcp-phase", { hasText: "ready" }).waitFor();
      assert.deepEqual(
        (await toolsOf(page)).map((tool) => tool.name),
        expectedTools.map((tool) => tool.name).filter((name) => name !== "aircon.firmware.update"),
      );
      assert.deepEqual(await call(page, "aircon.firmware.update", {}), { missing: true });
      assert.deepEqual(await call(page, "aircon.power.set", { on: false }), { resolved: { ok: false, error: { _tag: "Offline" } } });
      await page.locator("#online").check();
      await waitForTool(page, "aircon.firmware.update", true);
      await page.locator('#tools li[data-id="aircon.firmware.update"][data-available="true"]').waitFor();

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}

for (const core of ["core-ts", "core-effect"]) {
  test(`the page of ${core} works, and tells it, when the browser has no WebMCP host`, async () => {
    const handler = await pageHandler(new URL(`../${core}/page.ts`, import.meta.url));
    await using served = await serve({ "/": handler }, { port: 0 });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${served.url}/`);
      await page.locator("#webmcp-phase", { hasText: "no host" }).waitFor();
      await page.locator("#power").click();
      await page.locator("#status-power", { hasText: "on" }).waitFor();
    } finally {
      await browser.close();
    }
  });
}
