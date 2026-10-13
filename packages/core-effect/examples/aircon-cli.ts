#!/usr/bin/env node
/** The air conditioner as a command line: `node examples/aircon-cli.ts aircon power set --on`. */
import { NodeCli } from "../src/node.ts";
import { aircon, unitLayer } from "./aircon.ts";

NodeCli.main(aircon, unitLayer, { name: "aircon", version: "0.1.0" });
