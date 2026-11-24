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
  assert.match(headers, /^\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable$/m);
  const offenders = new Set<string>();
  for (const viewport of viewports) {
    for (const path of pages) {
      const page = await openPage(browser, { viewport });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin === origin && request.resourceType() !== "document" && !url.pathname.startsWith("/assets/")) offenders.add(`${path}: ${url.pathname}`);
      });
      await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
      await page.close();
    }
  }
  assert.deepEqual([...offenders], []);
});

test("the homepage loads no stylesheet, and the head names each script that it loads at once, as a script or a modulepreload link", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: phone });
  const loaded: { file: string; type: string }[] = [];
  page.on("request", (request) => loaded.push({ file: new URL(request.url()).pathname, type: request.resourceType() }));
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  const preloaded = new Set(await page.locator('head link[rel="modulepreload"], head script[type="module"][src]').evaluateAll((elements) => elements.map((element) => element.getAttribute("href") ?? element.getAttribute("src") ?? "")));
  await page.close();
  assert.deepEqual(loaded.filter(({ type }) => type === "stylesheet"), []);
  const scripts = loaded.filter(({ type, file }) => type === "script" && file.startsWith("/assets/")).map(({ file }) => file);
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

test("with its scripts blocked, each page with tabs or a code explorer has the roles that agents rely on", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const axe = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  const run = `axe.run(document, { runOnly: { type: "rule", values: ${JSON.stringify(agentRules)} } }).then((result) => result.violations.map((violation) => violation.id + ": " + violation.nodes.length))`;
  for (const [path, role] of [
    ["/docs/quick-start/", "tab"],
    ["/examples/core-ts/", "treeitem"],
  ] as const) {
    const page = await openPage(browser, { viewport: phone });
    await page.route(`${origin}/assets/**/*.js`, (route) => route.abort());
    await page.goto(`${origin}${path}`, { waitUntil: "load" });
    assert.ok((await page.locator(`[role="${role}"]`).count()) > 0, `${path} has the role ${role} in its HTML`);
    await page.addScriptTag({ content: axe });
    const violations: unknown = await page.evaluate(run);
    await page.close();
    assert.deepEqual(violations, [], path);
  }
});

test("each docs page shows Edit page and Report issue once, at every width", async () => {
  if (browser === undefined) throw new Error("No browser.");
  for (const viewport of viewports) {
    for (const path of ["/docs/quick-start/", "/examples/core-ts/", "/spec/catalog/"]) {
      const page = await openPage(browser, { viewport });
      await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
      for (const name of ["Edit page", "Report issue"]) {
        const links = page.getByRole("link", { name });
        assert.equal(await links.count(), 1, `${path} at ${viewport.width}px has one ${name} link`);
        assert.ok(await links.isVisible(), `${path} at ${viewport.width}px shows ${name}`);
      }
      await page.close();
    }
  }
});

test("on a phone, the 404 page centres its message", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: phone });
  await page.goto(`${origin}/404.html`, { waitUntil: "networkidle" });
  for (const selector of ["h1", ".tagline"]) {
    const { align, middle } = await page.locator(selector).evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { align: getComputedStyle(element).textAlign, middle: box.left + box.width / 2 };
    });
    assert.equal(align, "center", selector);
    assert.ok(Math.abs(middle - phone.width / 2) < 2, `${selector} is in the middle of the screen: ${middle}`);
  }
  await page.close();
});

test("the table of contents reads no layout when a docs page starts, and marks the heading at the top", async () => {
  if (browser === undefined) throw new Error("No browser.");
  for (const viewport of viewports) {
    const page = await openPage(browser, { viewport });
    await page.addInitScript(() => {
      const reads: string[] = [];
      Reflect.set(window, "layoutReads", reads);
      let observing = 0;
      const NativeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeObserver {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            observing += 1;
            try {
              callback(entries, observer);
            } finally {
              observing -= 1;
            }
          });
        }
      };
      const read: unknown = Reflect.get(Element.prototype, "getBoundingClientRect");
      if (typeof read !== "function") throw new Error("No getBoundingClientRect.");
      Object.defineProperty(Element.prototype, "getBoundingClientRect", {
        value(this: Element): DOMRect {
          if (observing === 0) reads.push(new Error().stack ?? "");
          const rect: unknown = Reflect.apply(read, this, []);
          if (!(rect instanceof DOMRect)) throw new Error("getBoundingClientRect gave no DOMRect.");
          return rect;
        },
      });
    });
    await page.goto(`${origin}/docs/quick-start/`, { waitUntil: "networkidle" });
    await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve())));
    const reads = await page.evaluate((): unknown => Reflect.get(window, "layoutReads"));
    assert.deepEqual(reads, [], `at ${viewport.width}px`);

    const toc = viewport === phone ? ".mobile-toc" : ".toc";
    const target = await page.locator(`${toc} a`).nth(2).getAttribute("href");
    if (target === null) throw new Error("The table of contents has no third link.");
    await page.locator(target).evaluate((heading) => heading.scrollIntoView({ block: "start" }));
    await page.locator(`${toc} a[aria-current="true"][href="${target}"]`).waitFor({ state: "attached" });
    await page.close();
  }
});

test("the homepage passes every rule of axe-core, the experimental rules too", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const axe = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  const everyRule = `axe.run(document, { runOnly: { type: "rule", values: axe.getRules().map((rule) => rule.ruleId) } }).then((result) => result.violations.map((violation) => violation.id + ": " + violation.nodes.map((node) => node.target.join(" ")).join(", ")))`;
  for (const viewport of viewports) {
    const page = await openPage(browser, { viewport });
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.addScriptTag({ content: axe });
    const violations: unknown = await page.evaluate(everyRule);
    await page.close();
    assert.deepEqual(violations, [], `at ${viewport.width}px`);
  }
});
