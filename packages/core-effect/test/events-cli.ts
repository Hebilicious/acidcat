#!/usr/bin/env node
import * as NodeCli from "../src/NodeCli.ts";
import { events, feedLayer } from "./events-fixture.ts";

NodeCli.main(events, feedLayer, { name: "feed", version: "0.0.0" });
