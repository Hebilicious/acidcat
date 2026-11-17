import { globSync, readFileSync } from "node:fs";
import path from "node:path";

import { isCatalog, typescriptTypes } from "@acid-cat/cli";
import type { TypeScriptTypes } from "@acid-cat/cli";

export const root = path.resolve(import.meta.dirname, "..");

export const GENERATED_DIRECTORIES = ["**/node_modules/**", ".worktrees/**", ".moon/**", "**/target/**", "**/dist/**", "**/.out/**"];
const REJECTED_TEST_INPUTS = ["**/rejected/**"];
const ignored = [...GENERATED_DIRECTORIES, ...REJECTED_TEST_INPUTS];

export const pklSources = (): string[] =>
  globSync("**/*.pkl", { cwd: root, exclude: ignored })
    .filter((file) => /^amends\s/m.test(readFileSync(path.join(root, file), "utf-8")))
    .sort();

export const renderedPath = (source: string): string => source.replace(/\.pkl$/, ".acidcat.json");

export const catalogFiles = (): string[] => globSync("**/*.acidcat.json", { cwd: root, exclude: ignored }).sort();

export function catalogTypes(catalog: string): TypeScriptTypes {
  const document: unknown = JSON.parse(readFileSync(path.join(root, catalog), "utf-8"));
  return isCatalog(document) ? typescriptTypes(document) : { ok: false, errors: ["the file is not a catalog"] };
}

export const typedCatalogs = ["examples/aircon/catalog/aircon.acidcat.json"];

export const typesPath = (catalog: string): string => catalog.replace(/\.acidcat\.json$/, ".types.ts");
