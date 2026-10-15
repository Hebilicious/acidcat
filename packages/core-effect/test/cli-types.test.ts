/**
 * The types of the CLI binding keep the services of the application. `moon run core-effect:typecheck` checks this file:
 * each `@ts-expect-error` marks a program that forgets the layer of the application.
 */
import { test } from "node:test";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";

import { Cli } from "../src/index.ts";
import { NodeCli } from "../src/node.ts";
import { fixture, Switch, fixtureLayer } from "./fixture.ts";

const options = { name: "fixture", version: "0.0.0" };

test("Cli.run needs the services of the application", () => {
  const provided: Effect.Effect<void | number, never, Command.Environment> = Cli.run(fixture, options).pipe(
    Effect.provide(fixtureLayer),
  );
  // @ts-expect-error The layer of the application is missing.
  const missing: Effect.Effect<void | number, never, Command.Environment> = Cli.run(fixture, options);
  const withServices: Effect.Effect<void | number, never, Command.Environment> = Cli.run(fixture, { ...options, services: fixtureLayer });
  void [provided, missing, withServices];
});

test("Cli.command needs the services of the application", () => {
  const provided: Command.Command<string, {}, {}, never, never> = Cli.command(fixture, options).pipe(
    Command.provide(fixtureLayer),
  );
  // @ts-expect-error The layer of the application is missing.
  const missing: Command.Command<string, {}, {}, never, never> = Cli.command(fixture, options);
  void [provided, missing];
});

test("Cli.command gives the services to the commands of the capabilities, and keeps the needs of the commands of the application", () => {
  const withServices: Command.Command<string, {}, {}, never, never> = Cli.command(fixture, { ...options, services: fixtureLayer });
  const greet = Cli.declare("greet", {}, () => Switch.use(() => Effect.void));
  const needsSwitch: Command.Command<string, {}, {}, never, Switch> = Cli.command(fixture, { ...options, services: fixtureLayer, commands: [greet] });
  // @ts-expect-error The command of the application needs the switch.
  const missing: Command.Command<string, {}, {}, never, never> = Cli.command(fixture, { ...options, services: fixtureLayer, commands: [greet] });
  void [withServices, needsSwitch, missing];
});

test("NodeCli.main takes the options of Cli.command, and a layer for the services that they do not give", () => {
  const greet = Cli.declare("greet", {}, () => Switch.use(() => Effect.void));
  void (() => NodeCli.main(fixture, Layer.empty, { ...options, services: fixtureLayer }));
  void (() => NodeCli.main(fixture, fixtureLayer, { ...options, services: fixtureLayer, commands: [greet] }));
  // @ts-expect-error The command of the application needs the switch.
  void (() => NodeCli.main(fixture, Layer.empty, { ...options, services: fixtureLayer, commands: [greet] }));
});
