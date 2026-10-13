/**
 * Check this repository's example catalogs and fixtures.
 *
 * Every `examples/<name>.pkl` must render, once put in canonical form, to exactly the committed
 * `examples/<name>.acidcat.json`. Every committed catalog, including the catalog libraries' fixtures, must then conform.
 *
 * Usage: node scripts/check-examples.ts
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { canonicalText } from "@acid-cat/catalog";
import { problemsOf } from "@acid-cat/cli";

const root = path.resolve(import.meta.dirname, "..");
const problems: string[] = [];

for (const source of readdirSync(path.join(root, "examples")).filter((name) => name.endsWith(".pkl"))) {
  const rendered = execFileSync("pkl", ["eval", path.join(root, "examples", source)], { encoding: "utf-8" });
  const committed = `examples/${source.replace(/\.pkl$/, ".acidcat.json")}`;
  if (canonicalText(JSON.parse(rendered)) !== readFileSync(path.join(root, committed), "utf-8")) {
    problems.push(`${committed}: stale; run \`moon run examples\``);
  }
}

const catalogs = [
  ...readdirSync(path.join(root, "examples"))
    .filter((name) => name.endsWith(".acidcat.json"))
    .map((name) => `examples/${name}`),
  ...readdirSync(path.join(root, "packages/catalog/fixtures")).map((name) => `packages/catalog/fixtures/${name}`),
];
for (const file of catalogs) {
  const text = readFileSync(path.join(root, file), "utf-8");
  problems.push(...problemsOf(JSON.parse(text), text).map((problem) => `${file}: ${problem}`));
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Every example and fixture conforms (${catalogs.length} catalogs).\n`);
