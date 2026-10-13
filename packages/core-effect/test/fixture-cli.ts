#!/usr/bin/env node
/** The fixture as a command line, for the CLI tests. */
import { Cli } from "../src/index.ts";
import { fixture, switchLayer } from "./fixture.ts";

Cli.main(fixture, switchLayer, { name: "fixture", version: "0.0.0" });
