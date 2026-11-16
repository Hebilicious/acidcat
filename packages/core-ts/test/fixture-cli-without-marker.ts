#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import { cliMain } from "../src/index.ts";
import { fixture, Holds, options, Watchers } from "./fixture.ts";

cliMain(fixture, { name: "fixture", version: "0.0.0", ...options(new Holds(), new Watchers((path) => writeFile(path, ""))) });
