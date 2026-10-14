/**
 * The types of the CLI binding keep the services of the application. `moon run core-effect:typecheck` checks this file:
 * each `@ts-expect-error` marks a program that forgets the layer of the application.
 */
import { test } from "node:test";
import { Effect } from "effect";
import { Command } from "effect/cli";

import { Cli } from "../src/index.ts";
import { fixture, switchLayer } from "./fixture.ts";

const options = { name: "fixture", version: "0.0.0" };

test("Cli.run needs the services of the application", () => {
  const provided: Effect.Effect<void | number, never, Command.Environment> = Cli.run(fixture, options).pipe(
    Effect.provide(switchLayer),
  );
  // @ts-expect-error The layer of the application is missing.
  const missing: Effect.Effect<void | number, never, Command.Environment> = Cli.run(fixture, options);
  void [provided, missing];
});

test("Cli.command needs the services of the application", () => {
  const provided: Command.Command<string, {}, {}, never, never> = Cli.command(fixture, options).pipe(
    Command.provide(switchLayer),
  );
  // @ts-expect-error The layer of the application is missing.
  const missing: Command.Command<string, {}, {}, never, never> = Cli.command(fixture, options);
  void [provided, missing];
});
