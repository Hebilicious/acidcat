import {
  CallFailureError,
  CLI_EXIT_CODES,
  CLI_GENERIC_COMMANDS,
  CLI_RESUME_FLAGS,
  CLI_WATCH_EXIT_CODES,
  cliAliases,
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
  INTERRUPT_GRACE_MS,
  isCallFailure,
  isJsonObject,
  ownMember,
  unavailable,
  viewOf,
} from "@acid-cat/spec-ts";
import type { Availability, CallFailure, CatalogCapability, CatalogDocument, CliAlias, JsonObject, Occurrence, Outcome } from "@acid-cat/spec-ts";

import { catalogOf } from "./app.ts";
import { cliFormatErrors, filled, cliLayout, cliListText, cliOutputErrors, cliOutputFlagHelp, cliOutputRun, cliUi, defaultCliOutput } from "./cli-human.ts";
import type { CliForm, CliFormat, CliOutput, CliOutputFlag, CliOutputRun, CliRender } from "./cli-human.ts";
import { MESSAGES, PROGRAM_FLAGS, RESERVED_FLAGS } from "./cli-output.generated.ts";
import type { App, ToJsonSchema } from "./app.ts";
import type { HttpClient } from "./http-client.ts";
import { createSession } from "./session.ts";

export interface CliOptions<Context> {
  readonly name: string;
  readonly version: string;
  readonly context: Context;
  readonly toJsonSchema: ToJsonSchema;
  /** The target that the command line serves. The default is `"cli"`. */
  readonly target?: string | undefined;
  /**
   * The text at the top of the help. The default is the description of the application, then its title, then `name`.
   */
  readonly description?: string | undefined;
  /**
   * The commands of the application, beside the commands of the capabilities, `call`, `list` and `watch`. The name of
   * each one must not be `call`, `list`, `watch`, the name of another command of the application, or the first word of
   * the command of a capability (spec/bindings/cli.md#commands).
   */
  readonly commands?: readonly CliCommand<Context>[] | undefined;
  /**
   * The HTTP binding of the application in another process or on another machine (spec/bindings/cli.md#server). With
   * it, the command line sends each call, the availability of `list` and each subscription of `watch` to that server.
   * The commands still come from the view of `target` in this program. Serve the HTTP binding with the same target, for
   * example `httpHandler(app, { target: "cli", … })`. The commands of the application still get `context`.
   */
  readonly remote?: HttpClient | undefined;
  /**
   * The human form of the output: its flags, its default and its formatters. Without it, the command line writes JSON
   * only. The program stops with an error when it starts if the name of an output flag is not valid, is in two output
   * flags, or is the name of another flag: `--help`, `--version`, `--cursor`, `--max-age-ms`, a flag alias, or a flag
   * of the input of a capability or an event of the view.
   */
  readonly output?: CliOutput | undefined;
}

interface Provider {
  readonly view: CatalogDocument;
  readonly availability: (signal: AbortSignal | undefined) => Promise<ReadonlyMap<string, Availability> | CallFailure>;
  readonly invoke: (id: string, input: unknown, signal: AbortSignal | undefined) => Promise<Outcome<unknown, unknown>>;
  readonly subscribe: (id: string, input: unknown, options: { readonly signal?: AbortSignal | undefined; readonly cursor?: string; readonly maxAgeMs?: number }) => Promise<AsyncIterable<Occurrence> | CallFailure>;
  readonly dispose: () => Promise<void>;
}

function localProvider<Context>(app: App<Context>, options: CliOptions<Context>): Provider {
  const session = createSession(app, { target: options.target ?? "cli", context: options.context, toJsonSchema: options.toJsonSchema });
  return {
    get view() {
      return session.view;
    },
    availability: async () => new Map([...session.handles.values()].map((handle) => [handle.id, handle.availability.getSnapshot()])),
    invoke: (id, input, signal) => session.invoke(id, input, { signal }),
    subscribe: (id, input, subscribeOptions) => session.subscribe(id, input, subscribeOptions),
    dispose: () => session.dispose(),
  };
}

function remoteProvider<Context>(app: App<Context>, options: CliOptions<Context>, client: HttpClient): Provider {
  const view = viewOf(catalogOf(app, { toJsonSchema: options.toJsonSchema }), options.target ?? "cli");
  return {
    view,
    availability: async (signal) => {
      const served = await client.capabilities({ signal });
      if ("kind" in served) return served;
      return new Map(Object.keys(view.capabilities).map((id) => [id, served.get(id) ?? unavailable("The server does not serve this capability.")]));
    },
    invoke: (id, input, signal) => client.invoke(id, input, { signal }),
    subscribe: (id, input, subscribeOptions) => client.subscribe(id, input, subscribeOptions),
    dispose: async () => undefined,
  };
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal | undefined;
  /** The form that `default: "auto"` of the option `output` gives. The default is `"json"`. */
  readonly output?: CliForm | undefined;
  /** Style the human form with ANSI colors. The default is `false`. */
  readonly color?: boolean | undefined;
}

export interface CliCommand<Context> {
  readonly name: string;
  readonly description: string;
  /**
   * Run the command with the arguments that come after its name, unchanged: the command line reads output flags only
   * before the name. `io.output` is the form that the arguments and the option `output` choose. The result is the exit
   * code.
   */
  run(args: readonly string[], io: CliIo & { readonly context: Context }): number | Promise<number>;
}

const isGenericCommand = (word: string): boolean => CLI_GENERIC_COMMANDS.some((command) => command === word);

const isHelp = (args: readonly string[]): boolean => args.includes("--help") || args.includes("-h");

const NO_FLAGS: JsonObject = { type: "object", properties: {} };

class UsageError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Run the command line as the main program of the process. An interrupt (`SIGINT`) cancels the call or the subscription.
 * If the run has not ended `INTERRUPT_GRACE_MS` after the interrupt, or at a second interrupt, the process exits with
 * code 130. The default arguments are the arguments of the process. With `default: "auto"` in the option `output`, the
 * form is human when standard output is a terminal and no CI and no coding agent is detected, and JSON in all other
 * cases.
 */
export function main<Context>(app: App<Context>, options: CliOptions<Context>, args: readonly string[] = process.argv.slice(2)): void {
  const interrupt = new AbortController();
  const onInterrupt = () => {
    if (interrupt.signal.aborted) process.exit(CLI_EXIT_CODES.cancelled);
    interrupt.abort();
    setTimeout(() => process.exit(CLI_EXIT_CODES.cancelled), INTERRUPT_GRACE_MS).unref();
  };
  process.on("SIGINT", onInterrupt);
  void runCli(app, options, args, {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    signal: interrupt.signal,
    output: defaultCliOutput(process.stdout.isTTY, process.env),
    color: process.stdout.isTTY && (process.env.NO_COLOR ?? "") === "",
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (problem: unknown) => {
      process.stderr.write(`${problem instanceof Error ? problem.message : String(problem)}\n`);
      process.exitCode = CLI_EXIT_CODES.internal;
    },
  );
}

/** Run the command line with arguments. The result is the exit code (spec/bindings/cli.md#outcomes). */
export async function runCli<Context>(app: App<Context>, options: CliOptions<Context>, argv: readonly string[], io: CliIo): Promise<number> {
  const provider = options.remote === undefined ? localProvider(app, options) : remoteProvider(app, options, options.remote);
  const view = provider.view;
  const types = view.$defs ?? {};
  const commands = Object.keys(view.capabilities).map((id) => ({ id, path: commandPath(id) }));
  for (const { path } of commands) {
    if (path[0] !== undefined && isGenericCommand(path[0])) throw new Error(filled(MESSAGES.genericCommand, { command: path.join(" ") }));
  }
  // A shared prefix is a command that only contains other commands (`spec/bindings/cli.md`), so the path of a capability
  // must not be the start of the path of another capability.
  for (const { path } of commands) {
    const longer = commands.find((other) => other.path.length > path.length && path.every((word, index) => other.path[index] === word));
    if (longer !== undefined) {
      throw new Error(filled(MESSAGES.sharedPrefix, { command: path.join(" "), longer: longer.path.join(" ") }));
    }
  }
  for (const [id, event] of Object.entries(view.events ?? {})) {
    const properties = event.input === undefined ? undefined : cliInputSchema(event.input, types).properties;
    const taken = CLI_RESUME_FLAGS.find((flag) => isJsonObject(properties) && flag in properties);
    if (taken !== undefined) throw new Error(filled(MESSAGES.resumeProperty, { id, flag: taken }));
  }
  const { aliases, default: defaultAlias, errors: aliasErrors } = cliAliases(view, options.target ?? "cli");
  if (aliasErrors.length > 0) throw new Error(aliasErrors.join("\n"));
  const usageOf = (id: string): string => {
    const input = viewCapability(view, id).input;
    return cliUsage(options.name, id, input === undefined ? undefined : cliInputSchema(input, types));
  };
  const aliasUsage = (alias: CliAlias): string => cliAliasUsage(options.name, alias, cliAliasInput(view, alias));
  const aliasUsages = (kind: CliAlias["kind"], id: string): readonly string[] =>
    aliases.filter((alias) => alias.kind === kind && alias.id === id).map(aliasUsage);

  const formats = options.output?.formats ?? [];
  const formatErrors = cliFormatErrors(formats, Object.keys(view.capabilities), Object.keys(view.events ?? {}));
  if (formatErrors.length > 0) throw new Error(formatErrors.join("\n"));
  const outputFlags = options.output?.flags ?? [];
  const outputErrors = cliOutputErrors(outputFlags, takenFlags(view, aliases));
  if (outputErrors.length > 0) throw new Error(outputErrors.join("\n"));
  const added = options.commands ?? [];
  const chosen: CliOutputRun = cliOutputRun(outputFlags, argv, added.map(({ name }) => name), options.output?.default, () => io.output ?? "json");
  const args = chosen.exitCode === undefined ? chosen.args : [];
  const output: CliForm = chosen.exitCode === undefined ? chosen.form : "json";
  const formatOf = (id: string): CliFormat | undefined => formats.find((format) => format.id === id);
  const ui = cliUi(io.color === true);
  const render = async (format: CliRender | undefined, json: unknown): Promise<string> => {
    try {
      return (await format?.(json, ui)) ?? cliLayout(json);
    } catch {
      return cliLayout(json);
    }
  };
  const show = async (format: CliRender | undefined, json: unknown): Promise<void> => {
    const text = await render(format, json);
    if (text !== "") io.stdout(text);
  };

  const taken = new Set([...CLI_GENERIC_COMMANDS, ...commands.flatMap(({ path }) => path.slice(0, 1)), ...aliases.map(({ name }) => name)]);
  for (const command of added) {
    if (taken.has(command.name)) throw new Error(`The command ${command.name} of the application has the same name as another command.`);
    taken.add(command.name);
  }

  const printFailure = (failure: CallFailure) =>
    io.stderr(output === "human" ? `${ui.error("error")} (${failure.kind}): ${failure.message}` : JSON.stringify({ kind: failure.kind, message: failure.message }));
  const printHuman = async (id: string, outcome: Exclude<Outcome<unknown, unknown>, CallFailure>): Promise<void> => {
    const format = formatOf(id);
    if (outcome.ok) {
      const value = jsonOf(outcome.value);
      if (value !== null) await show(format?.value, value);
      return;
    }
    const failure = jsonOf(outcome.error);
    const tag = isJsonObject(failure) && typeof failure._tag === "string" ? failure._tag : undefined;
    await show(tag === undefined ? undefined : format?.failures.get(tag), failure);
  };
  const print = async (outcome: Outcome<unknown, unknown>, id?: string): Promise<number> => {
    if (isCallFailure(outcome)) printFailure(outcome);
    else if (output === "human" && id !== undefined) await printHuman(id, outcome);
    else io.stdout(JSON.stringify(outcome.ok ? outcome.value : outcome.error, null, 2));
    return cliExitCode(outcome);
  };
  const invoke = async (id: string, input: unknown): Promise<number> => await print(await provider.invoke(id, input, io.signal), id);

  const printUnlessInterrupted = async (failure: CallFailure): Promise<number> => (io.signal?.aborted === true ? CLI_WATCH_EXIT_CODES.cancelled : await print(failure));

  const watch = async (rest: readonly string[]): Promise<number> => {
    const [id, ...args] = rest;
    const { flagArgs, resume } = resumeFlags(args);
    if (id === undefined) throw new UsageError("Give the id of an event.", CLI_EXIT_CODES["invalid-input"]);
    const event = view.events === undefined ? undefined : ownMember(view.events, id);
    let input: unknown = {};
    if (event !== undefined) {
      const schema = cliInputSchema(event.input ?? { type: "object" }, types);
      if (isHelp(flagArgs)) {
        io.stdout(cliHelp(cliEventUsage(options.name, id, event.input === undefined ? undefined : schema), event.description));
        return CLI_EXIT_CODES.value;
      }
      if (schema.properties !== undefined) {
        input = parseFlags(flagArgs, schema);
      } else {
        const [text = "{}", extra] = flagArgs;
        if (extra !== undefined) throw new UsageError(`Unexpected argument ${extra}.`, CLI_EXIT_CODES["invalid-input"]);
        try {
          input = JSON.parse(text);
        } catch {
          return print({ kind: "invalid-input", message: "The input is not JSON." });
        }
      }
    }
    return await follow(id, input, resume);
  };

  const follow = async (id: string, input: unknown, resume: Resume): Promise<number> => {
    const subscribed = await provider.subscribe(id, input, { signal: io.signal, ...resume });
    if ("kind" in subscribed) return printUnlessInterrupted(subscribed);
    try {
      for await (const occurrence of subscribed) {
        if (output === "json") {
          io.stdout(JSON.stringify(occurrence));
          continue;
        }
        if (occurrence.truncated === true) io.stdout("(some occurrences were lost)");
        await show(formatOf(id)?.value, jsonOf(occurrence.data));
      }
    } catch (error) {
      if (io.signal?.aborted === true) return CLI_WATCH_EXIT_CODES.cancelled;
      printFailure(error instanceof CallFailureError ? { kind: error.kind, message: error.message } : { kind: "internal", message: "The event failed." });
      return CLI_WATCH_EXIT_CODES.internal;
    }
    return io.signal?.aborted === true ? CLI_WATCH_EXIT_CODES.cancelled : CLI_WATCH_EXIT_CODES.complete;
  };

  const runAlias = async (alias: CliAlias, rest: readonly string[]): Promise<number> => {
    const entry = alias.kind === "event" ? view.events?.[alias.id] : view.capabilities[alias.id];
    if (entry === undefined) throw new Error(`The view of the session has no ${alias.kind} ${alias.id}.`);
    if (isHelp(rest)) {
      io.stdout(cliHelp(aliasUsage(alias), entry.description));
      return CLI_EXIT_CODES.value;
    }
    const { flagArgs, resume } = alias.kind === "event" ? resumeFlags(rest) : { flagArgs: rest, resume: {} };
    const run = async (input: unknown): Promise<number> =>
      alias.kind === "event" ? await follow(alias.id, input, resume) : await invoke(alias.id, input);
    const schema = cliAliasInput(view, alias) ?? NO_FLAGS;
    if (schema.properties !== undefined) return await run({ ...alias.input, ...parseFlags(flagArgs, schema) });
    const [text = "{}", extra] = flagArgs;
    if (extra !== undefined) throw new UsageError(`Unexpected argument ${extra}.`, CLI_EXIT_CODES["invalid-input"]);
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      // unavailable comes before invalid-input (spec/invocation.md#call-failures).
      if (alias.kind === "capability") {
        const availability = await provider.availability(io.signal);
        if ("kind" in availability) return print(availability);
        const state = availability.get(alias.id);
        if (state !== undefined && !state.available) return print({ kind: "unavailable", message: state.reason });
      }
      return print({ kind: "invalid-input", message: "The input is not JSON." });
    }
    return await run(input);
  };

  const argsWithDefaultAlias = (): readonly string[] => {
    const [head] = args;
    if (defaultAlias === undefined) return args;
    if (head === undefined) return [defaultAlias.name];
    const flagOfProgram = PROGRAM_FLAGS.includes(head) || aliases.some(({ name }) => name === head);
    return head.startsWith("--") && !flagOfProgram ? [defaultAlias.name, ...args] : args;
  };

  try {
    if (chosen.exitCode !== undefined) {
      io.stderr(chosen.error);
      return chosen.exitCode;
    }
    const [first, ...rest] = argsWithDefaultAlias();
    if (first === undefined || first === "--help" || first === "-h") {
      const description = options.description ?? app.description ?? app.title ?? options.name;
      const aliasLines = aliases.map((alias) => aliasUsage(alias).slice(options.name.length + 1));
      io.stdout(help(options.name, description, commands.map(({ path }) => path.join(" ")), Object.keys(view.events ?? {}).length > 0, added, aliasLines, outputFlags));
      return CLI_EXIT_CODES.value;
    }
    if (first === "--version" || first === "-v") {
      io.stdout(options.version);
      return CLI_EXIT_CODES.value;
    }
    if (first === "list") {
      const availability = await provider.availability(io.signal);
      if ("kind" in availability) return print(availability);
      if (output === "human") {
        io.stdout(
          cliListText(
            Object.entries(view.capabilities).map(([id, capability]) => {
              const state = availability.get(id) ?? unavailable("There is no such capability.");
              return { id, description: capability.description, unavailable: state.available ? undefined : state.reason };
            }),
            Object.entries(view.events ?? {}).map(([id, event]) => ({ id, description: event.description })),
          ),
        );
        return CLI_EXIT_CODES.value;
      }
      io.stdout(
        JSON.stringify(
          [
            ...Object.entries(view.capabilities).map(([id, capability]) => {
              const usages = aliasUsages("capability", id);
              return {
                kind: "capability",
                id,
                description: capability.description,
                ...(availability.get(id) ?? unavailable("There is no such capability.")),
                usage: usageOf(id),
                ...(usages.length > 0 ? { aliases: usages } : {}),
              };
            }),
          ...Object.entries(view.events ?? {}).map(([id, event]) => {
            const usages = aliasUsages("event", id);
            return {
              kind: "event",
              id,
              description: event.description,
              usage: cliEventUsage(options.name, id, event.input === undefined ? undefined : cliInputSchema(event.input, types)),
              ...(usages.length > 0 ? { aliases: usages } : {}),
            };
          }),
        ],
          null,
          2,
        ),
      );
      return CLI_EXIT_CODES.value;
    }
    if (first === "call") {
      const [id, text = "{}"] = rest;
      if (id === undefined) throw new UsageError("Give the id of a capability.", CLI_EXIT_CODES["invalid-input"]);
      let input: unknown;
      try {
        input = JSON.parse(text);
      } catch {
        // The call failures of the id come before invalid-input (spec/invocation.md#call-failures).
        if (ownMember(provider.view.capabilities, id) === undefined) return print({ kind: "unknown-capability", message: `There is no capability ${id}.` });
        const availability = await provider.availability(io.signal);
        if ("kind" in availability) return print(availability);
        const state = availability.get(id);
        if (state !== undefined && !state.available) return print({ kind: "unavailable", message: state.reason });
        return print({ kind: "invalid-input", message: "The input is not JSON." });
      }
      return await invoke(id, input);
    }
    if (first === "watch") return await watch(rest);
    const alias = aliases.find(({ name }) => name === first);
    if (alias !== undefined) return await runAlias(alias, rest);
    const command = added.find(({ name }) => name === first);
    if (command !== undefined) return await command.run(rest, { ...io, output, context: options.context });

    const match = commands
      .filter(({ path }) => path.every((word, index) => args[index] === word))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (match === undefined) {
      const usages = commands.map(({ id }) => ({ id, usage: usageOf(id) }));
      for (let length = args.length; length > 0; length--) {
        const list = cliCommandList(args.slice(0, length), usages);
        if (list === undefined) continue;
        if (!isHelp(args.slice(length))) throw new UsageError(list, CLI_EXIT_CODES["unknown-capability"]);
        io.stdout(list);
        return CLI_EXIT_CODES.value;
      }
      throw new UsageError(`There is no command ${args.filter((arg) => !arg.startsWith("-")).join(" ")}.`, CLI_EXIT_CODES["unknown-capability"]);
    }

    const capability = viewCapability(view, match.id);
    const schema = cliInputSchema(capability.input ?? { type: "object" }, types);
    const flagArgs = args.slice(match.path.length);
    if (isHelp(flagArgs)) {
      io.stdout(cliHelp(usageOf(match.id), capability.description));
      return CLI_EXIT_CODES.value;
    }
    return await invoke(match.id, parseFlags(flagArgs, schema));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(error.message);
    return error.exitCode;
  } finally {
    await provider.dispose();
  }
}

function takenFlags(view: CatalogDocument, aliases: readonly CliAlias[]): ReadonlyMap<string, string> {
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
    const properties = input === undefined ? undefined : cliInputSchema(input, types).properties;
    for (const property of Object.keys(objectOrEmpty(properties))) take(`--${property}`, `a flag of the ${member} ${id}`);
  }
  return taken;
}

const jsonOf = (value: unknown): unknown => {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
};

type Resume = { cursor?: string; maxAgeMs?: number };

function resumeFlags(args: readonly string[]): { readonly flagArgs: string[]; readonly resume: Resume } {
  const flagArgs: string[] = [];
  const resume: Resume = {};
  const flagsAndValues = args.values();
  for (const arg of flagsAndValues) {
    const [name = "", inline] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s, 2) : [];
    if (name !== "cursor" && name !== "max-age-ms") {
      flagArgs.push(arg);
      continue;
    }
    const text = inline ?? flagsAndValues.next().value;
    if (text === undefined) throw new UsageError(`The flag --${name} needs a value.`, CLI_EXIT_CODES["invalid-input"]);
    if (name === "cursor") {
      resume.cursor = text;
      continue;
    }
    const maxAgeMs = Number(text);
    if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(maxAgeMs)) throw new UsageError("The flag --max-age-ms must be a whole number of milliseconds.", CLI_EXIT_CODES["invalid-input"]);
    resume.maxAgeMs = maxAgeMs;
  }
  return { flagArgs, resume };
}

function parseFlags(args: readonly string[], schema: JsonObject): Record<string, unknown> {
  const properties = objectOrEmpty(schema.properties);
  const definitions = objectOrEmpty(schema.$defs);
  // A map, not an object, so that a flag name such as `__proto__` or `constructor` is an ordinary key.
  const input = new Map<string, unknown>();
  const repeated = new Map<string, { readonly items: JsonObject; readonly values: string[] }>();
  const flagsAndValues = args.values();
  for (const arg of flagsAndValues) {
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument ${arg}.`, CLI_EXIT_CODES["invalid-input"]);
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    const property = ownMember(properties, name);
    if (property === undefined) throw new UsageError(`Unknown flag --${name}.`, CLI_EXIT_CODES["invalid-input"]);
    const type = cliResolve(objectOrEmpty(property), definitions);
    if (type.type === "boolean") {
      input.set(name, inline === undefined ? true : inline === "true");
      continue;
    }
    const text = inline ?? flagsAndValues.next().value;
    if (text === undefined) throw new UsageError(`The flag --${name} needs a value.`, CLI_EXIT_CODES["invalid-input"]);
    const items = cliRepeatedItems(type, definitions);
    if (items === undefined) {
      input.set(name, valueOf(name, text, type));
    } else {
      const flag = repeated.get(name) ?? { items, values: [] };
      flag.values.push(text);
      repeated.set(name, flag);
    }
  }
  for (const [name, { items, values }] of repeated) {
    input.set(name, cliJsonArray(values) ?? values.map((text) => valueOf(name, text, items)));
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  for (const name of required) {
    if (!input.has(name)) throw new UsageError(`The flag --${name} is required.`, CLI_EXIT_CODES["invalid-input"]);
  }
  return Object.fromEntries(input);
}

function valueOf(name: string, text: string, type: JsonObject): unknown {
  if (Array.isArray(type.enum) && type.enum.every((value) => typeof value === "string")) {
    if (!type.enum.includes(text)) throw new UsageError(`The flag --${name} must be one of: ${type.enum.join(", ")}.`, CLI_EXIT_CODES["invalid-input"]);
    return text;
  }
  if (type.type === "integer" || type.type === "number") {
    const number = Number(text);
    if (text.trim() === "" || !Number.isFinite(number) || (type.type === "integer" && !Number.isInteger(number))) {
      throw new UsageError(`The flag --${name} must be a ${type.type}.`, CLI_EXIT_CODES["invalid-input"]);
    }
    return number;
  }
  if (type.type === "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`The flag --${name} must be JSON.`, CLI_EXIT_CODES["invalid-input"]);
  }
}

const objectOrEmpty = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

function viewCapability(view: CatalogDocument, id: string): CatalogCapability {
  const capability = ownMember(view.capabilities, id);
  if (capability === undefined) throw new Error(`The view of the session has no capability ${id}.`);
  return capability;
}

function help(
  name: string,
  description: string,
  paths: readonly string[],
  hasEvents: boolean,
  added: readonly CliCommand<unknown>[],
  aliases: readonly string[],
  outputFlags: readonly CliOutputFlag[],
): string {
  return [
    description,
    "",
    `Usage: ${name} <command> [flags]`,
    "",
    "Commands:",
    ...paths.map((path) => `  ${path}`),
    "  call <id> [input]",
    "  list",
    ...(hasEvents ? ["  watch <id> [flags] [--cursor <string>] [--max-age-ms <integer>]"] : []),
    ...added.map((command) => `  ${command.name}  ${command.description}`),
    ...(aliases.length > 0 ? ["", "Aliases:", ...aliases.map((alias) => `  ${alias}`)] : []),
    ...(outputFlags.length > 0 ? ["", "Output:", ...outputFlags.map((flag) => `  ${cliOutputFlagHelp(flag)}`)] : []),
  ].join("\n");
}
