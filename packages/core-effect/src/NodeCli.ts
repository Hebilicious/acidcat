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
  runMain(Cli.run(app, options).pipe(Effect.provide(Layer.merge(layer, NodeServices.layer))));
}

/**
 * Run a command that `Cli.command` made and the application changed, as the main program of the process. The command
 * must already have the services of the capabilities, for example from `Command.provide`. See `Cli.runCommand`.
 */
export function runCommand<Name extends string, Input, ContextInput, E>(
  command: Command.Command<Name, Input, ContextInput, E, Command.Environment>,
  options: { readonly version: string },
): void {
  runMain(Cli.runCommand(command, options).pipe(Effect.provide(NodeServices.layer)));
}

/**
 * Run a program as the main program of the process, so that an interrupt (`SIGINT`) cancels its call at all times.
 *
 * `NodeRuntime.runMain` adds its `SIGINT` listener after the program starts, and the program runs until it first waits
 * before that. With no listener, Node.js ends the process at an interrupt, with no exit code. A listener that does
 * nothing keeps the interrupt from the start: Node.js gives a signal to the listeners when the program waits, and then
 * the listener of `runMain` is there.
 */
function runMain<E>(program: Effect.Effect<unknown, E>): void {
  const keep = () => undefined;
  process.on("SIGINT", keep);
  try {
    NodeRuntime.runMain(program);
  } finally {
    process.removeListener("SIGINT", keep);
  }
}
