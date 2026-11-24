import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { TestContext } from "node:test";
import { chromium, firefox, webkit } from "playwright";
import type { Browser, BrowserType, Page } from "playwright";
import { openPage, waitForHydration } from "./github.ts";
import { serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

let origin = "";
let server: StaticServer | undefined;

before(async () => {
  server = await serveDist();
  origin = server.origin;
});

after(async () => {
  await server?.close();
});

const errorsOf = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
};

for (const engine of [chromium, firefox, webkit] satisfies BrowserType[]) {
  describe(`in ${engine.name()}`, () => {
    let browser: Browser | undefined;
    let missing = "";
    let page: Page | undefined;
    let errors: string[] = [];

    // CI installs every engine. Another host can lack the system libraries of one, as WebKit needs those of Ubuntu.
    before(async () => {
      browser = await engine.launch().catch((error: unknown) => {
        if (process.env["CI"] !== undefined) throw error;
        missing = `${engine.name()} does not start on this host. Run "playwright install-deps ${engine.name()}" on Ubuntu or Debian.`;
        return undefined;
      });
    });

    after(async () => {
      await page?.close();
      await browser?.close();
    });

    const open = async (t: TestContext, path: string): Promise<Page | undefined> => {
      if (browser === undefined) {
        t.skip(missing);
        return undefined;
      }
      await page?.close();
      page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      errors = errorsOf(page);
      await page.goto(`${origin}${path}`, { waitUntil: "load" });
      await waitForHydration(page).catch(() => assert.fail(`the page hydrates. Errors: ${errors.join("; ")}`));
      return page;
    };

    test("the homepage hydrates, its Fig. 3 tabs respond, and a docs link changes the page with no new document", async (t) => {
      const home = await open(t, "/");
      if (home === undefined) return;
      await home.locator("#surfaces-title").evaluate((title) => title.scrollIntoView({ block: "center", behavior: "instant" }));
      const tab = home.locator('.surface-tabs [role="tab"][data-surface="mcp"]');
      await tab.click();
      await home.waitForFunction(() => document.querySelector('.surface-tabs [data-surface="mcp"]')?.getAttribute("aria-selected") === "true");
      await home.evaluate(() => Reflect.set(window, "sameDocument", true));
      await home.locator('a.button-acid[href="/docs/"]').first().click();
      await home.waitForURL(`${origin}/docs/`);
      await home.locator("h1#_top").waitFor();
      assert.ok(await home.evaluate(() => "sameDocument" in window), "the page changes in the same document");
      assert.deepEqual(errors, []);
    });

    test("the language tabs switch, and the search finds a page", async (t) => {
      const docs = await open(t, "/docs/quick-start/");
      if (docs === undefined) return;
      const group = docs.locator(".tabs").first();
      const second = group.locator('[role="tab"]').nth(1);
      await second.click();
      assert.equal(await second.getAttribute("aria-selected"), "true");
      const panel = await second.getAttribute("href");
      assert.ok(panel !== null && (await docs.locator(panel).isVisible()), "the panel of the selected tab shows");

      await docs.locator(".search-button").click();
      await docs.locator("#localsearch-input").fill("catalog");
      await docs.locator(".VPLocalSearchBox .result").first().waitFor();
      assert.deepEqual(errors, []);
    });

    test("the code explorer selects a file", async (t) => {
      const examples = await open(t, "/examples/core-ts/");
      if (examples === undefined) return;
      await examples.locator('[role="treeitem"][data-path="apis"] > .row').click();
      await examples.locator('[role="treeitem"][data-path="apis/graphql.ts"]').click();
      await examples.waitForFunction(() => document.querySelector("[data-current-path]")?.textContent === "examples/aircon/apis/graphql.ts");
      await examples.locator("[data-source] .line").nth(5).waitFor();
      assert.deepEqual(errors, []);
    });
  });
}
