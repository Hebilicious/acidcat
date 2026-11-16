#!/usr/bin/env node
import * as NodeServer from "@acid-cat/core-effect/NodeServer";
import { Console, Effect } from "effect";

import { addressOf, pageHandler } from "../web/page.ts";

const address = addressOf(process.argv[2] ?? "127.0.0.1:0");
if (address === undefined) {
  console.error(`${process.argv[2]} is not an address such as 127.0.0.1:8080.`);
  process.exit(2);
}

Effect.runFork(
  Effect.scoped(
    Effect.gen(function* () {
      const page = yield* Effect.promise(() => pageHandler(new URL("./page.ts", import.meta.url)));
      const served = yield* NodeServer.serve({ "/": page }, address);
      yield* Console.log(`${served.url}/`);
      return yield* Effect.never;
    }),
  ),
);
