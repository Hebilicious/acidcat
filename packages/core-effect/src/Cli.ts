import {
  CLI_EXIT_CODES,
  CLI_GENERIC_COMMANDS,
  CLI_RESUME_FLAGS,
  CLI_WATCH_EXIT_CODES,
  cliAliases,
  cliAliasOfArgs,
  cliAliasFlagNames,
  cliAliasInput,
  cliAliasUsage,
  cliCommandList,
  cliEventUsage,
  cliExitCode,
  cliHelp,
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
import { Console, Context, Effect, Exit, Logger, Option, Predicate, Schema, Scope, Stdio, Stream } from "effect";
import { Argument, CliConfig, CliError, CliOutput, Command, CommandSpec, Flag, Primitive } from "effect/cli";
import type { HelpDoc } from "effect/cli";

import * as App from "./App.ts";
import type { AnySchema } from "./Capability.ts";
import type * as Http from "./Http.ts";
import { filled, formOf, hasColor, layout, outputErrors, outputFlagHelp, outputRun, programArguments, ui } from "./internal/human.ts";
import type { Environment, Form, OutputFlag, Ui } from "./internal/human.ts";
import { MESSAGES, PROGRAM_FLAGS, RESERVED_FLAGS } from "./internal/output.generated.ts";
import * as Session from "./Session.ts";

export { formOf, layout } from "./internal/human.ts";
export type { Environment, Form, OutputFlag, Ui } from "./internal/human.ts";

/** The human form of the output. Without it, the command line writes JSON only, and takes no output flag. */
export interface Output {
  /**
   * The flags that choose the form. They can be anywhere in the arguments. When the arguments give more than one, the
   * last one wins.
   */
  readonly flags?: readonly OutputFlag[] | undefined;
  /**
   * The form when the arguments give no output flag. The default is `"json"`. `"auto"` is the human form when standard
   * output is a terminal and no CI and no coding agent is detected (see `formOf`), and JSON in all other cases.
   */
  readonly default?: "auto" | "json" | undefined;
  /**
   * How the human form writes the outcomes of some capabilities and the occurrences of some events. Make each one with
   * `App.format`. Without a format, the human form writes the generic layout of the value. `command` throws if two
   * formats have the same id, or if the id of a format is not in the view of `target`.
   */
  readonly formats?: readonly App.Format[] | undefined;
}

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
   * each one must not be `call`, `list`, `watch`, the name of another command of the application, the first word of a
   * command alias, or the first word of the command of a capability (spec/bindings/cli.md#commands).
   */
  readonly commands?: Commands | undefined;
  /**
   * The HTTP binding of the application on a server (spec/bindings/cli.md#server), from `Http.client`. With it, the
   * command line sends each call, the availability of `list` and each subscription of `watch` to that server, and opens
   * no session in this process. The commands still come from the view of `target` in this program. Serve the HTTP
   * binding with the same target, so that both have the same view.
   */
  readonly remote?: Http.Client | undefined;
  /**
   * The human form of the output: its flags, its default and its formats. Without it, the command line writes JSON
   * only. `command` throws if the name of an output flag is not valid, is in two output flags, or is the name of
   * another flag: `--help`, `--version`, `--cursor`, `--max-age-ms`, a flag alias, or a flag of the input of a
   * capability or an event of the view.
   */
  readonly output?: Output | undefined;
}

/**
 * Standard output, and the environment of the process, that decide the form of the output under `default: "auto"`
 * of `Output`, and the layout of the JSON form: one line, or many lines with an indent of 2 on a terminal. The
 * default is no terminal, so the form is JSON on one line. `NodeCli` gives the ones of the process.
 */
export interface Terminal {
  readonly stdoutIsTerminal: boolean;
  readonly environment: Environment;
}

export const Terminal = Context.Reference<Terminal>("@acid-cat/core-effect/Cli/Terminal", {
  defaultValue: () => ({ stdoutIsTerminal: false, environment: {} }),
});

interface Presentation {
  readonly form: Form;
  readonly ui: Ui;
}

const Presentation = Context.Reference<Presentation>("@acid-cat/core-effect/Cli/Presentation", { defaultValue: () => ({ form: "json", ui: ui(false) }) });

const writeJson = (value: unknown) =>
  Effect.gen(function* () {
    const { stdoutIsTerminal } = yield* Terminal;
    yield* Console.log(stdoutIsTerminal ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  });

/**
 * The form of the output that the arguments and `Options.output` choose. A command of the application reads it to
 * write in the same form. Without `Options.output`, it is `"json"`.
 */
export const outputForm: Effect.Effect<Form> = Effect.gen(function* () {
  return (yield* Presentation).form;
});

interface OutputSettings {
  readonly output: Output;
  readonly commands: readonly string[];
}

const OutputSettings = Context.Reference<OutputSettings | undefined>("@acid-cat/core-effect/Cli/Output", { defaultValue: () => undefined });

interface AliasEntry {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly default: boolean;
  readonly flags: readonly string[];
}

/**
 * The help of a capability or an event, or the command list of a shared prefix (spec/bindings/cli.md#commands). The
 * help formatter writes it in place of the help of `effect/cli`.
 */
const HelpText = Context.Reference<string | undefined>("@acid-cat/core-effect/Cli/HelpText", { defaultValue: () => undefined });

const Aliases = Context.Reference<ReadonlyArray<AliasEntry>>("@acid-cat/core-effect/Cli/Aliases", { defaultValue: () => [] });

const pathKey = (words: readonly string[]): string => words.join(" ");

const SharedPrefixes = Context.Reference<ReadonlySet<string>>("@acid-cat/core-effect/Cli/SharedPrefixes", { defaultValue: () => new Set() });

const CommandPaths = Context.Reference<ReadonlyArray<ReadonlyArray<string>>>("@acid-cat/core-effect/Cli/CommandPaths", { defaultValue: () => [] });

const ApplicationCommands = Context.Reference<ReadonlySet<string>>("@acid-cat/core-effect/Cli/ApplicationCommands", { defaultValue: () => new Set() });

/**
 * `effect/cli` reads a flag alias such as `--on` as a flag, never as a command, and the arguments of a process cannot
 * contain NUL, so no user can give this name.
 */
const aliasSubcommandName = (name: string): string => `\u0000${name}`;

const withoutAliasMarks = (text: string): string => text.replaceAll("\u0000", "");

/** The formatter of `effect/cli` escapes the NUL of a command in an error, so the command loses it before. */
const withoutAliasMarksIn = (error: CliError.CliError): CliError.CliError =>
  error._tag === "UnrecognizedOption" && error.command !== undefined
    ? new CliError.UnrecognizedOption({ option: error.option, suggestions: error.suggestions, command: error.command.map(withoutAliasMarks) })
    : error;

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
const usageErrorsOnStderr = (isSharedPrefix: (commandPath: readonly string[]) => boolean): CliOutput.Presenter => ({
  present: (event) =>
    event._tag === "InvalidInvocation"
      ? Effect.gen(function* () {
          const formatter = yield* CliOutput.Formatter;
          yield* Console.error(formatter.formatHelpDoc(event.helpDoc));
          if (!isSharedPrefix(event.commandPath)) yield* Console.error(formatter.formatErrors(event.errors));
        })
      : event._tag === "Help" && event.reason === "Implicit"
        ? Effect.gen(function* () {
            const usage = parentUsageError(event.commandPath);
            if (usage === undefined) return yield* CliOutput.defaultPresenter.present(event);
            const formatter = yield* CliOutput.Formatter;
            yield* Console.error(formatter.formatHelpDoc(event.helpDoc));
            if (Context.get(event.helpDoc.annotations, HelpText) === undefined) yield* Console.error(usage.message);
          })
        : CliOutput.defaultPresenter.present(event),
});

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
 * code with `exitCodeOf`. Other failures of the command stay in the error channel. Standard output carries only the
 * outcomes, so the logs and the usage errors go to standard error.
 *
 * When the first one or two arguments are the name of an alias (spec/bindings/cli.md#aliases), and do not start with
 * the path of a command, the subcommand of the alias makes the call or the subscription, and `<alias> --help` writes
 * the usage of the alias. With a default alias, the program runs it when there is no argument, or when the first
 * argument starts with `--` and is not a flag alias or a global flag: then all the arguments are its flags. The help of
 * the root command ends with the aliases. The program stops with a defect when it starts if the name of a flag alias,
 * or of a flag of the default alias, is the name of a global flag: a flag of `effect/cli`, such as `--log-level`, or a
 * flag of the application. A `--` after the first argument is an argument, but a command of the application gets its
 * arguments unchanged.
 */
export const runCommand = <Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  options: { readonly version: string },
): Effect.Effect<void | number, Exclude<E, CliError.CliError>, R | Command.Environment> => {
  const aliases = Context.get(command.annotations, Aliases);
  const paths = Context.get(command.annotations, CommandPaths);
  const settings = Context.get(command.annotations, OutputSettings);
  const claimed = new Set(settings?.output.flags?.flatMap(({ names }) => names) ?? []);
  const sharedPrefixes = Context.get(command.annotations, SharedPrefixes);
  const isSharedPrefix = (commandPath: readonly string[]) => sharedPrefixes.has(pathKey(commandPath.slice(1)));
  const isInvalidSharedPrefix = (error: CliError.CliError) => error._tag === "ShowHelp" && error.errors.length > 0 && isSharedPrefix(error.commandPath);
  const applicationCommands = Context.get(command.annotations, ApplicationCommands);
  const dispatch = (given: readonly string[]) =>
    Effect.gen(function* () {
    const runWith = Command.runWith(command, { version: options.version });
    const { builtIns } = yield* CliConfig.CliConfig;
    const args = startsApplicationCommand(command, builtIns, applicationCommands, given) ? given : dashesAsArguments(given);
    if (aliases.length === 0) return yield* runWith(args);
    const taken = new Set(globalFlagsOfEveryCommand(command, builtIns).flatMap(flagNames));
    const clash = aliases.find(({ name }) => name.startsWith("--") && taken.has(name.slice(2)));
    if (clash !== undefined) return yield* Effect.die(new Error(`The alias ${clash.name} has the name of a flag of the command line.`));
    const fallback = aliases.find((alias) => alias.default);
    const shadowed = fallback?.flags.find((flag) => taken.has(flag));
    if (fallback !== undefined && shadowed !== undefined) {
      return yield* Effect.die(new Error(`The default alias ${fallback.name} has the flag --${shadowed}, which is a flag of the command line.`));
    }
    const runAlias = (alias: AliasEntry, rest: readonly string[]) =>
      rest.includes("--help") || rest.includes("-h") ? Console.log(cliHelp(alias.usage, alias.description)) : runWith([aliasSubcommandName(alias.name), ...rest]);
    const named = cliAliasOfArgs(aliases, paths, args);
    if (named !== undefined && "unknownCommand" in named) {
      yield* Console.error(`There is no command ${named.unknownCommand.join(" ")}.`);
      process.exitCode = CLI_EXIT_CODES["unknown-capability"];
      return;
    }
    if (named !== undefined) return yield* runAlias(named.alias, named.rest);
    const [first] = args;
    const startsDefault = first === undefined || (first.startsWith("--") && !taken.has(longFlagName(first)));
    if (fallback !== undefined && startsDefault) return yield* runAlias(fallback, args);
    return yield* runWith(args);
  });
  const program = Effect.gen(function* () {
    const args = yield* (yield* Stdio.Stdio).args;
    if (settings === undefined) return yield* dispatch(programArguments(args));
    const { output, commands } = settings;
    const { builtIns } = yield* CliConfig.CliConfig;
    const clashes = outputErrors(output.flags ?? [], flagsOfCommandLine(command, builtIns));
    if (clashes.length > 0) return yield* Effect.die(new Error(clashes.join("\n")));
    const terminal = yield* Terminal;
    const chosen = outputRun(output.flags ?? [], args, commands, output.default, () => formOf(terminal.stdoutIsTerminal, terminal.environment));
    if (chosen.exitCode !== undefined) {
      yield* Console.error(chosen.error);
      process.exitCode = chosen.exitCode;
      return;
    }
    const { form } = chosen;
    const presentation: Presentation = { form, ui: ui(hasColor(form, terminal.stdoutIsTerminal, terminal.environment)) };
    return yield* Effect.provideService(dispatch(chosen.args), Presentation, presentation);
  });
  return Effect.catchIf(
    program,
    CliError.isCliError,
    (error) => Effect.sync(() => (process.exitCode = isInvalidSharedPrefix(error) ? CLI_EXIT_CODES["unknown-capability"] : exitCodeOf(error))),
    Effect.fail,
  ).pipe(
    Effect.updateService(
      CliOutput.Formatter,
      (formatter): CliOutput.Formatter => ({
        formatHelpDoc: (doc) => Context.get(doc.annotations, HelpText) ?? withOutputFlags(withAliases(withoutAliasMarks(formatter.formatHelpDoc(withoutClaimedAliases(doc, claimed))), doc), doc),
        formatCliError: (error) => formatter.formatCliError(withoutAliasMarksIn(error)),
        formatError: (error) => formatter.formatError(error),
        formatVersion: (name, version) => formatter.formatVersion(name, version),
        formatErrors: (errors) => formatter.formatErrors(errors.map(withoutAliasMarksIn)),
      }),
    ),
    Effect.provideService(Logger.LogToStderr, true),
    Effect.provideService(CliOutput.Presenter, usageErrorsOnStderr(isSharedPrefix)),
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

function startsApplicationCommand(command: Command.Command.Any, builtIns: BuiltIns, applicationCommands: ReadonlySet<string>, args: readonly string[]): boolean {
  const root = CommandSpec.resolve(command, [command.name], { builtIns });
  const names = new Set(Option.isNone(root) ? [] : root.value.subcommands.flatMap(({ name, alias }) => (alias === undefined ? [name] : [name, alias])));
  const head = args.find((arg) => names.has(arg));
  return head !== undefined && applicationCommands.has(head);
}

/**
 * `effect/cli` reads a `--` as the end of the flags (spec/bindings/cli.md: after the first argument, it is an
 * argument). A `--` after a long flag with no value becomes the value of the flag. For any other `--`, a second `--`
 * goes before it, so that `effect/cli` reads it as a positional argument.
 */
function dashesAsArguments(args: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const [index, arg] of args.entries()) {
    const previous = result.at(-1);
    if (arg !== "--") result.push(arg);
    else if (previous !== undefined && previous.startsWith("--") && previous.length > 2 && !previous.includes("=")) result[result.length - 1] = `${previous}=--`;
    else return [...result, "--", ...args.slice(index)];
  }
  return result;
}

const ACTIONS_OF_THE_ROOT = new Set(PROGRAM_FLAGS.map((flag) => flag.slice("--".length)));

function flagsOfCommandLine(command: Command.Command.Any, builtIns: BuiltIns): ReadonlyMap<string, string> {
  const flags = globalFlagsOfEveryCommand(command, builtIns).filter(({ name }) => !ACTIONS_OF_THE_ROOT.has(name));
  return new Map(flags.flatMap(flagNames).map((name) => [name.length === 1 ? `-${name}` : `--${name}`, "a flag of the command line"]));
}

function withoutClaimedAliases(doc: HelpDoc.HelpDoc, claimed: ReadonlySet<string>): HelpDoc.HelpDoc {
  if (doc.globalFlags === undefined || claimed.size === 0) return doc;
  return { ...doc, globalFlags: doc.globalFlags.map((flag) => ({ ...flag, aliases: flag.aliases.filter((alias) => !claimed.has(alias)) })) };
}

function withOutputFlags(help: string, doc: { readonly annotations: Context.Context<never> }): string {
  const flags = Context.get(doc.annotations, OutputSettings)?.output.flags ?? [];
  if (flags.length === 0) return help;
  return [help, "", "OUTPUT FLAGS", ...flags.map((flag) => `  ${outputFlagHelp(flag)}`)].join("\n");
}

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

  const formats = new Map<string, App.Format>();
  for (const format of options.output?.formats ?? []) {
    if (formats.has(format.id)) throw new Error(`There are two formats for ${format.id}.`);
    const members = format.member === "event" ? (catalogView.events ?? {}) : catalogView.capabilities;
    if (ownMember(members, format.id) === undefined) throw new Error(`The format of ${format.id} refers to a ${format.member} that is not in the view of the target ${target}.`);
    formats.set(format.id, format);
  }

  const print = (id: string, outcome: Outcome<unknown, unknown>) =>
    Effect.gen(function* () {
      const { form, ui } = yield* Presentation;
      if (isCallFailure(outcome)) yield* writeCallFailure(outcome);
      else if (form === "json") yield* writeJson(outcome.ok ? outcome.value : outcome.error);
      else if (outcome.ok) yield* writeText(humanValue(formats.get(id), outcome.value, ui));
      else yield* writeText(humanFailure(formats.get(id), outcome.error, ui));
      process.exitCode = cliExitCode(outcome);
    });

  const cancelledByInterrupt = Effect.onInterrupt(() => printFailure({ kind: "cancelled", message: "The call was cancelled." }, CLI_EXIT_CODES.cancelled));

  const invoke = (id: string, input: unknown) =>
    Effect.scoped(Effect.flatMap(view, (provider) => provider.invoke(id, input))).pipe(
      Effect.flatMap((outcome) => print(id, outcome)),
      cancelledByInterrupt,
    );

  const flagsOf = (input: JsonObject | undefined) => flagsOfBundled(cliInputSchema(input ?? { type: "object" }, types));

  const flagsOfBundled = (schema: JsonObject) => {
    const properties = schemasIn(schema.properties);
    const required = new Set(isStrings(schema.required) ? schema.required : []);
    const definitions = isJsonObject(schema.$defs) ? schema.$defs : {};
    return Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [name, flagFor(name, cliResolve(property, definitions), definitions, required.has(name))]),
    );
  };

  const usageOf = (id: string, input: JsonObject | undefined) => cliUsage(options.name, id, input === undefined ? undefined : cliInputSchema(input, types));
  const usages = Object.entries(catalogView.capabilities).map(([id, capability]) => ({ id, usage: usageOf(id, capability.input) }));

  const leaves = Object.entries(catalogView.capabilities).map(([id, capability]) => {
    const flags = flagsOf(capability.input);
    const path = commandPath(id);
    const name = path.at(-1);
    if (name === undefined) throw new Error(`The capability id ${id} has no words.`);
    const leaf: AppCommand<R> = Command.make(name, flags, (parsed: Record<string, unknown>) => invoke(id, inputFrom(parsed))).pipe(
      Command.withDescription(capability.description),
      Command.annotate(HelpText, cliHelp(usageOf(id, capability.input), capability.description)),
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
            if (ownMember(catalogView.capabilities, id) === undefined) return yield* print(id, { kind: "unknown-capability", message: `There is no capability ${id}.` });
            const provider = yield* view;
            const availability = yield* Effect.result(provider.availability([id]));
            if (availability._tag === "Failure") return yield* print(id, availability.failure);
            const [state] = availability.success;
            if (state !== undefined && !state.available) return yield* print(id, { kind: "unavailable", message: state.reason });
            return yield* print(id, { kind: "invalid-input", message: "The input is not JSON." });
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
        if (availability._tag === "Failure") return yield* print("", availability.failure);
        if ((yield* Presentation).form === "human") {
          const listed = capabilities.map(([id, capability], index) => {
            const state = availability.success[index];
            const reason = state === undefined || state.available ? "" : ` (unavailable: ${state.reason})`;
            return [commandPath(id).join(" "), `${capability.description}${reason}`] as const;
          });
          const events = Object.entries(catalogView.events ?? {}).map(([id, event]) => [`watch ${id}`, event.description] as const);
          return yield* Console.log([...section("Capabilities", listed), ...(events.length === 0 ? [] : section("Events", events))].join("\n"));
        }
        const entries = [];
        for (const [index, [id, capability]] of capabilities.entries()) {
          const aliases = aliasUsages("capability", id);
          entries.push({
            kind: "capability",
            id,
            description: capability.description,
            ...availability.success[index],
            usage: usageOf(id, capability.input),
            ...(aliases.length > 0 ? { aliases } : {}),
          });
        }
        for (const [id, event] of Object.entries(catalogView.events ?? {})) {
          const usage = cliEventUsage(options.name, id, event.input === undefined ? undefined : cliInputSchema(event.input, types));
          const usages = aliasUsages("event", id);
          entries.push({ kind: "event", id, description: event.description, usage, ...(usages.length > 0 ? { aliases: usages } : {}) });
        }
        yield* writeJson(entries);
      }),
    ).pipe(cancelledByInterrupt),
  ).pipe(Command.withDescription("List the capabilities, with their availability, and the events."));

  const follow = (id: string, input: unknown, resume: Resume) =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* view;
        const started = yield* Effect.result(provider.subscribe(id, input, resume));
        if (started._tag === "Failure") return yield* printFailure(started.failure, CLI_EXIT_CODES[started.failure.kind]);
        const { form, ui } = yield* Presentation;
        const write = (occurrence: Occurrence) =>
          form === "json"
            ? Console.log(JSON.stringify(occurrence))
            : writeText([...(occurrence.truncated === true ? [LOST] : []), humanValue(formats.get(id), occurrence.data, ui)].join("\n"));
        const ended = yield* Effect.result(Stream.runForEach(started.success, write));
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
      if (name in properties) throw new Error(filled(MESSAGES.resumeProperty, { id, flag: name }));
    }
    const help = cliHelp(cliEventUsage(options.name, id, schema), event.description);
    return followCommand(id, id, schema, undefined, (made) => made.pipe(Command.withDescription(event.description), Command.annotate(HelpText, help)));
  });
  const watch = Command.make("watch").pipe(
    Command.withDescription(
      options.output === undefined
        ? "Follow an event by its id. Each occurrence goes to standard output as one line of JSON."
        : "Follow an event by its id. Each occurrence goes to standard output, as one line of JSON or in the human form.",
    ),
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
    const finish: Finish = (made) => made.pipe(Command.withDescription(described.description), Command.unlisted);
    const name = aliasSubcommandName(alias.name);
    const subcommand =
      alias.kind === "event"
        ? followCommand(name, alias.id, schema, alias.input, finish)
        : schema !== undefined && schema.properties === undefined
          ? finish(Command.make(name, jsonInput, ({ input }) => invokeJson(alias.id, input)))
          : finish(Command.make(name, flagsOfBundled(schema ?? { type: "object" }), (parsed: Record<string, unknown>) => invoke(alias.id, { ...alias.input, ...inputFrom(parsed) })));
    return { kind: alias.kind, id: alias.id, entry, subcommand };
  });

  const reserved = new Set<string>(CLI_GENERIC_COMMANDS);
  const taken = new Set(reserved);
  for (const { path } of leaves) {
    const [first] = path;
    if (first === undefined) continue;
    if (reserved.has(first)) throw new Error(filled(MESSAGES.genericCommand, { command: path.join(" ") }));
    taken.add(first);
  }
  // A shared prefix is a command that only contains other commands (`spec/bindings/cli.md`), so the path of a capability
  // must not be the start of the path of another capability.
  for (const { path } of leaves) {
    const longer = leaves.find((other) => other.path.length > path.length && path.every((word, index) => other.path[index] === word));
    if (longer !== undefined) {
      throw new Error(filled(MESSAGES.sharedPrefix, { command: path.join(" "), longer: longer.path.join(" ") }));
    }
  }
  for (const { name } of aliases) taken.add(name.split(" ")[0] ?? name);
  const errors = outputErrors(options.output?.flags ?? [], takenFlags(catalogView, aliases));
  if (errors.length > 0) throw new Error(errors.join("\n"));
  for (const added of options.commands ?? []) {
    if (taken.has(added.name)) throw new Error(`The command ${added.name} of the application has the same name as another command.`);
    taken.add(added.name);
  }

  return Command.make(options.name).pipe(
    Command.withDescription(options.description ?? app.description ?? app.title ?? options.name),
    Command.withSubcommands([call, list, watch, ...group(leaves, [], usages), ...aliasCommands.map(({ subcommand }) => subcommand), ...(options.commands ?? [])]),
    Command.annotate(
      Aliases,
      aliasCommands.map(({ entry }) => entry),
    ),
    Command.annotate(SharedPrefixes, new Set(leaves.flatMap(({ path }) => path.slice(1).map((_, index) => pathKey(path.slice(0, index + 1)))))),
    Command.annotate(
      CommandPaths,
      leaves.map(({ path }) => path),
    ),
    Command.annotate(ApplicationCommands, new Set((options.commands ?? []).map(({ name }) => name))),
    Command.annotate(OutputSettings, options.output === undefined ? undefined : { output: options.output, commands: (options.commands ?? []).map(({ name }) => name) }),
  );
}

function takenFlags(view: CatalogDocument, aliases: ReadonlyArray<{ readonly name: string }>): ReadonlyMap<string, string> {
  const taken = new Map<string, string>();
  const take = (name: string, what: string) => {
    if (!taken.has(name)) taken.set(name, what);
  };
  for (const [name, what] of RESERVED_FLAGS) take(name, what);
  for (const { name } of aliases) if (name.startsWith("--")) take(name, `the flag alias ${name}`);
  const types = view.$defs ?? {};
  const members = [
    ...Object.entries(view.capabilities).map(([id, { input }]) => ({ member: "capability", id, input })),
    ...Object.entries(view.events ?? {}).map(([id, { input }]) => ({ member: "event", id, input })),
  ];
  for (const { member, id, input } of members) {
    const properties = input === undefined ? {} : schemasIn(cliInputSchema(input, types).properties);
    for (const property of Object.keys(properties)) take(`--${property}`, `a flag of the ${member} ${id}`);
  }
  return taken;
}

interface Leaf<R> {
  readonly path: readonly string[];
  readonly leaf: AppCommand<R>;
}

function group<R>(leaves: readonly Leaf<R>[], prefix: readonly string[], usages: readonly { readonly id: string; readonly usage: string }[]): AppCommand<R>[] {
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
    const path = [...prefix, word];
    commands.push(
      Command.make(word).pipe(
        Command.withDescription(`The ${path.join(".")} capabilities.`),
        Command.withSubcommands(group(children, path, usages)),
        Command.annotate(HelpText, cliCommandList(path, usages)),
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

const writeCallFailure = (failure: CallFailure) =>
  Effect.gen(function* () {
    const { form, ui } = yield* Presentation;
    yield* Console.error(form === "json" ? JSON.stringify({ kind: failure.kind, message: failure.message }) : `${ui.error("error")} (${failure.kind}): ${failure.message}`);
  });

const printFailure = (failure: CallFailure, code: number) =>
  Effect.gen(function* () {
    yield* writeCallFailure(failure);
    process.exitCode = code;
  });

const LOST = "(some occurrences were lost)";

const writeText = (text: string) => (text === "" ? Effect.void : Console.log(text));

function section(title: string, rows: readonly (readonly [string, string])[]): readonly string[] {
  const width = Math.max(...rows.map(([first]) => first.length));
  return [title, ...rows.map(([first, text]) => `  ${first.padEnd(width)}  ${text}`.trimEnd())];
}

const humanValue = (format: App.Format | undefined, json: unknown, ui: Ui): string =>
  json === null ? "" : formatted(json, format?.schema, format?.value, ui);

function humanFailure(format: App.Format | undefined, json: unknown, ui: Ui): string {
  const tag = Predicate.hasProperty(json, "_tag") && typeof json._tag === "string" ? json._tag : undefined;
  const formatter = tag === undefined ? undefined : format?.failures?.[tag];
  const schemas = format?.failureSchemas ?? [];
  const tagged = (formatter === undefined ? undefined : (failure: unknown, ui: Ui) => {
    if (!Predicate.hasProperty(failure, "_tag") || failure._tag !== tag) throw new Error(`The failure does not decode to the tag ${tag}.`);
    return formatter(failure, ui);
  });
  return formatted(json, schemas.length === 0 ? undefined : Schema.Union(schemas), tagged, ui);
}

function formatted(json: unknown, schema: AnySchema | undefined, formatter: ((value: unknown, ui: Ui) => string) | undefined, ui: Ui): string {
  if (formatter === undefined) return layout(json);
  const decoded = schema === undefined ? Exit.succeed(json) : Schema.decodeUnknownExit(schema)(json);
  if (Exit.isFailure(decoded)) return layout(json);
  try {
    return formatter(decoded.value, ui);
  } catch {
    return layout(json);
  }
}
