/**
 * The catalog files of this repository: the Pkl catalog sources, and the committed `.acidcat.json` files.
 *
 * A Pkl catalog source is a `.pkl` file that amends the catalog module. Its catalog is the `.acidcat.json` file beside
 * it. Each package keeps its own catalogs, so the scripts find them all by name, in every directory.
 */
import { globSync, readFileSync } from "node:fs";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

const ignored = ["**/node_modules/**", ".worktrees/**", ".moon/**", "**/target/**", "**/dist/**", "**/.out/**"];

/** The Pkl files that amend the catalog module, relative to the root. */
export const pklSources = (): string[] =>
  globSync("**/*.pkl", { cwd: root, exclude: ignored })
    .filter((file) => /^amends\s/m.test(readFileSync(path.join(root, file), "utf-8")))
    .sort();

/** The catalog file that a Pkl source renders to. */
export const renderedPath = (source: string): string => source.replace(/\.pkl$/, ".acidcat.json");

/** The `.acidcat.json` files, relative to the root. */
export const catalogFiles = (): string[] => globSync("**/*.acidcat.json", { cwd: root, exclude: ignored }).sort();
