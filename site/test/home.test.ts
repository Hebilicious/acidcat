import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page, Request } from "playwright";
import { openPage } from "./github.ts";
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
    const page = await openPage(browser, { viewport });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });

    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("-webkit-tap-highlight-color")), "rgba(0, 0, 0, 0)", "a tap does not flash the color of the browser");
    const wide = await page.locator(".console-code").evaluateAll((blocks) => blocks.filter((block) => block.scrollWidth > block.clientWidth + 1).length);
    assert.equal(wide, 0, "the code of Fig. 4 wraps, with no sideways scroll");
    await page.locator("[data-plate] canvas").waitFor({ state: "detached", timeout: 10000 });
    const still = await page.locator("[data-plate] img").boundingBox();
    assert.ok(still !== null && still.width >= viewport.width - 1, "with a software renderer, the still image fills the hero");

    const pending = await page.locator(".engine-stage").evaluate((stage) => {
      if (!(stage instanceof HTMLElement)) return { width: 0, height: 0 };
      stage.dataset["engine"] = "pending";
      stage.dataset["layout"] = innerWidth > 900 ? "wide" : "tall";
      const box = stage.getBoundingClientRect();
      delete stage.dataset["engine"];
      return { width: box.width, height: box.height };
    });
    const machine = viewport.width > 900 ? 624 / 1200 : 1170 / 500;
    assert.ok(Math.abs(pending.height - pending.width * machine) < 1, `while Fig. 1 loads, its stage has the height of the machine: ${pending.height} for ${pending.width}`);

    const docs = page.locator('a.button-acid[href="/docs/"]').first();
    await docs.click();
    await page.waitForURL(`${origin}/docs/`);
    await page.locator("h1#_top").waitFor();
    assert.equal(await page.locator("h1").first().textContent(), "Introduction");
    await page.close();
  });
}

test("at 960px, the hero shows the phone plate with the phone framing, as at 959px", async () => {
  const hero = async (width: number) => {
    if (browser === undefined) throw new Error("No browser.");
    const page = await openPage(browser, { viewport: { width, height: 900 } });
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => (document.querySelector<HTMLElement>("[data-plate]")?.style.getPropertyValue("--plate-position") ?? "") !== "");
    const { plate, position } = await page.locator("[data-plate]").evaluate((root) => ({
      plate: root.querySelector("img")?.currentSrc ?? "",
      position: root instanceof HTMLElement ? root.style.getPropertyValue("--plate-position") : "",
    }));
    await page.close();
    return { plate: new URL(plate).pathname, position };
  };
  const [narrow, edge, desktop] = [await hero(959), await hero(960), await hero(961)];
  assert.match(edge.plate, /^\/assets\/phone/);
  assert.match(desktop.plate, /^\/assets\/plate/);
  assert.notEqual(edge.position, "");
  assert.equal(edge.position, narrow.position);
});

test("reduced motion keeps the hero still and stops the animations", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { reducedMotion: "reduce" });
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("[data-plate].is-live").count(), 0);
  assert.ok(await page.locator("[data-plate] img").isVisible());
  const animation = await page.locator(".hero-expansion").first().evaluate((element) => getComputedStyle(element).animationName);
  assert.equal(animation, "none");
  await page.close();
});

/** Each group of the files that the homepage fetches ahead when it is idle, by its budget. */
const prefetchGroups = [
  { name: "search dialog ahead", pattern: /^\/assets\/(SearchDialog\.[\w-]+\.js|search\.[\w-]+\.css)$/ },
  { name: "stylesheet ahead", pattern: /\.css$/ },
  { name: "pages ahead", pattern: /\.js$/ },
] as const;

/** An image of the hero in any format. The scripts of the hero have names that start the same way. */
const isPlate = (file: string): boolean => /^\/assets\/(phone|plate)/.test(file) && !/\.(js|css)$/.test(file);

test("on a phone, the homepage loads less than its budget of bytes before the reader acts", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 400, height: 860 } });
  const requests: Promise<{ file: string; type: string; size: number }>[] = [];
  const finished = new Set<string>();
  const measure = (request: Request): void => {
    finished.add(request.url());
    requests.push(request.sizes().then(({ responseBodySize }) => ({ file: new URL(request.url()).pathname, type: request.resourceType(), size: responseBodySize })));
  };
  page.on("requestfinished", measure);
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.locator("[data-plate] canvas").waitFor({ state: "detached", timeout: 10000 });
  // The page adds the prefetch links of a group in one task, when it is idle. Each group must have its links, and each link must have finished.
  const prefetches = await page.waitForFunction(
    (groups) => {
      const hrefs = [...document.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"]')].map((link) => link.href);
      const present = groups.every(([, pattern]) => hrefs.some((href) => new RegExp(pattern).test(new URL(href).pathname)));
      const done = hrefs.every((href) => performance.getEntriesByName(href).length > 0);
      return present && done ? hrefs : undefined;
    },
    prefetchGroups.map(({ name, pattern }) => [name, pattern.source] as const),
  );
  const prefetched = (await prefetches.jsonValue()) ?? [];
  while (prefetched.some((href) => !finished.has(href))) await page.waitForEvent("requestfinished");
  // The size of a request that finishes later would be read after the page closes, and that read rejects.
  page.off("requestfinished", measure);
  const loaded = await Promise.all(requests);
  const files = loaded.map(({ file }) => file);
  const bytes = new Map<string, number>();
  const group = (file: string, type: string) => (type === "other" ? (prefetchGroups.find(({ pattern }) => pattern.test(file))?.name ?? "other") : type);
  for (const { file, type, size } of loaded) bytes.set(group(file, type), (bytes.get(group(file, type)) ?? 0) + size);
  for (const { name } of prefetchGroups) assert.ok((bytes.get(name) ?? 0) > 0, `the page fetches ahead ${name}`);

  const plates = files.filter(isPlate);
  assert.equal(plates.length, 1, `the hero loads one plate, not ${plates.join(" and ")}`);
  assert.match(plates[0] ?? "", /^\/assets\/phone-840\.[\w-]+\.avif$/, "on a phone, the hero is the phone plate in AVIF");
  assert.deepEqual(files.filter((file) => /^\/assets\/(clean|data)\./.test(file)), [], "a software renderer loads no texture of the hero");
  assert.deepEqual(files.filter((file) => /plate-renderer/.test(file)), [], "a software renderer loads no renderer of the hero");
  assert.deepEqual(files.filter((file) => /catalog-engine|webgpu-pass/.test(file)), [], "no renderer loads before its figure is near");
  assert.deepEqual(files.filter((file) => file.endsWith(".woff2") && !/-core\.[\w-]+\.woff2$/.test(file)), [], "only the core of each font");
  const phonePlate = 88_000;
  const fontCores = 170_000;
  const vaporpressHomepageBelowVitePress = 166_000;
  const homepageWithItsCss = 176_000;
  const starCount = 1_000;
  const pagesOfEachSectionInTheHeaderAndTheDocsLayout = 111_000;
  const cssOfTheDocs = 39_500;
  const scriptAndCssOfTheSearchDialog = 15_000;
  const budget: Record<string, number> = {
    image: phonePlate,
    font: fontCores,
    script: vaporpressHomepageBelowVitePress,
    document: homepageWithItsCss,
    fetch: starCount,
    "pages ahead": pagesOfEachSectionInTheHeaderAndTheDocsLayout,
    "stylesheet ahead": cssOfTheDocs,
    "search dialog ahead": scriptAndCssOfTheSearchDialog,
  };
  for (const [type, size] of bytes) assert.ok(size <= (budget[type] ?? 0), `${type}: ${size} bytes, budget ${budget[type] ?? 0}`);
  await page.close();
});

test("each page preloads every font face that it loads, and the homepage preloads no other", async () => {
  if (browser === undefined) throw new Error("No browser.");
  for (const path of ["/", "/docs/", "/spec/catalog/", "/packages/"]) {
    const page: Page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
    const loaded = new Set<string>();
    page.on("requestfinished", (request) => {
      const file = new URL(request.url()).pathname;
      if (file.endsWith(".woff2")) loaded.add(file);
    });
    await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
    const preloaded = new Set<string>(await page.locator('link[rel="preload"][as="font"]').evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? "")));
    assert.deepEqual([...loaded].filter((file) => !preloaded.has(file)), [], `${path} loads a face that it does not preload`);
    if (path === "/") assert.deepEqual([...preloaded].filter((file) => !loaded.has(file)), [], "the homepage preloads a face that it does not use");
    await page.close();
  }
});
