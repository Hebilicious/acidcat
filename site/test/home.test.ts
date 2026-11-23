import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser } from "playwright";

const dist = new URL("../dist/", import.meta.url).pathname;
const types: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".png": "image/png",
};

const resolveFile = async (url: string): Promise<string | undefined> => {
  const path = normalize(join(dist, decodeURIComponent(new URL(url, "http://site").pathname)));
  if (!path.startsWith(dist)) return undefined;
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory() === true) return join(path, "index.html");
  return info === undefined ? undefined : path;
};

const server = createServer((request, response) => {
  resolveFile(request.url ?? "/")
    .then(async (path) => {
      if (path === undefined) throw new Error("not found");
      const body = await readFile(path);
      response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
      response.end(body);
    })
    .catch(() => {
      response.writeHead(404);
      response.end();
    });
});

let origin = "";
let browser: Browser | undefined;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The server has no port.");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  const animation = await page.locator(".ornament svg").first().evaluate((element) => getComputedStyle(element).animationName);
  assert.equal(animation, "none");
  await page.close();
});
