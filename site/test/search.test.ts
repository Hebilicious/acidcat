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
let framework: StaticServer | undefined;
let browser: Browser | undefined;

before(async () => {
  server = await serveDist();
  framework = await serveDist(new URL("../.out/framework/", import.meta.url).pathname);
  origin = server.origin;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
  await framework?.close();
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
    assert.equal(await page.locator('link[data-route="search"]').count(), 0, "the page loads the CSS of the search only when the search opens");
    await page.locator(".search-button").click();
    const input = page.locator("#localsearch-input");
    await input.waitFor();
    assert.equal(await page.locator('link[rel="stylesheet"][data-route="search"]').count(), 1);

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
    const first = page.locator(".VPLocalSearchBox .result").first();
    await first.waitFor();
    assert.equal(await first.evaluate((element) => getComputedStyle(element).borderTopColor), await acid(page), "the selected result has the acid border");

    await input.fill("zzqqxx");
    const empty = page.locator(".VPLocalSearchBox .no-results");
    await empty.waitFor();
    assert.equal(await empty.locator("strong").evaluate((element) => getComputedStyle(element).color), await acid(page));
    await page.close();
  });
}

const dialogStyles = (page: Page): Promise<number> => page.evaluate(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter((link) => link.href.includes("SearchDialog")).length);

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`on vaporpress at ${viewport.width}px, the search box is one input with the border of the site, finds a section, shows an empty state, and goes to a result with no new document`, async () => {
    if (browser === undefined || framework === undefined) throw new Error("No browser.");
    const page = await openPage(browser, { viewport });
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));
    await page.goto(`${framework.origin}/docs/quick-start/`, { waitUntil: "networkidle" });
    await waitForHydration(page);
    await page.evaluate(() => document.documentElement.setAttribute("data-same-document", ""));
    assert.equal(await dialogStyles(page), 0, "the page loads the CSS of the search only when the search opens");
    await page.locator(".search-button").click();
    const input = page.locator("#search-input");
    await input.waitFor();
    assert.equal(await dialogStyles(page), 1);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "search-input");

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

    await input.fill("zzqqxx");
    const empty = page.locator(".search-dialog .no-results");
    await empty.waitFor();
    assert.equal(await empty.locator("strong").evaluate((element) => getComputedStyle(element).color), await acid(page));

    await input.fill("conformance");
    const first = page.locator(".search-dialog .result").first();
    await first.waitFor();
    assert.equal(await first.evaluate((element) => getComputedStyle(element).borderTopColor), await acid(page), "the selected result has the acid border");
    assert.ok((await first.locator("mark").count()) > 0, "the result marks the words that match");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.pathname !== "/docs/quick-start/" && location.search === "");
    assert.equal(await page.locator(".search-dialog").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-same-document")), true);

    await page.keyboard.press("Control+k");
    await input.waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".search-dialog").waitFor({ state: "detached" });
    assert.deepEqual(problems, []);
    await page.close();
  });
}

const searchIndexRequests = (page: Page): string[] => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/search\.[\w-]+\.json$/.test(new URL(request.url()).pathname)) requests.push(request.url());
  });
  return requests;
};

const openDocsPage = async (path = "/docs/quick-start/"): Promise<{ readonly page: Page; readonly problems: string[]; readonly indexRequests: string[] }> => {
  if (browser === undefined || framework === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  const indexRequests = searchIndexRequests(page);
  await page.goto(`${framework.origin}${path}`, { waitUntil: "networkidle" });
  await waitForHydration(page);
  return { page, problems, indexRequests };
};

const afterTwoFrames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("on vaporpress, the open search is an entry of the history: Back closes only the search and keeps the scroll, and a result replaces the entry", async () => {
  const { page, problems } = await openDocsPage();
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForFunction(() => window.scrollY === 600);
  await page.evaluate(() => document.querySelector<HTMLElement>(".search-button")?.click());
  const input = page.locator("#search-input");
  await input.waitFor();
  assert.equal(await page.evaluate(() => location.pathname + location.search), "/docs/quick-start/?search");
  assert.equal(await page.evaluate(() => window.scrollY), 600, "opening the search keeps the scroll");

  await page.goBack();
  await page.locator(".search-dialog").waitFor({ state: "detached" });
  await afterTwoFrames(page);
  assert.equal(await page.evaluate(() => location.pathname + location.search), "/docs/quick-start/");
  assert.equal(await page.evaluate(() => window.scrollY), 600, "Back closes the search and keeps the scroll");

  await page.keyboard.press("Control+k");
  await input.fill("conformance");
  await page.locator(".search-dialog .result").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.pathname !== "/docs/quick-start/");
  await page.goBack();
  await page.waitForFunction(() => location.pathname === "/docs/quick-start/");
  assert.equal(await page.evaluate(() => location.search), "", "the result replaced the entry of the open search");
  assert.equal(await page.locator(".search-dialog").count(), 0);

  await page.keyboard.press("Control+k");
  await input.waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".search-dialog").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => location.pathname + location.search), "/docs/quick-start/", "Escape closes the search and leaves its entry");
  assert.deepEqual(problems, []);
  await page.close();
});

test("on vaporpress, / opens the search, but not in a text field", async () => {
  const { page, problems } = await openDocsPage();
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "text-field";
    document.body.prepend(field);
  });
  await page.focus("#text-field");
  await page.keyboard.press("/");
  assert.equal(await page.inputValue("#text-field"), "/");
  assert.equal(await page.locator(".search-dialog").count(), 0);
  await page.evaluate(() => document.querySelector<HTMLElement>("#text-field")?.blur());
  await page.keyboard.press("/");
  await page.locator("#search-input").waitFor();
  assert.equal(await page.inputValue("#search-input"), "", "the slash opens the search and is not typed in it");
  assert.deepEqual(problems, []);
  await page.close();
});

test("on vaporpress, the page loads the search index only when the search opens", async () => {
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
  test(`on vaporpress at ${viewport.width}px, the open search with results passes every rule of axe-core`, async () => {
    if (browser === undefined || framework === undefined) throw new Error("No browser.");
    const page = await openPage(browser, { viewport });
    await page.goto(`${framework.origin}/docs/quick-start/`, { waitUntil: "networkidle" });
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
