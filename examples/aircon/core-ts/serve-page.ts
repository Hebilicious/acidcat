#!/usr/bin/env node
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
