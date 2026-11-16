import {
  CLI_EXIT_CODES,
  CLI_RESUME_FLAGS,
  CLI_WATCH_EXIT_CODES,
  cliAliases,
  cliAliasFlagNames,
  cliAliasInput,
  cliAliasUsage,
  cliEventUsage,
  cliExitCode,
  cliInputSchema,
  cliJsonArray,
  cliRepeatedItems,
  cliResolve,
  cliUsage,
  commandPath,
  isCallFailure,
  isJsonObject,
  ownMember,
} from "@acid-cat/spec-ts";
import { unavailable } from "@acid-cat/spec-ts";
import type { Availability, CallFailure, CatalogDocument, JsonObject, Occurrence, Outcome, Resume } from "@acid-cat/spec-ts";
import { Console, Context, Effect, Logger, Option, Predicate, Schema, Scope, Stdio, Stream } from "effect";
import { Argument, CliConfig, CliError, CliOutput, Command, CommandSpec, Flag, Primitive } from "effect/cli";

import * as App from "./App.ts";
import type * as Http from "./Http.ts";
import * as Session from "./Session.ts";

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
  /**
   * The HTTP binding of the application on a server (spec/bindings/cli.md#server), from `Http.client`. With it, the
   * command line sends each call, the availability of `list` and each subscription of `watch` to that server, and opens
   * no session in this process. The commands still come from the view of `target` in this program. Serve the HTTP
   * binding with the same target, so that both have the same view.
   */
  readonly remote?: Http.Client | undefined;
}

interface AliasEntry {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly default: boolean;
  readonly flags: readonly string[];
}

const Aliases = Context.Reference<ReadonlyArray<AliasEntry>>("@acid-cat/core-effect/Cli/Aliases", { defaultValue: () => [] });

/**
 * `effect/cli` reads a flag alias such as `--on` as a flag, never as a command, so `runCommand` selects the subcommand
 * of each alias by this other name. The arguments of a process cannot contain NUL, so no user can give it.
 */
const aliasWord = (name: string): string => `\u0000${name}`;

interface Provider {
  readonly invoke: (id: string, input: unknown) => Effect.Effect<Outcome<unknown, unknown>>;
  readonly availability: (ids: readonly string[]) => Effect.Effect<ReadonlyArray<Availability>, Session.CallFailed>;
  readonly subscribe: (id: string, input: unknown, resume: Resume) => Effect.Effect<Stream.Stream<Occurrence, Session.CallFailed>, Session.CallFailed, Scope.Scope>;
}

const local = <R>(app: App.App<R>, target: string): Effect.Effect<Provider, never, R | Scope.Scope> =>
  Effect.map(
    Session.make(app, { target }),
    (session): Provider => ({
      invoke: session.invoke,
      availability: (ids) => Effect.forEach(ids, session.availability),
      subscribe: session.subscribe,
    }),
  );

const remote = (client: Http.Client): Provider => ({
  invoke: client.invoke,
  availability: (ids) =>
    Effect.map(client.capabilities, (listed) =>
      ids.map((id): Availability => {
        const entry = listed.find((each) => each.id === id);
        if (entry === undefined) return unavailable("The server does not serve this capability.");
        return entry.available ? { available: true } : { available: false, reason: entry.reason };
      }),
    ),
  subscribe: client.subscribe,
});

/**
 * The command line as an Effect. Exit codes follow spec/bindings/cli.md. To run it as the main program of a Node.js
 * process, use `NodeCli.main` from `@acid-cat/core-effect/node`.
 */
export const run = <R, const Commands extends ReadonlyArray<Command.Command.Any> = readonly []>(app: App.App<R>, options: Options<Commands>) =>
  runCommand(command(app, options), options);

/**
 * The default presenter of `effect/cli` writes the help of an invalid invocation to standard output, but standard
 * output must be empty for exit codes 2 and 3 (spec/bindings/cli.md#outcomes).
 */
const usageErrorsOnStderr: CliOutput.Presenter = {
  present: (event) =>
    event._tag === "InvalidInvocation"
      ? Effect.gen(function* () {
          const formatter = yield* CliOutput.Formatter;
          yield* Console.error(formatter.formatHelpDoc(event.helpDoc));
          yield* Console.error(formatter.formatErrors(event.errors));
        })
      : event._tag === "Help" && event.reason === "Implicit"
        ? Effect.gen(function* () {
            const usage = parentUsageError(event.commandPath);
            if (usage === undefined) return yield* CliOutput.defaultPresenter.present(event);
            const formatter = yield* CliOutput.Formatter;
            yield* Console.error(formatter.formatHelpDoc(event.helpDoc));
            yield* Console.error(usage.message);
          })
        : CliOutput.defaultPresenter.present(event),
};

/**
 * `effect/cli` shows the help of a command that only contains other commands when it runs with no subcommand, as if the
 * help was asked for. Below the root, that run is a usage error: `watch` with no event id, or a shared prefix alone.
 */
function parentUsageError(commandPath: readonly string[]): { readonly message: string; readonly code: number } | undefined {
  const words = commandPath.slice(1);
  if (words.length === 0) return undefined;
  return words.join(" ") === "watch"
    ? { message: "Give the id of an event.", code: CLI_EXIT_CODES["invalid-input"] }
    : { message: `There is no command ${words.join(" ")}.`, code: CLI_EXIT_CODES["unknown-capability"] };
}

/**
 * Run a command that `command` made, after the application changed it: for example with its own flags
 * (`Command.withGlobalFlags`), or with services that depend on them (`Command.provide`). Usage errors set the exit
 * code with `exitCodeOf`. Other failures of the command stay in the error channel. Standard output carries only JSON,
 * so the logs and the usage errors go to standard error.
 *
 * When the first argument is the name of an alias (spec/bindings/cli.md#aliases), the subcommand of the alias makes
 * the call or the subscription, and `<alias> --help` writes the usage of the alias. With a default alias, the program
 * runs it when there is no argument, or when the first argument starts with `--` and is not a flag alias or a global
 * flag: then all the arguments are its flags. The help of the root command ends with the aliases. The program stops
 * with a defect when it starts if the name of a flag alias, or of a flag of the default alias, is the name of a global
 * flag: a flag of `effect/cli`, such as `--log-level`, or a flag of the application.
 */
export const runCommand = <Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  options: { readonly version: string },
): Effect.Effect<void | number, Exclude<E, CliError.CliError>, R | Command.Environment> => {
  const aliases = Context.get(command.annotations, Aliases);
  const program = Effect.gen(function* () {
    const args = yield* (yield* Stdio.Stdio).args;
    const runWith = Command.runWith(command, { version: options.version });
    if (aliases.length === 0) return yield* runWith(args);
    const { builtIns } = yield* CliConfig.CliConfig;
    const taken = new Set(globalFlagsOfEveryCommand(command, builtIns).flatMap(flagNames));
    const clash = aliases.find(({ name }) => name.startsWith("--") && taken.has(name.slice(2)));
    if (clash !== undefined) return yield* Effect.die(new Error(`The alias ${clash.name} has the name of a flag of the command line.`));
    const fallback = aliases.find((alias) => alias.default);
    const shadowed = fallback?.flags.find((flag) => taken.has(flag));
    if (fallback !== undefined && shadowed !== undefined) {
      return yield* Effect.die(new Error(`The default alias ${fallback.name} has the flag --${shadowed}, which is a flag of the command line.`));
    }
    const runAlias = (alias: AliasEntry, rest: readonly string[]) =>
      rest.includes("--help") || rest.includes("-h") ? Console.log(`Usage: ${alias.usage}\n\n${alias.description}`) : runWith([aliasWord(alias.name), ...rest]);
    const [first, ...rest] = args;
    const named = aliases.find(({ name }) => name === first);
    if (named !== undefined) return yield* runAlias(named, rest);
    const startsDefault = first === undefined || (first.startsWith("--") && !taken.has(longFlagName(first)));
    if (fallback !== undefined && startsDefault) return yield* runAlias(fallback, args);
    return yield* runWith(args);
  });
  return Effect.catchIf(
    program,
    CliError.isCliError,
    (error) => Effect.sync(() => (process.exitCode = exitCodeOf(error))),
    Effect.fail,
  ).pipe(
    Effect.updateService(
      CliOutput.Formatter,
      (formatter): CliOutput.Formatter => ({
        formatHelpDoc: (doc) => withAliases(formatter.formatHelpDoc(doc), doc),
        formatCliError: (error) => formatter.formatCliError(error),
        formatError: (error) => formatter.formatError(error),
        formatVersion: (name, version) => formatter.formatVersion(name, version),
        formatErrors: (errors) => formatter.formatErrors(errors),
      }),
    ),
    Effect.provideService(Logger.LogToStderr, true),
    Effect.provideService(CliOutput.Presenter, usageErrorsOnStderr),
  );
};

type BuiltIns = CliConfig.CliConfig.Service["builtIns"];

const globalFlagsOfSpec = (spec: CommandSpec.Spec): readonly CommandSpec.Flag[] => spec.flags.filter(({ scope }) => scope._tag === "Global");

function globalFlagsOfEveryCommand(command: Command.Command.Any, builtIns: BuiltIns): readonly CommandSpec.Flag[] {
  const flags: CommandSpec.Flag[] = [];
  const visit = (at: readonly string[]): void => {
    const spec = CommandSpec.resolve(command, at, { builtIns });
    if (Option.isNone(spec)) return;
    flags.push(...globalFlagsOfSpec(spec.value));
    for (const subcommand of spec.value.subcommands) visit([...at, subcommand.name]);
  };
  visit([command.name]);
  return flags;
}

const flagNames = (flag: CommandSpec.Flag): readonly string[] => [flag.name, ...flag.aliases, ...(flag.negation === undefined ? [] : [flag.negation])];

const longFlagName = (arg: string): string => arg.slice(2).split("=", 1)[0] ?? "";

function withAliases(help: string, doc: { readonly annotations: Context.Context<never> }): string {
  const aliases = Context.get(doc.annotations, Aliases);
  if (aliases.length === 0) return help;
  return [help, "", "ALIASES", ...aliases.map(({ usage }) => `  ${usage.slice(usage.indexOf(" ") + 1)}`)].join("\n");
}

/**
 * The exit code for a usage error (spec/bindings/cli.md#exit-codes). `effect/cli` shows the help for each usage error,
 * and gives the errors in the `errors` of `ShowHelp`. Help with no errors is a request for help, or a command that only contains other commands with no subcommand.
 */
export function exitCodeOf(error: CliError.CliError): number {
  if (error._tag === "ShowHelp" && error.errors.length === 0) return parentUsageError(error.commandPath)?.code ?? CLI_EXIT_CODES.value;
  const errors: readonly CliError.CliError[] = error._tag === "ShowHelp" ? error.errors : [error];
  return errors.some((inner) => inner._tag === "UnknownSubcommand")
    ? CLI_EXIT_CODES["unknown-capability"]
    : CLI_EXIT_CODES["invalid-input"];
}

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
  const client = options.remote;
  const view: Effect.Effect<Provider, never, R | Scope.Scope> = client === undefined ? local(app, target) : Effect.succeed(remote(client));
  const document = App.document(app);
  const catalogView: CatalogDocument = {
    ...document,
    capabilities: Object.fromEntries(Object.entries(document.capabilities).filter(([, c]) => (c.audience ?? []).includes(target))),
    events: Object.fromEntries(Object.entries(document.events ?? {}).filter(([, e]) => (e.audience ?? []).includes(target))),
  };
  const types = catalogView.$defs ?? {};

  const cancelledByInterrupt = Effect.onInterrupt(() => printFailure({ kind: "cancelled", message: "The call was cancelled." }, CLI_EXIT_CODES.cancelled));

  const invoke = (id: string, input: unknown) =>
    Effect.scoped(Effect.flatMap(view, (provider) => provider.invoke(id, input))).pipe(Effect.flatMap(print), cancelledByInterrupt);

  const flagsOf = (input: JsonObject | undefined) => flagsOfBundled(cliInputSchema(input ?? { type: "object" }, types));

  const flagsOfBundled = (schema: JsonObject) => {
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

  const invokeJson = (id: string, text: string) =>
    Effect.suspend(() => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // The call failures of the id come before invalid-input (spec/invocation.md#call-failures).
        return Effect.scoped(
          Effect.gen(function* () {
            if (ownMember(catalogView.capabilities, id) === undefined) return yield* print({ kind: "unknown-capability", message: `There is no capability ${id}.` });
            const provider = yield* view;
            const availability = yield* Effect.result(provider.availability([id]));
            if (availability._tag === "Failure") return yield* print(availability.failure);
            const [state] = availability.success;
            if (state !== undefined && !state.available) return yield* print({ kind: "unavailable", message: state.reason });
            return yield* print({ kind: "invalid-input", message: "The input is not JSON." });
          }),
        );
      }
      return invoke(id, parsed);
    });

  const jsonInput = { input: Argument.String("input").pipe(Argument.withDescription("The input as JSON"), Argument.withDefault("{}")) };

  const call = Command.make(
    "call",
    {
      id: Argument.String("id").pipe(Argument.withDescription("The id of the capability")),
      ...jsonInput,
    },
    ({ id, input }) => invokeJson(id, input),
  ).pipe(Command.withDescription("Call a capability by its id, with its input as JSON."));

  const aliasUsages = (kind: "capability" | "event", id: string): readonly string[] =>
    aliasCommands.flatMap((alias) => (alias.kind === kind && alias.id === id ? [alias.entry.usage] : []));

  const list = Command.make("list", {}, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* view;
        const capabilities = Object.entries(catalogView.capabilities);
        const availability = yield* Effect.result(provider.availability(capabilities.map(([id]) => id)));
        if (availability._tag === "Failure") return yield* print(availability.failure);
        const entries = [];
        for (const [index, [id, capability]] of capabilities.entries()) {
          const usage = cliUsage(options.name, id, capability.input === undefined ? undefined : cliInputSchema(capability.input, types));
          const usages = aliasUsages("capability", id);
          entries.push({
            kind: "capability",
            id,
            description: capability.description,
            ...availability.success[index],
            usage,
            ...(usages.length > 0 ? { aliases: usages } : {}),
          });
        }
        for (const [id, event] of Object.entries(catalogView.events ?? {})) {
          const usage = cliEventUsage(options.name, id, event.input === undefined ? undefined : cliInputSchema(event.input, types));
          const usages = aliasUsages("event", id);
          entries.push({ kind: "event", id, description: event.description, usage, ...(usages.length > 0 ? { aliases: usages } : {}) });
        }
        yield* Console.log(JSON.stringify(entries, null, 2));
      }),
    ).pipe(cancelledByInterrupt),
  ).pipe(Command.withDescription("List the capabilities, with their availability, and the events."));

  const follow = (id: string, input: unknown, resume: Resume) =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* view;
        const started = yield* Effect.result(provider.subscribe(id, input, resume));
        if (started._tag === "Failure") return yield* printFailure(started.failure, CLI_EXIT_CODES[started.failure.kind]);
        const ended = yield* Effect.result(Stream.runForEach(started.success, (occurrence) => Console.log(JSON.stringify(occurrence))));
        if (ended._tag === "Failure") return yield* printFailure(ended.failure, CLI_WATCH_EXIT_CODES.internal);
        process.exitCode = CLI_WATCH_EXIT_CODES.complete;
      }),
    ).pipe(Effect.onInterrupt(() => Effect.sync(() => (process.exitCode = CLI_WATCH_EXIT_CODES.cancelled))));

  const resumeFlags = {
    cursor: Flag.String("cursor").pipe(Flag.withDescription("Resume after this cursor of an occurrence."), Flag.optional),
    "max-age-ms": Flag.Int("max-age-ms").pipe(Flag.withDescription("Do not replay occurrences older than this number of milliseconds."), Flag.optional),
  };

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

  type Finish = <Input>(made: Command.Command<string, Input, {}, never, R>) => Command.Command<string, Input, {}, never, R>;

  const followCommand = (name: string, id: string, schema: JsonObject | undefined, fixed: JsonObject | undefined, finish: Finish) =>
    schema !== undefined && schema.properties === undefined
      ? finish(
          Command.make(name, { ...jsonInput, ...resumeFlags }, ({ input, cursor, "max-age-ms": maxAgeMs }) =>
            Effect.suspend(() =>
              isJsonText(input)
                ? followWith(id, JSON.parse(input), cursor, maxAgeMs)
                : printFailure({ kind: "invalid-input", message: "The input is not JSON." }, CLI_EXIT_CODES["invalid-input"]),
            ),
          ),
        )
      : finish(
          Command.make(name, { input: flagsOfBundled(schema ?? { type: "object" }), ...resumeFlags }, ({ input, cursor, "max-age-ms": maxAgeMs }) =>
            followWith(id, { ...fixed, ...inputFrom(input) }, cursor, maxAgeMs),
          ),
        );

  const watchers = Object.entries(catalogView.events ?? {}).map(([id, event]) => {
    const schema = event.input === undefined ? undefined : cliInputSchema(event.input, types);
    const properties = schema === undefined ? {} : schemasIn(schema.properties);
    for (const name of CLI_RESUME_FLAGS) {
      if (name in properties) throw new Error(`The input of the event ${id} has a property ${name}, which is a flag of watch.`);
    }
    return followCommand(id, id, schema, undefined, (made) => made.pipe(Command.withDescription(event.description)));
  });
  const watch = Command.make("watch").pipe(
    Command.withDescription("Follow an event by its id. Each occurrence goes to standard output as one line of JSON."),
    Command.withSubcommands(watchers),
  );

  const { aliases, default: defaultAlias, errors: aliasErrors } = cliAliases(catalogView, target);
  if (aliasErrors.length > 0) throw new Error(aliasErrors.join("\n"));
  const aliasCommands = aliases.map((alias) => {
    const described = alias.kind === "event" ? catalogView.events?.[alias.id] : catalogView.capabilities[alias.id];
    if (described === undefined) throw new Error(`The alias ${alias.name} refers to ${alias.id}, which is not in the view.`);
    const schema = cliAliasInput(catalogView, alias);
    const entry: AliasEntry = {
      name: alias.name,
      usage: cliAliasUsage(options.name, alias, schema),
      description: described.description,
      default: alias.name === defaultAlias?.name,
      flags: cliAliasFlagNames(catalogView, alias),
    };
    const finish: Finish = (made) => made.pipe(Command.withDescription(described.description), Command.unlisted, Command.withAlias(aliasWord(alias.name)));
    const subcommand =
      alias.kind === "event"
        ? followCommand(entry.name, alias.id, schema, alias.input, finish)
        : schema !== undefined && schema.properties === undefined
          ? finish(Command.make(entry.name, jsonInput, ({ input }) => invokeJson(alias.id, input)))
          : finish(Command.make(entry.name, flagsOfBundled(schema ?? { type: "object" }), (parsed: Record<string, unknown>) => invoke(alias.id, { ...alias.input, ...inputFrom(parsed) })));
    return { kind: alias.kind, id: alias.id, entry, subcommand };
  });

  const reserved = new Set(["call", "list", "watch"]);
  const taken = new Set(reserved);
  for (const { path } of leaves) {
    const [first] = path;
    if (first === undefined) continue;
    if (reserved.has(first)) throw new Error(`The command ${path.join(" ")} has the same name as a command of the command line.`);
    taken.add(first);
  }
  // A shared prefix is a command that only contains other commands (`spec/bindings/cli.md`), so the path of a capability
  // must not be the start of the path of another capability.
  for (const { path } of leaves) {
    const longer = leaves.find((other) => other.path.length > path.length && path.every((word, index) => other.path[index] === word));
    if (longer !== undefined) {
      throw new Error(`The command ${path.join(" ")} is also the start of the command ${longer.path.join(" ")}. A shared prefix only contains other commands.`);
    }
  }
  for (const { name } of aliases) taken.add(name);
  for (const added of options.commands ?? []) {
    if (taken.has(added.name)) throw new Error(`The command ${added.name} of the application has the same name as another command.`);
    taken.add(added.name);
  }

  return Command.make(options.name).pipe(
    Command.withDescription(options.description ?? app.description ?? app.title ?? options.name),
    Command.withSubcommands([call, list, watch, ...group(leaves, []), ...aliasCommands.map(({ subcommand }) => subcommand), ...(options.commands ?? [])]),
    Command.annotate(
      Aliases,
      aliasCommands.map(({ entry }) => entry),
    ),
  );
}

interface Leaf<R> {
  readonly path: readonly string[];
  readonly leaf: AppCommand<R>;
}

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

function schemasIn(value: unknown): { readonly [name: string]: JsonObject } {
  if (!Predicate.isReadonlyObject(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, Predicate.isReadonlyObject(schema) ? schema : {}]));
}

function flagFor(name: string, property: JsonObject, definitions: JsonObject, required: boolean) {
  const items = cliRepeatedItems(property, definitions);
  const flag = describe(items === undefined ? scalarFlag(name, property) : repeatedFlag(name, items), property);
  return required ? flag : flag.pipe(Flag.optional);
}

function scalarFlag(name: string, property: JsonObject): Flag.Flag<unknown> {
  if (isStringEnum(property.enum)) return Flag.Literals(name, property.enum);
  if (property.type === "integer") return Flag.Int(name);
  if (property.type === "number") return Flag.Finite(name);
  if (property.type === "boolean") return Flag.Boolean(name);
  if (property.type === "string") return Flag.String(name);
  return Flag.String(name).pipe(Flag.withSchema(Schema.fromJsonString(Schema.Json)));
}

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

function itemPrimitive(items: JsonObject): Primitive.Primitive<unknown> {
  if (isStringEnum(items.enum)) return Primitive.Choice(items.enum.map((value) => [value, value] as const));
  if (items.type === "integer") return Primitive.Int;
  if (items.type === "number") return Primitive.Finite;
  return Primitive.String;
}

const describe = (flag: Flag.Flag<unknown>, property: JsonObject): Flag.Flag<unknown> =>
  typeof property.description === "string" ? flag.pipe(Flag.withDescription(property.description)) : flag;

function inputFrom(parsed: Record<string, unknown>): Record<string, unknown> {
  // The entries go through `Object.fromEntries`, so that a flag name such as `__proto__` is an ordinary key.
  const entries = Object.entries(parsed).flatMap(([name, value]): [string, unknown][] => {
    if (Option.isOption(value)) return Option.isSome(value) ? [[name, value.value]] : [];
    return value === undefined ? [] : [[name, value]];
  });
  return Object.fromEntries(entries);
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const printFailure = (failure: CallFailure, code: number) =>
  Effect.gen(function* () {
    yield* Console.error(JSON.stringify({ kind: failure.kind, message: failure.message }));
    process.exitCode = code;
  });

const print = (outcome: Outcome<unknown, unknown>) =>
  Effect.gen(function* () {
    if (isCallFailure(outcome)) {
      yield* Console.error(JSON.stringify({ kind: outcome.kind, message: outcome.message }));
    } else {
      yield* Console.log(JSON.stringify(outcome.ok ? outcome.value : outcome.error, null, 2));
    }
    process.exitCode = cliExitCode(outcome);
  });
