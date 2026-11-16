import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal";
import { Effect, Layer, Stdio } from "effect";
import type { Command } from "effect/cli";

import type * as App from "./App.ts";
import * as Cli from "./Cli.ts";

/**
 * `NodeRuntime.runMain` installs its interrupt handlers after `Effect.runFork` returns, and `runFork` runs the program
 * until the program first waits. The program yields first, so that an interrupt (`SIGINT`) during a call always cancels
 * the call.
 */
const afterInterruptHandlers = <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.andThen(Effect.yieldNow, program);

const nodeServices = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeStdio.layer, NodeTerminal.layer),
);

const withArgs = (args: readonly string[]) =>
  Layer.effect(
    Stdio.Stdio,
    Effect.map(Stdio.Stdio, (stdio) => ({ ...stdio, args: Effect.succeed(args) })),
  );

export function main<R, E, const Commands extends ReadonlyArray<Command.Command.Any> = readonly []>(
  app: App.App<R>,
  layer: Layer.Layer<R | Command.Services<Commands[number]>, E>,
  options: Cli.Options<Commands>,
  args: readonly string[] = process.argv.slice(2),
): void {
  const services = Layer.provideMerge(withArgs(args), nodeServices);
  Cli.run(app, options).pipe(Effect.provide(Layer.merge(layer, services)), afterInterruptHandlers, NodeRuntime.runMain);
}

export function runCommand<Name extends string, Input, ContextInput, E>(
  command: Command.Command<Name, Input, ContextInput, E, Command.Environment>,
  options: { readonly version: string },
): void {
  Cli.runCommand(command, options).pipe(Effect.provide(nodeServices), afterInterruptHandlers, NodeRuntime.runMain);
}
