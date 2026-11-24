import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

// Vite and @vitejs/plugin-vue keep caches for the process, so the dev server runs in a process apart from the build of site.test.ts.
const fixture = fileURLToPath(new URL("./fixture/", import.meta.url));

describe("the dev server", () => {
  test("serves a page that renders in the browser and changes pages", async () => {
    const browser = await chromium.launch();
    const server = await createServer({ configFile: join(fixture, "vite.config.ts"), server: { port: 0 }, logLevel: "warn" });
    await server.listen();
    try {
      const url = server.resolvedUrls?.local[0];
      assert.ok(url !== undefined);
      const page = await browser.newPage();
      await page.goto(`${url}guide/`);
      await page.waitForSelector("#the-guide");
      assert.equal(await page.title(), "Guide | Fixture");
      await page.click(".counter");
      assert.equal(await page.textContent(".counter"), "Count 6");
      await page.click("text=link to the long page");
      await page.waitForSelector("#section-12");
      assert.equal(await page.title(), "Long page | Fixture");
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
