/**
 * The CLI binding (spec/bindings/cli.md): a command line made from the catalog, with `effect/cli`. This module works
 * in all runtimes. `NodeCli` in `@acid-cat/core-effect/node` runs it in Node.js.
 */
import {
  bundle,
  CLI_EXIT_CODES,
  CLI_RESUME_FLAGS,
  CLI_WATCH_EXIT_CODES,
  cliEventUsage,
  cliExitCode,
  cliJsonArray,
  cliRepeatedItems,
  cliResolve,
  cliUsage,
  commandPath,
  isCallFailure,
  isJsonObject,
} from "@acid-cat/spec-ts";
import type { CallFailure, CatalogDocument, JsonObject, Outcome, Resume } from "@acid-cat/spec-ts";
import { Console, Effect, Logger, Option, Predicate, Schema, Stream } from "effect";
import { Argument, CliError, Command, Flag, Primitive } from "effect/cli";

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
   * The commands of the application, beside the commands of the capabilities, `call`, `list` and `watch`. The name of
   * each one must not be `call`, `list`, `watch`, the name of another command of the application, or the first word of
   * the command of a capability (spec/bindings/cli.md#commands).
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
 * code with `exitCodeOf`. Other failures of the command stay in the error channel. Standard output carries only JSON,
 * so the logs go to standard error.
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
  ).pipe(Effect.provideService(Logger.LogToStderr, true));

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
 * The root command: one command for each capability in the view, `call`, `list`, `watch` with one command for each
 * event in the view, and the commands of the application. It throws if the name of a command of the application is not
 * allowed (see `Options.commands`), or if the path of a capability is the start of the path of another capability.
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
    events: Object.fromEntries(Object.entries(document.events ?? {}).filter(([, e]) => (e.audience ?? []).includes(target))),
  };
  const types = catalogView.$defs ?? {};

  const invoke = (id: string, input: unknown) =>
    Effect.scoped(Effect.flatMap(view, (session) => session.invoke(id, input))).pipe(
      Effect.flatMap(print),
      Effect.onInterrupt(() => Effect.sync(() => (process.exitCode = CLI_EXIT_CODES.cancelled))),
    );

  /** The flags of an input schema, one for each top-level property. */
  const flagsOf = (input: JsonObject | undefined) => {
    const schema = bundle(input ?? { type: "object" }, types);
    const properties = schemasIn(schema.properties);
    const required = new Set(isStrings(schema.required) ? schema.required : []);
    const definitions = isJsonObject(schema.$defs) ? schema.$defs : {};
    return Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [name, flagFor(name, cliResolve(property, definitions), definitions, required.has(name))]),
    );
  };

  const leaves = Object.entries(catalogView.capabilities).map(([id, capability]) => {
    const flags = flagsOf(capability.input);
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
          entries.push({ kind: "capability", id, description: capability.description, ...(yield* session.availability(id)), usage });
        }
        for (const [id, event] of Object.entries(catalogView.events ?? {})) {
          const usage = cliEventUsage(options.name, id, event.input === undefined ? undefined : bundle(event.input, types));
          entries.push({ kind: "event", id, description: event.description, usage });
        }
        yield* Console.log(JSON.stringify(entries, null, 2));
      }),
    ),
  ).pipe(Command.withDescription("List the capabilities, with their availability, and the events."));

  /**
   * Follow an event (spec/bindings/cli.md#events): each occurrence goes to standard output as one line of JSON. An
   * interrupt cancels the subscription. `resume` gives the cursor and `maxAgeMs`.
   */
  const follow = (id: string, input: unknown, resume: Resume) =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* view;
        const started = yield* Effect.result(session.subscribe(id, input, resume));
        if (started._tag === "Failure") return yield* printFailure(started.failure, CLI_EXIT_CODES[started.failure.kind]);
        const ended = yield* Effect.result(Stream.runForEach(started.success, (occurrence) => Console.log(JSON.stringify(occurrence))));
        if (ended._tag === "Failure") return yield* printFailure(ended.failure, CLI_WATCH_EXIT_CODES.internal);
        process.exitCode = CLI_WATCH_EXIT_CODES.complete;
      }),
    ).pipe(Effect.onInterrupt(() => Effect.sync(() => (process.exitCode = CLI_WATCH_EXIT_CODES.cancelled))));

  /** The flags that give the cursor and `maxAgeMs`. They are not properties of the input. */
  const resumeFlags = {
    cursor: Flag.String("cursor").pipe(Flag.withDescription("Resume after this cursor of an occurrence."), Flag.optional),
    "max-age-ms": Flag.Int("max-age-ms").pipe(Flag.withDescription("Do not replay occurrences older than this number of milliseconds."), Flag.optional),
  };

  /** Follow an event with the cursor and `maxAgeMs` of the flags. `maxAgeMs` must not be negative. */
  const followWith = (id: string, input: unknown, cursor: Option.Option<string>, maxAgeMs: Option.Option<number>) =>
    Effect.suspend(() => {
      if (Option.isSome(maxAgeMs) && maxAgeMs.value < 0) {
        return printFailure({ kind: "invalid-input", message: "--max-age-ms must not be negative." }, CLI_EXIT_CODES["invalid-input"]);
      }
      return follow(id, input, {
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
        ...(Option.isSome(maxAgeMs) ? { maxAgeMs: maxAgeMs.value } : {}),
      });
    });

  const watchers = Object.entries(catalogView.events ?? {}).map(([id, event]) => {
    const schema = event.input === undefined ? undefined : bundle(event.input, types);
    const properties = schema === undefined ? {} : schemasIn(schema.properties);
    for (const name of CLI_RESUME_FLAGS) {
      if (name in properties) throw new Error(`The input of the event ${id} has a property ${name}, which is a flag of watch.`);
    }
    if (schema !== undefined && schema.properties === undefined) {
      return Command.make(
        id,
        { input: Argument.String("input").pipe(Argument.withDescription("The input as JSON"), Argument.withDefault("{}")), ...resumeFlags },
        ({ input, cursor, "max-age-ms": maxAgeMs }) =>
          Effect.suspend(() =>
            isJsonText(input)
              ? followWith(id, JSON.parse(input), cursor, maxAgeMs)
              : printFailure({ kind: "invalid-input", message: "The input is not JSON." }, CLI_EXIT_CODES["invalid-input"]),
          ),
      ).pipe(Command.withDescription(event.description));
    }
    return Command.make(id, { input: flagsOf(event.input), ...resumeFlags }, ({ input, cursor, "max-age-ms": maxAgeMs }) =>
      followWith(id, inputFrom(input), cursor, maxAgeMs),
    ).pipe(Command.withDescription(event.description));
  });
  const watch = Command.make("watch").pipe(
    Command.withDescription("Follow an event by its id. Each occurrence goes to standard output as one line of JSON."),
    Command.withSubcommands(watchers),
  );

  const reserved = new Set(["call", "list", "watch"]);
  const taken = new Set(reserved);
  for (const { path } of leaves) {
    const [first] = path;
    if (first === undefined) continue;
    if (reserved.has(first)) throw new Error(`The command ${path.join(" ")} has the same name as a command of the command line.`);
    taken.add(first);
  }
  // A shared prefix is a command that only contains other commands (spec/bindings/cli.md#commands), so the path of a
  // capability must not be the start of the path of another capability. Ids are unique, so no two paths are the same.
  // Each event is one command under `watch`, and no capability path starts with `watch`.
  for (const { path } of leaves) {
    const longer = leaves.find((other) => other.path.length > path.length && path.every((word, index) => other.path[index] === word));
    if (longer !== undefined) {
      throw new Error(`The command ${path.join(" ")} is also the start of the command ${longer.path.join(" ")}. A shared prefix only contains other commands.`);
    }
  }
  for (const added of options.commands ?? []) {
    if (taken.has(added.name)) throw new Error(`The command ${added.name} of the application has the same name as another command.`);
    taken.add(added.name);
  }

  return Command.make(options.name).pipe(
    Command.withDescription(options.description ?? app.description ?? app.title ?? options.name),
    Command.withSubcommands([call, list, watch, ...group(leaves, []), ...(options.commands ?? [])]),
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

/**
 * The flag for one property of the input (spec/bindings/cli.md#commands). A repeated flag must occur at least once if
 * it is required.
 */
function flagFor(name: string, property: JsonObject, definitions: JsonObject, required: boolean) {
  const items = cliRepeatedItems(property, definitions);
  const flag = describe(items === undefined ? scalarFlag(name, property) : repeatedFlag(name, items), property);
  if (property.type === "boolean" && !required) return flag.pipe(Flag.withDefault(false));
  return required ? flag : flag.pipe(Flag.optional);
}

/** The flag that takes one value of the type of `property`, or JSON text for a type with no flag of its own. */
function scalarFlag(name: string, property: JsonObject): Flag.Flag<unknown> {
  if (isStringEnum(property.enum)) return Flag.Literals(name, property.enum);
  if (property.type === "integer") return Flag.Int(name);
  if (property.type === "number") return Flag.Finite(name);
  if (property.type === "boolean") return Flag.Boolean(name);
  if (property.type === "string") return Flag.String(name);
  return Flag.String(name).pipe(Flag.withSchema(Schema.fromJsonString(Schema.Json)));
}

/**
 * A repeated flag. If it occurs exactly once with JSON text of an array, it gives that array. If not, each occurrence
 * gives one item of the type of `items`, in the order of the flags.
 */
function repeatedFlag(name: string, items: JsonObject): Flag.Flag<unknown> {
  const primitive = itemPrimitive(items);
  const item = (value: string) =>
    primitive.parse(value).pipe(Effect.mapError((expected) => new CliError.InvalidValue({ option: name, value, expected, kind: "flag" })));
  return Flag.String(name).pipe(
    Flag.withMetavar(Primitive.getTypeName(primitive)),
    Flag.atLeast(1),
    Flag.mapEffect((values) => {
      const array = cliJsonArray(values);
      return array === undefined ? Effect.forEach(values, item) : Effect.succeed(array);
    }),
  );
}

/** The parser of one item of a repeated flag: `items` is an `enum` of strings, `integer`, `number` or `string`. */
function itemPrimitive(items: JsonObject): Primitive.Primitive<unknown> {
  if (isStringEnum(items.enum)) return Primitive.Choice(items.enum.map((value) => [value, value] as const));
  if (items.type === "integer") return Primitive.Int;
  if (items.type === "number") return Primitive.Finite;
  return Primitive.String;
}

const describe = (flag: Flag.Flag<unknown>, property: JsonObject): Flag.Flag<unknown> =>
  typeof property.description === "string" ? flag.pipe(Flag.withDescription(property.description)) : flag;

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

/** `true` if a text is JSON. */
function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Write a call failure to standard error, and set the exit code. */
const printFailure = (failure: CallFailure, code: number) =>
  Effect.gen(function* () {
    yield* Console.error(JSON.stringify({ kind: failure.kind, message: failure.message }));
    process.exitCode = code;
  });

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
