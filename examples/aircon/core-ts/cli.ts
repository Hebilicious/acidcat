#!/usr/bin/env node
/**
 * The air conditioner as a command line: `node core-ts/cli.ts aircon power set --on`. With `AIRCON_URL`, the command line
 * controls the unit of the server at that URL (`node core-ts/serve.ts`).
 */
import { cliMain, httpClient } from "@acid-cat/core-ts";
import type { HttpClient } from "@acid-cat/core-ts";
import { aircon, toJsonSchema, Unit } from "./aircon.ts";

let remote: HttpClient | undefined;
const url = process.env.AIRCON_URL;
if (url !== undefined) {
  try {
    remote = httpClient(url);
  } catch (error) {
    process.stderr.write(`AIRCON_URL: ${error instanceof Error ? error.message : "The URL is not valid."}\n`);
    process.exit(2);
  }
}
cliMain(aircon, { name: "aircon", version: "0.1.0", context: { unit: new Unit() }, toJsonSchema, remote });
