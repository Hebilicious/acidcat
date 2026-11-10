#!/usr/bin/env node
/** The events fixture as a command line, for the tests of `watch`. */
import { NodeCli } from "../src/node.ts";
import { events, feedLayer } from "./events-fixture.ts";

NodeCli.main(events, feedLayer, { name: "feed", version: "0.0.0" });
