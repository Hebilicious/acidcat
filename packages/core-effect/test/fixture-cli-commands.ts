/**
 * The fixture's command line with a command of the application, `position`, and its own description. `position` uses
 * the services of the capabilities and takes an argument.
 */
import { Console, Effect, SubscriptionRef } from "effect";
import { Argument, Command } from "effect/cli";

import { NodeCli } from "../src/node.ts";
import { fixture, fixtureLayer, Switch } from "./fixture.ts";

const position = Command.make("position", { label: Argument.String("label") }, ({ label }) =>
  Effect.gen(function* () {
    const on = yield* SubscriptionRef.get(yield* Switch);
    yield* Console.log(`${label}: ${on ? "on" : "off"}`);
  }),
).pipe(Command.withDescription("Write the position of the switch."));

NodeCli.main(fixture, fixtureLayer, {
  name: "fixture",
  version: "0.0.0",
  description: "The fixture, with a command of its own.",
  commands: [position],
});
