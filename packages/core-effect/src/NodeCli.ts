/**
 * Run the CLI binding as the main program of a Node.js process.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import type { Command } from "effect/cli";

import type * as App from "./App.ts";
import * as Cli from "./Cli.ts";

/** Run the command line as the main program of the process. `layer` gives the services of the capabilities. */
export function main<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Cli.Options): void {
  Cli.run(app, options).pipe(Effect.provide(Layer.merge(layer, NodeServices.layer)), NodeRuntime.runMain);
}

/**
 * Run a command that `Cli.command` made and the application changed, as the main program of the process. The command
 * must already have the services of the capabilities, for example from `Command.provide`. See `Cli.runCommand`.
 */
export function runCommand<Name extends string, Input, ContextInput, E>(
  command: Command.Command<Name, Input, ContextInput, E, Command.Environment>,
  options: { readonly version: string },
): void {
  Cli.runCommand(command, options).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
