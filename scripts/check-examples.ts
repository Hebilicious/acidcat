/**
 * Check every catalog file of this repository: the examples, and the fixtures of each package.
 *
 * Each Pkl catalog source must render, once put in canonical form, to exactly the committed `.acidcat.json` file beside
 * it. Each committed `.acidcat.json` file must conform, and `check` warns when it is not in canonical form. Thus each catalog library tests
 * its own catalogs, and all libraries still agree on the canonical form.
 *
 * Usage: node scripts/check-examples.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { canonicalText } from "@acid-cat/catalog";
import { check } from "@acid-cat/cli";

import { catalogFiles, pklSources, renderedPath, root } from "./catalogs.ts";

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

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Every catalog is in canonical form and conforms (${catalogs.length} catalogs).\n`);
