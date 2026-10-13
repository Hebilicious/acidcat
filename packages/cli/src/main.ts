#!/usr/bin/env node
/**
 * `acid-cat`: check, format and view AcidCat catalogs.
 *
 * Exit codes: 0 when the command succeeds, 1 when a catalog does not conform or a file is not found.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { canonicalText } from "@acid-cat/catalog";
import { Console, Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import packageJson from "../package.json" with { type: "json" };
import { check, viewOf, type Catalog } from "./catalog.ts";
import { conform } from "./conform/index.ts";

const readCatalog = Effect.fn("readCatalog")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file);
  return { text, document: JSON.parse(text) as unknown };
});

const fail = Effect.sync(() => {
  process.exitCode = 1;
});

const files = Argument.String("catalog").pipe(
  Argument.withDescription("A catalog file, such as acidcat.catalog.json"),
  Argument.variadic({ min: 1 }),
);

const checkCommand = Command.make(
  "check",
  {
    files,
    strict: Flag.Boolean("strict").pipe(Flag.withDescription("Fail on warnings too"), Flag.withDefault(false)),
  },
  Effect.fn(function* ({ files, strict }) {
    let failed = false;
    for (const file of files) {
      const { text, document } = yield* readCatalog(file);
      const report = check(document, text);
      for (const error of report.errors) yield* Console.error(`${file}: error: ${error}`);
      for (const warning of report.warnings) yield* Console.error(`${file}: warning: ${warning}`);
      failed ||= report.errors.length > 0 || (strict && report.warnings.length > 0);
    }
    if (failed) return yield* fail;
    yield* Console.log(files.length === 1 ? "The catalog conforms." : "Every catalog conforms.");
  }),
).pipe(Command.withDescription("Check that catalogs conform to the specification."));

const formatCommand = Command.make(
  "format",
  {
    files,
    write: Flag.Boolean("write").pipe(Flag.withDescription("Rewrite each file instead of printing it"), Flag.withDefault(false)),
  },
  Effect.fn(function* ({ files, write }) {
    const fs = yield* FileSystem.FileSystem;
    for (const file of files) {
      const { document } = yield* readCatalog(file);
      const text = canonicalText(document as Catalog);
      if (write) yield* fs.writeFileString(file, text);
      else yield* Effect.sync(() => process.stdout.write(text));
    }
  }),
).pipe(Command.withDescription("Write catalogs in canonical form."));

const viewCommand = Command.make(
  "view",
  {
    file: Argument.String("catalog").pipe(Argument.withDescription("A catalog file")),
    target: Argument.String("target").pipe(Argument.withDescription("The name of a target in the catalog")),
  },
  Effect.fn(function* ({ file, target }) {
    const { document } = yield* readCatalog(file);
    const catalog = document as Catalog;
    if (!(target in catalog.targets)) {
      yield* Console.error(`${file}: error: there is no target ${target}`);
      return yield* fail;
    }
    yield* Effect.sync(() => process.stdout.write(canonicalText(viewOf(catalog, target))));
  }),
).pipe(Command.withDescription("Print the view of one target."));

const url = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

const conformCommand = Command.make(
  "conform",
  {
    mcp: url("mcp", "The URL of the MCP server"),
    http: url("http", "The base URL of the HTTP API, before /capabilities"),
    cli: url("cli", "The command that starts the command line, for example \"node fixture-cli.ts\""),
    maximumBytes: Flag.Int("max-bytes").pipe(Flag.withDescription("The body limit of the remote bindings"), Flag.withDefault(1_048_576)),
  },
  Effect.fn(function* (options) {
    const value = (option: Option.Option<string>) => (Option.isSome(option) ? option.value : undefined);
    const command = value(options.cli)?.split(/\s+/).filter((word) => word !== "");
    const results = yield* Effect.promise(() =>
      conform({ mcp: value(options.mcp), http: value(options.http), cli: command, maximumBytes: options.maximumBytes }),
    );
    if (results.length === 0) {
      yield* Console.error("Give at least one binding: --mcp, --http or --cli.");
      return yield* fail;
    }
    for (const result of results) {
      yield* Console.log(`${result.passed ? "✓" : "✗"} ${result.binding}: ${result.name} (${result.rule})${result.detail ? `\n    ${result.detail}` : ""}`);
    }
    const failed = results.filter((result) => !result.passed).length;
    yield* Console.log(`\n${results.length - failed} passed, ${failed} failed.`);
    if (failed > 0) return yield* fail;
  }),
).pipe(Command.withDescription("Test a running implementation of the conformance fixture through its bindings."));

const acidCat = Command.make("acid-cat").pipe(
  Command.withDescription("Check, format and view AcidCat catalogs, and test implementations."),
  Command.withSubcommands([checkCommand, formatCommand, viewCommand, conformCommand]),
);

acidCat.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
