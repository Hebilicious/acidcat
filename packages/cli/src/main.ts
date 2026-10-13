#!/usr/bin/env node
/**
 * `acid-cat`: check, format and view AcidCat catalogs.
 *
 * Exit codes: 0 when the command succeeds, 1 when a catalog does not conform or a file is not found.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { canonicalText } from "@acid-cat/catalog";
import { Console, Effect, FileSystem } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import packageJson from "../package.json" with { type: "json" };
import { check, viewOf, type Catalog } from "./catalog.ts";

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

const acidCat = Command.make("acid-cat").pipe(
  Command.withDescription("Check, format and view AcidCat catalogs."),
  Command.withSubcommands([checkCommand, formatCommand, viewCommand]),
);

acidCat.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
