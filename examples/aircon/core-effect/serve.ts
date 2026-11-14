#!/usr/bin/env node
/**
 * The HTTP binding of the target `cli`, for the command line on another computer: `node core-effect/serve.ts
 * [host:port]`. The default address is `127.0.0.1:0`, a free port on this computer. The program writes the base URL of
 * the binding on standard output, for example `http://127.0.0.1:41234/cli`. Give it to the command line in `AIRCON_URL`.
 */
import { Http } from "@acid-cat/core-effect";
import * as NodeServer from "@acid-cat/core-effect/NodeServer";
import { Console, Effect } from "effect";

import { aircon, unitLayer } from "./aircon.ts";

const address = process.argv[2] ?? "127.0.0.1:0";
const colon = address.lastIndexOf(":");
const hostname = address.slice(0, colon).replace(/^\[(.*)\]$/, "$1");
const port = Number(address.slice(colon + 1));
if (colon <= 0 || !Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`${address} is not an address such as 0.0.0.0:8080.`);
  process.exit(2);
}

// All requests use one unit: the services are built one time, for the first request.
const cli = Http.toWebHandler(aircon, unitLayer, { allowedOrigins: [], base: "/cli", target: "cli" });

Effect.runFork(
  Effect.scoped(
    Effect.gen(function* () {
      const served = yield* NodeServer.serve({ "/cli": cli }, { hostname, port });
      yield* Console.log(`${served.url}/cli`);
      return yield* Effect.never;
    }),
  ),
);
