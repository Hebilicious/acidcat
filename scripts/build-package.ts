// pnpm uses `publishConfig` when it packs or publishes the package.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { basename, isAbsolute, join } from "node:path";
import { build } from "rolldown";

import { isJsonObject, parseObject, stringMember, stringRecord } from "./npm-packages.ts";

type Exports = string | Record<string, string>;

interface Manifest {
  name: string;
  exports: Exports;
  bin?: Record<string, string>;
  publishConfig?: { exports?: unknown; bin?: unknown };
}

function readManifest(): Manifest {
  const json = parseObject(readFileSync("package.json", "utf8"), "package.json");
  const exports = typeof json.exports === "string" ? json.exports : stringRecord(json.exports, "package.json: exports");
  const publishConfig = json.publishConfig;
  if (publishConfig !== undefined && !isJsonObject(publishConfig)) throw new Error("package.json: publishConfig is not an object.");
  return {
    name: stringMember(json, "name", "package.json"),
    exports,
    ...(json.bin !== undefined && { bin: stringRecord(json.bin, "package.json: bin") }),
    ...(publishConfig !== undefined && { publishConfig }),
  };
}

const manifest = readManifest();

const source = /^\.\/src\/([\w-]+)\.ts$/;

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
  input: entryPoints,
  platform: "node",
  transform: { target: "node24" },
  external: (id) => !id.startsWith(".") && !isAbsolute(id),
  output: {
    dir: "dist",
    format: "esm",
    preserveModules: true,
    preserveModulesRoot: "src",
    entryFileNames: (chunk) => (chunk.facadeModuleId?.endsWith(".json") ? `json/${basename(chunk.name)}.js` : "[name].js"),
  },
  logLevel: "warn",
});

execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });

const relativeTsImport = /((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+)\.ts\2/g;

for (const file of readdirSync("dist", { recursive: true, encoding: "utf8" })) {
  if (!file.endsWith(".d.ts")) continue;
  const path = join("dist", file);
  writeFileSync(path, readFileSync(path, "utf8").replace(relativeTsImport, "$1$2$3.js$2"));
}
