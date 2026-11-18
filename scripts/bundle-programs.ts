// Node strips the types of each module of a TypeScript program at start-up, which takes most of the start-up time of a program of hundreds of modules.
import { rmSync } from "node:fs";
import { build } from "esbuild";

const entryPoints = process.argv.slice(2);
if (entryPoints.length === 0) throw new Error("Usage: node bundle-programs.ts <program.ts>...");

const outdir = ".out/programs";

rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints,
  outdir,
  outbase: ".",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Playwright reads its own files at run time, from its directory in node_modules.
  external: ["playwright"],
  // The CommonJS modules of the bundle call `require`, which an ES module does not have.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "warning",
});
