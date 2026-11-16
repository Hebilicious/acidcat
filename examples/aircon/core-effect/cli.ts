#!/usr/bin/env node
import { Http } from "@acid-cat/core-effect";
import { NodeCli } from "@acid-cat/core-effect/node";
import { aircon, unitLayer } from "./aircon.ts";

const url = process.env.AIRCON_URL;
let remote: Http.Client | undefined;
if (url !== undefined) {
  try {
    remote = Http.client(url);
  } catch (error) {
    console.error(`AIRCON_URL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

NodeCli.main(aircon, unitLayer, { name: "aircon", version: "0.1.0", remote });
