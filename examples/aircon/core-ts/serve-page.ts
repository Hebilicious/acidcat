#!/usr/bin/env node
/**
 * The web page of the air conditioner on @acid-cat/core-ts, with its WebMCP tools. `node core-ts/serve-page.ts
 * [host:port]` bundles `page.ts`, serves the page on the address, by default on 127.0.0.1 with a free port, and writes
 * its URL on standard output. Open the URL in a browser that has WebMCP. Each page has its own simulated unit.
 */
import { serve } from "@acid-cat/core-ts/node";

import { addressOf, pageHandler } from "../web/page.ts";

const address = addressOf(process.argv[2] ?? "127.0.0.1:0");
if (address === undefined) {
  process.stderr.write(`${process.argv[2]} is not an address such as 127.0.0.1:8080.\n`);
  process.exit(2);
}
const page = await pageHandler(new URL("./page.ts", import.meta.url));
const served = await serve({ "/": page }, address);
process.stdout.write(`${served.url}/\n`);
