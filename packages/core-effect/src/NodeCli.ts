import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CLI_EXIT_CODES, INTERRUPT_GRACE_MS } from "@acid-cat/spec-ts";
import { Console, Effect, Layer, Stdio } from "effect";
import type { Command } from "effect/cli";

import type * as App from "./App.ts";
import * as Cli from "./Cli.ts";

/**
 * `NodeRuntime.runMain` installs its interrupt handlers after `Effect.runFork` returns, and `runFork` runs the program
 * until the program first waits. The program yields first, so that an interrupt (`SIGINT`) during a call always cancels
 * the call.
 */
const afterInterruptHandlers = <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.andThen(Effect.yieldNow, program);

// `NodeRuntime.runMain` keeps the process running until the main fiber ends, so a fiber that cannot be interrupted
// keeps it running for ever.
const exitAfterInterruptGrace = () => {
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(CLI_EXIT_CODES.cancelled);
    interrupted = true;
    setTimeout(() => process.exit(CLI_EXIT_CODES.cancelled), INTERRUPT_GRACE_MS).unref();
  });
};

const withArgs = (args: readonly string[]) =>
  Layer.effect(
    Stdio.Stdio,
    Effect.map(Stdio.Stdio, (stdio) => ({ ...stdio, args: Effect.succeed(args) })),
  );

const terminal = Layer.effect(
  Cli.Terminal,
  Effect.flatMap(Effect.service(Stdio.Stdio), (stdio) => Effect.map(stdio.stdoutIsTerminal, (stdoutIsTerminal) => ({ stdoutIsTerminal, environment: process.env }))),
);

const stopOnBrokenRule = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.catchDefect(program, (problem) =>
    Effect.andThen(
      Console.error(problem instanceof Error ? problem.message : String(problem)),
      Effect.sync(() => (process.exitCode = CLI_EXIT_CODES.internal)),
    ),
  );

export function main<R, E, const Commands extends ReadonlyArray<Command.Command.Any> = readonly []>(
  app: App.App<R>,
  layer: Layer.Layer<R | Command.Services<Commands[number]>, E>,
  options: Cli.Options<Commands>,
  args: readonly string[] = process.argv.slice(2),
): void {
  const services = Layer.provideMerge(Layer.merge(withArgs(args), terminal), NodeServices.layer);
  exitAfterInterruptGrace();
  Effect.suspend(() => Cli.run(app, options)).pipe(stopOnBrokenRule, Effect.provide(Layer.merge(layer, services)), afterInterruptHandlers, NodeRuntime.runMain);
}

export function runCommand<Name extends string, Input, ContextInput, E>(
  command: Command.Command<Name, Input, ContextInput, E, Command.Environment>,
  options: { readonly version: string },
): void {
  exitAfterInterruptGrace();
  Cli.runCommand(command, options).pipe(stopOnBrokenRule, Effect.provide(Layer.provideMerge(terminal, NodeServices.layer)), afterInterruptHandlers, NodeRuntime.runMain);
}
