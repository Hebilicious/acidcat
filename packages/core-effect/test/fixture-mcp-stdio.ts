#!/usr/bin/env node
import * as NodeMcp from "../src/NodeMcp.ts";
import { fixture, fixtureLayer, POLL } from "./fixture.ts";

NodeMcp.main(fixture, fixtureLayer, { name: "fixture", version: "0.0.0", poll: POLL });
