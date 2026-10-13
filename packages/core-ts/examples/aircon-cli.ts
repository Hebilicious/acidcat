#!/usr/bin/env node
/** The air conditioner as a command line: `node examples/aircon-cli.ts aircon power set --on`. */
import { cliMain } from "../src/index.ts";
import { aircon, toJsonSchema, Unit } from "./aircon.ts";

cliMain(aircon, { name: "aircon", version: "0.1.0", context: { unit: new Unit() }, toJsonSchema });
