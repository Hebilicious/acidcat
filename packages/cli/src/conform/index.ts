/**
 * `acid-cat conform`: test a running implementation through its bindings (spec/conformance.md). The implementation
 * serves the conformance fixture (conformance/fixture.acidcat.json), with its switch on.
 */
import { DEADLINE } from "./check.ts";
import type { Check } from "./check.ts";
import { checkCli } from "./cli.ts";
import { checkHttp } from "./http.ts";
import { checkMcp } from "./mcp.ts";
import { checkMcpStdio } from "./mcp-stdio.ts";
import { checkProperties, httpInvoke, mcpInvoke } from "./properties.ts";
import { browserDriver, checkWebMcp, processDriver } from "./webmcp.ts";
import type { WebMcpInstall } from "./webmcp.ts";

export type { Check } from "./check.ts";
export { DEADLINE, fixture } from "./check.ts";
export { serve } from "./serve.ts";
export type { Routes, Served, WebHandler } from "./serve.ts";
export { createTestHost } from "./webmcp.ts";
export type { TestHost, WebMcpInstall } from "./webmcp.ts";

export interface ConformOptions {
  /** The URL of the MCP server, for example `http://localhost:8787/mcp`. */
  readonly mcp?: string | undefined;
  /**
   * The command that starts the MCP server through standard input and standard output, for example
   * `["node", "fixture-mcp-stdio.ts"]`. Each check starts its own process.
   */
  readonly mcpStdio?: readonly string[] | undefined;
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
   * The time, in milliseconds, that each check has to settle. A check that does not settle in this time fails. The
   * default is `DEADLINE`, 30 seconds.
   */
  readonly deadline?: number | undefined;
}

/** Run all checks for the bindings that the options give. */
export async function conform(options: ConformOptions): Promise<readonly Check[]> {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  const deadline = options.deadline ?? DEADLINE;
  const results: Check[] = [];
  if (options.mcp !== undefined) {
    results.push(...(await checkMcp(options.mcp, { maximumBytes, deadline })).results);
    const mcp = await mcpInvoke(options.mcp, AbortSignal.timeout(deadline)).catch(() => undefined);
    if (mcp !== undefined) {
      results.push(...(await checkProperties("mcp", mcp.invoke, deadline)).results);
      await mcp.close();
    }
  }
  if (options.mcpStdio !== undefined) {
    for (const checks of await checkMcpStdio(options.mcpStdio, { deadline })) results.push(...checks.results);
  }
  if (options.http !== undefined) {
    results.push(...(await checkHttp(options.http, { maximumBytes, deadline })).results);
    results.push(...(await checkProperties("http", httpInvoke(options.http), deadline)).results);
  }
  if (options.cli !== undefined) results.push(...(await checkCli(options.cli, { deadline })).results);
  if (options.webmcp !== undefined) {
    const driver = typeof options.webmcp === "string" ? await browserDriver(options.webmcp) : await processDriver(options.webmcp);
    try {
      results.push(...(await checkWebMcp(driver, { deadline })).results);
    } finally {
      await driver.close();
    }
  }
  return results;
}
