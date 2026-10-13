#!/usr/bin/env node
/** The fixture as a command line, for the CLI tests. */
import { NodeCli } from "../src/node.ts";
import { fixture, switchLayer } from "./fixture.ts";

NodeCli.main(fixture, switchLayer, { name: "fixture", version: "0.0.0" });
