#!/usr/bin/env node
import { cliMain } from "../src/index.ts";
import { sensorOptions, sensorsApp } from "./sensors.ts";

cliMain(sensorsApp, { name: "sensors", version: "0.0.0", ...sensorOptions() });
