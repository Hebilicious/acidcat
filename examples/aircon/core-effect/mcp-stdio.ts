#!/usr/bin/env node
/** The air conditioner as an MCP server through standard input and standard output: `node core-effect/mcp-stdio.ts`. */
import { NodeMcp } from "@acid-cat/core-effect/node";
import { aircon, unitLayer } from "./aircon.ts";

NodeMcp.main(aircon, unitLayer, { name: "aircon", version: "0.1.0" });
