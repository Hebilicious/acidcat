import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const dist = new URL("../dist/", import.meta.url).pathname;
const site = "https://acidcat.hebilicious.workers.dev";

const pages = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return pages(path);
      return Promise.resolve(entry.name.endsWith(".html") ? [path] : []);
    }),
  );
  return nested.flat();
};

test("every link to another website opens in a new tab", async () => {
  const offenders: string[] = [];
  for (const file of await pages(dist)) {
    const html = await readFile(file, "utf8");
    for (const match of html.matchAll(/<a\b[^>]*>/g)) {
      const tag = match[0];
      const href = /\shref="(https?:\/\/[^"]+)"/.exec(tag)?.[1];
      if (href === undefined || href.startsWith(site)) continue;
      if (!/\starget="_blank"/.test(tag) || !/\srel="[^"]*noopener/.test(tag)) offenders.push(`${file.slice(dist.length)}: ${href}`);
    }
  }
  assert.deepEqual(offenders, []);
});
