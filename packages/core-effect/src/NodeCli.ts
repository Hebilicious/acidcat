/**
 * Run the CLI binding as the main program of a Node.js process.
 */
import { Console as NodeConsole } from "node:console";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { GlobalFlag } from "effect/cli";
import type { Command } from "effect/cli";

import type * as App from "./App.ts";
import * as Cli from "./Cli.ts";
import { flagNames } from "./internal/flags.ts";

/**
 * Run the command line as the main program of the process. `layer` gives the services that the command needs: those of
 * the capabilities that `options.services` does not give, and those of the commands of the application. The options
 * are the options of `Cli.command`.
 */
export function main<
  R,
  E,
  const Commands extends ReadonlyArray<Cli.Declared<Command.Command<any, any, any, any, any>>> = readonly [],
  const GlobalFlags extends ReadonlyArray<GlobalFlag.GlobalFlag<any>> = readonly [],
  LA = never,
  LE = never,
  LR = never,
>(
  app: App.App<R>,
  layer: Layer.Layer<Cli.CommandServices<R, Commands, GlobalFlags, LA, LR>, E>,
  options: Cli.CommandOptions<Commands, GlobalFlags, LA, LE, LR>,
): void {
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
  const restore = requestsBuiltIn(process.argv.slice(2)) ? () => undefined : sendConsoleToStandardError();
  const answers = Layer.succeed(Cli.Answers, { write: (text: string) => Effect.sync(() => void process.stdout.write(`${text}\n`)) });
  const keep = () => undefined;
  process.on("SIGINT", keep);
  try {
    NodeRuntime.runMain(program.pipe(Effect.provide(answers), Effect.ensuring(Effect.sync(restore))));
  } finally {
    process.removeListener("SIGINT", keep);
  }
}

/** The names of the built-in flags of `effect/cli` that ask for output of their own: help, version and completions. */
const builtInOutputs = new Set(
  [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions, GlobalFlag.Wizard].flatMap((flag) =>
    flagNames(flag.flag).map((name) => (name.length === 1 ? `-${name}` : `--${name}`)),
  ),
);

/** True if the arguments ask for the output of a built-in flag, for example `--help`. That output goes to standard output. */
const requestsBuiltIn = (args: readonly string[]) => args.some((arg) => builtInOutputs.has(arg.split("=")[0]!));

/**
 * While the command runs, send all output of the console to standard error: logs of Effect, the `Console` of Effect,
 * and the global console that other runtimes of the program write to, with each of its methods. Standard output carries
 * only the answers, which `Cli.Answers` writes (spec/bindings/cli.md#outcomes). The help that `effect/cli` shows for a
 * usage error is output of the console, so it goes to standard error too. The result gives the program its own console
 * again.
 */
function sendConsoleToStandardError(): () => void {
  const own = globalThis.console;
  globalThis.console = new NodeConsole({ stdout: process.stderr, stderr: process.stderr });
  return () => {
    globalThis.console = own;
  };
}
