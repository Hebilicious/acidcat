#!/usr/bin/env node
/**
 * The fixture as a command line that calls a server, for the conformance tests: `fixture-cli-remote.ts <url> [args]`.
 * Each call and each subscription goes to the HTTP binding of the target `cli` at the URL.
 */
import { cliMain, httpClient } from "../src/index.ts";
import { fixture, options } from "./fixture.ts";

const [url = "", ...args] = process.argv.slice(2);
cliMain(fixture, { name: "fixture", version: "0.0.0", ...options(), remote: httpClient(url) }, args);
