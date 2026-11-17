import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { canonicalText } from "@acid-cat/catalog";
import { check } from "@acid-cat/cli";

import { catalogFiles, catalogTypes, pklSources, renderedPath, root, typedCatalogs, typesPath } from "./catalogs.ts";

const problems: string[] = [];

for (const source of pklSources()) {
  const committed = renderedPath(source);
  if (!existsSync(path.join(root, committed))) {
    problems.push(`${committed}: missing; run \`moon run examples\``);
    continue;
  }
  const rendered = execFileSync("pkl", ["eval", path.join(root, source)], { encoding: "utf-8" });
  if (canonicalText(JSON.parse(rendered)) !== readFileSync(path.join(root, committed), "utf-8")) {
    problems.push(`${committed}: stale; run \`moon run examples\``);
  }
}

const catalogs = catalogFiles();
for (const file of catalogs) {
  const text = readFileSync(path.join(root, file), "utf-8");
  const report = check(JSON.parse(text), text);
  problems.push(...[...report.errors, ...report.warnings].map((problem) => `${file}: ${problem}`));
}

for (const catalog of typedCatalogs) {
  const committed = typesPath(catalog);
  const types = catalogTypes(catalog);
  if (!types.ok) problems.push(...types.errors.map((error) => `${catalog}: ${error}`));
  else if (!existsSync(path.join(root, committed))) problems.push(`${committed}: missing; run \`moon run examples\``);
  else if (types.text !== readFileSync(path.join(root, committed), "utf-8")) problems.push(`${committed}: stale; run \`moon run examples\``);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Every catalog is in canonical form and conforms (${catalogs.length} catalogs), and its committed TypeScript types are up to date.\n`);
