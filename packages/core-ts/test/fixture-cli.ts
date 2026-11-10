#!/usr/bin/env node
/** The fixture as a command line, for the conformance tests. */
import { writeFile } from "node:fs/promises";

import { cliMain } from "../src/index.ts";
import { fixture, Holds, options, Watchers } from "./fixture.ts";

const mark = (path: string) => writeFile(path, "");

cliMain(fixture, { name: "fixture", version: "0.0.0", ...options(new Holds(mark), new Watchers(mark)) });
