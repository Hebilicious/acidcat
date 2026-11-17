#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { canonicalText } from "@acid-cat/catalog";
import { Console, Data, Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import packageJson from "../package.json" with { type: "json" };
import { check, isCatalog, viewOf } from "./catalog.ts";
import { conform, DEADLINE } from "./conform/index.ts";
import { parseJson } from "./json.ts";
import { typescriptTypes } from "./typescript.ts";

class UnreadableFile extends Data.TaggedError("UnreadableFile")<{ readonly file: string; readonly reason: string }> {}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readText = Effect.fn("readText")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((error) => new UnreadableFile({ file, reason: `the file cannot be read: ${error.message}` })));
});

const readCatalog = Effect.fn("readCatalog")(function* (file: string) {
  const text = yield* readText(file);
  const document = yield* Effect.try({
    try: () => parseJson(text),
    catch: (error) => new UnreadableFile({ file, reason: `the file is not JSON: ${messageOf(error)}` }),
  });
  return { text, document };
});

const reportUnreadable = (error: UnreadableFile) => Effect.andThen(Console.error(`${error.file}: error: ${error.reason}`), fail);

const fail = Effect.sync(() => {
  process.exitCode = 1;
});

const files = Argument.String("catalog").pipe(
  Argument.withDescription("A catalog file, such as acidcat.catalog.json"),
  Argument.variadic({ min: 1 }),
);

const output = Flag.Literals("output", ["human", "json"]).pipe(
  Flag.withDescription("human: text for a person. json: one JSON document on standard output, for a script or an agent"),
  Flag.withDefault("human"),
);

const printJson = (value: unknown) => Effect.sync(() => process.stdout.write(`${JSON.stringify(value)}\n`));

const checkCommand = Command.make(
  "check",
  {
    files,
    strict: Flag.Boolean("strict").pipe(Flag.withDescription("Fail on warnings too"), Flag.withDefault(false)),
    output,
  },
  Effect.fn(function* ({ files, strict, output }) {
    let failed = false;
    const reports = [];
    for (const file of files) {
      const report = yield* readCatalog(file).pipe(
        Effect.map(({ text, document }) => check(document, text)),
        Effect.catchTag("UnreadableFile", (error) => Effect.succeed({ errors: [error.reason], warnings: [] })),
      );
      reports.push({ file, ...report });
      failed ||= report.errors.length > 0 || (strict && report.warnings.length > 0);
    }
    if (output === "json") {
      yield* printJson({ conforms: !failed, catalogs: reports });
      if (failed) return yield* fail;
      return;
    }
    for (const { file, errors, warnings } of reports) {
      for (const error of errors) yield* Console.error(`${file}: error: ${error}`);
      for (const warning of warnings) yield* Console.error(`${file}: warning: ${warning}`);
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
      const text = canonicalText(document);
      if (write) yield* fs.writeFileString(file, text);
      else yield* Effect.sync(() => process.stdout.write(text));
    }
  }, Effect.catchTag("UnreadableFile", reportUnreadable)),
).pipe(Command.withDescription("Write catalogs in canonical form."));

const viewCommand = Command.make(
  "view",
  {
    file: Argument.String("catalog").pipe(Argument.withDescription("A catalog file")),
    target: Argument.String("target").pipe(Argument.withDescription("The name of a target in the catalog")),
  },
  Effect.fn(function* ({ file, target }) {
    const { document: catalog } = yield* readCatalog(file);
    if (!isCatalog(catalog)) {
      yield* Console.error(`${file}: error: the file is not a catalog; run \`acid-cat check ${file}\``);
      return yield* fail;
    }
    if (!Object.hasOwn(catalog.targets, target)) {
      yield* Console.error(`${file}: error: there is no target ${target}`);
      return yield* fail;
    }
    yield* Effect.sync(() => process.stdout.write(canonicalText(viewOf(catalog, target))));
  }, Effect.catchTag("UnreadableFile", reportUnreadable)),
).pipe(Command.withDescription("Print the view of one target."));

const typescriptCommand = Command.make(
  "typescript",
  {
    file: Argument.String("catalog").pipe(Argument.withDescription("A catalog file")),
    target: Flag.String("target").pipe(Flag.withDescription("Write only the types of the view of this target"), Flag.optional),
  },
  Effect.fn(function* ({ file, target }) {
    const { document: catalog } = yield* readCatalog(file);
    if (!isCatalog(catalog)) {
      yield* Console.error(`${file}: error: the file is not a catalog; run \`acid-cat check ${file}\``);
      return yield* fail;
    }
    if (Option.isSome(target) && !Object.hasOwn(catalog.targets, target.value)) {
      yield* Console.error(`${file}: error: there is no target ${target.value}`);
      return yield* fail;
    }
    const types = typescriptTypes(Option.isSome(target) ? viewOf(catalog, target.value) : catalog);
    if (!types.ok) {
      for (const error of types.errors) yield* Console.error(`${file}: error: ${error}`);
      return yield* fail;
    }
    yield* Effect.sync(() => process.stdout.write(types.text));
  }, Effect.catchTag("UnreadableFile", reportUnreadable)),
).pipe(Command.withDescription("Print the TypeScript types of a catalog, or of the view of one target."));

const typesCommand = Command.make("types", {}, () =>
  Effect.andThen(Console.error("Give a language: acid-cat types typescript <catalog.json>"), fail),
).pipe(
  Command.withDescription("Print the types of a catalog in a programming language."),
  Command.withSubcommands([typescriptCommand]),
);

const url = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

const conformCommand = Command.make(
  "conform",
  {
    mcp: url("mcp", "The URL of the MCP server"),
    mcpHandshake: Flag.Boolean("mcp-handshake").pipe(
      Flag.withDescription("Check the initialize handshake of MCP revision 2025-11-25 through --mcp too"),
      Flag.withDefault(false),
    ),
    mcpStdio: url("mcp-stdio", "The command that starts the MCP server through standard input and output, for example \"node fixture-mcp-stdio.ts\""),
    http: url("http", "The base URL of the HTTP API, before /capabilities"),
    cli: url("cli", "The command that starts the command line, for example \"node fixture-cli.ts\""),
    webmcp: url("webmcp", "The URL of a web page that serves the app target. It runs in Chromium, through Playwright"),
    pollBuffer: Flag.Int("poll-buffer").pipe(
      Flag.withDescription("The number of occurrences that a poll lease of the deployment keeps, from 1 to 97. With it, conform tests a cursor older than the buffer"),
      Flag.optional,
    ),
    pollLeaseMs: Flag.Int("poll-lease-ms").pipe(
      Flag.withDescription("The lease time of the deployment, in milliseconds, shorter than the deadline. With it, conform tests that a lease with no poll ends"),
      Flag.optional,
    ),
    webhookPrincipal: url(
      "webhook-principal",
      "Test webhook delivery through --mcp. The deployment gives this principal to a request with the header Authorization: Bearer <principal>",
    ),
    webhookCert: url("webhook-cert", "The PEM file of the certificate of the HTTPS receiver of the webhook tests. It must be valid for 127.0.0.1, and the deployment must trust it"),
    webhookKey: url("webhook-key", "The PEM file of the private key of --webhook-cert"),
    webhookOtherPrincipal: url("webhook-other-principal", "A second principal that the deployment gives to a request with Authorization: Bearer <principal>, for the check of the limit"),
    webhookMaxTtlMs: Flag.Int("webhook-max-ttl-ms").pipe(Flag.withDescription("The maximum lifetime of a webhook subscription in the deployment. The default is 3600000"), Flag.optional),
    webhookMinTtlMs: Flag.Int("webhook-min-ttl-ms").pipe(
      Flag.withDescription("The minimum lifetime of a webhook subscription in the deployment, shorter than the deadline. With it, conform tests that a subscription with no renewal ends"),
      Flag.optional,
    ),
    webhookMaxSubscriptions: Flag.Int("webhook-max-subscriptions").pipe(
      Flag.withDescription("The maximum number of webhook subscriptions of one principal in the deployment. With it, conform tests the limit"),
      Flag.optional,
    ),
    maximumBytes: Flag.Int("max-bytes").pipe(Flag.withDescription("The body limit of the remote bindings"), Flag.withDefault(1_048_576)),
    deadline: Flag.Int("deadline").pipe(
      Flag.withDescription("The time, in milliseconds, that each check has to settle. A check that does not settle in this time fails"),
      Flag.withDefault(DEADLINE),
    ),
    output,
  },
  Effect.fn(function* (options) {
    const value = (option: Option.Option<string>) => (Option.isSome(option) ? option.value : undefined);
    const words = (option: Option.Option<string>) => value(option)?.split(/\s+/).filter((word) => word !== "");
    const optionalInt = (option: Option.Option<number>) => (Option.isSome(option) ? option.value : undefined);
    const webhookOptions = [options.webhookPrincipal, options.webhookCert, options.webhookKey];
    const given = webhookOptions.filter(Option.isSome).length;
    if (given !== 0 && given !== 3) {
      yield* Console.error("Give --webhook-principal, --webhook-cert and --webhook-key together.");
      return yield* fail;
    }
    const settings = [Option.isSome(options.webhookOtherPrincipal), Option.isSome(options.webhookMaxTtlMs), Option.isSome(options.webhookMinTtlMs), Option.isSome(options.webhookMaxSubscriptions)];
    if (given === 0 && settings.includes(true)) {
      yield* Console.error("The other --webhook-* options need --webhook-principal, --webhook-cert and --webhook-key.");
      return yield* fail;
    }
    const webhook =
      Option.isSome(options.webhookPrincipal) && Option.isSome(options.webhookCert) && Option.isSome(options.webhookKey)
        ? {
            principal: options.webhookPrincipal.value,
            cert: yield* readText(options.webhookCert.value),
            key: yield* readText(options.webhookKey.value),
            otherPrincipal: value(options.webhookOtherPrincipal),
            maxTtlMs: optionalInt(options.webhookMaxTtlMs),
            minTtlMs: optionalInt(options.webhookMinTtlMs),
            maxSubscriptions: optionalInt(options.webhookMaxSubscriptions),
          }
        : undefined;
    const results = yield* Effect.promise(() =>
      conform({
        mcp: value(options.mcp),
        mcpHandshake: options.mcpHandshake,
        mcpStdio: words(options.mcpStdio),
        http: value(options.http),
        cli: words(options.cli),
        webmcp: value(options.webmcp),
        poll: { bufferLimit: optionalInt(options.pollBuffer), leaseMs: optionalInt(options.pollLeaseMs) },
        webhook,
        maximumBytes: options.maximumBytes,
        deadline: options.deadline,
      }),
    );
    if (results.length === 0) {
      yield* Console.error("Give at least one binding: --mcp, --mcp-stdio, --http, --cli or --webmcp.");
      return yield* fail;
    }
    const failed = results.filter((result) => !result.passed).length;
    const warnings = results.filter((result) => result.warning === true).length;
    if (options.output === "json") {
      yield* printJson({ passed: results.length - failed, failed, warnings, checks: results });
      if (failed > 0) return yield* fail;
      return;
    }
    for (const result of results) {
      yield* Console.log(`${result.warning === true ? "!" : result.passed ? "✓" : "✗"} ${result.binding}: ${result.name} (${result.rule})${result.detail ? `\n    ${result.detail}` : ""}`);
    }
    yield* Console.log(`\n${results.length - failed} passed, ${failed} failed${warnings === 0 ? "" : `, ${warnings} with a warning`}.`);
    if (failed > 0) return yield* fail;
  }, Effect.catchTag("UnreadableFile", reportUnreadable)),
).pipe(Command.withDescription("Test a running implementation of the conformance fixture through its bindings."));

const acidCat = Command.make("acid-cat").pipe(
  Command.withDescription("Check, format and view AcidCat catalogs, write their types, and test implementations."),
  Command.withSubcommands([checkCommand, formatCommand, viewCommand, typesCommand, conformCommand]),
);

// Package runners, such as `pnpm` and `npx`, pass a `--` before the arguments of the program.
const args = process.argv.slice(2);
const programArguments = args[0] === "--" ? args.slice(1) : args;

Command.runWith(acidCat, { version: packageJson.version })(programArguments).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
