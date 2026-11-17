import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { canonicalText } from "@acid-cat/catalog";

import { catalogFiles, catalogTypes, pklSources, renderedPath, root, typedCatalogs, typesPath } from "./catalogs.ts";

for (const source of pklSources()) {
  const rendered = execFileSync("pkl", ["eval", path.join(root, source)], { encoding: "utf-8" });
  writeFileSync(path.join(root, renderedPath(source)), canonicalText(JSON.parse(rendered)));
}

const files = catalogFiles();
for (const file of files) {
  const text = readFileSync(path.join(root, file), "utf-8");
  const canonical = canonicalText(JSON.parse(text));
  if (canonical !== text) writeFileSync(path.join(root, file), canonical);
}
for (const catalog of typedCatalogs) {
  const types = catalogTypes(catalog);
  if (!types.ok) throw new Error(`${catalog}: ${types.errors.join("; ")}`);
  writeFileSync(path.join(root, typesPath(catalog)), types.text);
}
process.stdout.write(
  `Rendered ${pklSources().length} Pkl catalogs. ${files.length} catalogs are in canonical form. Wrote ${typedCatalogs.length} TypeScript type files.\n`,
);
