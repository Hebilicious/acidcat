import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { agentRules, axeViolations, checkRolesWithScriptsBlocked } from "./axe.ts";
import { openPage, waitForHydration } from "./github.ts";
import { dist, serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

const pages = ["/", "/docs/", "/spec/catalog/", "/packages/"];
const phone = { width: 400, height: 860 };
const phoneThatShowsTheHeroOnly = { width: 400, height: 700 };
const viewports = [phone, { width: 1440, height: 900 }];

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

test("the homepage loads no stylesheet, names each script that it loads before a figure comes near as a preload link of its head, and starts the scripts from one inline script", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: phoneThatShowsTheHeroOnly });
  const loaded: { file: string; type: string }[] = [];
  page.on("request", (request) => loaded.push({ file: new URL(request.url()).pathname, type: request.resourceType() }));
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  const preloaded = new Set(await page.locator('head link[rel="preload"][as="script"]').evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? "")));
  const moduleScripts = await page.locator('script[type="module"]').count();
  await page.close();
  assert.deepEqual(loaded.filter(({ type }) => type === "stylesheet"), []);
  const scripts = loaded.filter(({ type, file }) => type === "script" && file.startsWith("/assets/")).map(({ file }) => file);
  assert.ok(scripts.length > 0, "the homepage loads its scripts");
  assert.deepEqual(scripts.filter((file) => !preloaded.has(file)), []);
  assert.equal(moduleScripts, 0, "the inline script imports the module scripts after the first paint");
});

const starts: Record<string, () => void> = {
  "a browser without PerformanceObserver": () => Reflect.deleteProperty(window, "PerformanceObserver"),
  "a browser without paint timing": () => Object.defineProperty(PerformanceObserver, "supportedEntryTypes", { get: () => ["navigation"] }),
  "a browser that reports no paint": () => Object.defineProperty(PerformanceObserver.prototype, "observe", { value: () => undefined }),
  "a background tab or a prerender": () => Object.defineProperty(Document.prototype, "visibilityState", { get: () => "hidden" }),
};

for (const [browserState, setup] of Object.entries(starts)) {
  test(`the homepage starts its scripts in ${browserState}`, async () => {
    if (browser === undefined) throw new Error("No browser.");
    const page = await openPage(browser);
    await page.addInitScript(setup);
    await page.goto(`${origin}/`);
    await waitForHydration(page);
    await page.close();
  });
}

test("the homepage runs its scripts when the reader comes back to it from another document", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser);
  await page.goto(`${origin}/`);
  await waitForHydration(page);
  await page.goto(`${origin}/robots.txt`);
  await page.goBack();
  await waitForHydration(page);
  await page.close();
});

test("no script imports the chunk of a page, so a page that starts from its lean chunk runs each module once", async () => {
  const scripts = (await readdir(join(dist, "assets"), { recursive: true })).filter((file) => file.endsWith(".js"));
  const importsOfPages = await Promise.all(
    scripts.map(async (file) => [...(await readFile(join(dist, "assets", file), "utf8")).matchAll(/from"([^"]+\.md\.[\w-]+\.js)"/g)].map(([, chunk]) => `${file} imports ${chunk}`)),
  );
  assert.deepEqual(importsOfPages.flat(), []);
});

test("the accessibility tree of each page passes the rules that agents rely on", async () => {
  if (browser === undefined) throw new Error("No browser.");
  for (const viewport of viewports) {
    for (const path of pages) {
      const page = await openPage(browser, { viewport });
      await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
      const violations = await axeViolations(page, agentRules);
      await page.close();
      assert.deepEqual(violations, [], `${path} at ${viewport.width}px`);
    }
  }
});

test("with its scripts blocked, each page with tabs or a code explorer has the roles that agents rely on", async () => {
  if (browser === undefined) throw new Error("No browser.");
  await checkRolesWithScriptsBlocked(browser, origin);
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
  for (const viewport of viewports) {
    const page = await openPage(browser, { viewport });
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    const violations = await axeViolations(page, "every rule");
    await page.close();
    assert.deepEqual(violations, [], `at ${viewport.width}px`);
  }
});
