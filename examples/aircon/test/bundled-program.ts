import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function bundledProgram(source: string): string {
  const bundle = fileURLToPath(new URL(`../.out/programs/${source.replace(/\.ts$/, ".mjs")}`, import.meta.url));
  if (!existsSync(bundle)) throw new Error(`${bundle} does not exist. Run moon run example-aircon:test-programs.`);
  return bundle;
}
