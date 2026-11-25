import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";
import sharp from "sharp";
import type { Browser, Page } from "playwright";
import { checkRolesWithScriptsBlocked } from "./axe.ts";
import { openPage, waitForHydration } from "./github.ts";
import { dist, serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

// The docs, the examples and the specification move to vaporpress before the homepage and the
// packages page. Until VitePress goes, these tests compare the build of the framework with the build of VitePress.
const framework = new URL("../.out/framework/", import.meta.url).pathname;
const notMoved: ReadonlySet<string> = new Set(["index.html", "packages/index.html"]);

const htmlFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => relative(root, `${entry.parentPath}/${entry.name}`))
    .sort();
};

const urlOf = (file: string): string => (file === "404.html" ? "/404.html" : `/${file.replace(/index\.html$/, "")}`);

let browser: Browser | undefined;
let vitepress: StaticServer | undefined;
let site: StaticServer | undefined;

before(async () => {
  vitepress = await serveDist();
  site = await serveDist(framework);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await vitepress?.close();
  await site?.close();
});

const open = async (origin: string, path: string, viewport = { width: 1440, height: 900 }): Promise<{ readonly page: Page; readonly problems: string[] }> => {
  assert.ok(browser);
  const page = await openPage(browser, { viewport });
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(`${path}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`${path}: ${error.message}`));
  await page.goto(`${origin}${path}`);
  await waitForHydration(page);
  return { page, problems };
};

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** For the antialiasing of the GPU. */
const tolerance = 1;

const pixels = async (images: readonly Buffer[]): Promise<Buffer> => Buffer.concat(await Promise.all(images.map((image) => sharp(image).raw().toBuffer())));

const differentPixels = (expected: Buffer, actual: Buffer): number => {
  if (expected.length !== actual.length) return Math.max(expected.length, actual.length);
  let count = 0;
  for (let index = 0; index < expected.length; index += 1) {
    if (Math.abs((expected[index] ?? 0) - (actual[index] ?? 0)) > tolerance) count += 1;
  }
  return count;
};

/** Chromium shades the edges of the diamond under the header, a square that CSS turns by 45 degrees, a few levels apart from one render to the next. */
const hiddenRegions = (page: Page): Promise<readonly Box[]> =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".site-search, .site-search *")].map((element) => element.getBoundingClientRect());
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const search = { x: left + scrollX, y: top + scrollY, width: Math.max(...boxes.map((box) => box.right)) - left, height: Math.max(...boxes.map((box) => box.bottom)) - top };
    const header = document.querySelector(".page > .header")?.getBoundingClientRect();
    const diamond = header === undefined ? [] : [{ x: header.left + header.width / 2 - 8 + scrollX, y: header.bottom - 8 + scrollY, width: 16, height: 16 }];
    return [search, ...diamond];
  });

/** One screenshot of a long page at full height needs gigabytes of memory. */
const segments = async (page: Page, width: number, hidden: readonly Box[]): Promise<readonly Buffer[]> => {
  await page.evaluate((boxes) => {
    for (const box of boxes) {
      const cover = document.createElement("div");
      cover.className = "hidden-region";
      Object.assign(cover.style, { position: "absolute", left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
      document.body.append(cover);
    }
  }, hidden);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const parts: Buffer[] = [];
  for (let y = 0; y < height; y += 2000) {
    parts.push(await page.screenshot({ fullPage: true, clip: { x: 0, y, width, height: Math.min(2000, height - y) }, mask: [page.locator(".hidden-region")], animations: "disabled" }));
  }
  return parts;
};

describe("the docs on vaporpress", () => {
  test("have every page of the docs, the examples and the specification that VitePress builds", async () => {
    const expected = (await htmlFiles(dist)).filter((file) => !notMoved.has(file));
    assert.deepEqual(await htmlFiles(framework), expected);
  });

  test("hydrate each page with no error and no mismatch", async () => {
    assert.ok(site);
    const problems: string[] = [];
    for (const file of await htmlFiles(framework)) {
      if (file === "404.html") continue;
      const opened = await open(site.origin, urlOf(file));
      problems.push(...opened.problems);
      await opened.page.close();
    }
    assert.deepEqual(problems, []);
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`look the same as the VitePress pages at ${viewport.width}px, except the search, which has not moved`, async () => {
      assert.ok(site && vitepress);
      for (const path of ["/docs/quick-start/", "/examples/core-ts/", "/spec/catalog/"]) {
        const shots: (readonly Buffer[])[] = [];
        let hidden: readonly Box[] | undefined;
        for (const origin of [vitepress.origin, site.origin]) {
          const { page } = await open(origin, path, viewport);
          await page.evaluate(() => document.fonts.ready);
          hidden ??= await hiddenRegions(page);
          shots.push(await segments(page, viewport.width, hidden));
          await page.close();
        }
        assert.equal(shots.length, 2);
        const [expected, actual] = await Promise.all(shots.map((shot) => pixels(shot)));
        assert.ok(expected !== undefined && actual !== undefined);
        assert.equal(differentPixels(expected, actual), 0, `${path} at ${viewport.width}px differs from the VitePress page.`);
      }
    });
  }

  test("with their scripts blocked, have the roles of their tabs and code explorers in their HTML", async () => {
    assert.ok(browser && site);
    await checkRolesWithScriptsBlocked(browser, site.origin);
  });

  test("link Edit page to the source of the page, and Report issue to a new issue", async () => {
    assert.ok(site);
    const { page: docs } = await open(site.origin, "/docs/quick-start/");
    assert.equal(await docs.getAttribute(".page-actions a:has-text('Edit page')", "href"), "https://github.com/Hebilicious/acidcat/edit/main/site/content/docs/quick-start.md");
    assert.match((await docs.getAttribute(".page-actions a:has-text('Report issue')", "href")) ?? "", /^https:\/\/github\.com\/Hebilicious\/acidcat\/issues\/new\?title=Site%3A\+Quick\+start/);
    await docs.close();
    const { page: spec } = await open(site.origin, "/spec/catalog/");
    assert.equal(await spec.getAttribute(".page-actions a:has-text('Edit page')", "href"), "https://github.com/Hebilicious/acidcat/edit/main/spec/catalog.md");
    await spec.close();
  });

  test("change the page with no new document, with the sidebar and the table of contents of the new page", async () => {
    assert.ok(site);
    const { page, problems } = await open(site.origin, "/docs/");
    await page.evaluate(() => document.documentElement.setAttribute("data-same-document", ""));
    await page.click(".sidebar-pane a[href='/docs/quick-start/']");
    await page.waitForFunction(() => document.title === "Quick start | AcidCat");
    assert.equal(await page.getAttribute(".sidebar-pane a[aria-current='page']", "href"), "/docs/quick-start/");
    assert.ok((await page.locator(".toc a[href='#1-install']").count()) === 1);
    await page.click(".site-links a[href='/spec/']");
    await page.waitForFunction(() => document.querySelector(".page")?.getAttribute("data-section") === "spec");
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-same-document")), true);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("start the tabs of a page after a page change", async () => {
    assert.ok(site);
    const { page, problems } = await open(site.origin, "/docs/");
    await page.click(".sidebar-pane a[href='/docs/quick-start/']");
    await page.waitForFunction(() => document.title === "Quick start | AcidCat");
    const tabs = page.locator('[role="tablist"]').first().locator('[role="tab"]');
    await tabs.nth(1).click();
    assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
    assert.deepEqual(problems, []);
    await page.close();
  });
});
