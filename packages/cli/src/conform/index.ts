/**
 * `acid-cat conform`: test a running implementation through its bindings (spec/conformance.md). The implementation
 * serves the conformance fixture (conformance/fixture.acidcat.json), with its switch on.
 */
import type { Check } from "./check.ts";
import { checkCli } from "./cli.ts";
import { checkHttp } from "./http.ts";
import { checkMcp } from "./mcp.ts";
import { checkProperties, httpInvoke, mcpInvoke } from "./properties.ts";

export type { Check } from "./check.ts";
export { fixture } from "./check.ts";
export { serve } from "./serve.ts";
export type { Served, WebHandler } from "./serve.ts";

export interface ConformOptions {
  /** The URL of the MCP server, for example `http://localhost:8787/mcp`. */
  readonly mcp?: string | undefined;
  /** The base URL of the HTTP API, before `/capabilities`. */
  readonly http?: string | undefined;
  /** The command that starts the command line, for example `["node", "fixture-cli.ts"]`. */
  readonly cli?: readonly string[] | undefined;
  /** The body limit of the remote bindings, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
}

/** Run all checks for the bindings that the options give. */
export async function conform(options: ConformOptions): Promise<readonly Check[]> {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  const results: Check[] = [];
  if (options.mcp !== undefined) {
    results.push(...(await checkMcp(options.mcp, { maximumBytes })).results);
    const mcp = await mcpInvoke(options.mcp).catch(() => undefined);
    if (mcp !== undefined) {
      results.push(...(await checkProperties("mcp", mcp.invoke)).results);
      await mcp.close();
    }
  }
  if (options.http !== undefined) {
    results.push(...(await checkHttp(options.http, { maximumBytes })).results);
    results.push(...(await checkProperties("http", httpInvoke(options.http))).results);
  }
  if (options.cli !== undefined) results.push(...(await checkCli(options.cli)).results);
  return results;
}
