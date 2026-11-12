#!/usr/bin/env node
/** The lamp as a command line, for the CLI tests. The bulb of this lamp is burnt, so the lamp stays off. */
import * as NodeCli from "../src/NodeCli.ts";
import { lamp, makeLampLayer } from "./lamp.ts";

NodeCli.main(lamp, makeLampLayer({ burntAfter: 1200 }), { name: "lamp", version: "0.0.0" });
