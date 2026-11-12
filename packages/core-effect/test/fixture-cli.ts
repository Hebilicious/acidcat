#!/usr/bin/env node
/** The fixture as a command line, for the CLI tests. */
import { writeFile } from "node:fs/promises";

import { Effect, Layer } from "effect";

import * as NodeCli from "../src/NodeCli.ts";
import { fixture, holdsLayer, switchLayer, watchersLayer } from "./fixture.ts";

const writeMarker = (path: string) => Effect.promise(() => writeFile(path, ""));

NodeCli.main(fixture, Layer.mergeAll(switchLayer, holdsLayer(writeMarker), watchersLayer(writeMarker)), { name: "fixture", version: "0.0.0" });
