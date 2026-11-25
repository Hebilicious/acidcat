import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { createBuilder } from "vite";
import { serve } from "./static-server.ts";

const fixture = fileURLToPath(new URL("./fixture/", import.meta.url));
const dist = join(fixture, "dist");

let origin = "";
let browser: Browser | undefined;
let close: (() => void) | undefined;

const readDist = (path: string): Promise<string> => readFile(join(dist, path), "utf8");

const assets = async (): Promise<ReadonlyMap<string, string>> => {
  const files = await readdir(join(dist, "assets"));
  return new Map(await Promise.all(files.map(async (file): Promise<[string, string]> => [file, await readDist(`assets/${file}`)])));
};

const chunkOf = (html: string): string => {
  const href = /<link rel="modulepreload" href="\/assets\/([^"]+)" data-page-chunk>/.exec(html)?.[1];
  assert.ok(href, "The page names its lean chunk.");
  return href;
};

const open = async (path: string, prepare?: (page: Page) => void): Promise<{ readonly page: Page; readonly problems: string[] }> => {
  assert.ok(browser);
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  prepare?.(page);
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(() => document.querySelector("#app")?.hasAttribute("data-v-app") === true);
  return { page, problems };
};

const chunkUrl = async (file: string): Promise<string> => {
  const manifest: unknown = JSON.parse(await readDist(".vite/manifest.json"));
  const chunk: unknown = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, file) : undefined;
  const chunkFile: unknown = typeof chunk === "object" && chunk !== null ? Reflect.get(chunk, "file") : undefined;
  assert.equal(typeof chunkFile, "string");
  return `${origin}/${String(chunkFile)}`;
};

const afterTwoFrames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const markDocument = (page: Page): Promise<void> => page.evaluate(() => document.documentElement.setAttribute("data-same-document", ""));
const sameDocument = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.hasAttribute("data-same-document"));

before(async () => {
  const builder = await createBuilder({ configFile: join(fixture, "vite.config.ts"), logLevel: "warn" });
  await builder.buildApp();
  const served = await serve(dist);
  origin = served.origin;
  close = () => served.server.close();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  close?.();
});

describe("the static build", () => {
  test("writes every page with its title, its head and its content", async () => {
    const guide = await readDist("guide/index.html");
    assert.match(guide, /<title>Guide \| Fixture<\/title>/);
    assert.match(guide, /<meta name="description" content="How the fixture works." data-page-head>/);
    assert.match(guide, /<link rel="canonical" href="https:\/\/fixture.test\/guide\/" data-page-head>/);
    assert.match(guide, /<meta name="theme-color" content="#000000">/);
    assert.match(guide, /<h2 id="components-in-markdown">Components in Markdown<\/h2>/);
    assert.match(guide, /<button type="button" class="counter">Count 5<\/button>/);
    assert.match(guide, /<pre class="highlighted" data-language="ts" data-meta="title=&quot;example.ts&quot;">/);
    assert.match(await readDist("guide/long/index.html"), /<h2 id="section-12">Section 12<\/h2>/);
    assert.match(await readDist("index.html"), /<title>Home \| Fixture<\/title>/);
    assert.match(await readDist("404.html"), /<h1 id="page-not-found">Page not found<\/h1>/);
    const outside = await readDist("more/outside/index.html");
    assert.match(outside, /<h1 id="a-page-from-another-folder">A page from another folder<\/h1>/);
    chunkOf(outside);
    await assert.rejects(readDist("draft/index.html"), "An excluded file is not a page.");
  });

  test("names the lean chunk of each page, which leaves its static HTML to the DOM", async () => {
    const files = await assets();
    const leanLong = files.get(chunkOf(await readDist("guide/long/index.html")));
    assert.ok(leanLong !== undefined);
    assert.doesNotMatch(leanLong, /Words to fill the page/);
    const full = [...files.values()].filter((code) => code.includes("Words to fill the page"));
    assert.equal(full.length, 1, "One chunk, the one that a page change loads, has the static HTML of the long page.");
    const leanHome = files.get(chunkOf(await readDist("index.html")));
    assert.ok(leanHome !== undefined);
    assert.doesNotMatch(leanHome, /lean chunk leaves out/);
  });

  test("ships no virtual DOM renderer", async () => {
    const code = [...(await assets()).values()].join("\n");
    assert.doesNotMatch(code, /_vnode/, "The renderer of the virtual DOM keeps the tree of a container in _vnode.");
    assert.doesNotMatch(code, /RouterLink/, "The router registers no RouterLink, a component of the virtual DOM.");
  });

  test("serves each image of a page as WebP files at several widths, with its size", async () => {
    const guide = await readDist("guide/index.html");
    const images = [...guide.matchAll(/<img [^>]*>/g)].map(([tag]) => tag);
    assert.equal(images.length, 2);
    const [first = "", second = ""] = images;
    for (const tag of [first, second]) {
      assert.match(tag, /width="1000" height="400"/);
      assert.match(tag, /srcset="\/assets\/diagram-480\.[\w-]+\.webp 480w, \/assets\/diagram-800\.[\w-]+\.webp 800w, \/assets\/diagram-1000\.[\w-]+\.webp 1000w"/);
      assert.match(tag, /sizes="\(min-width: 1000px\) 1000px, 100vw"/);
      assert.match(tag, /decoding="async"/);
    }
    assert.match(first, /alt="A blue diagram" title="The diagram"/);
    assert.doesNotMatch(first, /loading=/, "The first image of a page can be its largest element, so it loads at once.");
    assert.match(second, /loading="lazy"/);
    const files = await readdir(join(dist, "assets"));
    for (const [, file = ""] of first.matchAll(/\/assets\/([^ "]+\.webp)/g)) assert.ok(files.includes(file), `The build writes ${file}.`);
    assert.match(await readDist("index.html"), /<img class="home-diagram" src="\/assets\/diagram-1000\.[\w-]+\.webp" srcset="[^"]+ 1000w" sizes="[^"]+" width="1000" height="400" alt="A blue diagram">/);
  });

  test("writes the search index of the pages with a hash in its name, and names it in the head of each page", async () => {
    const url = /<meta name="vaporpress:search" content="(\/assets\/search\.[\w-]{8}\.json)">/.exec(await readDist("guide/index.html"))?.[1];
    assert.ok(url !== undefined);
    assert.match(await readDist("404.html"), new RegExp(`content="${url}"`));
    const index = await readDist(url);
    assert.match(index, /a-smaller-heading/);
    assert.doesNotMatch(index, /quuxfooter/, "The search leaves out the content with data-search-ignore.");
    assert.doesNotMatch(index, /"\/404"/, "A page without data-search is not in the index.");
    const parsed: unknown = JSON.parse(index);
    const ids: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "documentIds") : undefined;
    assert.equal(Object.values(typeof ids === "object" && ids !== null ? ids : {}).filter((id) => id === "/").length, 1, "Headings with no id add no section of their own.");
  });

  test("checks each lazy layout once for each page that it renders", async () => {
    const pages = (await readdir(dist, { recursive: true })).filter((file) => file.endsWith(".html"));
    assert.equal(Reflect.get(globalThis, "tocChecks"), pages.length);
  });

  test("gives a page the data of its loader, and leaves the loader out", async () => {
    assert.match(await readDist("index.html"), /<p class="numbers">1, 2, 3 at build time<\/p>/);
    const code = [...(await assets()).values()].join("\n");
    assert.match(code, /at build time/);
    assert.doesNotMatch(code, /defineLoader/);
  });
});

describe("in the browser", () => {
  test("hydrates the first page with no change to the DOM, and its components respond", async () => {
    assert.ok(browser);
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });
    await page.addInitScript(() => {
      const changes: string[] = [];
      Object.assign(window, { domChanges: changes });
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of [...record.addedNodes, ...record.removedNodes]) if (node.nodeType === Node.ELEMENT_NODE) changes.push(node.nodeName);
        }
      });
      document.addEventListener("readystatechange", () => {
        if (document.readyState === "interactive") observer.observe(document, { childList: true, subtree: true });
      });
    });
    await page.goto(`${origin}/guide/`);
    await page.waitForFunction(() => document.querySelector("#app")?.hasAttribute("data-v-app") === true);
    const changes = await page.evaluate(() => {
      const value: unknown = Reflect.get(window, "domChanges");
      if (!Array.isArray(value)) return ["no record"];
      return value.filter((name): name is string => typeof name === "string" && name !== "LINK" && name !== "SCRIPT");
    });
    assert.deepEqual(changes, [], "Hydration adds and removes no element of the page.");
    await page.click(".counter");
    assert.equal(await page.textContent(".counter"), "Count 6");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("h1") ?? document.body).color), "rgb(1, 2, 3)");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("changes the page with no new document, and updates the title and the head", async () => {
    const { page, problems } = await open("/");
    await markDocument(page);
    assert.equal(await page.getAttribute("body", "data-updated-for"), "A unique homepage");
    await page.click(".to-guide");
    await page.waitForSelector("#the-guide");
    assert.equal(await sameDocument(page), true);
    await page.waitForFunction(() => document.body.dataset["updatedFor"] === "The guide");
    assert.equal(await page.title(), "Guide | Fixture");
    assert.equal(await page.getAttribute('meta[name="description"]', "content"), "How the fixture works.");
    assert.equal(await page.getAttribute('link[rel="canonical"]', "href"), "https://fixture.test/guide/");
    assert.equal(await page.locator("[data-page-head]").count(), 2);
    await page.click(".counter");
    assert.equal(await page.textContent(".counter"), "Count 6");
    await page.goBack();
    await page.waitForSelector(".home-title");
    assert.equal(await sameDocument(page), true);
    assert.equal(await page.title(), "Home | Fixture");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("renders a lazy layout in the same task as the page that uses it", async () => {
    const { page, problems } = await open("/");
    // The browser paints only after the microtasks of a task, and a mutation observer runs in those microtasks.
    await page.evaluate(() => {
      const states: boolean[] = [];
      Reflect.set(window, "tocWithGuide", states);
      new MutationObserver(() => {
        if (document.querySelector("#the-guide") !== null) states.push(document.querySelector(".toc") !== null);
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.click(".to-guide");
    await page.waitForSelector("#the-guide");
    assert.deepEqual(await page.evaluate((): unknown => Reflect.get(window, "tocWithGuide")), [true]);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("hydrates a lazy layout with the first page, because the router loads it before the first render", async () => {
    const { page, problems } = await open("/guide/");
    await page.waitForFunction(() => document.body.dataset["mounted"]?.includes("toc") === true);
    assert.equal(await page.evaluate(() => document.body.dataset["mounted"]), "toc layout ", "The layout of the page mounts with the app, before its root.");
    assert.deepEqual(problems, []);
    await page.close();
  });

  for (const [name, file] of [
    ["a lazy layout", "src/Toc.vue"],
    ["the page", "pages/guide/index.md"],
  ] as const) {
    test(`loads the page as a new document when the chunk of ${name} does not load on a page change`, async () => {
      const chunk = await chunkUrl(file);
      const { page } = await open("/", (page) => void page.route(chunk, (route) => route.abort()));
      await markDocument(page);
      await page.click(".to-guide");
      await page.waitForURL(`${origin}/guide/`);
      await page.waitForSelector("#the-guide");
      assert.equal(await sameDocument(page), false);
      await page.close();
    });
  }

  test("keeps the HTML of the first page and its links when a chunk of the first page does not load", async () => {
    assert.ok(browser);
    const page = await browser.newPage();
    await page.route(await chunkUrl("src/Toc.vue"), (route) => route.abort());
    const failed = page.waitForEvent("console", (message) => message.type() === "error" && message.text().includes("dynamically imported module"));
    await page.goto(`${origin}/guide/`);
    await failed;
    await markDocument(page);
    assert.equal(await page.textContent("#the-guide"), "The guide");
    assert.equal(await page.evaluate(() => document.querySelector("#app")?.hasAttribute("data-v-app")), false);
    await page.click("header a[href='/guide/long/']");
    await page.waitForSelector("#section-12");
    assert.equal(await sameDocument(page), false, "The link loads a new document.");
    await page.close();
  });

  test("loads the page of a link in view before the click", async () => {
    const file = await chunkUrl("pages/guide/long.md");
    let prefetched: Promise<unknown> = Promise.resolve();
    const { page, problems } = await open("/", (page) => {
      prefetched = page.waitForResponse((response) => response.url() === file);
    });
    await prefetched;
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    await page.click("header a[href='/guide/long/']");
    await page.waitForSelector("#section-12");
    assert.deepEqual(requested.filter((url) => url.endsWith(".js")), [], "The page change loads no script: the chunk is already there.");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("loads the page of a link under the pointer at once, before it is in view", async () => {
    const inView = await chunkUrl("pages/guide/branches.md");
    const belowTheFold = await chunkUrl("content/outside.md");
    const requested: string[] = [];
    let prefetched: Promise<unknown> = Promise.resolve();
    const { page, problems } = await open("/guide/long/", (page) => {
      page.on("request", (request) => requested.push(request.url()));
      prefetched = page.waitForResponse((response) => response.url() === inView);
    });
    await prefetched;
    assert.equal(requested.includes(belowTheFold), false, "The links in view load together, and the link below the fold is not in view.");
    const hovered = page.waitForResponse((response) => response.url() === belowTheFold);
    await page.evaluate(() => document.querySelector("a[href='/more/outside/']")?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    await hovered;
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("moves the focus to the target of a link in the page, so the skip link skips the header", async () => {
    const { page, problems } = await open("/guide/");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Skip to content");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "content");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "link to the long page");
    await page.focus(".skip-link");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "content");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("restores the scroll position on the way forward", async () => {
    const { page, problems } = await open("/guide/");
    await page.click("text=link to the long page");
    await page.waitForSelector("#section-12");
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForFunction(() => window.scrollY === 1500);
    await page.goBack();
    await page.waitForSelector("#the-guide");
    await page.waitForFunction(() => window.scrollY === 0);
    await page.goForward();
    await page.waitForSelector("#section-12");
    await page.waitForFunction(() => window.scrollY === 1500);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("restores the scroll position on the way back, and goes to the heading of a hash", async () => {
    const { page, problems } = await open("/guide/long/");
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForFunction(() => window.scrollY === 1500);
    // Playwright scrolls an element into view before a click, which would move the page that the router saves.
    await page.evaluate(() => document.querySelector<HTMLElement>("header a[href='/guide/']")?.click());
    await page.waitForSelector("#the-guide");
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await page.goBack();
    await page.waitForSelector("#section-12");
    await page.waitForFunction(() => window.scrollY === 1500);
    await page.goto(`${origin}/guide/`);
    await page.click("text=link to the long page");
    await page.waitForSelector("#section-12");
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/guide/long/#section-9";
      link.id = "hash-link";
      link.textContent = "Section 9";
      document.body.prepend(link);
    });
    await page.click("#hash-link");
    await page.waitForFunction(() => Math.abs(document.querySelector("#section-9")?.getBoundingClientRect().top ?? -1) < 2);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("keeps the scroll position when only the query changes, on the way there and back", async () => {
    const { page, problems } = await open("/guide/long/");
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForFunction(() => window.scrollY === 1500);
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/guide/long/?view=compact";
      link.id = "query-link";
      document.body.prepend(link);
      link.click();
    });
    await page.waitForFunction(() => location.search === "?view=compact");
    await afterTwoFrames(page);
    assert.equal(await page.evaluate(() => window.scrollY), 1500);
    await page.goBack();
    await page.waitForFunction(() => location.search === "");
    await afterTwoFrames(page);
    assert.equal(await page.evaluate(() => window.scrollY), 1500);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("moves the focus to the target of a link to a hash on another page", async () => {
    const { page, problems } = await open("/guide/");
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/guide/long/#section-12";
      link.id = "cross-hash";
      link.textContent = "Section 12";
      document.body.prepend(link);
    });
    await page.click("#cross-hash");
    await page.waitForFunction(() => document.activeElement?.id === "section-12");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.querySelector("#section-12")?.compareDocumentPosition(document.activeElement ?? document.body) === Node.DOCUMENT_POSITION_FOLLOWING), true, "The next Tab goes on from the heading.");
    assert.deepEqual(problems, []);
    await page.close();
  });

  const toggleBranches = async (page: Page): Promise<void> => {
    assert.equal(await page.locator(".when-false").count(), 1);
    await page.click(".toggle");
    await page.waitForSelector(".when-true");
    assert.equal(await page.textContent(".when-true"), "Shown after a click.Static text.");
    await page.click(".toggle");
    await page.waitForSelector(".when-false");
    assert.equal(await page.textContent(".when-false"), "Shown at first.Static text.");
    await page.click(".grow");
    await page.click(".grow");
    assert.deepEqual(await page.locator(".items li").allTextContents(), ["An item.Static text.", "An item.Static text.", "An item.Static text."]);
  };

  test("renders a branch of v-if, v-else and v-for that the server did not render, after hydration", async () => {
    const { page, problems } = await open("/guide/branches/");
    await toggleBranches(page);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("renders a branch that the server did not render, after a page change to the page and back to it", async () => {
    const { page, problems } = await open("/");
    await page.click("header a[href='/guide/branches/']");
    await page.waitForSelector(".when-false");
    await toggleBranches(page);
    const { page: first } = await open("/guide/branches/");
    await first.click("header a[href='/']");
    await first.waitForSelector(".home-title");
    await first.click("header a[href='/guide/branches/']");
    await first.waitForSelector(".when-false");
    await toggleBranches(first);
    assert.deepEqual(problems, []);
    await page.close();
    await first.close();
  });

  test("hydrates a page whose file is outside the folder of the pages", async () => {
    const { page, problems } = await open("/more/outside/");
    await markDocument(page);
    await page.click("text=Home");
    await page.waitForSelector(".home-title");
    assert.equal(await sameDocument(page), true);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("finds the sections of the pages, gives the excerpt of a section, and goes to a result with no new document", async () => {
    const { page, problems } = await open("/");
    await markDocument(page);
    await page.fill(".search", "smaller");
    const result = page.locator('.search-results a[href="/guide/#a-smaller-heading"]');
    await result.waitFor();
    assert.equal(await result.getAttribute("data-titles"), "The guide > Code");
    assert.equal(await result.innerHTML(), "A <mark>smaller</mark> heading", "The title marks the words that match.");
    await page.waitForFunction(() => document.querySelector(".search-excerpt")?.textContent?.trim() === "Text under the smaller heading.");
    assert.equal(await page.locator(".search-excerpt [id], .search-excerpt [aria-labelledby]").count(), 0, "The excerpt has no id that the page could have too.");
    await page.fill(".search", "quuxfooter");
    await page.waitForFunction(() => document.querySelectorAll(".search-results li").length === 0);
    await page.fill(".search", "smaller");
    await result.click();
    await page.waitForSelector("#the-guide");
    assert.equal(await sameDocument(page), true);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test("serves the 404 page for a path that has no page", async () => {
    const { page, problems } = await open("/no/such/page/");
    assert.equal(await page.textContent("h1"), "Page not found");
    assert.equal(await page.title(), "Not found | Fixture");
    assert.deepEqual(
      problems.filter((problem) => !problem.includes("404")),
      [],
    );
    await page.click("text=Go home");
    await page.waitForSelector(".home-title");
    await page.close();
  });
});
