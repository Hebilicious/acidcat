import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { generateCSS, loadConfig } from "@hebilicious/cssforge";

const site = new URL("../", import.meta.url).pathname;
const families = ["palette", "spacing_fluid", "typography_fluid", "typography", "font", "radius", "layout"];

const sources = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return Promise.resolve(/\.(vue|css|ts)$/.test(entry.name) ? [path] : []);
    }),
  );
  return nested.flat();
};

test("every design token that the site uses exists in the cssforge output", async () => {
  const output = generateCSS((await loadConfig(join(site, "cssforge.config.ts"))).config);
  const defined = new Set(Array.from(output.matchAll(/^(--[\w-]+):/gm), (match) => match[1]));
  const pattern = new RegExp(`var\\((--(?:${families.join("|")})-[\\w-]+)`, "g");
  const missing: string[] = [];
  for (const file of await sources(join(site, "src"))) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const token = match[1];
      if (token !== undefined && !defined.has(token)) missing.push(`${file.slice(site.length)}: ${token}`);
    }
  }
  assert.deepEqual(missing, []);
});
