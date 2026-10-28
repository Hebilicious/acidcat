#!/usr/bin/env node
/** The fixture as an MCP server through standard input and standard output, for the conformance tests. */
import { mcpStdioMain } from "../src/index.ts";
import { fixture, options } from "./fixture.ts";

mcpStdioMain(fixture, { name: "fixture", version: "0.0.0", ...options() });
