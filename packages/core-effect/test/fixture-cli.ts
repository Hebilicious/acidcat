#!/usr/bin/env node
/** The fixture as a command line, for the CLI tests. */
import { writeFile } from "node:fs/promises";

import { Effect, Layer } from "effect";

import { NodeCli } from "../src/node.ts";
import { fixture, holdsLayer, switchLayer } from "./fixture.ts";

const writeMarker = (path: string) => Effect.promise(() => writeFile(path, ""));

NodeCli.main(fixture, Layer.merge(switchLayer, holdsLayer(writeMarker)), { name: "fixture", version: "0.0.0" });
