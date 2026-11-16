#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import { cliMain } from "../src/index.ts";
import { fixture, Holds, options, Watchers } from "./fixture.ts";

const mark = (path: string) => writeFile(path, "");

cliMain(fixture, { name: "fixture", version: "0.0.0", ...options(new Holds(mark), new Watchers(mark)) });
