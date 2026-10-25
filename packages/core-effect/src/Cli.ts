/**
 * The CLI binding (spec/bindings/cli.md): a command line made from the catalog, with `effect/cli`. This module works
 * in all runtimes. `NodeCli` in `@acid-cat/core-effect/node` runs it in Node.js.
 */
import { bundle, CLI_EXIT_CODES, cliExitCode, cliUsage, commandPath, isCallFailure, REFERENCE } from "@acid-cat/spec-ts";
import type { CatalogDocument, JsonObject, Outcome } from "@acid-cat/spec-ts";
import { Console, Effect, Option, Predicate, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";

import * as App from "./App.ts";
import * as Session from "./Session.ts";

/**
 * The options of the command line. `Commands` is the type of the commands of the application. Their errors and their
 * services are the errors and the services of the command line.
 */
export interface Options<Commands extends ReadonlyArray<Command.Command.Any> = readonly []> {
  readonly name: string;
  readonly version: string;
  /** The target that the command line serves. The default is `"cli"`. */
  readonly target?: string | undefined;
  /**
   * The help text of the root command. The default is the description of the application, then its title, then
   * `name`.
   */
  readonly description?: string | undefined;
  /**
   * The commands of the application, beside the commands of the capabilities, `call` and `list`. The name of each one
   * must not be `call`, `list`, the name of another command of the application, or the first word of the command of a
   * capability (spec/bindings/cli.md#commands).
   */
  readonly commands?: Commands | undefined;
}

/**
 * The command line as an Effect. Exit codes follow spec/bindings/cli.md. To run it as the main program of a Node.js
 * process, use `NodeCli.main` from `@acid-cat/core-effect/node`.
 */
export const run = <R, const Commands extends ReadonlyArray<Command.Command.Any> = readonly []>(app: App.App<R>, options: Options<Commands>) =>
  runCommand(command(app, options), options);

/**
 * Run a command that `command` made, after the application changed it: for example with its own flags
 * (`Command.withGlobalFlags`), or with services that depend on them (`Command.provide`). Usage errors set the exit
 * code with `exitCodeOf`. Other failures of the command stay in the error channel.
 */
export const runCommand = <Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  options: { readonly version: string },
): Effect.Effect<void | number, Exclude<E, CliError.CliError>, R | Command.Environment> =>
  Effect.catchIf(
    Command.run(command, { version: options.version }),
    CliError.isCliError,
    (error) => Effect.sync(() => (process.exitCode = exitCodeOf(error))),
    Effect.fail,
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
 * A command of the command line. Its handler needs `R`, the services of the capabilities and of the commands of the
 * application. `Command.provide` gives them. `E` is the errors of the commands of the application.
 */
export type AppCommand<R, E = never> = Command.Command<string, {}, {}, E, R>;

/**
 * The root command: one command for each capability in the view, `call`, `list`, and the commands of the application.
 * It throws if the name of a command of the application is not allowed (see `Options.commands`).
 */
export function command<R, const Commands extends ReadonlyArray<Command.Command.Any> = readonly []>(
  app: App.App<R>,
  options: Options<Commands>,
): AppCommand<R | Command.Services<Commands[number]>, Command.Error<Commands[number]>> {
  const target = options.target ?? "cli";
  const view = Session.make(app, { target });
  const document = App.document(app);
  const catalogView: CatalogDocument = {
    ...document,
    capabilities: Object.fromEntries(Object.entries(document.capabilities).filter(([, c]) => (c.audience ?? []).includes(target))),
  };
  const types = catalogView.$defs ?? {};

  const invoke = (id: string, input: unknown) =>
    Effect.scoped(Effect.flatMap(view, (session) => session.invoke(id, input))).pipe(
      Effect.flatMap(print),
      Effect.onInterrupt(() => Effect.sync(() => (process.exitCode = CLI_EXIT_CODES.cancelled))),
    );

  const leaves = Object.entries(catalogView.capabilities).map(([id, capability]) => {
    const schema = bundle(capability.input ?? { type: "object" }, types);
    const properties = schemasIn(schema.properties);
    const required = new Set(isStrings(schema.required) ? schema.required : []);
    const definitions = schemasIn(schema.$defs);
    const flags = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [name, flagFor(name, resolve(property, definitions), required.has(name))]),
    );
    const path = commandPath(id);
    const name = path.at(-1);
    if (name === undefined) throw new Error(`The capability id ${id} has no words.`);
    const leaf: AppCommand<R> = Command.make(name, flags, (parsed: Record<string, unknown>) => invoke(id, inputFrom(parsed))).pipe(
      Command.withDescription(capability.description),
    );
    return { path, leaf };
  });

  const call = Command.make(
    "call",
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

  const list = Command.make("list", {}, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* view;
        const entries = [];
        for (const [id, capability] of Object.entries(catalogView.capabilities)) {
          const usage = cliUsage(options.name, id, capability.input === undefined ? undefined : bundle(capability.input, types));
          entries.push({ id, description: capability.description, ...(yield* session.availability(id)), usage });
        }
        yield* Console.log(JSON.stringify(entries, null, 2));
      }),
    ),
  ).pipe(Command.withDescription("List the capabilities, with their availability."));

  const reserved = new Set(["call", "list"]);
  const taken = new Set(reserved);
  for (const { path } of leaves) {
    const [first] = path;
    if (first === undefined) continue;
    if (reserved.has(first)) throw new Error(`The command ${path.join(" ")} has the same name as a command of the command line.`);
    taken.add(first);
  }
  for (const added of options.commands ?? []) {
    if (taken.has(added.name)) throw new Error(`The command ${added.name} of the application has the same name as another command.`);
    taken.add(added.name);
  }

  return Command.make(options.name).pipe(
    Command.withDescription(options.description ?? app.description ?? app.title ?? options.name),
    Command.withSubcommands([call, list, ...group(leaves, []), ...(options.commands ?? [])]),
  );
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
    const [word, ...rest] = entry.path;
    if (word === undefined || rest.length === 0) {
      commands.push(entry.leaf);
      continue;
    }
    const children = byWord.get(word) ?? [];
    children.push({ path: rest, leaf: entry.leaf });
    byWord.set(word, children);
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

const isStrings = Schema.is(Schema.Array(Schema.String));
const isStringEnum = Schema.is(Schema.NonEmptyArray(Schema.String));

/**
 * The schemas in a `properties` or `$defs` object, by name. A schema that is not an object, for example `true`, has no
 * keywords, so it becomes the empty schema.
 */
function schemasIn(value: unknown): { readonly [name: string]: JsonObject } {
  if (!Predicate.isReadonlyObject(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, Predicate.isReadonlyObject(schema) ? schema : {}]));
}

/** A property schema, or the type that it refers to. */
function resolve(property: JsonObject, definitions: { readonly [name: string]: JsonObject }): JsonObject {
  const name = typeof property.$ref === "string" ? REFERENCE.exec(property.$ref)?.[1] : undefined;
  return name === undefined ? property : (definitions[name] ?? property);
}

/** The flag for one property of the input (spec/bindings/cli.md#commands). */
function flagFor(name: string, property: JsonObject, required: boolean) {
  const base: Flag.Flag<unknown> =
    isStringEnum(property.enum)
      ? Flag.Literals(name, property.enum)
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

/** Write an outcome and set the exit code (spec/bindings/cli.md#outcomes). */
const print = (outcome: Outcome<unknown, unknown>) =>
  Effect.gen(function* () {
    if (isCallFailure(outcome)) {
      yield* Console.error(JSON.stringify({ kind: outcome.kind, message: outcome.message }));
    } else {
      yield* Console.log(JSON.stringify(outcome.ok ? outcome.value : outcome.error, null, 2));
    }
    process.exitCode = cliExitCode(outcome);
  });
