#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import { cliMain, httpClient } from "@acid-cat/core-ts";
import type { HttpClient } from "@acid-cat/core-ts";
import { unixSocketFetch } from "@acid-cat/core-ts/node";
import { aircon, output, toJsonSchema, Unit } from "./aircon.ts";

let remote: HttpClient | undefined;
const url = process.env.AIRCON_URL;
const socket = process.env.AIRCON_SOCKET;
if (url !== undefined) {
  try {
    remote = httpClient(url, { fetch: socket === undefined ? undefined : unixSocketFetch(socket) });
  } catch (error) {
    process.stderr.write(`AIRCON_URL: ${error instanceof Error ? error.message : "The URL is not valid."}\n`);
    process.exit(2);
  }
}
cliMain(aircon, { name: "aircon", version: "0.1.0", context: { unit: new Unit(), writeFile }, toJsonSchema, remote, output });
