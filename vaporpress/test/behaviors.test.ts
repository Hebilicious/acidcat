import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { serve } from "./static-server.ts";

const root = fileURLToPath(new URL("./.tmp/behaviors/", import.meta.url));

let origin = "";
let browser: Browser | undefined;
let close: (() => void) | undefined;

const tabs = `
<div class="tabs">
  <div role="tablist"><button role="tab" aria-controls="one">One</button><button role="tab" aria-controls="two">Two</button><button role="tab" aria-controls="three">Three</button></div>
  <div id="one" role="tabpanel">First</div><div id="two" role="tabpanel" hidden>Second</div><div id="three" role="tabpanel" hidden>Third</div>
</div>
<script type="module">
  import { listenToTabs, selectTab } from "/behaviors/index.js";
  const tabsOf = (group) => [...group.querySelectorAll('[role="tab"]')];
  listenToTabs({ tab: '[role="tab"]', group: ".tabs", tabsOf, choose: (group, tab) => selectTab(tabsOf(group), tab, (each) => document.getElementById(each.getAttribute("aria-controls"))) });
  document.body.dataset.ready = "";
</script>`;

const listbox = `
<button id="opener">Search</button>
<dialog><input id="query"><ul id="options"></ul></dialog>
<script type="module">
  import { isSearchShortcut, onListboxKey, openModal } from "/behaviors/index.js";
  const dialog = document.querySelector("dialog");
  const options = ["Alpha", "Beta", "Gamma"];
  let selected = 0;
  let closeModal;
  const render = () => {
    document.querySelector("#options").innerHTML = options.map((option, index) => '<li aria-selected="' + (index === selected) + '">' + option + "</li>").join("");
  };
  addEventListener("keydown", (event) => {
    if (closeModal === undefined && isSearchShortcut(event)) {
      event.preventDefault();
      closeModal = openModal(dialog);
      document.querySelector("#query").focus();
      render();
    }
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      closeModal = undefined;
      return;
    }
    onListboxKey(event, { count: options.length, selected, select: (index) => { selected = index; render(); }, open: (index) => { document.body.dataset.opened = options[index]; } });
  });
  document.body.dataset.ready = "";
</script>`;

const copy = `
<figure><button class="copy">Copy</button><pre><code>pnpm add vaporpress</code></pre></figure>
<script type="module">
  import { copyCodeOnClick } from "/behaviors/index.js";
  copyCodeOnClick({ button: ".copy", code: (button) => button.parentElement.querySelector("pre code"), copied: (button, copied) => button.setAttribute("aria-label", copied ? "Copied" : "Copy code") });
  document.body.dataset.ready = "";
</script>`;

const headings = `
<style>h2 { margin: 0 0 120vh; } p { height: 50vh; }</style><p></p>
<h2 id="first">First</h2><h2 id="second">Second</h2><h2 id="third">Third</h2>
<script type="module">
  import { observeActiveHeading } from "/behaviors/index.js";
  observeActiveHeading([...document.querySelectorAll("h2")], 100, (id) => { document.body.dataset.active = id ?? "none"; });
  document.body.dataset.ready = "";
</script>`;

before(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const sources = new URL("../src/behaviors/", import.meta.url);
  await mkdir(join(root, "behaviors"));
  for (const file of await readdir(sources)) {
    const code = stripTypeScriptTypes(await readFile(new URL(file, sources), "utf8")).replaceAll(/(from "\.\/[\w-]+)\.ts"/g, '$1.js"');
    await writeFile(join(root, "behaviors", file.replace(/\.ts$/, ".js")), code);
  }
  for (const [name, body] of Object.entries({ tabs, listbox, copy, headings })) await writeFile(join(root, `${name}.html`), `<!doctype html><html><body>${body}</body></html>`);
  const served = await serve(root.replace(/\/$/, ""));
  origin = served.origin;
  close = () => served.server.close();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  close?.();
  await rm(root, { recursive: true, force: true });
});

const open = async (name: string): Promise<Page> => {
  assert.ok(browser);
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.goto(`${origin}/${name}.html`);
  await page.waitForSelector("body[data-ready]");
  return page;
};

const selectedTab = (page: Page): Promise<string | null> => page.textContent('[role="tab"][aria-selected="true"]');

test("a click and the arrow keys choose a tab, show its panel, and keep one tab in the tab order", async () => {
  const page = await open("tabs");
  await page.click("text=Two");
  assert.equal(await selectedTab(page), "Two");
  assert.equal(await page.isVisible("#two"), true);
  assert.equal(await page.isVisible("#one"), false);
  await page.keyboard.press("ArrowRight");
  assert.equal(await selectedTab(page), "Three");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Three");
  await page.keyboard.press("ArrowRight");
  assert.equal(await selectedTab(page), "One");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await selectedTab(page), "Three");
  await page.keyboard.press("Home");
  assert.equal(await selectedTab(page), "One");
  await page.keyboard.press("End");
  assert.equal(await selectedTab(page), "Three");
  assert.deepEqual(await page.$$eval('[role="tab"]', (all) => all.map((tab) => tab.tabIndex)), [-1, -1, 0]);
  await page.close();
});

test("the search shortcuts open a modal, the arrow keys move around the list, Enter opens an option, and closing gives the focus back", async () => {
  const page = await open("listbox");
  await page.focus("#opener");
  await page.keyboard.press("Control+k");
  assert.equal(await page.evaluate(() => document.querySelector("dialog")?.open), true);
  const selected = (): Promise<string | null> => page.textContent('[aria-selected="true"]');
  assert.equal(await selected(), "Alpha");
  await page.keyboard.press("ArrowUp");
  assert.equal(await selected(), "Gamma");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await selected(), "Beta");
  await page.keyboard.press("/");
  assert.equal(await page.inputValue("#query"), "/", "A slash in a text field is text.");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.body.dataset["opened"]), "Beta");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.querySelector("dialog")?.open), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "opener");
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.querySelector("dialog")?.open), true, "A slash outside a text field opens the search.");
  await page.close();
});

test("a copy button copies the text of its code block, and marks itself", async () => {
  const page = await open("copy");
  await page.click(".copy");
  await page.waitForSelector(".copy[data-copied]");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "pnpm add vaporpress");
  assert.equal(await page.getAttribute(".copy", "aria-label"), "Copied");
  await page.close();
});

test("the active heading is the last heading above the line, and changes as the page scrolls", async () => {
  const page = await open("headings");
  await page.waitForSelector("body[data-active]");
  assert.equal(await page.evaluate(() => document.body.dataset["active"]), "none");
  await page.evaluate(() => document.querySelector("#second")?.scrollIntoView());
  await page.waitForFunction(() => document.body.dataset["active"] === "second");
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForFunction(() => document.body.dataset["active"] === "none");
  await page.close();
});
