import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { axeViolations } from "./axe.ts";
import { openPage, waitForHydration } from "./github.ts";
import { serveDist } from "./static-server.ts";
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

const acid = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--palette-acid-400)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`at ${viewport.width}px, the search box is one input with the border of the site, and shows results and an empty state`, async () => {
    if (browser === undefined) throw new Error("No browser.");
    const page = await openPage(browser, { viewport });
    await page.goto(`${origin}/docs/quick-start/`, { waitUntil: "networkidle" });
    await waitForHydration(page);
    const stylesheets = await page.locator('link[rel="stylesheet"]').count();
    await page.locator(".search-button").click();
    const input = page.locator("#search-input");
    await input.waitFor();
    assert.equal(await page.locator('link[rel="stylesheet"]').count(), stylesheets, "the CSS of the search is in the page");

    const bar = await page.locator(".search-bar").evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return { border: style.borderTopColor, width: style.borderTopWidth, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } };
    });
    const field = await input.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return { background: style.backgroundColor, border: style.borderTopWidth, outline: style.outlineStyle, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } };
    });
    assert.equal(bar.border, await acid(page), "the focused search bar has the acid border");
    assert.equal(bar.width, "1px");
    assert.deepEqual({ background: field.background, border: field.border, outline: field.outline }, { background: "rgba(0, 0, 0, 0)", border: "0px", outline: "none" }, "the input draws nothing over the bar");
    assert.ok(field.box.left >= bar.box.left && field.box.right <= bar.box.right && field.box.top >= bar.box.top && field.box.bottom <= bar.box.bottom, "the input is inside the bar");

    await input.fill("catalog");
    const first = page.locator(".search-dialog .result").first();
    await first.waitFor();
    assert.equal(await first.evaluate((element) => getComputedStyle(element).borderTopColor), await acid(page), "the selected result has the acid border");

    await input.fill("zzqqxx");
    const empty = page.locator(".search-dialog .no-results");
    await empty.waitFor();
    assert.equal(await empty.locator("strong").evaluate((element) => getComputedStyle(element).color), await acid(page));
    await page.close();
  });
}

test("the search marks the words that match, Enter goes to the selected result with no new document, Control+K opens the search and Escape closes it", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${origin}/docs/quick-start/`, { waitUntil: "networkidle" });
  await waitForHydration(page);
  await page.evaluate(() => document.documentElement.setAttribute("data-same-document", ""));
  await page.keyboard.press("Control+k");
  const input = page.locator("#search-input");
  await input.waitFor();
  await input.fill("conformance");
  const first = page.locator(".search-dialog .result").first();
  await first.locator("mark").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.pathname !== "/docs/quick-start/");
  assert.equal(await page.evaluate(() => location.pathname + location.search + location.hash), "/docs/concepts/conformance/", "Enter goes to the first result: the section of the page, which starts at its first heading");
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-same-document")), true);
  await page.keyboard.press("Control+k");
  await input.waitFor();
  await page.keyboard.press("Escape");
  await input.waitFor({ state: "hidden" });
  assert.deepEqual(problems, []);
  await page.close();
});

const searchIndexRequests = (page: Page): string[] => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/search\.[\w-]+\.json$/.test(new URL(request.url()).pathname)) requests.push(request.url());
  });
  return requests;
};

const openDocsPage = async (path = "/docs/quick-start/"): Promise<{ readonly page: Page; readonly problems: string[]; readonly indexRequests: string[] }> => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  const indexRequests = searchIndexRequests(page);
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  await waitForHydration(page);
  return { page, problems, indexRequests };
};

const afterTwoFrames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("the open search is an entry of the history: Back closes only the search and keeps the scroll, and a result replaces the entry", async () => {
  const { page, problems } = await openDocsPage();
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForFunction(() => window.scrollY === 600);
  await page.evaluate(() => document.querySelector<HTMLElement>(".search-button")?.click());
  const input = page.locator("#search-input");
  await input.waitFor();
  assert.equal(await page.evaluate(() => location.pathname + location.search), "/docs/quick-start/?search");
  assert.equal(await page.evaluate(() => window.scrollY), 600, "opening the search keeps the scroll");

  await page.goBack();
  await input.waitFor({ state: "hidden" });
  await afterTwoFrames(page);
  assert.equal(await page.evaluate(() => location.pathname + location.search), "/docs/quick-start/");
  assert.equal(await page.evaluate(() => window.scrollY), 600, "Back closes the search and keeps the scroll");

  await page.keyboard.press("Control+k");
  await input.fill("conformance");
  await page.locator(".search-dialog .result").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.pathname !== "/docs/quick-start/");
  assert.equal(await page.evaluate(() => location.pathname + location.search + location.hash), "/docs/concepts/conformance/");
  await page.goBack();
  await page.waitForFunction(() => location.pathname === "/docs/quick-start/");
  assert.equal(await page.evaluate(() => location.search), "", "the result replaced the entry of the open search");
  assert.equal(await page.locator("#search-dialog[open]").count(), 0);

  await page.keyboard.press("Control+k");
  await input.waitFor();
  await page.keyboard.press("Escape");
  await input.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => location.pathname + location.search), "/docs/quick-start/", "Escape closes the search and leaves its entry");
  assert.deepEqual(problems, []);
  await page.close();
});

test("/ opens the search, but not in a text field", async () => {
  const { page, problems } = await openDocsPage();
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "text-field";
    document.body.prepend(field);
  });
  await page.focus("#text-field");
  await page.keyboard.press("/");
  assert.equal(await page.inputValue("#text-field"), "/");
  assert.equal(await page.locator("#search-dialog[open]").count(), 0);
  await page.evaluate(() => document.querySelector<HTMLElement>("#text-field")?.blur());
  await page.keyboard.press("/");
  await page.locator("#search-input").waitFor();
  assert.equal(await page.inputValue("#search-input"), "", "the slash opens the search and is not typed in it");
  assert.deepEqual(problems, []);
  await page.close();
});

test("before the app hydrates, a click opens the search field at once, and the text typed in it stays and gives results after hydration", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  let release = (): void => undefined;
  const scripts = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/assets\/[^/]+\.js$/, async (route) => {
    await scripts;
    await route.continue();
  });
  await page.goto(`${origin}/docs/quick-start/`, { waitUntil: "domcontentloaded" });
  await page.locator(".search-button").click();
  const input = page.locator("#search-dialog[open] #search-input");
  await input.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "search-input");
  await page.keyboard.type("conformance");
  assert.equal(await page.evaluate(() => Reflect.has(document.getElementById("app") ?? {}, "__vue_app__")), false, "the app has not hydrated");
  release();
  await waitForHydration(page);
  await page.locator(".search-dialog .result").first().waitFor();
  assert.equal(await input.inputValue(), "conformance");
  assert.equal(await page.evaluate(() => location.search), "?search", "the app takes the open search into the history");
  await page.goBack();
  await input.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => location.pathname + location.search), "/docs/quick-start/", "Back closes only the search");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("search-button")), true, "the focus comes back to the search button");
  assert.deepEqual(problems, []);
  await page.close();
});

test("with scripts blocked, the search button does nothing", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  await page.goto(`${origin}/docs/quick-start/`);
  await page.locator(".search-button").click();
  await page.keyboard.press("Control+k");
  assert.equal(await page.locator("#search-dialog[open]").count(), 0);
  assert.equal(await page.locator("#search-input").isVisible(), false);
  assert.equal(page.url(), `${origin}/docs/quick-start/`);
  await page.close();
});

test("the page loads the search index only when the search opens", async () => {
  const { page, problems, indexRequests } = await openDocsPage();
  await page.hover(".search-button");
  await page.focus(".search-button");
  await page.waitForLoadState("networkidle");
  assert.deepEqual(indexRequests, [], "a first visit, a pointer over the button and its focus load no byte of the index");
  await page.keyboard.press("Enter");
  await page.locator("#search-input").fill("catalog");
  await page.locator(".search-dialog .result").first().waitFor();
  assert.equal(indexRequests.length, 1);
  assert.deepEqual(problems, []);
  await page.close();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`at ${viewport.width}px, the open search with results passes every rule of axe-core`, async () => {
    if (browser === undefined) throw new Error("No browser.");
    const page = await openPage(browser, { viewport });
    await page.goto(`${origin}/docs/quick-start/`, { waitUntil: "networkidle" });
    await waitForHydration(page);
    await page.keyboard.press("Control+k");
    await page.locator("#search-input").fill("catalog");
    await page.locator(".search-dialog .result").nth(1).waitFor();
    await page.keyboard.press("ArrowDown");
    assert.deepEqual(await axeViolations(page, "every rule"), []);
    await page.locator(".search-action[aria-pressed]").click();
    await page.locator(".search-dialog .excerpt").first().waitFor();
    assert.deepEqual(await axeViolations(page, "every rule"), [], "with the detailed list");
    await page.close();
  });
}
