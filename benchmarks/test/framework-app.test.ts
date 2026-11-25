import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { serve } from "../src/server.ts";
import type { StaticServer } from "../src/server.ts";

const root = fileURLToPath(new URL("../apps/framework/dist/", import.meta.url));
const axeSource = readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const desktop = { width: 1350, height: 940 };
const phone = { width: 400, height: 860 };

let server: StaticServer | undefined;
let browser: Browser | undefined;
let origin = "";

before(async () => {
  server = await serve(root, ["/assets/"]);
  origin = server.origin;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const open = async (path: string, options: BrowserContextOptions = {}): Promise<Page> => {
  if (browser === undefined) throw new Error("No browser.");
  const context = await browser.newContext({ viewport: desktop, ...options });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(() => document.querySelector("#app")?.hasAttribute("data-v-app") === true);
  return page;
};

const axeViolations = async (page: Page): Promise<unknown> => {
  await page.addScriptTag({ content: await axeSource });
  return page.evaluate(`axe.run(document, { runOnly: { type: "rule", values: axe.getRules().map((rule) => rule.ruleId) } }).then((result) => result.violations.map((violation) => violation.id + ": " + violation.nodes.map((node) => node.target.join(" ")).join(", ")))`);
};

const sameDocument = (page: Page): Promise<unknown> => page.evaluate((): unknown => Reflect.get(window, "sameDocument"));

test("the theme that the reader chose applies before the first paint, and the switch changes it and keeps it", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const context = await browser.newContext({ viewport: desktop, colorScheme: "light" });
  await context.addInitScript(() => {
    if (sessionStorage.getItem("seeded") === null) {
      localStorage.setItem("theme", "dark");
      sessionStorage.setItem("seeded", "");
    }
    new MutationObserver((_records, observer) => {
      if (document.body === null) return;
      Reflect.set(window, "themeAtBody", document.documentElement.dataset["theme"]);
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/guide/`);
  assert.equal(await page.evaluate((): unknown => Reflect.get(window, "themeAtBody")), "dark", "the stored theme applies before the body exists");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "dark");
  await page.waitForFunction(() => document.querySelector(".theme-toggle")?.getAttribute("aria-pressed") === "true");
  await page.click(".theme-toggle");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "light");
  assert.equal(await page.getAttribute(".theme-toggle", "aria-pressed"), "false");
  await page.reload();
  assert.equal(await page.evaluate((): unknown => Reflect.get(window, "themeAtBody")), "light", "the new choice stays after a reload");
  await context.close();
});

test("with no stored choice, the page follows the system theme, and the switch shows it", async () => {
  const page = await open("/guide/", { colorScheme: "dark" });
  await page.waitForFunction(() => document.querySelector(".theme-toggle")?.getAttribute("aria-pressed") === "true");
  assert.equal(await page.evaluate(() => document.documentElement.dataset["theme"]), undefined);
  await page.context().close();
});

test("on a phone, the menu button opens the sidebar, a link closes it, and Escape closes it", async () => {
  const page = await open("/guide/installation/", { viewport: phone });
  await page.evaluate(() => Reflect.set(window, "sameDocument", true));
  assert.equal(await page.isVisible("nav.sidebar"), false);
  await page.click(".menu-button");
  assert.equal(await page.getAttribute(".menu-button", "aria-expanded"), "true");
  await page.click('nav.sidebar a[href="/guide/configuration/"]');
  await page.waitForURL(`${origin}/guide/configuration/`);
  assert.equal(await page.isVisible("nav.sidebar"), false);
  assert.equal(await sameDocument(page), true);
  await page.click(".menu-button");
  assert.equal(await page.isVisible("nav.sidebar"), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.isVisible("nav.sidebar"), false);
  await page.context().close();
});

test("the copy button of a code block copies its code", async () => {
  const page = await open("/guide/installation/", { permissions: ["clipboard-read", "clipboard-write"] });
  const block = page.locator(".code-block").first();
  await block.hover();
  await block.locator(".copy-code").click();
  await page.waitForSelector(".copy-code[data-copied]");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await block.locator("pre code").textContent());
  await page.context().close();
});

test("the search shows the section, the title and an excerpt with the match, and the keys move and open a result", async () => {
  const page = await open("/guide/installation/");
  await page.evaluate(() => Reflect.set(window, "sameDocument", true));
  await page.keyboard.press("Control+k");
  await page.fill("dialog.search[open] input", "trailing");
  await page.waitForSelector('[role="option"] .result-title mark');
  const first = page.locator('[role="option"]').first();
  assert.equal(await first.locator(".result-section").textContent(), "Routing");
  assert.equal(await first.locator(".result-title").textContent(), "Trailing slashes");
  assert.match((await first.locator(".result-excerpt").textContent()) ?? "", /^Each route ends with a slash\. The host serves/);
  await page.fill("dialog.search[open] input", "upload");
  await page.waitForSelector('[role="option"] .result-excerpt mark');
  assert.match((await page.locator('[role="option"] .result-excerpt mark').first().textContent()) ?? "", /^upload$/i);
  assert.equal(await first.getAttribute("aria-selected"), "true");
  await page.fill("dialog.search[open] input", "example");
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length > 1);
  await page.keyboard.press("ArrowDown");
  const second = page.locator('[role="option"]').nth(1);
  assert.equal(await second.getAttribute("aria-selected"), "true");
  assert.equal(await page.getAttribute("dialog.search input", "aria-activedescendant"), await second.getAttribute("id"));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.waitForSelector("dialog.search", { state: "detached" });
  await page.waitForURL(`${origin}/reference/cli/#examples`);
  assert.equal(await sameDocument(page), true);
  await page.context().close();
});

test("the table of contents marks the heading of the section on screen", async () => {
  const page = await open("/guide/routing/");
  await page.locator("#redirects").scrollIntoViewIfNeeded();
  await page.evaluate(() => document.getElementById("redirects")?.scrollIntoView({ block: "start" }));
  await page.waitForSelector('.toc a[href="#redirects"][aria-current="true"]');
  assert.equal(await page.locator('.toc a[aria-current="true"]').count(), 1);
  await page.context().close();
});

test("a page links the previous and the next page of the sidebar", async () => {
  const page = await open("/guide/installation/");
  assert.equal(await page.getAttribute('.pagination a[rel="prev"]', "href"), "/guide/");
  assert.equal(await page.getAttribute('.pagination a[rel="next"]', "href"), "/guide/configuration/");
  await page.context().close();
});

test("the arrow keys move between the tabs of a code group", async () => {
  const page = await open("/guide/installation/");
  await page.locator('.tabs [role="tab"][aria-selected="true"]').first().focus();
  await page.keyboard.press("ArrowRight");
  const focused = await page.evaluate(() => [document.activeElement?.getAttribute("aria-selected"), document.activeElement?.getAttribute("tabindex")]);
  assert.deepEqual(focused, ["true", "0"]);
  await page.context().close();
});

test("every page state passes every rule of axe-core, in both themes, at desktop and phone widths", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const viewport of [desktop, phone]) {
      const page = await open("/guide/installation/", { colorScheme, viewport });
      assert.deepEqual(await axeViolations(page), [], `${colorScheme}, ${viewport.width}px`);
      if (viewport === phone) {
        await page.click(".menu-button");
        assert.deepEqual(await axeViolations(page), [], `${colorScheme}, ${viewport.width}px, menu open`);
        await page.keyboard.press("Escape");
      }
      await page.keyboard.press("Control+k");
      await page.fill("dialog.search[open] input", "routing");
      await page.waitForSelector('[role="option"]');
      assert.deepEqual(await axeViolations(page), [], `${colorScheme}, ${viewport.width}px, search open`);
      await page.context().close();
    }
  }
});
