import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { dist, serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

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

test("the build writes the homepage and the docs", async () => {
  const home = await readFile(join(dist, "index.html"), "utf8");
  assert.match(home, /data-plate/);
  for (const surface of ["CLI", "MCP", "WebMCP", "HTTP", "TypeScript"]) assert.ok(home.includes(`>${surface}<`), surface);
  await stat(join(dist, "docs/index.html"));
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 400, height: 860 },
]) {
  test(`the homepage renders at ${viewport.width}px with no errors and no sideways scroll`, async () => {
    if (browser === undefined) throw new Error("No browser.");
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });

    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width);
    await page.locator("[data-plate].is-live").waitFor({ timeout: 10000 });
    const plate = await page.locator("[data-plate] canvas").boundingBox();
    assert.ok(plate !== null && plate.width >= viewport.width - 1, "the living plate fills the hero");

    const docs = page.locator('a.button-acid[href="/docs/"]').first();
    await docs.click();
    await page.waitForURL(`${origin}/docs/`);
    assert.equal(await page.locator("h1").first().textContent(), "Introduction");
    await page.close();
  });
}

test("reduced motion keeps the hero still and stops the animations", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("[data-plate].is-live").count(), 0);
  assert.ok(await page.locator("[data-plate] img").isVisible());
  const animation = await page.locator(".hero-expansion").first().evaluate((element) => getComputedStyle(element).animationName);
  assert.equal(animation, "none");
  await page.close();
});
