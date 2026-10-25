#!/usr/bin/env node
/** The air conditioner as a command line: `node core-effect/cli.ts aircon power set --on`. */
import { NodeCli } from "@acid-cat/core-effect/node";
import { aircon, unitLayer } from "./aircon.ts";

NodeCli.main(aircon, unitLayer, { name: "aircon", version: "0.1.0" });
