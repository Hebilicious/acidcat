import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { complement, coreRanges, unicodeRange } from "../src/lib/fonts.ts";
import { builtPages, dist, serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

let server: StaticServer | undefined;
let browser: Browser | undefined;

before(async () => {
  server = await serveDist();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

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
  for (const file of await builtPages()) {
    for (const character of visibleText(await readFile(file, "utf8"))) {
      const codePoint = character.codePointAt(0);
      if (codePoint !== undefined && !inCore(codePoint)) outside.set(character, file.slice(dist.length));
    }
  }
  assert.deepEqual([...outside].map(([character, file]) => `U+${(character.codePointAt(0) ?? 0).toString(16)} in ${file}`), [], "add these code points to coreRanges in src/lib/fonts.ts");
});

test("every character that the browser draws beside the text of a page is in the core: list markers, generated content and text from scripts", async () => {
  if (browser === undefined || server === undefined) throw new Error("No browser.");
  const page = await browser.newPage();
  // The search button of the docs shows the key of the platform, and only macOS has its own symbol.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const outside = new Map<string, string>();
  for (const file of await builtPages()) {
    const path = file.slice(dist.length - 1).replace(/index\.html$/, "");
    await page.goto(`${server.origin}${path}`, { waitUntil: "load" });
    const drawn: string = await page.evaluate(() => {
      const markers: Record<string, string> = { disc: "\u2022", circle: "\u25e6", square: "\u25aa", "disclosure-closed": "\u25b8", "disclosure-open": "\u25be" };
      const parts: string[] = [];
      for (const element of document.querySelectorAll("body *")) {
        if (element.closest("script, style, template") !== null) continue;
        const style = getComputedStyle(element);
        if (style.display === "list-item") parts.push(markers[style.listStyleType] ?? "");
        for (const pseudo of ["::before", "::after"]) {
          for (const [, quoted] of getComputedStyle(element, pseudo).content.matchAll(/"((?:[^"\\]|\\.)*)"/g)) parts.push(quoted ?? "");
        }
        for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? "");
      }
      return parts.join("");
    });
    for (const character of drawn) {
      const codePoint = character.codePointAt(0);
      if (codePoint !== undefined && !inCore(codePoint)) outside.set(character, path);
    }
  }
  await page.close();
  assert.deepEqual([...outside].map(([character, path]) => `U+${(character.codePointAt(0) ?? 0).toString(16)} on ${path}`), [], "add these code points to coreRanges in src/lib/fonts.ts");
});
