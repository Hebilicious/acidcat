import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { complement, coreRanges, unicodeRange } from "../src/lib/fonts.ts";

const dist = new URL("../dist/", import.meta.url).pathname;

const pages = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".html")).map((entry) => join(entry.parentPath, entry.name));
};

const inCore = (codePoint: number) => coreRanges.some(([first, last]) => codePoint >= first && codePoint <= last);

const visibleText = (html: string) =>
  html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)));

test("the core and the rest of each font cover every code point once", () => {
  const rest = complement(coreRanges);
  const ranges = [...coreRanges, ...rest].toSorted((a, b) => a[0] - b[0]);
  let next = 0;
  for (const [first, last] of ranges) {
    assert.equal(first, next);
    next = last + 1;
  }
  assert.equal(next, 0x110000);
  assert.equal(unicodeRange([[0x41, 0x41], [0x2190, 0x2199]]), "U+0041, U+2190-2199");
});

test("every character on every page is in the core of the fonts, so no page loads the rest", async () => {
  const outside = new Map<string, string>();
  for (const file of await pages(dist)) {
    for (const character of visibleText(await readFile(file, "utf8"))) {
      const codePoint = character.codePointAt(0);
      if (codePoint !== undefined && !inCore(codePoint)) outside.set(character, file.slice(dist.length));
    }
  }
  assert.deepEqual([...outside].map(([character, file]) => `U+${(character.codePointAt(0) ?? 0).toString(16)} in ${file}`), [], "add these code points to coreRanges in src/lib/fonts.ts");
});
