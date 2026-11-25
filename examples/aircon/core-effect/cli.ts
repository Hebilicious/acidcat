#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import { Http } from "@acid-cat/core-effect";
import { NodeCli } from "@acid-cat/core-effect/node";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Layer } from "effect";

import { aircon, Files, unitLayer } from "./aircon.ts";
import { output } from "./output.ts";

const url = process.env.AIRCON_URL;
const socket = process.env.AIRCON_SOCKET;
let remote: Http.Client | undefined;
if (url !== undefined) {
  try {
    remote = Http.client(url, { layer: socket === undefined ? undefined : NodeHttpClient.layerUndiciOptions({ connect: { socketPath: socket } }) });
  } catch (error) {
    console.error(`AIRCON_URL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

NodeCli.main(aircon, Layer.merge(unitLayer, Layer.succeed(Files, { writeFile })), { name: "aircon", version: "0.1.0", remote, output });
