#!/usr/bin/env node
/** The air conditioner as a command line: `node examples/aircon-cli.ts aircon power set --on`. */
import { Cli } from "../src/index.ts";
import { aircon, unitLayer } from "./aircon.ts";

Cli.main(aircon, unitLayer, { name: "aircon", version: "0.1.0" });
