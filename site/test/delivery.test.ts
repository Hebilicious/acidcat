import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { openPage } from "./github.ts";
import { dist, serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

const pages = ["/", "/docs/", "/spec/catalog/", "/packages/"];
const phone = { width: 400, height: 860 };
const viewports = [phone, { width: 1440, height: 900 }];

// The rules of axe-core that the Lighthouse audit "Accessibility tree is well-formed" checks.
const agentRules = [
  "button-name",
  "input-button-name",
  "input-image-alt",
  "label",
  "link-name",
  "select-name",
  "document-title",
  "aria-allowed-attr",
  "aria-allowed-role",
  "aria-command-name",
  "aria-conditional-attr",
  "aria-dialog-name",
  "aria-hidden-body",
  "aria-hidden-focus",
  "aria-input-field-name",
  "aria-prohibited-attr",
  "aria-required-attr",
  "aria-required-children",
  "aria-required-parent",
  "aria-roles",
  "aria-text",
  "aria-toggle-field-name",
  "aria-tooltip-name",
  "aria-treeitem-name",
  "aria-valid-attr",
  "aria-valid-attr-value",
  "duplicate-id-aria",
  "definition-list",
  "table-duplicate-name",
  "tabindex",
  "autocomplete-valid",
  "presentation-role-conflict",
  "svg-img-alt",
];

let origin = "";
let server: StaticServer | undefined;
let browser: Browser | undefined;

before(async () => {
  server = await serveDist();
  origin = server.origin;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test("every file that a page loads has a hash in its name, and the browser keeps it for a year", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const headers = await readFile(join(dist, "_headers"), "utf8");
  assert.match(headers, /^\/_astro\/\*\n\s+Cache-Control: public, max-age=31536000, immutable$/m);
  const offenders = new Set<string>();
  for (const viewport of viewports) {
    for (const path of pages) {
      const page = await openPage(browser, { viewport });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin === origin && request.resourceType() !== "document" && !url.pathname.startsWith("/_astro/")) offenders.add(`${path}: ${url.pathname}`);
      });
      await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
      await page.close();
    }
  }
  assert.deepEqual([...offenders], []);
});

test("the homepage loads no stylesheet, and each script that it loads at once has a modulepreload link", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: phone });
  const loaded: { file: string; type: string }[] = [];
  page.on("request", (request) => loaded.push({ file: new URL(request.url()).pathname, type: request.resourceType() }));
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  const preloaded = new Set(await page.locator('link[rel="modulepreload"]').evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? "")));
  await page.close();
  assert.deepEqual(loaded.filter(({ type }) => type === "stylesheet"), []);
  const scripts = loaded.filter(({ type, file }) => type === "script" && file.startsWith("/_astro/")).map(({ file }) => file);
  assert.ok(scripts.length > 0, "the homepage loads its scripts");
  assert.deepEqual(scripts.filter((file) => !preloaded.has(file)), []);
});

test("the accessibility tree of each page passes the rules that agents rely on", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const axe = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  const run = `axe.run(document, { runOnly: { type: "rule", values: ${JSON.stringify(agentRules)} } }).then((result) => result.violations.map((violation) => violation.id + ": " + violation.nodes.map((node) => node.target.join(" ")).join(", ")))`;
  for (const viewport of viewports) {
    for (const path of pages) {
      const page = await openPage(browser, { viewport });
      await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
      await page.addScriptTag({ content: axe });
      const violations: unknown = await page.evaluate(run);
      await page.close();
      assert.deepEqual(violations, [], `${path} at ${viewport.width}px`);
    }
  }
});
