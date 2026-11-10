#!/usr/bin/env node
/** The fixture as an MCP server through stdio whose subscriptions to fixture.watch ignore cancellation, for the conformance tests. */
import { mcpStdioMain } from "../src/index.ts";
import { fixture, Holds, options, WatchersThatIgnoreCancellation } from "./fixture.ts";

mcpStdioMain(fixture, { name: "fixture", version: "0.0.0", ...options(new Holds(), new WatchersThatIgnoreCancellation()) });
