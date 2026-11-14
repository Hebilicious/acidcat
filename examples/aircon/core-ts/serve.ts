#!/usr/bin/env node
/**
 * The air conditioner as a server: the HTTP binding of the target `cli` at `/cli`, for the command line on another
 * machine. `node core-ts/serve.ts [host:port]` listens on the address, by default on 127.0.0.1 with a free port, and
 * writes the base URL on standard output. Then `AIRCON_URL=<url> node core-ts/cli.ts aircon status get` controls the
 * unit of this server.
 */
import { httpHandler } from "@acid-cat/core-ts";
import { serve } from "@acid-cat/core-ts/node";
import { aircon, toJsonSchema, Unit } from "./aircon.ts";

const address = process.argv[2] ?? "127.0.0.1:0";
const match = /^(.+):([0-9]+)$/.exec(address);
if (match === null) {
  process.stderr.write(`${address} is not an address such as 0.0.0.0:8080.\n`);
  process.exit(2);
}
const [, hostname = "", port = "0"] = match;
const cli = httpHandler(aircon, { allowedOrigins: [], target: "cli", base: "/cli", context: { unit: new Unit() }, toJsonSchema });
const served = await serve({ "/cli": cli }, { hostname: hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(port) });
process.stdout.write(`${served.url}/cli\n`);
