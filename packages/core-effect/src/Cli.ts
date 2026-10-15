/**
 * The CLI binding (spec/bindings/cli.md): a command line made from the catalog, with `effect/cli`. This module works
 * in all runtimes. `NodeCli` in `@acid-cat/core-effect/node` runs it in Node.js.
 */
import { CLI_EXIT_CODES, cliExitCode, cliUsage, commandPath, isCallFailure, REFERENCE } from "@acid-cat/spec-ts";
import type { JsonObject, Outcome } from "@acid-cat/spec-ts";
import { Console, Effect, Layer, Option, Schema } from "effect";
import type { Terminal } from "effect";
import { Argument, CliError, Command, Flag, GlobalFlag } from "effect/cli";
import type { Param } from "effect/cli";

import * as App from "./App.ts";
import * as Session from "./Session.ts";

export interface Options {
  readonly name: string;
  readonly version: string;
  /** The target that the command line serves. The default is `"cli"`. */
  readonly target?: string | undefined;
}

/**
 * The command line as an Effect. Exit codes follow spec/bindings/cli.md. To run it as the main program of a Node.js
 * process, use `NodeCli.main` from `@acid-cat/core-effect/node`.
 */
export const run = <R>(app: App.App<R>, options: Options) => runCommand(command(app, options), options);

/**
 * Run a command that `command` made, after the application changed it: for example with its own flags
 * (`Command.withGlobalFlags`), or with services that depend on them (`Command.provide`). Usage errors set the exit
 * code with `exitCodeOf`. Other failures of the command stay in the error channel.
 */
export const runCommand = <Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  options: { readonly version: string },
): Effect.Effect<void | number, Exclude<E, CliError.CliError | Terminal.QuitError>, R | Command.Environment> =>
  Command.run(command, { version: options.version }).pipe(
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.sync(() => (process.exitCode = exitCodeOf(error)))
        : Effect.fail(error as Exclude<E, CliError.CliError | Terminal.QuitError>),
    ),
  );

/**
 * The exit code for a usage error (spec/bindings/cli.md#exit-codes). `effect/cli` shows the help for each usage error,
 * and gives the errors in the `errors` of `ShowHelp`. Help with no errors is a request for help.
 */
export function exitCodeOf(error: CliError.CliError): number {
  const errors: readonly CliError.CliError[] = error._tag === "ShowHelp" ? error.errors : [error];
  if (errors.length === 0) return CLI_EXIT_CODES.value;
  return errors.some((inner) => inner._tag === "UnknownSubcommand")
    ? CLI_EXIT_CODES["unknown-capability"]
    : CLI_EXIT_CODES["invalid-input"];
}

/**
 * A command of the command line. Its handler needs `R`, the services of the capabilities. `Command.provide` gives them.
 */
export type AppCommand<R> = Command.Command<string, {}, {}, never, R>;

/** The services of the settings among some global flags. */
type SettingsOf<Flags extends ReadonlyArray<GlobalFlag.GlobalFlag<any>>> = Flags[number] extends infer F
  ? F extends GlobalFlag.Setting<infer Id, any>
    ? GlobalFlag.Setting.Identifier<Id>
    : never
  : never;

export interface CommandOptions<
  Commands extends ReadonlyArray<Command.Command<any, any, any, any, any>>,
  GlobalFlags extends ReadonlyArray<GlobalFlag.GlobalFlag<any>>,
  LA,
  LE,
  LR,
> extends Options {
  /** The commands of the application, beside the commands of the capabilities (spec/bindings/cli.md#commands). */
  readonly commands?: Commands | undefined;
  /** The flags of the application, for all commands. The services of the capabilities can depend on them. */
  readonly globalFlags?: GlobalFlags | undefined;
  /**
   * The services of the capabilities, for the commands of the capabilities, `call` and `list`. The commands of the
   * application do not get them.
   */
  readonly services?: Layer.Layer<LA, LE, LR> | undefined;
}

/**
 * The root command: one command for each capability in the view, `call` and `list`, and the commands of the
 * application. The program stops with an error when two commands have the same path, or when the flag of a capability
 * has the name of a global flag (spec/bindings/cli.md#commands). `Cli.command` checks this when it makes the command.
 */
export function command<
  R,
  const Commands extends ReadonlyArray<Command.Command<any, any, any, any, any>> = readonly [],
  const GlobalFlags extends ReadonlyArray<GlobalFlag.GlobalFlag<any>> = readonly [],
  LA = never,
  LE = never,
  LR = never,
>(
  app: App.App<R>,
  options: CommandOptions<Commands, GlobalFlags, LA, LE, LR>,
): Command.Command<
  string,
  {},
  {},
  LE | Command.Error<Commands[number]>,
  Exclude<Exclude<R, LA> | LR | Command.Services<Commands[number]>, SettingsOf<GlobalFlags>>
> {
  const target = options.target ?? "cli";
  const view = Session.make(app, { target });
  const served = App.capabilitiesOf(app, target);

  const invoke = (id: string, input: unknown) =>
    Effect.scoped(Effect.flatMap(view, (session) => session.invoke(id, input))).pipe(
      Effect.flatMap(print),
      Effect.onInterrupt(() => Effect.sync(() => (process.exitCode = CLI_EXIT_CODES.cancelled))),
    );

  const leaves = served.map((capability) => {
    const id = capability.id;
    const schema = App.inputJsonSchema(capability);
    const properties = (schema.properties ?? {}) as { readonly [name: string]: JsonObject };
    const required = new Set((schema.required ?? []) as readonly string[]);
    const definitions = (schema.$defs ?? {}) as { readonly [name: string]: JsonObject };
    const flags = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [name, flagFor(name, resolve(property, definitions), required.has(name))]),
    );
    const path = commandPath(id);
    const leaf: AppCommand<R> = Command.make(path.at(-1)!, flags, (parsed: Record<string, unknown>) => invoke(id, inputFrom(parsed))).pipe(
      Command.withDescription(capability.description),
    );
    return { id, flags, path, leaf };
  });

  const call = Command.make(
    "call" as string,
    {
      id: Argument.String("id").pipe(Argument.withDescription("The id of the capability")),
      input: Argument.String("input").pipe(Argument.withDescription("The input as JSON"), Argument.withDefault("{}")),
    },
    ({ id, input }) =>
      Effect.suspend(() => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(input);
        } catch {
          return print({ kind: "invalid-input", message: "The input is not JSON." });
        }
        return invoke(id, parsed);
      }),
  ).pipe(Command.withDescription("Call a capability by its id, with its input as JSON."));

  const list = Command.make("list" as string, {}, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* view;
        const entries = [];
        for (const capability of served) {
          const id = capability.id;
          const usage = cliUsage(options.name, id, capability.input === undefined ? undefined : App.inputJsonSchema(capability));
          entries.push({ id, description: capability.description, ...(yield* session.availability(id)), usage });
        }
        yield* Console.log(JSON.stringify(entries, null, 2));
      }),
    ),
  ).pipe(Command.withDescription("List the capabilities, with their availability."));

  const globalFlags = options.globalFlags ?? [];
  const globalNames = new Set([...GlobalFlag.BuiltIns, ...globalFlags].flatMap((flag) => flagNames(flag.flag)));
  for (const { id, flags } of leaves) {
    for (const name of Object.keys(flags)) {
      if (globalNames.has(name)) throw new Error(`The flag --${name} of ${id} has the same name as a global flag of the command line.`);
    }
  }

  const services = options.services;
  const provided = (each: Command.Command<string, any, {}, never, R>): Command.Command<string, any, {}, LE, Exclude<R, LA> | LR> =>
    services === undefined ? (each as never) : each.pipe(Command.provide(services));
  const bindingCommands = [call, list, ...group(leaves, [])].map(provided);
  const applicationCommands = options.commands ?? [];

  const taken = new Set<string>();
  for (const each of [...bindingCommands, ...applicationCommands]) {
    if (taken.has(each.name)) throw new Error(`Two commands of the command line have the path ${options.name} ${each.name}.`);
    taken.add(each.name);
  }

  const root = Command.make(options.name).pipe(
    Command.withDescription(app.description ?? app.title ?? options.name),
    Command.withSubcommands([...bindingCommands, ...applicationCommands]),
  );
  return (globalFlags.length === 0 ? root : root.pipe(Command.withGlobalFlags(globalFlags))) as never;
}

/** The names and the aliases of a flag. */
function flagNames(flag: Param.Param<"flag", unknown>): string[] {
  const node = flag as Param.Single<"flag", unknown> | Param.Map<"flag", unknown, unknown> | Param.Transform<"flag", unknown, unknown> | Param.Optional<"flag", unknown> | Param.Variadic<"flag", unknown>;
  switch (node._tag) {
    case "Single":
      return [node.name, ...node.aliases];
    case "Transform":
      return [...flagNames(node.param), ...node.alternatives.flatMap((alternative) => flagNames(alternative() as Param.Param<"flag", unknown>))];
    case "Map":
    case "Optional":
    case "Variadic":
      return flagNames(node.param);
  }
}

interface Leaf<R> {
  readonly path: readonly string[];
  readonly leaf: AppCommand<R>;
}

/** Make the commands that only contain other commands, from the shared prefixes of the ids. */
function group<R>(leaves: readonly Leaf<R>[], prefix: readonly string[]): AppCommand<R>[] {
  const commands: AppCommand<R>[] = [];
  const byWord = new Map<string, Leaf<R>[]>();
  for (const entry of leaves) {
    if (entry.path.length === 1) {
      commands.push(entry.leaf);
      continue;
    }
    const children = byWord.get(entry.path[0]!) ?? [];
    children.push({ path: entry.path.slice(1), leaf: entry.leaf });
    byWord.set(entry.path[0]!, children);
  }
  for (const [word, children] of byWord) {
    commands.push(
      Command.make(word).pipe(
        Command.withDescription(`The ${[...prefix, word].join(".")} capabilities.`),
        Command.withSubcommands(group(children, [...prefix, word])),
      ),
    );
  }
  return commands;
}

/** A property schema, or the type that it refers to. */
function resolve(property: JsonObject, definitions: { readonly [name: string]: JsonObject }): JsonObject {
  const name = typeof property.$ref === "string" ? REFERENCE.exec(property.$ref)?.[1] : undefined;
  return name === undefined ? property : (definitions[name] ?? property);
}

/** The flag for one property of the input (spec/bindings/cli.md#commands). */
function flagFor(name: string, property: JsonObject, required: boolean) {
  const enumValues = Array.isArray(property.enum) && property.enum.every((value) => typeof value === "string") ? (property.enum as string[]) : undefined;
  const base: Flag.Flag<unknown> =
    enumValues !== undefined
      ? Flag.Literals(name, enumValues as [string, ...string[]])
      : property.type === "integer"
        ? Flag.Int(name)
        : property.type === "number"
          ? Flag.Finite(name)
          : property.type === "boolean"
            ? Flag.Boolean(name)
            : property.type === "string"
              ? Flag.String(name)
              : Flag.String(name).pipe(Flag.withSchema(Schema.fromJsonString(Schema.Json)));
  const described = typeof property.description === "string" ? base.pipe(Flag.withDescription(property.description)) : base;
  if (property.type === "boolean" && !required) return described.pipe(Flag.withDefault(false));
  return required ? described : described.pipe(Flag.optional);
}

/** The input from the parsed flags: each flag that the user gave, and nothing for the others. */
function inputFrom(parsed: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (Option.isOption(value)) {
      if (Option.isSome(value)) input[name] = value.value;
    } else if (value !== undefined) {
      input[name] = value;
    }
  }
  return input;
}

/**
 * Write an outcome and set the exit code (spec/bindings/cli.md#outcomes): a value or a failure as JSON on standard
 * output, a call failure as `{ "kind", "message" }` on standard error. A command of the application uses it to give its
 * outcomes as the commands of the capabilities do.
 */
export const print = (outcome: Outcome<unknown, unknown>): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (isCallFailure(outcome)) {
      yield* Console.error(JSON.stringify({ kind: outcome.kind, message: outcome.message }));
    } else {
      yield* Console.log(JSON.stringify(outcome.ok ? outcome.value : outcome.error, null, 2));
    }
    process.exitCode = cliExitCode(outcome);
  });
