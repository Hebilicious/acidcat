/**
 * Run the MCP binding through standard input and standard output, as the main program of a Node.js process.
 */
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Effect } from "effect";
import type { Layer } from "effect";

import type * as App from "./App.ts";
import * as Mcp from "./Mcp.ts";

/**
 * Run the MCP server through standard input and standard output as the main program of the process, until standard
 * input ends. `layer` gives the services of the capabilities. The process is one session.
 */
export function main<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Mcp.StdioOptions): void {
  Mcp.serveStdio(app, options).pipe(Effect.provide(layer), Effect.provide(NodeStdio.layer), NodeRuntime.runMain);
}
