/**
 * Check that no code turns the type checks off. The linter (`.oxlintrc.json`) rejects type assertions, non-null
 * assertions, `any` and `@ts-` comments. This check rejects what the linter cannot see:
 *
 * - a comment that turns a lint rule off: `oxlint-disable…` or `eslint-disable…`;
 * - a `tsconfig*.json` that does not extend `tsconfig.base.json`, or that changes one of its options. Only `noEmit`
 *   can change, so that a build configuration can write declarations.
 *
 * Usage: node scripts/check-escapes.ts
 */
import { globSync, readFileSync } from "node:fs";
import path from "node:path";

import { root } from "./catalogs.ts";

const ignored = ["**/node_modules/**", ".worktrees/**", ".moon/**", "**/target/**", "**/dist/**", "**/.out/**"];
const problems: string[] = [];

const sources = globSync("**/*.{ts,mts,cts,js,mjs,cjs}", { cwd: root, exclude: ignored });
for (const file of sources) {
  readFileSync(path.join(root, file), "utf-8")
    .split("\n")
    .forEach((line, index) => {
      if (/(\/\/|\/\*)\s*(oxlint|eslint)-disable/.test(line)) problems.push(`${file}:${index + 1}: a comment turns a lint rule off`);
    });
}

interface TsConfig {
  readonly extends?: unknown;
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readConfig(file: string): TsConfig {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`);
  const compilerOptions = parsed["compilerOptions"];
  return { extends: parsed["extends"], compilerOptions: isRecord(compilerOptions) ? compilerOptions : {} };
}

const base = path.join(root, "tsconfig.base.json");
const baseOptions = readConfig(base).compilerOptions ?? {};
const changeable = new Set(["noEmit"]);

for (const file of globSync("**/tsconfig*.json", { cwd: root, exclude: ignored })) {
  const absolute = path.join(root, file);
  if (absolute === base) continue;

  // Follow `extends` to the base configuration.
  const chain = [absolute];
  for (let current = readConfig(absolute); typeof current.extends === "string"; ) {
    const next = path.resolve(path.dirname(chain.at(-1) ?? absolute), current.extends);
    if (chain.includes(next)) break;
    chain.push(next);
    current = readConfig(next);
  }
  if (!chain.includes(base)) problems.push(`${file}: does not extend tsconfig.base.json`);

  for (const [option, value] of Object.entries(readConfig(absolute).compilerOptions ?? {})) {
    if (option in baseOptions && !changeable.has(option) && JSON.stringify(value) !== JSON.stringify(baseOptions[option])) {
      problems.push(`${file}: changes the option ${option} of tsconfig.base.json`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`No code turns the type checks off (${sources.length} files).\n`);
