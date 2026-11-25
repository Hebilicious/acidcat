import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { openPage, waitForHydration } from "./github.ts";
import { builtPages, dist, serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

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

const open = async (origin: string, path: string, viewport = { width: 1440, height: 900 }): Promise<{ readonly page: Page; readonly problems: string[] }> => {
  assert.ok(browser);
  const page = await openPage(browser, { viewport });
  // The packages page asks each registry for its latest version. The test blocks the requests, so it needs no network.
  await page.route(/^https:\/\/(?!api\.github\.com\/)/, (route) => route.abort());
  const problems: string[] = [];
  page.on("console", (message) => {
    if ((message.type() === "error" || message.type() === "warning") && !message.text().includes("ERR_FAILED") && !message.text().includes("No available adapters")) problems.push(`${path}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`${path}: ${error.message}`));
  await page.goto(`${origin}${path}`);
  await waitForHydration(page);
  return { page, problems };
};

describe("the layout of the site", () => {
  test("hydrates each page with no error and no mismatch", async () => {
    assert.ok(site);
    const problems: string[] = [];
    for (const file of await builtPages()) {
      if (file.endsWith("/404.html")) continue;
      const opened = await open(site.origin, file.slice(dist.length - 1).replace(/index\.html$/, ""));
      problems.push(...opened.problems);
      await opened.page.close();
    }
    assert.deepEqual(problems, []);
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
