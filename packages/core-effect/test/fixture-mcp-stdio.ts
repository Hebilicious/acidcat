#!/usr/bin/env node
/** The fixture as an MCP server through standard input and standard output, for the conformance tests. */
import { NodeMcp } from "../src/node.ts";
import { fixture, fixtureLayer } from "./fixture.ts";

NodeMcp.main(fixture, fixtureLayer, { name: "fixture", version: "0.0.0" });
