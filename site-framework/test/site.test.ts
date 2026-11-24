import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { createBuilder } from "vite";
import { serve } from "./static-server.ts";

const fixture = fileURLToPath(new URL("./fixture/", import.meta.url));
const dist = join(fixture, "dist");

let origin = "";
let browser: Browser | undefined;
let close: (() => void) | undefined;

const readDist = (path: string): Promise<string> => readFile(join(dist, path), "utf8");

const assets = async (): Promise<ReadonlyMap<string, string>> => {
  const files = await readdir(join(dist, "assets"));
  return new Map(await Promise.all(files.map(async (file): Promise<[string, string]> => [file, await readDist(`assets/${file}`)])));
};

const chunkOf = (html: string): string => {
  const href = /<link rel="modulepreload" href="\/assets\/([^"]+)" data-page-chunk>/.exec(html)?.[1];
  assert.ok(href, "The page names its lean chunk.");
  return href;
};

const open = async (path: string, prepare?: (page: Page) => void): Promise<{ readonly page: Page; readonly problems: string[] }> => {
  assert.ok(browser);
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  prepare?.(page);
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(() => document.querySelector("#app")?.hasAttribute("data-v-app") === true);
  return { page, problems };
};

const markDocument = (page: Page): Promise<void> => page.evaluate(() => document.documentElement.setAttribute("data-same-document", ""));
const sameDocument = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.hasAttribute("data-same-document"));

before(async () => {
  const builder = await createBuilder({ configFile: join(fixture, "vite.config.ts"), logLevel: "warn" });
  await builder.buildApp();
  const served = await serve(dist);
  origin = served.origin;
  close = () => served.server.close();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  close?.();
});

describe("the static build", () => {
  test("writes every page with its title, its head and its content", async () => {
    const guide = await readDist("guide/index.html");
    assert.match(guide, /<title>Guide \| Fixture<\/title>/);
    assert.match(guide, /<meta name="description" content="How the fixture works." data-page-head>/);
    assert.match(guide, /<link rel="canonical" href="https:\/\/fixture.test\/guide\/" data-page-head>/);
    assert.match(guide, /<meta name="theme-color" content="#000000">/);
    assert.match(guide, /<h2 id="components-in-markdown">Components in Markdown<\/h2>/);
    assert.match(guide, /<button type="button" class="counter">Count 5<\/button>/);
    assert.match(guide, /<pre class="highlighted" data-language="ts" data-meta="title=&quot;example.ts&quot;">/);
    assert.match(await readDist("guide/long/index.html"), /<h2 id="section-12">Section 12<\/h2>/);
    assert.match(await readDist("index.html"), /<title>Home \| Fixture<\/title>/);
    assert.match(await readDist("404.html"), /<h1 id="page-not-found">Page not found<\/h1>/);
    const outside = await readDist("more/outside/index.html");
    assert.match(outside, /<h1 id="a-page-from-another-folder">A page from another folder<\/h1>/);
    chunkOf(outside);
  });

  test("names the lean chunk of each page, which leaves its static HTML to the DOM", async () => {
    const files = await assets();
    const leanLong = files.get(chunkOf(await readDist("guide/long/index.html")));
    assert.ok(leanLong !== undefined);
    assert.doesNotMatch(leanLong, /Words to fill the page/);
    const full = [...files.values()].filter((code) => code.includes("Words to fill the page"));
    assert.equal(full.length, 1, "One chunk, the one that a page change loads, has the static HTML of the long page.");
    const leanHome = files.get(chunkOf(await readDist("index.html")));
    assert.ok(leanHome !== undefined);
    assert.doesNotMatch(leanHome, /lean chunk leaves out/);
  });

  test("ships no virtual DOM renderer", async () => {
    const code = [...(await assets()).values()].join("\n");
    assert.doesNotMatch(code, /_vnode/, "The renderer of the virtual DOM keeps the tree of a container in _vnode.");
  });

  test("gives a page the data of its loader, and leaves the loader out", async () => {
    assert.match(await readDist("index.html"), /<p class="numbers">1, 2, 3 at build time<\/p>/);
    const code = [...(await assets()).values()].join("\n");
    assert.match(code, /at build time/);
    assert.doesNotMatch(code, /defineLoader/);
  });
});

describe("in the browser", () => {
  test("hydrates the first page with no change to the DOM, and its components respond", async () => {
    assert.ok(browser);
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });
    await page.addInitScript(() => {
      const changes: string[] = [];
      Object.assign(window, { domChanges: changes });
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of [...record.addedNodes, ...record.removedNodes]) if (node.nodeType === Node.ELEMENT_NODE) changes.push(node.nodeName);
        }
      });
      document.addEventListener("readystatechange", () => {
        if (document.readyState === "interactive") observer.observe(document, { childList: true, subtree: true });
      });
    });
    await page.goto(`${origin}/guide/`);
    await page.waitForFunction(() => document.querySelector("#app")?.hasAttribute("data-v-app") === true);
    const changes = await page.evaluate(() => {
      const value: unknown = Reflect.get(window, "domChanges");
      if (!Array.isArray(value)) return ["no record"];
      return value.filter((name): name is string => typeof name === "string" && name !== "LINK" && name !== "SCRIPT");
    });
    assert.deepEqual(changes, [], "Hydration adds and removes no element of the page.");
    await page.click(".counter");
    assert.equal(await page.textContent(".counter"), "Count 6");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("h1") ?? document.body).color), "rgb(1, 2, 3)");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("changes the page with no new document, and updates the title and the head", async () => {
    const { page, problems } = await open("/");
    await markDocument(page);
    await page.click(".to-guide");
    await page.waitForSelector("#the-guide");
    assert.equal(await sameDocument(page), true);
    assert.equal(await page.title(), "Guide | Fixture");
    assert.equal(await page.getAttribute('meta[name="description"]', "content"), "How the fixture works.");
    assert.equal(await page.getAttribute('link[rel="canonical"]', "href"), "https://fixture.test/guide/");
    assert.equal(await page.locator("[data-page-head]").count(), 2);
    await page.click(".counter");
    assert.equal(await page.textContent(".counter"), "Count 6");
    await page.goBack();
    await page.waitForSelector(".home-title");
    assert.equal(await sameDocument(page), true);
    assert.equal(await page.title(), "Home | Fixture");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("loads the page of a link in view before the click", async () => {
    const manifest: unknown = JSON.parse(await readDist(".vite/manifest.json"));
    const chunk: unknown = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "pages/guide/long.md") : undefined;
    const file: unknown = typeof chunk === "object" && chunk !== null ? Reflect.get(chunk, "file") : undefined;
    assert.equal(typeof file, "string");
    let prefetched: Promise<unknown> = Promise.resolve();
    const { page, problems } = await open("/", (page) => {
      prefetched = page.waitForResponse((response) => response.url() === `${origin}/${String(file)}`);
    });
    await prefetched;
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    await page.click("header a[href='/guide/long/']");
    await page.waitForSelector("#section-12");
    assert.deepEqual(requested.filter((url) => url.endsWith(".js")), [], "The page change loads no script: the chunk is already there.");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("restores the scroll position on the way back, and goes to the heading of a hash", async () => {
    const { page, problems } = await open("/guide/long/");
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForFunction(() => window.scrollY === 1500);
    // Playwright scrolls an element into view before a click, which would move the page that the router saves.
    await page.evaluate(() => document.querySelector<HTMLElement>("header a[href='/guide/']")?.click());
    await page.waitForSelector("#the-guide");
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await page.goBack();
    await page.waitForSelector("#section-12");
    await page.waitForFunction(() => window.scrollY === 1500);
    await page.goto(`${origin}/guide/`);
    await page.click("text=link to the long page");
    await page.waitForSelector("#section-12");
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/guide/long/#section-9";
      link.id = "hash-link";
      link.textContent = "Section 9";
      document.body.prepend(link);
    });
    await page.click("#hash-link");
    await page.waitForFunction(() => Math.abs(document.querySelector("#section-9")?.getBoundingClientRect().top ?? -1) < 2);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("hydrates a page whose file is outside the folder of the pages", async () => {
    const { page, problems } = await open("/more/outside/");
    await markDocument(page);
    await page.click("text=Home");
    await page.waitForSelector(".home-title");
    assert.equal(await sameDocument(page), true);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("serves the 404 page for a path that has no page", async () => {
    const { page, problems } = await open("/no/such/page/");
    assert.equal(await page.textContent("h1"), "Page not found");
    assert.equal(await page.title(), "Not found | Fixture");
    assert.deepEqual(
      problems.filter((problem) => !problem.includes("404")),
      [],
    );
    await page.click("text=Go home");
    await page.waitForSelector(".home-title");
    await page.close();
  });
});
