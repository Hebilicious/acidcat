#!/usr/bin/env node
import * as NodeCli from "../src/NodeCli.ts";
import { lamp, makeLampLayer } from "./lamp.ts";

NodeCli.main(lamp, makeLampLayer({ burntAfter: 1200 }), { name: "lamp", version: "0.0.0" });
