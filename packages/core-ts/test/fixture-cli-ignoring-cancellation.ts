#!/usr/bin/env node
/** The fixture as a command line whose calls to fixture.hold ignore cancellation, for the conformance tests. */
import { writeFile } from "node:fs/promises";

import { cliMain } from "../src/index.ts";
import { fixture, HoldsThatIgnoreCancellation, options, Watchers } from "./fixture.ts";

const mark = (path: string) => writeFile(path, "");

cliMain(fixture, { name: "fixture", version: "0.0.0", ...options(new HoldsThatIgnoreCancellation(mark), new Watchers(mark)) });
