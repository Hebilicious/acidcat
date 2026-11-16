#!/usr/bin/env node
import { cliMain, httpClient } from "../src/index.ts";
import { fixture, options } from "./fixture.ts";

const [url = "", ...args] = process.argv.slice(2);
cliMain(fixture, { name: "fixture", version: "0.0.0", ...options(), remote: httpClient(url) }, args);
