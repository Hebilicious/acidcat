/**
 * The CLI binding (spec/bindings/cli.md): a command line made from the catalog, with `effect/cli`. This module works
 * in all runtimes. `NodeCli` in `@acid-cat/core-effect/node` runs it in Node.js.
 */
import { bundle, CLI_EXIT_CODES, cliExitCode, commandPath, isCallFailure, REFERENCE } from "@acid-cat/spec-ts";
import type { CatalogDocument, JsonObject, Outcome } from "@acid-cat/spec-ts";
import { Console, Effect, Layer, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

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
export const run = <R>(app: App.App<R>, options: Options) =>
  Command.run(command(app, options), { version: options.version }).pipe(
    Effect.catch((error) => Effect.sync(() => (process.exitCode = usageExitCode(error)))),
  );

/**
 * The exit code for a usage error. `effect/cli` shows the help for each usage error, and gives the errors in the
 * `errors` of `ShowHelp`. Help with no errors is a request for help.
 */
function usageExitCode(error: { readonly _tag?: string; readonly errors?: readonly { readonly _tag?: string }[] }): number {
  const errors = error._tag === "ShowHelp" ? (error.errors ?? []) : [error];
  if (errors.length === 0) return CLI_EXIT_CODES.value;
  return errors.some((inner) => inner._tag === "UnknownSubcommand")
    ? CLI_EXIT_CODES["unknown-capability"]
    : CLI_EXIT_CODES["invalid-input"];
}

/** The root command: one command for each capability in the view, plus `call` and `list`. */
export function command<R>(app: App.App<R>, options: Options) {
  const target = options.target ?? "cli";
  const view = Session.make(app, { target });
  const document = App.document(app);
  const catalogView = { ...document, capabilities: Object.fromEntries(Object.entries(document.capabilities).filter(([, c]) => (c.audience ?? []).includes(target))) } as CatalogDocument;
  const types = catalogView.$defs ?? {};

  const invoke = (id: string, input: unknown) =>
    Effect.scoped(Effect.flatMap(view, (session) => session.invoke(id, input))).pipe(
      Effect.flatMap(print),
      Effect.onInterrupt(() => Effect.sync(() => (process.exitCode = CLI_EXIT_CODES.cancelled))),
    );

  const leaves = Object.entries(catalogView.capabilities).map(([id, capability]) => {
    const schema = bundle(capability.input ?? { type: "object" }, types);
    const properties = (schema.properties ?? {}) as { readonly [name: string]: JsonObject };
    const required = new Set((schema.required ?? []) as readonly string[]);
    const definitions = (schema.$defs ?? {}) as { readonly [name: string]: JsonObject };
    const flags = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [name, flagFor(name, resolve(property, definitions), required.has(name))]),
    );
    const path = commandPath(id);
    const leaf = Command.make(path.at(-1)!, flags, (parsed: Record<string, unknown>) => invoke(id, inputFrom(parsed))).pipe(
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
          entries.push({ id, description: capability.description, ...(yield* session.availability(id)), usage: `${options.name} ${commandPath(id).join(" ")}` });
        }
        yield* Console.log(JSON.stringify(entries, null, 2));
      }),
    ),
  ).pipe(Command.withDescription("List the capabilities, with their availability."));

  const reserved = new Set(["call", "list"]);
  for (const { path } of leaves) {
    if (reserved.has(path[0]!)) throw new Error(`The command ${path.join(" ")} has the same name as a command of the command line.`);
  }

  return Command.make(options.name).pipe(
    Command.withDescription(app.description ?? app.title ?? options.name),
    Command.withSubcommands([call, list, ...group(leaves, [])] as never),
  );
}

/** Make the commands that only contain other commands, from the shared prefixes of the ids. */
function group(leaves: readonly { readonly path: readonly string[]; readonly leaf: unknown }[], prefix: readonly string[]): unknown[] {
  const commands: unknown[] = [];
  const byWord = new Map<string, { readonly path: readonly string[]; readonly leaf: unknown }[]>();
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
        Command.withSubcommands(group(children, [...prefix, word]) as never),
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
