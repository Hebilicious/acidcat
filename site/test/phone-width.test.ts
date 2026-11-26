import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { openPage, waitForHydration } from "./github.ts";
import { serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

const widths = [360, 400, 414];

let browser: Browser | undefined;
let site: StaticServer | undefined;

before(async () => {
  site = await serveDist();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await site?.close();
});

const describeOverflow = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    if (root.scrollWidth <= root.clientWidth) return undefined;
    const scrolls = (element: Element) => getComputedStyle(element).overflowX !== "visible";
    const contained = (element: Element) => {
      for (let parent = element.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) if (scrolls(parent)) return true;
      return false;
    };
    const describe = (element: Element) => {
      const path: string[] = [];
      for (let node: Element | null = element; node !== null && node !== document.body && path.length < 4; node = node.parentElement) {
        path.unshift([node.localName, ...node.classList].join("."));
      }
      return `${path.join(" > ")} "${(element.textContent ?? "").trim().slice(0, 60)}"`;
    };
    let widest: { element: Element; right: number } | undefined;
    for (const element of document.body.querySelectorAll("*")) {
      const right = element.getBoundingClientRect().right;
      if (right > root.clientWidth && right > (widest?.right ?? 0) && !contained(element)) widest = { element, right };
    }
    return `${root.scrollWidth} px wide; widest element: ${widest === undefined ? "none found" : `${describe(widest.element)}, right edge at ${Math.round(widest.right)} px`}`;
  });

test("no page is wider than a phone viewport of 360, 400 or 414 px", async () => {
  assert.ok(site && browser);
  const { origin } = site;
  const routes = (await readFile(new URL("routes.txt", import.meta.url), "utf8")).split("\n").filter((line) => line !== "");
  const pages = await Promise.all(
    widths.map(async (width) => {
      assert.ok(browser);
      const page = await openPage(browser, { viewport: { width, height: 860 } });
      // The packages page asks each registry for its latest version. The test blocks the requests, so it needs no network.
      await page.route(/^https:\/\/(?!api\.github\.com\/)/, (route) => route.abort());
      return { width, page };
    }),
  );
  const offenders: string[] = [];
  for (const route of routes) {
    await Promise.all(
      pages.map(async ({ width, page }) => {
        await page.goto(`${origin}${route}`);
        await waitForHydration(page);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const found = await describeOverflow(page);
        if (found !== undefined) offenders.push(`${route} at ${width} px: ${found}`);
      }),
    );
  }
  await Promise.all(pages.map(({ page }) => page.close()));
  assert.deepEqual(offenders.sort(), []);
});
