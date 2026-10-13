#!/usr/bin/env node
/**
 * `acidcat`: the toolchain for catalogs.
 *
 *   acidcat check <catalog.json ...>            Validate catalogs, including their canonical form.
 *   acidcat format [--write] <catalog.json ...> Print each catalog in canonical form, or rewrite the file.
 *   acidcat view <catalog.json> <target>        Print the view of one target.
 *
 * Exit codes: 0 when everything conforms, 1 when a catalog breaks a rule, 2 for a usage error.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { canonicalText } from "@acidcat/catalog";
import { problemsOf, viewOf, type Catalog } from "./catalog.ts";

const USAGE = `Usage:
  acidcat check <catalog.json ...>
  acidcat format [--write] <catalog.json ...>
  acidcat view <catalog.json> <target>
`;

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "check":
    check(rest);
    break;
  case "format":
    format(rest);
    break;
  case "view":
    view(rest);
    break;
  default:
    usage();
}

function check(files: readonly string[]): void {
  if (files.length === 0) usage();
  let failed = false;
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const problems = problemsOf(JSON.parse(text), text);
    for (const problem of problems) process.stderr.write(`${file}: ${problem}\n`);
    failed ||= problems.length > 0;
  }
  if (failed) process.exit(1);
  process.stdout.write(`${files.length === 1 ? "The catalog conforms" : "Every catalog conforms"}.\n`);
}

function format(argumentsGiven: readonly string[]): void {
  const write = argumentsGiven.includes("--write");
  const files = argumentsGiven.filter((argument) => argument !== "--write");
  if (files.length === 0) usage();
  for (const file of files) {
    const text = canonicalText(JSON.parse(readFileSync(file, "utf-8")));
    if (write) writeFileSync(file, text);
    else process.stdout.write(text);
  }
}

function view(argumentsGiven: readonly string[]): void {
  const [file, target] = argumentsGiven;
  if (file === undefined || target === undefined) usage();
  const catalog = JSON.parse(readFileSync(file, "utf-8")) as Catalog;
  if (!(target in catalog.targets)) {
    process.stderr.write(`${file}: there is no target named ${target}\n`);
    process.exit(1);
  }
  process.stdout.write(canonicalText(viewOf(catalog, target)));
}

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}
