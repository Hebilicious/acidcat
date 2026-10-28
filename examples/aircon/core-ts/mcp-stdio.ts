#!/usr/bin/env node
/** The air conditioner as an MCP server through standard input and standard output: `node core-ts/mcp-stdio.ts`. */
import { mcpStdioMain } from "@acid-cat/core-ts";
import { aircon, toJsonSchema, Unit } from "./aircon.ts";

mcpStdioMain(aircon, { name: "aircon", version: "0.1.0", context: { unit: new Unit() }, toJsonSchema });
