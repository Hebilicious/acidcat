import { globSync, readFileSync } from "node:fs";
import path from "node:path";

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
