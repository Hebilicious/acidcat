import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { openPage } from "./github.ts";
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

const documentLoads = (page: Page): Promise<number> => page.evaluate(() => performance.getEntriesByType("navigation").length);

test("a link to another page changes the page in the browser, with no new document", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(new URL(request.url()).pathname);
  });
  await page.goto(`${origin}/docs/`, { waitUntil: "networkidle" });
  await page.evaluate(() => Reflect.set(window, "sameDocument", true));

  await page.locator('.sidebar-content a[href="/docs/quick-start/"]').click();
  await page.waitForURL(`${origin}/docs/quick-start/`);
  await page.locator("h1", { hasText: "Quick start" }).waitFor();
  await page.locator('.site-links a[href="/spec/"]').click();
  await page.waitForURL(`${origin}/spec/`);
  await page.locator(".sidebar-section-title", { hasText: "Specification" }).waitFor();
  await page.locator('.site-brand[href="/"]').click();
  await page.waitForURL(`${origin}/`);
  await page.locator("#hero-title").waitFor();
  await page.goBack();
  await page.waitForURL(`${origin}/spec/`);

  assert.equal(await page.evaluate((): unknown => Reflect.get(window, "sameDocument")), true);
  assert.equal(await documentLoads(page), 1);
  assert.deepEqual(documents, ["/docs/"]);
  await page.close();
});

test("a page change from the homepage to the docs loads the CSS of the docs before the page renders, in the order of the build", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  assert.deepEqual(await page.locator("[data-route]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-route"))), ["home"], "the homepage has only its own CSS");
  await page.locator('.site-links a[href="/docs/"]').click();
  await page.locator("h1#_top").waitFor();
  assert.equal(await page.locator(".page > .header").evaluate((header) => getComputedStyle(header).position), "fixed", "the docs have their CSS when they render");
  assert.deepEqual(await page.locator("[data-route]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-route"))), ["docs", "home"]);
  await page.close();
});

test("VitePress fetches ahead the page that a link in view leads to, before the reader clicks it", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  const prefetched = page.waitForRequest((request) => /\/assets\/docs_quick-start_index\.md\.[\w-]+\.js$/.test(new URL(request.url()).pathname));
  await page.goto(`${origin}/docs/`);
  await prefetched;
  assert.equal(await documentLoads(page), 1);
  await page.close();
});

test("leaving the homepage stops its observers and its animation frames, and coming back starts them again", async () => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    const watched = new Map<object, Set<Element>>();
    const track = (observer: object): Set<Element> => {
      const targets = watched.get(observer) ?? new Set<Element>();
      watched.set(observer, targets);
      return targets;
    };
    window.IntersectionObserver = class extends window.IntersectionObserver {
      override observe(target: Element): void {
        track(this).add(target);
        super.observe(target);
      }
      override unobserve(target: Element): void {
        track(this).delete(target);
        super.unobserve(target);
      }
      override disconnect(): void {
        track(this).clear();
        super.disconnect();
      }
    };
    window.ResizeObserver = class extends window.ResizeObserver {
      override observe(target: Element, options?: ResizeObserverOptions): void {
        track(this).add(target);
        super.observe(target, options);
      }
      override unobserve(target: Element): void {
        track(this).delete(target);
        super.unobserve(target);
      }
      override disconnect(): void {
        track(this).clear();
        super.disconnect();
      }
    };
    let frames = 0;
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      frames += 1;
      return requestFrame(callback);
    };
    const contexts: WebGL2RenderingContext[] = [];
    const getContext: unknown = Reflect.get(HTMLCanvasElement.prototype, "getContext");
    if (typeof getContext !== "function") throw new Error("No getContext.");
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      value(this: HTMLCanvasElement, ...args: unknown[]): unknown {
        const context: unknown = Reflect.apply(getContext, this, args);
        if (context instanceof WebGL2RenderingContext) contexts.push(context);
        return context;
      },
    });
    Reflect.set(window, "lifecycle", () => {
      const targets = [...watched.values()].flatMap((set) => [...set]);
      return {
        detached: targets.filter((target) => !target.isConnected).length,
        home: targets.filter((target) => target.closest(".home-page") !== null).length,
        frames,
        liveContexts: contexts.filter((context) => !context.isContextLost()).length,
      };
    });
  });
  type Lifecycle = { detached: number; home: number; frames: number; liveContexts: number };
  const lifecycle = (): Promise<Lifecycle> => page.evaluate((): Lifecycle => {
    const read: unknown = Reflect.get(window, "lifecycle");
    if (typeof read !== "function") throw new Error("No lifecycle probe.");
    const value: unknown = Reflect.apply(read, undefined, []);
    if (typeof value !== "object" || value === null || !("detached" in value) || !("home" in value) || !("frames" in value) || !("liveContexts" in value)) throw new Error("A bad probe.");
    return { detached: Number(value.detached), home: Number(value.home), frames: Number(value.frames), liveContexts: Number(value.liveContexts) };
  });
  const framesIn = async (ms: number): Promise<number> => {
    const before = (await lifecycle()).frames;
    await page.waitForTimeout(ms);
    return (await lifecycle()).frames - before;
  };

  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.locator(".machine").scrollIntoViewIfNeeded();
  assert.ok((await lifecycle()).home > 0, "the homepage observes its sections");
  const gpu = await page.locator("[data-plate]").getAttribute("data-gpu");

  await page.locator('a.button-acid[href="/docs/"]').click();
  await page.waitForURL(`${origin}/docs/`);
  await page.locator(".markdown-content").waitFor();
  await page.waitForTimeout(500);
  const away = await lifecycle();
  assert.equal(away.detached, 0, "no observer watches an element of the homepage after the reader leaves it");
  assert.equal(await framesIn(1000), 0, "no animation frame runs after the reader leaves the homepage");
  assert.equal(away.liveContexts, 0, "the homepage frees each WebGL context when the reader leaves it");

  await page.goBack();
  await page.waitForURL(`${origin}/`);
  await page.locator("#hero-title").waitFor();
  assert.ok((await lifecycle()).home > 0, "the homepage observes its sections again");
  if (gpu !== null) await page.locator(`[data-plate][data-gpu="${gpu}"]`).waitFor({ timeout: 10000 });
  assert.equal(await documentLoads(page), 1);
  await page.close();
});
