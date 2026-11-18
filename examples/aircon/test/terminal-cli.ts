import { NodeCli } from "@acid-cat/core-effect/node";
import { unavailable } from "@acid-cat/spec-ts";
import { Effect, Layer, SubscriptionRef } from "effect";

import { aircon, Unit, unitLayer } from "../core-effect/aircon.ts";
import { output } from "../core-effect/output.ts";

const [connection, ...args] = process.argv.slice(2);

process.stdout.isTTY = true;

const offline = Layer.effectDiscard(Effect.flatMap(Effect.service(Unit), (unit) => SubscriptionRef.set(unit.connection, unavailable("The unit is offline."))));

NodeCli.main(aircon, connection === "offline" ? Layer.provideMerge(offline, unitLayer) : unitLayer, { name: "aircon", version: "0.1.0", output }, args);
