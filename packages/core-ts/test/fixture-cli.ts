#!/usr/bin/env node
/** The fixture as a command line, for the conformance tests. */
import { cliMain } from "../src/index.ts";
import { fixture, options } from "./fixture.ts";

cliMain(fixture, { name: "fixture", version: "0.0.0", ...options() });
