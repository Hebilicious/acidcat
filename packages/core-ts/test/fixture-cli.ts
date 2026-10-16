#!/usr/bin/env node
/** The fixture as a command line, for the conformance tests. */
import { writeFile } from "node:fs/promises";

import { cliMain } from "../src/index.ts";
import { fixture, Holds, options } from "./fixture.ts";

cliMain(fixture, { name: "fixture", version: "0.0.0", ...options(new Holds((path) => writeFile(path, ""))) });
