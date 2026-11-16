#!/usr/bin/env node
import { mcpStdioMain } from "../src/index.ts";
import { fixture, options, POLL } from "./fixture.ts";

mcpStdioMain(fixture, { name: "fixture", version: "0.0.0", ...options(), poll: POLL });
