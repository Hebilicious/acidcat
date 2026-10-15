/**
 * The fixture's command line with a command and a flag of the application. `--switch` gives the first position of the
 * switch, so the services of the capabilities depend on the flag. `greet` is a command of the application: it writes
 * its outcome as the commands of the capabilities do, and it does not get their services.
 */
import { Effect, Layer, SubscriptionRef } from "effect";
import { Argument, Flag, GlobalFlag } from "effect/cli";

import { Cli } from "../src/index.ts";
import { NodeCli } from "../src/node.ts";
import { fixture, Switch } from "./fixture.ts";

const switchFlag = GlobalFlag.Setting("switch")({
  flag: Flag.Boolean("switch").pipe(Flag.withDescription("The first position of the switch."), Flag.withDefault(true)),
});

const greet = Cli.declare(
  "greet",
  { name: Argument.String("name") },
  ({ name }) => (name === "nobody" ? Cli.print({ ok: false, error: { _tag: "NoOne" } }) : Cli.print({ ok: true, value: `Hello, ${name}.` })),
  { description: "Greet someone." },
);

const command = Cli.command(fixture, {
  name: "fixture",
  version: "0.0.0",
  services: Layer.effect(Switch, Effect.flatMap(switchFlag, SubscriptionRef.make)),
  globalFlags: [switchFlag],
  commands: [greet],
});

NodeCli.runCommand(command, { version: "0.0.0" });
