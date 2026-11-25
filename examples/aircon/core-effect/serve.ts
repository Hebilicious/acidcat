#!/usr/bin/env node
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

const socket = process.env.AIRCON_SOCKET;
const cli = Http.toWebHandler(aircon, unitLayer, { allowedOrigins: [], base: "/cli", target: "cli" });

Effect.runFork(
  Effect.scoped(
    Effect.gen(function* () {
      const served = yield* NodeServer.serve({ "/cli": cli }, socket === undefined ? { hostname, port } : { path: socket });
      yield* Console.log(`${served.url}/cli`);
      return yield* Effect.never;
    }),
  ),
);
