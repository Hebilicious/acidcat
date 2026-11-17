#!/usr/bin/env node
import { cliMain } from "../src/index.ts";
import { fileMarker } from "./file-marker.ts";
import { fixture, HoldsThatIgnoreCancellation, options, Watchers } from "./fixture.ts";

cliMain(fixture, { name: "fixture", version: "0.0.0", ...options(new HoldsThatIgnoreCancellation(fileMarker), new Watchers(fileMarker)) });
