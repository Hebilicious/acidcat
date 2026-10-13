/**
 * The CLI binding (spec/bindings/cli.md): a command line made from the catalog.
 */
import { bundle, CLI_EXIT_CODES, cliExitCode, commandPath, isCallFailure, REFERENCE } from "@acid-cat/spec";
import type { JsonObject, Outcome } from "@acid-cat/spec";

import type { App, ToJsonSchema } from "./app.ts";
import { createSession } from "./session.ts";

export interface CliOptions<Context> {
  readonly name: string;
  readonly version: string;
  readonly context: Context;
  readonly toJsonSchema: ToJsonSchema;
  /** The target that the command line serves. The default is `"cli"`. */
  readonly target?: string | undefined;
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal | undefined;
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

  const print = (outcome: Outcome<unknown, unknown>): number => {
    if (isCallFailure(outcome)) io.stderr(JSON.stringify({ kind: outcome.kind, message: outcome.message }));
    else io.stdout(JSON.stringify(outcome.ok ? outcome.value : outcome.error, null, 2));
    return cliExitCode(outcome);
  };

  try {
    const [first, ...rest] = args;
    if (first === undefined || first === "--help" || first === "-h") {
      io.stdout(help(options.name, commands.map(({ path }) => path.join(" "))));
      return CLI_EXIT_CODES.value;
    }
    if (first === "--version" || first === "-v") {
      io.stdout(options.version);
      return CLI_EXIT_CODES.value;
    }
    if (first === "list") {
      io.stdout(
        JSON.stringify(
          [...session.handles.values()].map((handle) => ({
            id: handle.id,
            description: handle.description,
            ...handle.availability.getSnapshot(),
            usage: `${options.name} ${commandPath(handle.id).join(" ")}`,
          })),
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

    const match = commands
      .filter(({ path }) => path.every((word, index) => args[index] === word))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (match === undefined) throw new UsageError(`There is no command ${args.filter((arg) => !arg.startsWith("-")).join(" ")}.`, CLI_EXIT_CODES["unknown-capability"]);

    const capability = session.view.capabilities[match.id]!;
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
  const properties = (schema.properties ?? {}) as { readonly [name: string]: JsonObject };
  const definitions = (schema.$defs ?? {}) as { readonly [name: string]: JsonObject };
  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument ${arg}.`, CLI_EXIT_CODES["invalid-input"]);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const property = properties[name];
    if (property === undefined) throw new UsageError(`Unknown flag --${name}.`, CLI_EXIT_CODES["invalid-input"]);
    const type = resolve(property, definitions);
    if (type.type === "boolean") {
      input[name] = inline === undefined ? true : inline === "true";
      continue;
    }
    const text = inline ?? args[(index += 1)];
    if (text === undefined) throw new UsageError(`The flag --${name} needs a value.`, CLI_EXIT_CODES["invalid-input"]);
    input[name] = valueOf(name, text, type);
  }
  for (const name of (schema.required ?? []) as readonly string[]) {
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

function resolve(property: JsonObject, definitions: { readonly [name: string]: JsonObject }): JsonObject {
  const name = typeof property.$ref === "string" ? REFERENCE.exec(property.$ref)?.[1] : undefined;
  return name === undefined ? property : (definitions[name] ?? property);
}

function help(name: string, paths: readonly string[]): string {
  return [
    `Usage: ${name} <command> [flags]`,
    "",
    "Commands:",
    ...paths.map((path) => `  ${path}`),
    "  call <id> [input]",
    "  list",
  ].join("\n");
}

function usage(name: string, path: readonly string[], description: string, schema: JsonObject): string {
  const properties = Object.keys((schema.properties ?? {}) as object);
  const required = new Set((schema.required ?? []) as readonly string[]);
  const flags = properties.map((property) => (required.has(property) ? `--${property} <value>` : `[--${property} <value>]`));
  return [`Usage: ${name} ${[...path, ...flags].join(" ")}`, "", description].join("\n");
}
