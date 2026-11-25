import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { catalogLanguages, cores } from "../src/lib/ecosystem.ts";
import { exampleFiles, exampleNames, fileTree, fragmentUrl, requireExampleFile } from "../src/lib/example-files.ts";
import type { TreeNode } from "../src/lib/example-files.ts";
import { fences, pickFence } from "../src/lib/markdown-fences.ts";
import { waitForHydration } from "./github.ts";
import { builtPages, dist, serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

const repository = new URL("../../", import.meta.url).pathname;
const examplePages = async (): Promise<string[]> => (await builtPages()).filter((file) => file.startsWith(join(dist, "examples/")));

const pointers = (html: string): string[] => [
  ...Array.from(html.matchAll(/\sdata-open="([^"]+)"/g), (match) => match[1] ?? ""),
  ...Array.from(html.matchAll(/\shref="#file=([^"]+)"/g), (match) => match[1] ?? ""),
];

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

const pageErrors = new WeakMap<Page, string[]>();

const close = async (page: Page): Promise<void> => {
  assert.deepEqual(pageErrors.get(page), []);
  await page.close();
};

const open = async (path: string, viewport = { width: 1440, height: 900 }): Promise<Page> => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  await waitForHydration(page);
  return page;
};

const count = (nodes: readonly TreeNode[]): number => nodes.reduce((total, node) => total + 1 + (node.kind === "folder" ? count(node.children) : 0), 0);

test("the example files come from git, without build output, dependencies or lock files", () => {
  assert.deepEqual(exampleNames(repository), ["aircon"]);
  const files = exampleFiles("aircon", repository);
  assert.ok(files.includes("catalog/aircon.pkl"));
  assert.ok(files.includes("core-rust/src/main.rs"));
  assert.deepEqual(
    files.filter((file) => /(^|\/)(node_modules|target|\.out)\//.test(file) || file.endsWith(".lock")),
    [],
  );
  assert.throws(() => requireExampleFile("aircon", "core-ts/missing.ts", "a page", repository), /core-ts\/missing\.ts/);
  const tree = fileTree(["b.ts", "a/z.ts", "a/b/c.ts"]);
  assert.deepEqual(
    tree.map((node) => [node.kind, node.path]),
    [
      ["folder", "a"],
      ["file", "b.ts"],
    ],
  );
});

test("the Examples pages copy no code block of the example README, and read it instead", async () => {
  const readme = await readFile(join(repository, "examples/aircon/README.md"), "utf8");
  const readmeLines = new Set(fences(readme).flatMap((fence) => fence.code.split("\n").map((line) => line.trim()).filter((line) => line !== "")));
  const copies: string[] = [];
  const directory = new URL("../content/examples/", import.meta.url).pathname;
  for (const name of await readdir(directory)) {
    for (const fence of fences(await readFile(join(directory, name), "utf8"))) {
      for (const line of fence.code.split("\n")) if (readmeLines.has(line.trim())) copies.push(`${name}: ${line}`);
    }
  }
  assert.deepEqual(copies, [], "Use <ExampleBlock> to show a code block of the README.");
  const markdown = "## Run\n\n```sh\ncurl -N a \\\n  -d b\ncurl c\nnode d\n```\n";
  assert.equal(pickFence(markdown, { section: "Run", match: "curl" }, "x").code, "curl -N a \\\n  -d b\ncurl c");
  assert.throws(() => pickFence(markdown, { section: "Other" }, "x"), /heading "Other"/);
  assert.throws(() => pickFence(markdown, { section: "Run", match: "missing" }, "x"), /"missing"/);
});

test("every file that an Examples page points to exists, and has its fragment in the build", async () => {
  const pages = await examplePages();
  assert.ok(pages.length > 1);
  const missing: string[] = [];
  for (const page of pages) {
    for (const file of pointers(await readFile(page, "utf8"))) {
      await stat(join(repository, "examples/aircon", file)).catch(() => missing.push(`${page.slice(dist.length)}: examples/aircon/${file}`));
      await stat(join(dist, fragmentUrl("aircon", file))).catch(() => missing.push(`${page.slice(dist.length)}: ${fragmentUrl("aircon", file)}`));
    }
  }
  assert.deepEqual(missing, []);
});

test("each core and each catalog language has its example", async () => {
  for (const core of cores) {
    const html = await readFile(join(dist, `examples/${core.id}/index.html`), "utf8");
    const opened = /\sdata-open="([^"]+)"/.exec(html)?.[1];
    assert.ok(opened !== undefined && `examples/aircon/${opened}`.startsWith(`${core.example}/`), `${core.id} opens ${opened}`);
  }
  const catalog = pointers(await readFile(join(dist, "examples/catalog/index.html"), "utf8"));
  for (const language of catalogLanguages) assert.ok(catalog.includes(language.example.slice("examples/aircon/".length)), language.id);
});

test("the explorer renders the tree of the example, with the selected file and its code", async () => {
  const page = await open("/examples/core-ts/");
  const tree = page.locator('[role="tree"]');
  assert.equal(await tree.locator('[role="treeitem"]').count(), count(fileTree(exampleFiles("aircon", repository))));
  const selected = tree.locator('[aria-selected="true"]');
  assert.equal(await selected.getAttribute("data-path"), "core-ts/aircon.ts");
  assert.equal(await page.locator("[data-current-path]").textContent(), "examples/aircon/core-ts/aircon.ts");
  assert.ok((await page.locator("[data-source] .line").count()) > 10);
  await close(page);
});

test("the script of an Examples page does not carry the opened file, and a page change in the browser loads it", async () => {
  const script = (await readdir(join(dist, "assets"))).find((file) => /^(examples_core-ts_index\.md|core-ts)\.[\w-]+\.js$/.test(file));
  if (script === undefined) throw new Error("No script for /examples/core-ts/.");
  assert.ok(!(await readFile(join(dist, "assets", script), "utf8")).includes("cliAliasDefault"), "the page script has no highlighted code of core-ts/aircon.ts");
  const page = await open("/examples/");
  await page.locator('.sidebar-content a[href="/examples/core-ts/"]').click();
  await page.locator('[role="treeitem"][data-path="core-ts/aircon.ts"][aria-selected="true"]').waitFor();
  await page.locator("[data-source] .line").nth(10).waitFor();
  assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
  await close(page);
});

test("selecting a file shows its code, its GitHub link and its deep link", async () => {
  const page = await open("/examples/core-ts/");
  const fragment = page.waitForResponse((response) => response.url().endsWith(fragmentUrl("aircon", "apis/graphql.ts")));
  await page.locator('[role="treeitem"][data-path="apis"] > .row').click();
  await page.locator('[role="treeitem"][data-path="apis/graphql.ts"]').click();
  await fragment;
  const source = await readFile(join(repository, "examples/aircon/apis/graphql.ts"), "utf8");
  const firstLine = source.split("\n")[0] ?? "";
  await page.waitForFunction((line) => document.querySelector("[data-source] code")?.textContent?.startsWith(line) === true, firstLine);
  assert.equal(await page.locator("[data-current-path]").textContent(), "examples/aircon/apis/graphql.ts");
  assert.equal(await page.locator("[data-github-link]").getAttribute("href"), "https://github.com/Hebilicious/acidcat/blob/main/examples/aircon/apis/graphql.ts");
  assert.equal(new URL(page.url()).hash, "#file=apis/graphql.ts");
  await close(page);
});

test("a file that failed to load loads when the reader selects it again", async () => {
  const page = await open("/examples/core-ts/");
  const url = `${origin}${fragmentUrl("aircon", "apis/graphql.ts")}`;
  let requests = 0;
  await page.route(url, (route) => {
    requests += 1;
    return requests === 1 ? route.abort() : route.continue();
  });
  const item = page.locator('[role="treeitem"][data-path="apis/graphql.ts"]');
  await page.locator('[role="treeitem"][data-path="apis"] > .row').click();
  await item.click();
  await page.waitForFunction(() => document.querySelector("[data-source]")?.textContent?.startsWith("Could not load") === true);
  await item.click();
  await page.waitForFunction(() => document.querySelector("[data-source] code")?.textContent?.includes("graphql") === true);
  assert.equal(requests, 2);
  await close(page);
});

test("a deep link to a file survives a reload", async () => {
  const page = await open("/examples/catalog/#file=core-rust/src/main.rs");
  const item = page.locator('[role="treeitem"][data-path="core-rust/src/main.rs"]');
  await page.waitForFunction(() => document.querySelector("[data-source]")?.getAttribute("aria-busy") === "false" && document.querySelector("[data-source] code")?.textContent?.includes("fn main") === true);
  assert.equal(await item.getAttribute("aria-selected"), "true");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("[data-source] code")?.textContent?.includes("fn main") === true);
  assert.equal(await item.getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('[role="treeitem"][data-path="core-rust"]').getAttribute("aria-expanded"), "true");
  await close(page);
});

test("long lines wrap under the code, with the line number on the first row", async () => {
  for (const width of [390, 1440]) {
    const page = await open("/examples/core-ts/", { width, height: 900 });
    const layout = await page.locator("[data-source] .line").evaluateAll((lines) => {
      const wrapped = lines.find((line) => line.getClientRects().length === 1 && line.getBoundingClientRect().height > 1.5 * Number.parseFloat(getComputedStyle(line).lineHeight));
      if (wrapped === undefined) return undefined;
      const range = document.createRange();
      range.selectNodeContents(wrapped);
      const rows = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const first = rows[0];
      return { lineTop: wrapped.getBoundingClientRect().top, lineHeight: Number.parseFloat(getComputedStyle(wrapped).lineHeight), firstTop: first?.top ?? Number.NaN, codeLeft: first?.left ?? Number.NaN, minLeft: Math.min(...rows.map((rect) => rect.left)) };
    });
    assert.ok(layout !== undefined, `${width}: a line wraps`);
    assert.ok(layout.firstTop - layout.lineTop < layout.lineHeight / 2, `${width}: the number and the code start on the same row`);
    assert.ok(layout.minLeft >= layout.codeLeft - 1, `${width}: the wrapped rows start under the code`);
    await close(page);
  }
});

test("the tree follows the keyboard pattern of a WAI-ARIA tree", async () => {
  const page = await open("/examples/core-ts/");
  const focused = (): Promise<string | undefined> => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset["path"] : undefined));
  assert.equal(await page.locator('[role="tree"] [tabindex="0"]').count(), 1);
  await page.locator('[role="treeitem"][data-path="core-ts/aircon.ts"]').focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "core-ts/cli.ts");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  assert.equal(await focused(), "core-ts/aircon.ts", "focus returns to the selected item");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await focused(), "core-ts");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.locator('[role="treeitem"][data-path="core-ts"]').getAttribute("aria-expanded"), "false");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "test");
  await page.keyboard.press("Home");
  assert.equal(await focused(), "apis");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator('[role="treeitem"][data-path="apis"]').getAttribute("aria-expanded"), "true");
  await page.keyboard.press("ArrowRight");
  assert.equal(await focused(), "apis/capnweb.ts");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator('[role="treeitem"][data-path="apis/capnweb.ts"]').getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('[role="tree"] [tabindex="0"]').count(), 1);
  await page.keyboard.press("End");
  assert.equal(await focused(), "tsconfig.json");
  await close(page);
});

test("the tree toggle and the full-screen button work", async () => {
  const page = await open("/examples/core-ts/");
  const toggle = page.locator("[data-tree-toggle]");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator('[role="tree"]').isVisible(), false);
  await page.locator("[data-fullscreen]").click();
  await page.waitForFunction(() => document.fullscreenElement?.hasAttribute("data-explorer") === true);
  assert.equal(await page.locator("[data-fullscreen]").getAttribute("aria-pressed"), "true");
  await close(page);
});

test("the Examples pages have no sideways scroll at 390px, with the drawer of files closed and open", async () => {
  for (const path of ["/examples/", "/examples/core-ts/", "/examples/catalog/", "/examples/graphql/"]) {
    const page = await open(path, { width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, path);
    assert.equal(await page.locator("[data-source] pre").evaluate((pre) => pre.scrollWidth - pre.clientWidth), 0, `${path}: the code does not scroll sideways`);
    assert.equal(await page.locator('[role="tree"]').isVisible(), false, path);
    await page.locator("[data-tree-toggle]").click();
    assert.equal(await page.locator('[role="tree"]').isVisible(), true, path);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, path);
    await page.locator('[role="treeitem"][data-path="web"] > .row').click();
    await page.locator('[role="treeitem"][data-path="web/page.ts"]').click();
    assert.equal(await page.locator('[role="tree"]').isVisible(), false, `${path}: selecting a file closes the drawer`);
    await close(page);
  }
});
