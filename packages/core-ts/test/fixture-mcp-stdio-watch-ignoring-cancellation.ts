#!/usr/bin/env node
import { mcpStdioMain } from "../src/index.ts";
import { fixture, Holds, options, WatchersThatIgnoreCancellation } from "./fixture.ts";

mcpStdioMain(fixture, { name: "fixture", version: "0.0.0", ...options(new Holds(), new WatchersThatIgnoreCancellation()) });
