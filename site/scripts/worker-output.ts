import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import config from "../cloudflare.config.ts";

// `cf` builds a project with a Worker entrypoint through the framework's own command, and VitePress writes only static files.

const site = join(import.meta.dirname, "..");
const output = join(site, ".cloudflare/output/v1");
const workerDirectory = join(output, "workers/default");
const { values } = parseArgs({ options: { preview: { type: "boolean", default: false } } });

const worker = config.worker;
if (worker === undefined || typeof worker !== "object" || !("name" in worker) || typeof worker.entrypoint !== "string") {
  throw new Error("cloudflare.config.ts must give a Worker object with an entrypoint path.");
}
const { entrypoint, ...settings } = worker;

await rm(join(site, ".cloudflare/output"), { recursive: true, force: true });
await mkdir(workerDirectory, { recursive: true });
await build({
  entryPoints: [join(site, entrypoint)],
  outfile: join(workerDirectory, "bundle/index.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["module", "main"],
  minify: true,
  logLevel: "warning",
});
await cp(join(site, ".out/framework"), join(workerDirectory, "assets"), { recursive: true });
await writeFile(
  join(workerDirectory, "worker.config.json"),
  JSON.stringify({ ...settings, manifest: { type: "complete", mainModule: "index.js", modules: { "index.js": { type: "esm" } } } }),
);
await writeFile(join(output, "config.json"), JSON.stringify({ producer: { name: "acid-cat-site", version: "0.0.0" }, buildContext: { isPreview: values.preview } }));
