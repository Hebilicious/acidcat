/**
 * The fixture's command line with a flag of the application: `--switch` gives the first position of the switch, so the
 * services of the capabilities depend on the flag.
 */
import { Effect, Layer, SubscriptionRef } from "effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { Cli } from "../src/index.ts";
import { NodeCli } from "../src/node.ts";
import { fixture, holdsLayer, Switch } from "./fixture.ts";

const switchFlag = GlobalFlag.Setting("switch")({
  flag: Flag.Boolean("switch").pipe(Flag.withDescription("The first position of the switch."), Flag.withDefault(true)),
});

const services = Layer.merge(Layer.effect(Switch, Effect.flatMap(switchFlag, SubscriptionRef.make)), holdsLayer());

const command = Cli.command(fixture, { name: "fixture", version: "0.0.0" }).pipe(
  Command.provide(services),
  Command.withGlobalFlags([switchFlag]),
);

NodeCli.runCommand(command, { version: "0.0.0" });
