/**
 * The CLI binding (spec/bindings/cli.md): a command line made from the catalog.
 */
import {
  bundle,
  CallFailureError,
  CLI_EXIT_CODES,
  CLI_RESUME_FLAGS,
  CLI_WATCH_EXIT_CODES,
  cliEventUsage,
  cliExitCode,
  cliFlags,
  cliJsonArray,
  cliRepeatedItems,
  cliResolve,
  cliUsage,
  commandPath,
  isCallFailure,
  isJsonObject,
} from "@acid-cat/spec-ts";
import type { CallFailure, CatalogCapability, CatalogDocument, JsonObject, Outcome } from "@acid-cat/spec-ts";

import type { App, ToJsonSchema } from "./app.ts";
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
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal | undefined;
}

/** A command that the application adds to the command line. */
export interface CliCommand<Context> {
  readonly name: string;
  /** The text that the help gives for the command. */
  readonly description: string;
  /** Run the command with the arguments that come after its name. The result is the exit code. */
  run(args: readonly string[], io: CliIo & { readonly context: Context }): number | Promise<number>;
}

/** The commands of the command line itself. No other command can have their names. */
const GENERIC_COMMANDS: readonly string[] = ["call", "list", "watch"];

class UsageError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Run the command line as the main program of the process. An interrupt (`SIGINT`) cancels the call or the subscription. */
export function main<Context>(app: App<Context>, options: CliOptions<Context>): void {
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  void runCli(app, options, process.argv.slice(2), {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    signal: interrupt.signal,
  }).then((code) => {
    process.exitCode = code;
  });
}

/** Run the command line with arguments. The result is the exit code (spec/bindings/cli.md#outcomes). */
export async function runCli<Context>(app: App<Context>, options: CliOptions<Context>, args: readonly string[], io: CliIo): Promise<number> {
  const session = createSession(app, { target: options.target ?? "cli", context: options.context, toJsonSchema: options.toJsonSchema });
  const types = session.view.$defs ?? {};
  const commands = Object.keys(session.view.capabilities).map((id) => ({ id, path: commandPath(id) }));
  for (const { path } of commands) {
    if (path[0] !== undefined && GENERIC_COMMANDS.includes(path[0])) throw new Error(`The command ${path.join(" ")} has the same name as a command of the command line.`);
  }
  // A shared prefix is a command that only contains other commands (spec/bindings/cli.md), so the path of a capability
  // must not be the start of the path of another capability. Ids are unique, so no two paths are the same.
  for (const { path } of commands) {
    const longer = commands.find((other) => other.path.length > path.length && path.every((word, index) => other.path[index] === word));
    if (longer !== undefined) {
      throw new Error(`The command ${path.join(" ")} is also the start of the command ${longer.path.join(" ")}. A shared prefix only contains other commands.`);
    }
  }
  for (const [id, event] of Object.entries(session.view.events ?? {})) {
    const properties = event.input === undefined ? undefined : bundle(event.input, types).properties;
    const taken = CLI_RESUME_FLAGS.find((flag) => isJsonObject(properties) && flag in properties);
    if (taken !== undefined) throw new Error(`The input of the event ${id} has a property ${taken}, which is a flag of watch.`);
  }
  const added = options.commands ?? [];
  const taken = new Set([...GENERIC_COMMANDS, ...commands.flatMap(({ path }) => path.slice(0, 1))]);
  for (const command of added) {
    if (taken.has(command.name)) throw new Error(`The command ${command.name} of the application has the same name as another command.`);
    taken.add(command.name);
  }

  const printFailure = (failure: CallFailure) => io.stderr(JSON.stringify({ kind: failure.kind, message: failure.message }));
  const print = (outcome: Outcome<unknown, unknown>): number => {
    if (isCallFailure(outcome)) printFailure(outcome);
    else io.stdout(JSON.stringify(outcome.ok ? outcome.value : outcome.error, null, 2));
    return cliExitCode(outcome);
  };

  /** Subscribe to an event, and write each occurrence on one line (spec/bindings/cli.md#events). */
  const watch = async (rest: readonly string[]): Promise<number> => {
    const [id, ...args] = rest;
    const { flagArgs, resume } = resumeFlags(args);
    if (id === undefined) throw new UsageError("Give the id of an event.", CLI_EXIT_CODES["invalid-input"]);
    const event = session.view.events?.[id];
    let input: unknown = {};
    if (event !== undefined) {
      const schema = bundle(event.input ?? { type: "object" }, types);
      if (flagArgs.includes("--help") || flagArgs.includes("-h")) {
        io.stdout([`Usage: ${cliEventUsage(options.name, id, event.input === undefined ? undefined : schema)}`, "", event.description].join("\n"));
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
    const subscribed = await session.subscribe(id, input, { signal: io.signal, ...resume });
    if ("kind" in subscribed) return print(subscribed);
    try {
      for await (const occurrence of subscribed) io.stdout(JSON.stringify(occurrence));
    } catch (error) {
      printFailure(error instanceof CallFailureError ? { kind: error.kind, message: error.message } : { kind: "internal", message: "The event failed." });
      return CLI_WATCH_EXIT_CODES.internal;
    }
    return io.signal?.aborted === true ? CLI_WATCH_EXIT_CODES.cancelled : CLI_WATCH_EXIT_CODES.complete;
  };

  try {
    const [first, ...rest] = args;
    if (first === undefined || first === "--help" || first === "-h") {
      const description = options.description ?? app.description ?? app.title ?? options.name;
      io.stdout(help(options.name, description, commands.map(({ path }) => path.join(" ")), Object.keys(session.view.events ?? {}).length > 0, added));
      return CLI_EXIT_CODES.value;
    }
    if (first === "--version" || first === "-v") {
      io.stdout(options.version);
      return CLI_EXIT_CODES.value;
    }
    if (first === "list") {
      io.stdout(
        JSON.stringify(
          [
            ...[...session.handles.values()].map((handle) => {
            const input = viewCapability(session.view, handle.id).input;
            return {
              kind: "capability",
              id: handle.id,
              description: handle.description,
              ...handle.availability.getSnapshot(),
              usage: cliUsage(options.name, handle.id, input === undefined ? undefined : bundle(input, types)),
            };
          }),
          ...Object.entries(session.view.events ?? {}).map(([id, event]) => ({
            kind: "event",
            id,
            description: event.description,
            usage: cliEventUsage(options.name, id, event.input === undefined ? undefined : bundle(event.input, types)),
          })),
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
        const handle = session.handles.get(id);
        if (handle === undefined) return print({ kind: "unknown-capability", message: `There is no capability ${id}.` });
        const availability = handle.availability.getSnapshot();
        if (!availability.available) return print({ kind: "unavailable", message: availability.reason });
        return print({ kind: "invalid-input", message: "The input is not JSON." });
      }
      return print(await session.invoke(id, input, { signal: io.signal }));
    }
    if (first === "watch") return await watch(rest);
    const command = added.find(({ name }) => name === first);
    if (command !== undefined) return await command.run(rest, { ...io, context: options.context });

    const match = commands
      .filter(({ path }) => path.every((word, index) => args[index] === word))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (match === undefined) throw new UsageError(`There is no command ${args.filter((arg) => !arg.startsWith("-")).join(" ")}.`, CLI_EXIT_CODES["unknown-capability"]);

    const capability = viewCapability(session.view, match.id);
    const schema = bundle(capability.input ?? { type: "object" }, types);
    const flagArgs = args.slice(match.path.length);
    if (flagArgs.includes("--help") || flagArgs.includes("-h")) {
      io.stdout(usage(options.name, match.path, capability.description, schema));
      return CLI_EXIT_CODES.value;
    }
    return print(await session.invoke(match.id, parseFlags(flagArgs, schema), { signal: io.signal }));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(error.message);
    return error.exitCode;
  } finally {
    await session.dispose();
  }
}

/**
 * Take `--cursor` and `--max-age-ms` out of the arguments of `watch` (spec/bindings/cli.md#events). The result is the
 * other arguments, and the cursor and `maxAgeMs` of the subscription.
 */
function resumeFlags(args: readonly string[]): { readonly flagArgs: string[]; readonly resume: { cursor?: string; maxAgeMs?: number } } {
  const flagArgs: string[] = [];
  const resume: { cursor?: string; maxAgeMs?: number } = {};
  const remaining = args.values();
  for (const arg of remaining) {
    const [name = "", inline] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s, 2) : [];
    if (name !== "cursor" && name !== "max-age-ms") {
      flagArgs.push(arg);
      continue;
    }
    const text = inline ?? remaining.next().value;
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

/** Make the input from the flags (spec/bindings/cli.md#commands). */
function parseFlags(args: readonly string[], schema: JsonObject): Record<string, unknown> {
  const properties = objectOrEmpty(schema.properties);
  const definitions = objectOrEmpty(schema.$defs);
  const input: Record<string, unknown> = {};
  // The values of each repeated flag, in the order of the flags.
  const repeated = new Map<string, { readonly items: JsonObject; readonly values: string[] }>();
  // The loop and the value of a flag read the same iterator, so that a value is not read again as a flag.
  const remaining = args.values();
  for (const arg of remaining) {
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument ${arg}.`, CLI_EXIT_CODES["invalid-input"]);
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    const property = properties[name];
    if (property === undefined) throw new UsageError(`Unknown flag --${name}.`, CLI_EXIT_CODES["invalid-input"]);
    const type = cliResolve(objectOrEmpty(property), definitions);
    if (type.type === "boolean") {
      input[name] = inline === undefined ? true : inline === "true";
      continue;
    }
    const text = inline ?? remaining.next().value;
    if (text === undefined) throw new UsageError(`The flag --${name} needs a value.`, CLI_EXIT_CODES["invalid-input"]);
    const items = cliRepeatedItems(type, definitions);
    if (items === undefined) {
      input[name] = valueOf(name, text, type);
    } else {
      const flag = repeated.get(name) ?? { items, values: [] };
      flag.values.push(text);
      repeated.set(name, flag);
    }
  }
  // A repeated flag gives JSON text of the whole array, or one item for each occurrence.
  for (const [name, { items, values }] of repeated) {
    input[name] = cliJsonArray(values) ?? values.map((text) => valueOf(name, text, items));
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  for (const name of required) {
    if (!(name in input)) throw new UsageError(`The flag --${name} is required.`, CLI_EXIT_CODES["invalid-input"]);
  }
  return input;
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

/** A value as a JSON object, or an empty object when it is not one. */
const objectOrEmpty = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

/** The capability `id` of a view. The view has it, because the session serves it. */
function viewCapability(view: CatalogDocument, id: string): CatalogCapability {
  const capability = view.capabilities[id];
  if (capability === undefined) throw new Error(`The view of the session has no capability ${id}.`);
  return capability;
}

function help(name: string, description: string, paths: readonly string[], hasEvents: boolean, added: readonly CliCommand<unknown>[]): string {
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
  ].join("\n");
}

function usage(name: string, path: readonly string[], description: string, schema: JsonObject): string {
  return [`Usage: ${[name, ...path, ...cliFlags(schema)].join(" ")}`, "", description].join("\n");
}
