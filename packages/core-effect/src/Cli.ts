/**
 * The CLI binding (spec/bindings/cli.md): a command line made from the catalog, with `effect/cli`. This module works
 * in all runtimes. `NodeCli` in `@acid-cat/core-effect/node` runs it in Node.js.
 */
import { CLI_EXIT_CODES, cliExitCode, cliUsage, commandPath, isCallFailure, REFERENCE } from "@acid-cat/spec-ts";
import type { JsonObject, Outcome } from "@acid-cat/spec-ts";
import { Console, Context, Effect, Layer, Option, Schema } from "effect";
import type { Terminal } from "effect";
import { Argument, CliError, Command, Flag, GlobalFlag, Param } from "effect/cli";

import * as App from "./App.ts";
import { flagNames } from "./internal/flags.ts";
import * as Session from "./Session.ts";

/**
 * Where the command line writes its answers: the values and the failures of `print`, and the list of `list`. Standard
 * output carries the answers and nothing else (spec/bindings/cli.md#outcomes). The default is the `Console` of Effect.
 * `NodeCli` writes the answers to standard output, and sends the other output of the console to standard error.
 */
export const Answers = Context.Reference<{ readonly write: (text: string) => Effect.Effect<void> }>("@acid-cat/core-effect/Cli/Answers", {
  defaultValue: () => ({ write: (text) => Console.log(text) }),
});

export interface Options {
  readonly name: string;
  readonly version: string;
  /** The target that the command line serves. The default is `"cli"`. */
  readonly target?: string | undefined;
  /** The description of the command line, in the help of its root command. The default is the description of the application, then its title. */
  readonly description?: string | undefined;
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

/**
 * The parts of a command that the checks of `Cli.command` read: its name, the names and the aliases of its own flags,
 * and its subcommands.
 */
interface Shape {
  readonly name: string;
  /** Where the flags come from, in the messages of the checks: an id, or the path of a command. */
  readonly owner: string;
  readonly flags: readonly string[];
  readonly subcommands: readonly Shape[];
}

/**
 * A command of the application, made by `Cli.declare` from parts that the binding can read. `effect/cli` gives no way
 * to read the flags of a command that it made, so the binding makes the command from its parts, and checks them.
 */
export interface Declared<C extends Command.Command<any, any, any, any, any>> {
  readonly command: C;
  readonly shape: Shape;
}

type AnyDeclared = Declared<Command.Command<any, any, any, any, any>>;

/**
 * Declare a command of the application: its name, its flags and arguments in the form that `Command.make` takes, its
 * handler, and its subcommands. `Cli.command` adds it beside the commands of the capabilities, and checks its names.
 */
export function declare<
  const Name extends string,
  const Config extends Command.Command.Config,
  E = never,
  R = never,
  const Subcommands extends ReadonlyArray<AnyDeclared> = readonly [],
>(
  name: Name,
  config: Config,
  handler?: (input: Command.Command.Config.Infer<Config>) => Effect.Effect<void, E, R>,
  options: {
    readonly description?: string | undefined;
    readonly examples?: ReadonlyArray<Command.Command.Example> | undefined;
    readonly subcommands?: Subcommands | undefined;
  } = {},
): Declared<
  Command.Command<
    Name,
    Command.Command.Config.Infer<Config>,
    {},
    E | Command.Error<Subcommands[number]["command"]>,
    R | Command.Services<Subcommands[number]["command"]>
  >
> {
  const subcommands = options.subcommands ?? [];
  let made: Command.Command<any, any, any, any, any> = handler === undefined ? Command.make(name, config) : Command.make(name, config, handler);
  if (options.description !== undefined) made = made.pipe(Command.withDescription(options.description));
  if (options.examples !== undefined) made = made.pipe(Command.withExamples(options.examples));
  if (subcommands.length > 0) made = made.pipe(Command.withSubcommands(subcommands.map((each) => each.command) as never));
  return {
    command: made as never,
    shape: { name, owner: `the command ${name}`, flags: flagsOfConfig(config), subcommands: subcommands.map((each) => each.shape) },
  };
}

/** The names and the aliases of the flags in the config of a command. */
function flagsOfConfig(config: Command.Command.Config | ReadonlyArray<unknown>): string[] {
  return Object.values(config).flatMap((value: unknown): string[] => {
    if (Param.isParam(value)) return value.kind === "flag" ? flagNames(value as Param.Param<"flag", unknown>) : [];
    if (Array.isArray(value)) return flagsOfConfig(value);
    return typeof value === "object" && value !== null ? flagsOfConfig(value as Command.Command.Config) : [];
  });
}

export interface CommandOptions<
  Commands extends ReadonlyArray<AnyDeclared>,
  GlobalFlags extends ReadonlyArray<GlobalFlag.GlobalFlag<any>>,
  LA,
  LE,
  LR,
> extends Options {
  /**
   * The commands of the application, beside the commands of the capabilities (spec/bindings/cli.md#commands). Make each
   * one with `Cli.declare`, so that the binding can check its names.
   */
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
 * application. The program stops with an error when two commands have the same path, or when two flags in the scope
 * of a command have the same name or alias (spec/bindings/cli.md#commands). The scope of a command is its own flags and
 * the global flags, of the application and of `effect/cli`. `Cli.command` checks this when it makes the command.
 */
export function command<
  R,
  const Commands extends ReadonlyArray<AnyDeclared> = readonly [],
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
  LE | Command.Error<Commands[number]["command"]>,
  Exclude<Exclude<R, LA> | LR | Command.Services<Commands[number]["command"]>, SettingsOf<GlobalFlags>>
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
        yield* (yield* Answers).write(JSON.stringify(entries, null, 2));
      }),
    ),
  ).pipe(Command.withDescription("List the capabilities, with their availability."));

  const globalFlags = options.globalFlags ?? [];
  const applicationCommands = options.commands ?? [];
  check(
    options.name,
    [...GlobalFlag.BuiltIns, ...globalFlags].flatMap((flag) => flagNames(flag.flag)),
    [
      { name: "call", owner: "the command call", flags: [], subcommands: [] },
      { name: "list", owner: "the command list", flags: [], subcommands: [] },
      ...shapesOf(leaves.map(({ id, path, flags }) => ({ id, path, flags: Object.keys(flags) }))),
      ...applicationCommands.map((each) => each.shape),
    ],
  );

  const services = options.services;
  const provided = (each: Command.Command<string, any, {}, never, R>): Command.Command<string, any, {}, LE, Exclude<R, LA> | LR> =>
    services === undefined ? (each as never) : each.pipe(Command.provide(services));
  const bindingCommands = [call, list, ...group(leaves, [])].map(provided);

  const root = Command.make(options.name).pipe(
    Command.withDescription(options.description ?? app.description ?? app.title ?? options.name),
    Command.withSubcommands([...bindingCommands, ...applicationCommands.map((each) => each.command)]),
  );
  return (globalFlags.length === 0 ? root : root.pipe(Command.withGlobalFlags(globalFlags))) as never;
}

/** The first value that a list has two times. */
function repeated(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

/**
 * Check the names of a command line: no two global flags with one name or alias, no two sibling commands with one name
 * at any level, and no two flags with one name or alias in the scope of a command.
 */
function check(program: string, globalNames: readonly string[], commands: readonly Shape[]): void {
  const global = repeated(globalNames);
  if (global !== undefined) throw new Error(`Two global flags of the command line have the name ${global}.`);
  const globals = new Set(globalNames);
  const walk = (path: readonly string[], siblings: readonly Shape[]) => {
    const sibling = repeated(siblings.map((each) => each.name));
    if (sibling !== undefined) throw new Error(`Two commands of the command line have the path ${[...path, sibling].join(" ")}.`);
    for (const each of siblings) {
      const own = repeated(each.flags);
      if (own !== undefined) throw new Error(`Two flags of ${each.owner} have the name ${own}.`);
      const hidden = each.flags.find((name) => globals.has(name));
      if (hidden !== undefined) throw new Error(`The flag --${hidden} of ${each.owner} has the same name as a global flag of the command line.`);
      walk([...path, each.name], each.subcommands);
    }
  };
  walk([program], commands);
}

/** The shapes of the commands of the capabilities: the commands of the ids, in the groups of their shared prefixes. */
function shapesOf(leaves: readonly { readonly id: string; readonly path: readonly string[]; readonly flags: readonly string[] }[]): Shape[] {
  const shapes: Shape[] = [];
  const byWord = new Map<string, { readonly id: string; readonly path: readonly string[]; readonly flags: readonly string[] }[]>();
  for (const leaf of leaves) {
    if (leaf.path.length === 1) {
      shapes.push({ name: leaf.path[0]!, owner: leaf.id, flags: leaf.flags, subcommands: [] });
      continue;
    }
    const children = byWord.get(leaf.path[0]!) ?? [];
    children.push({ ...leaf, path: leaf.path.slice(1) });
    byWord.set(leaf.path[0]!, children);
  }
  for (const [word, children] of byWord) shapes.push({ name: word, owner: `the group ${word}`, flags: [], subcommands: shapesOf(children) });
  return shapes;
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
      yield* (yield* Answers).write(JSON.stringify(outcome.ok ? outcome.value : outcome.error, null, 2));
    }
    process.exitCode = cliExitCode(outcome);
  });
