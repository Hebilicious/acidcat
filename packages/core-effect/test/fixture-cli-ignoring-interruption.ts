#!/usr/bin/env node
import { Layer } from "effect";

import * as NodeCli from "../src/NodeCli.ts";
import { fileMarker } from "./file-marker.ts";
import { fixture, holdsLayer, switchLayer, watchersLayer } from "./fixture.ts";

const holds = holdsLayer(fileMarker, { ignoreInterruption: true });

NodeCli.main(fixture, Layer.mergeAll(switchLayer, holds, watchersLayer(fileMarker, { ignoreInterruption: true })), { name: "fixture", version: "0.0.0" });
