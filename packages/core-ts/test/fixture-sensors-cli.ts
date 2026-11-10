#!/usr/bin/env node
/** The sensors as a command line, for the tests of `watch` in a process of its own. */
import { cliMain } from "../src/index.ts";
import { sensorOptions, sensorsApp } from "./sensors.ts";

cliMain(sensorsApp, { name: "sensors", version: "0.0.0", ...sensorOptions() });
