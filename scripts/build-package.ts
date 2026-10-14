/**
 * Build one TypeScript package for npm. Run it in the directory of the package.
 *
 * In the workspace, `exports` and `bin` point to the TypeScript sources. `publishConfig` points to `dist/`, and pnpm
 * uses it when it packs or publishes the package. This script writes `dist/`:
 *
 * - esbuild bundles each entry point into `dist/<name>.js`, for Node.js 24 and later. Code that two entry points share
 *   goes into `dist/chunks/`. Dependencies stay imports. JSON files that the sources import go into the bundle.
 * - tsc writes the declarations from `tsconfig.build.json`. Their relative `.ts` imports become `.js` imports.
 *
 * The script fails when `publishConfig` does not point to the files that it writes.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { build } from "esbuild";

type Exports = string | Record<string, string>;

interface Manifest {
  name: string;
  exports: Exports;
  bin?: Record<string, string>;
  publishConfig?: { exports?: unknown; bin?: unknown };
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;

const source = /^\.\/src\/([\w-]+)\.ts$/;

/** The published form of one export: the bundle and its declarations, or the same file if it is not a source. */
const publishedExport = (path: string) => {
  const match = source.exec(path);
  return match ? { types: `./dist/${match[1]}.d.ts`, default: `./dist/${match[1]}.js` } : path;
};

const publishedBin = (path: string) => {
  const match = source.exec(path);
  if (!match) throw new Error(`The bin ${path} is not a file in src/.`);
  return `./dist/${match[1]}.js`;
};

const exportPaths = typeof manifest.exports === "string" ? [manifest.exports] : Object.values(manifest.exports);
const entryPoints = [...exportPaths, ...Object.values(manifest.bin ?? {})].filter((path) => source.test(path));

const expected = {
  exports:
    typeof manifest.exports === "string"
      ? { ".": publishedExport(manifest.exports) }
      : Object.fromEntries(Object.entries(manifest.exports).map(([key, path]) => [key, publishedExport(path)])),
  ...(manifest.bin && {
    bin: Object.fromEntries(Object.entries(manifest.bin).map(([name, path]) => [name, publishedBin(path)])),
  }),
};

const actual = { exports: manifest.publishConfig?.exports, ...(manifest.bin && { bin: manifest.publishConfig?.bin }) };
if (!isDeepStrictEqual(actual, expected)) {
  console.error(`${manifest.name}: publishConfig must be:\n${JSON.stringify(expected, null, 2)}`);
  process.exit(1);
}

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints,
  outdir: "dist",
  outbase: "src",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "external",
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "warning",
});

execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });

const relativeTsImport = /((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+)\.ts\2/g;

for (const file of readdirSync("dist", { recursive: true, encoding: "utf8" })) {
  if (!file.endsWith(".d.ts")) continue;
  const path = join("dist", file);
  writeFileSync(path, readFileSync(path, "utf8").replace(relativeTsImport, "$1$2$3.js$2"));
}
