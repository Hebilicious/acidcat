/**
 * The CLI binding (spec/bindings/cli.md): a command line made from the catalog.
 */
import { bundle, CLI_EXIT_CODES, cliExitCode, cliFlags, cliUsage, commandPath, isCallFailure, isJsonObject, REFERENCE } from "@acid-cat/spec-ts";
import type { CatalogCapability, CatalogDocument, JsonObject, Outcome } from "@acid-cat/spec-ts";

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
   * The commands of the application, beside the commands of the capabilities, `call` and `list`. The name of each one
   * must not be `call`, `list`, the name of another command of the application, or the first word of the command of a
   * capability (spec/bindings/cli.md#commands).
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

class UsageError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Run the command line as the main program of the process. An interrupt (`SIGINT`) cancels the call. */
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
    if (path[0] === "call" || path[0] === "list") throw new Error(`The command ${path.join(" ")} has the same name as a command of the command line.`);
  }
  const added = options.commands ?? [];
  const taken = new Set(["call", "list", ...commands.flatMap(({ path }) => path.slice(0, 1))]);
  for (const command of added) {
    if (taken.has(command.name)) throw new Error(`The command ${command.name} of the application has the same name as another command.`);
    taken.add(command.name);
  }

  const print = (outcome: Outcome<unknown, unknown>): number => {
    if (isCallFailure(outcome)) io.stderr(JSON.stringify({ kind: outcome.kind, message: outcome.message }));
    else io.stdout(JSON.stringify(outcome.ok ? outcome.value : outcome.error, null, 2));
    return cliExitCode(outcome);
  };

  try {
    const [first, ...rest] = args;
    if (first === undefined || first === "--help" || first === "-h") {
      const description = options.description ?? app.description ?? app.title ?? options.name;
      io.stdout(help(options.name, description, commands.map(({ path }) => path.join(" ")), added));
      return CLI_EXIT_CODES.value;
    }
    if (first === "--version" || first === "-v") {
      io.stdout(options.version);
      return CLI_EXIT_CODES.value;
    }
    if (first === "list") {
      io.stdout(
        JSON.stringify(
          [...session.handles.values()].map((handle) => {
            const input = viewCapability(session.view, handle.id).input;
            return {
              id: handle.id,
              description: handle.description,
              ...handle.availability.getSnapshot(),
              usage: cliUsage(options.name, handle.id, input === undefined ? undefined : bundle(input, types)),
            };
          }),
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
        return print({ kind: "invalid-input", message: "The input is not JSON." });
      }
      return print(await session.invoke(id, input, { signal: io.signal }));
    }
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

/** Make the input from the flags (spec/bindings/cli.md#commands). */
function parseFlags(args: readonly string[], schema: JsonObject): Record<string, unknown> {
  const properties = objectOrEmpty(schema.properties);
  const definitions = objectOrEmpty(schema.$defs);
  const input: Record<string, unknown> = {};
  // The loop and the value of a flag read the same iterator, so that a value is not read again as a flag.
  const remaining = args.values();
  for (const arg of remaining) {
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument ${arg}.`, CLI_EXIT_CODES["invalid-input"]);
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    const property = properties[name];
    if (property === undefined) throw new UsageError(`Unknown flag --${name}.`, CLI_EXIT_CODES["invalid-input"]);
    const type = resolve(objectOrEmpty(property), definitions);
    if (type.type === "boolean") {
      input[name] = inline === undefined ? true : inline === "true";
      continue;
    }
    const text = inline ?? remaining.next().value;
    if (text === undefined) throw new UsageError(`The flag --${name} needs a value.`, CLI_EXIT_CODES["invalid-input"]);
    input[name] = valueOf(name, text, type);
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

function resolve(property: JsonObject, definitions: JsonObject): JsonObject {
  const name = typeof property.$ref === "string" ? REFERENCE.exec(property.$ref)?.[1] : undefined;
  return name === undefined ? property : objectOrEmpty(definitions[name] ?? property);
}

/** A value as a JSON object, or an empty object when it is not one. */
const objectOrEmpty = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

/** The capability `id` of a view. The view has it, because the session serves it. */
function viewCapability(view: CatalogDocument, id: string): CatalogCapability {
  const capability = view.capabilities[id];
  if (capability === undefined) throw new Error(`The view of the session has no capability ${id}.`);
  return capability;
}

function help(name: string, description: string, paths: readonly string[], added: readonly CliCommand<unknown>[]): string {
  return [
    description,
    "",
    `Usage: ${name} <command> [flags]`,
    "",
    "Commands:",
    ...paths.map((path) => `  ${path}`),
    "  call <id> [input]",
    "  list",
    ...added.map((command) => `  ${command.name}  ${command.description}`),
  ].join("\n");
}

function usage(name: string, path: readonly string[], description: string, schema: JsonObject): string {
  return [`Usage: ${[name, ...path, ...cliFlags(schema)].join(" ")}`, "", description].join("\n");
}
