/**
 * The types of the CLI binding keep the services of the application. `moon run core-effect:typecheck` checks this file:
 * each `@ts-expect-error` marks a program that forgets the layer of the application.
 */
import { test } from "node:test";
import { Context, Effect, Layer } from "effect";
import { Command } from "effect/cli";

import { Cli } from "../src/index.ts";
import { NodeCli } from "../src/node.ts";
import { fixture, fixtureLayer } from "./fixture.ts";

/** A service that only a command of the application needs. */
class Clock extends Context.Service<Clock, number>()("fixture/Clock") {}

const clockLayer = Layer.succeed(Clock, 0);
const time = Command.make("time", {}, () =>
  Effect.gen(function* () {
    yield* Clock;
  }),
);

const options = { name: "fixture", version: "0.0.0" };

test("Cli.run needs the services of the application", () => {
  const provided: Effect.Effect<void | number, never, Command.Environment> = Cli.run(fixture, options).pipe(
    Effect.provide(fixtureLayer),
  );
  // @ts-expect-error The layer of the application is missing.
  const missing: Effect.Effect<void | number, never, Command.Environment> = Cli.run(fixture, options);
  void [provided, missing];
});

test("Cli.command needs the services of the application", () => {
  const provided: Command.Command<string, {}, {}, never, never> = Cli.command(fixture, options).pipe(
    Command.provide(fixtureLayer),
  );
  // @ts-expect-error The layer of the application is missing.
  const missing: Command.Command<string, {}, {}, never, never> = Cli.command(fixture, options);
  void [provided, missing];
});

test("Cli.command needs the services of the commands of the application", () => {
  const command = Cli.command(fixture, { ...options, commands: [time] });
  const provided: Command.Command<string, {}, {}, never, never> = command.pipe(Command.provide(Layer.merge(fixtureLayer, clockLayer)));
  // @ts-expect-error The layer of the command of the application is missing.
  const missing: Command.Command<string, {}, {}, never, never> = command.pipe(Command.provide(fixtureLayer));
  void [provided, missing];
});

test("NodeCli.main needs a layer with the services of the commands of the application", () => {
  const provided = () => NodeCli.main(fixture, Layer.merge(fixtureLayer, clockLayer), { ...options, commands: [time] });
  // @ts-expect-error The layer does not give the service of the command of the application.
  const missing = () => NodeCli.main(fixture, fixtureLayer, { ...options, commands: [time] });
  void [provided, missing];
});
