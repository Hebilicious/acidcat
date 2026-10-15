/**
 * `acid-cat conform`: test a running implementation through its bindings (spec/conformance.md). The implementation
 * serves the conformance fixture (conformance/fixture.acidcat.json), with its switch on.
 */
import { GUARD, within } from "./check.ts";
import type { Check } from "./check.ts";
import { checkCli } from "./cli.ts";
import { checkHttp } from "./http.ts";
import { checkMcp } from "./mcp.ts";
import { checkProperties, httpInvoke, mcpInvoke } from "./properties.ts";
import { browserDriver, checkWebMcp, processDriver } from "./webmcp.ts";
import type { WebMcpInstall } from "./webmcp.ts";

export type { Check } from "./check.ts";
export { fixture } from "./check.ts";
export { serve } from "./serve.ts";
export type { Served, WebHandler } from "./serve.ts";
export { createTestHost } from "./webmcp.ts";
export type { TestHost, WebMcpInstall } from "./webmcp.ts";

export interface ConformOptions {
  /** The URL of the MCP server, for example `http://localhost:8787/mcp`. */
  readonly mcp?: string | undefined;
  /** The base URL of the HTTP API, before `/capabilities`. */
  readonly http?: string | undefined;
  /** The command that starts the command line, for example `["node", "fixture-cli.ts"]`. */
  readonly cli?: readonly string[] | undefined;
  /**
   * The WebMCP binding: the URL of a page that serves the `app` target, or a function that installs the implementation
   * on a host in the same process. A page runs in Chromium, through Playwright.
   */
  readonly webmcp?: string | WebMcpInstall | undefined;
  /** The body limit of the remote bindings, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
  /**
   * The longest time, in milliseconds, that a check waits for one thing of the implementation: an outcome, a state, a
   * process. The default is 30 seconds. It is a limit of the infrastructure, so that an implementation that never
   * answers fails its check and the run ends. A check never passes because of it.
   */
  readonly guard?: number | undefined;
}

/** Run all checks for the bindings that the options give. */
export async function conform(options: ConformOptions): Promise<readonly Check[]> {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  const guard = options.guard ?? GUARD;
  const results: Check[] = [];
  if (options.mcp !== undefined) {
    results.push(...(await checkMcp(options.mcp, { maximumBytes })).results);
    const mcp = await mcpInvoke(options.mcp).catch(() => undefined);
    if (mcp !== undefined) {
      results.push(...(await checkProperties("mcp", mcp.invoke, guard)).results);
      await within(mcp.close(), guard, "the close of the MCP client").catch(() => undefined);
    }
  }
  if (options.http !== undefined) {
    results.push(...(await checkHttp(options.http, { maximumBytes })).results);
    results.push(...(await checkProperties("http", httpInvoke(options.http), guard)).results);
  }
  if (options.cli !== undefined) results.push(...(await checkCli(options.cli, guard)).results);
  if (options.webmcp !== undefined) {
    const driver = typeof options.webmcp === "string" ? await browserDriver(options.webmcp) : await processDriver(options.webmcp);
    try {
      results.push(...(await checkWebMcp(driver, guard)).results);
    } finally {
      const closed = await within(driver.close(), guard, "the removal of the WebMCP tools").then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      if (closed !== undefined) results.push({ binding: "webmcp", name: "the implementation removes its tools", rule: "spec/bindings/webmcp.md", passed: false, detail: closed });
    }
  }
  return results;
}
