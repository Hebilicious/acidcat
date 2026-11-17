#!/usr/bin/env node
import { Layer } from "effect";

import * as NodeCli from "../src/NodeCli.ts";
import { fileMarker } from "./file-marker.ts";
import { fixture, holdsLayer, switchLayer, watchersLayer } from "./fixture.ts";

NodeCli.main(fixture, Layer.mergeAll(switchLayer, holdsLayer(fileMarker), watchersLayer(fileMarker)), { name: "fixture", version: "0.0.0" });
