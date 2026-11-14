#!/usr/bin/env node
/**
 * The air conditioner as a command line: `node core-effect/cli.ts aircon power set --on`. With `AIRCON_URL`, the
 * command line controls the unit of the server at that URL (`node core-effect/serve.ts`):
 * `AIRCON_URL=http://host:8080/cli node core-effect/cli.ts aircon status get`.
 */
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
