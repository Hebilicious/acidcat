#!/usr/bin/env node
import { NodeMcp } from "@acid-cat/core-effect/node";
import { aircon, unitLayer } from "./aircon.ts";

NodeMcp.main(aircon, unitLayer, { name: "aircon", version: "0.1.0" });
