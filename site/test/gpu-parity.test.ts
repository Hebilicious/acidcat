import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";
import { openPage, stubGitHub } from "./github.ts";

const gpuFlags = [
  "--enable-gpu",
  "--ignore-gpu-blocklist",
  "--use-gl=angle",
  "--use-angle=gl-egl",
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--enable-blink-features=CanvasDrawElement",
];

/**
 * Two images match when the mean difference of their channels is at most `meanLimit` (of 255), and at most
 * `outlierLimit` of their pixels differ by more than `outlierDelta` in a channel. Both backends run the same shader
 * source on the same adapter, so the images differ only by rounding, by MSAA edge coverage, and by the text
 * rasterized at the moment of the paint.
 */
const tolerance = { meanLimit: 1.5, outlierDelta: 32, outlierLimit: 0.005 } as const;

type Backend = "webgpu" | "webgl2";

interface Case {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly reducedMotion: "reduce" | "no-preference";
  readonly region: string;
  readonly backendOf: string;
  readonly scroll?: string;
}

const cases: readonly Case[] = [
  { name: "the hero at 1440px, after three seconds", viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference", region: "[data-plate] canvas", backendOf: "[data-plate]" },
  { name: "the hero at 1800px, from the plate at twice the resolution", viewport: { width: 1800, height: 900 }, reducedMotion: "no-preference", region: "[data-plate] canvas", backendOf: "[data-plate]" },
  { name: "the hero at 390px, after three seconds", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", region: "[data-plate] canvas", backendOf: "[data-plate]" },
  { name: "the wide Fig. 1 at 1440px, still", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", region: ".holo-canvas", backendOf: ".engine-stage", scroll: ".engine-stage" },
  { name: "the tall Fig. 1 at 390px, still", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", region: ".holo-canvas", backendOf: ".engine-stage", scroll: ".engine-stage" },
  { name: "the key specifications of Fig. 2 at 1440px, still", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", region: ".spec-frame canvas", backendOf: ".spec-frame canvas", scroll: ".spec-frame" },
  { name: "the console of Fig. 4 at 390px, still", viewport: { width: 390, height: 1300 }, reducedMotion: "reduce", region: ".cores .bluescreen-canvas", backendOf: ".cores .bluescreen-canvas", scroll: ".console" },
];

let server: StaticServer | undefined;
let browser: Browser | undefined;

before(async () => {
  server = await serveDist();
  browser = await chromium.launch({ args: gpuFlags });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const hideWebgpu = (context: BrowserContext) =>
  context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true });
  });

/** Records each canvas that got a `paint` event of HTML-in-Canvas, the event after which a renderer draws the HTML of the canvas. */
const recordPaints = (context: BrowserContext) =>
  context.addInitScript(() => {
    const painted = new WeakSet<EventTarget>();
    Reflect.set(window, "wasPainted", (target: EventTarget) => painted.has(target));
    addEventListener(
      "paint",
      (event) => {
        if (event.target !== null) painted.add(event.target);
      },
      { capture: true },
    );
  });

/**
 * Resolves when the canvas of `selector` shows the HTML that it draws: the fonts are there, the canvas got a paint
 * event, and three frames went by. A paint event that a late font causes comes in the next frame, a renderer that
 * draws in an animation frame draws in the frame after it, and the screenshot takes a frame after that.
 */
const htmlDrawn = async (page: Page, selector: string): Promise<void> => {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction((region) => {
    const canvas = document.querySelector(region);
    const wasPainted: unknown = Reflect.get(window, "wasPainted");
    return canvas !== null && typeof wasPainted === "function" && wasPainted(canvas) === true;
  }, selector);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
};

const missingHardware = async (page: Page): Promise<string | undefined> =>
  page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (gl === null) return "WebGL 2 is not available.";
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL));
    if (/swiftshader|llvmpipe|softpipe|software/i.test(renderer)) return `WebGL 2 renders in software (${renderer}).`;
    if (typeof Reflect.get(gl, "texElementSubImage2D") !== "function") return "WebGL 2 has no texElementSubImage2D.";
    const gpu: unknown = Reflect.get(navigator, "gpu");
    if (!(gpu instanceof GPU)) return "WebGPU is not available.";
    const adapter = await gpu.requestAdapter({ powerPreference: "low-power" });
    if (adapter === null) return "WebGPU gives no adapter.";
    if (adapter.info.isFallbackAdapter) return "WebGPU gives only a fallback adapter.";
    if (typeof Reflect.get(GPUQueue.prototype, "drawElementImageToTexture") !== "function") return "WebGPU has no drawElementImageToTexture.";
    return undefined;
  });

const hardwareProblem = async (): Promise<string | undefined> => {
  if (browser === undefined || server === undefined) throw new Error("No browser.");
  const probe = await openPage(browser);
  await probe.goto(`${server.origin}/404`);
  const missing = await missingHardware(probe);
  await probe.close();
  return missing;
};

const capture = async (origin: string, item: Case, backend: Backend): Promise<{ image: Buffer; backend: string | undefined }> => {
  if (browser === undefined) throw new Error("No browser.");
  const context = await browser.newContext({ viewport: item.viewport, reducedMotion: item.reducedMotion });
  if (backend === "webgl2") await hideWebgpu(context);
  await stubGitHub(context);
  await recordPaints(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const plates: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/assets\/(plate|phone)/.test(path) && !/\.(js|css)$/.test(path)) plates.push(path);
  });
  if (item.reducedMotion === "no-preference") {
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
  }
  await page.goto(`${origin}/`);
  if (item.scroll !== undefined) {
    await page.locator(".engine-stage").evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".engine-stage")?.dataset["engine"] === "live", undefined, { timeout: 20000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.locator(item.scroll).first().evaluate((element) => element.scrollIntoView({ block: "center" }));
  }
  await page.waitForFunction((selector) => document.querySelector<HTMLElement>(selector)?.dataset["gpu"] !== undefined, item.backendOf, { timeout: 20000 });
  if (item.reducedMotion === "no-preference") await page.clock.runFor(3000);
  else await htmlDrawn(page, item.region);
  // The clock of the page does not drive CSS transitions, such as the fade of the live hero.
  await page.locator(item.region).first().evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)).then(() => undefined));
  // The sections above the region lay out after the first scroll and move it, so the test centers it again on the final layout.
  if (item.scroll !== undefined) await page.locator(item.scroll).first().evaluate((element) => element.scrollIntoView({ block: "center" }));
  const box = await page.locator(item.region).first().boundingBox();
  // Chromium captures an element taller than the window by making the window taller, which resizes the canvas, and the renderer draws again during the capture.
  if (box === null) throw new Error(`${item.region} has no box.`);
  assert.ok(box.y >= 0 && box.y + box.height <= item.viewport.height, `the region of ${item.name} is inside the window: from ${box.y}px to ${box.y + box.height}px in ${item.viewport.height}px`);
  // The sections above the region can end a fraction of a pixel apart between two loads. Chromium draws the canvas at its position rounded to a pixel, so the capture takes the same rounded rectangle.
  const image = await page.screenshot({ clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }, animations: "allow" });
  const used = await page.locator(item.backendOf).first().evaluate((element) => (element instanceof HTMLElement ? element.dataset["gpu"] : undefined));
  const region = await page.locator(item.region).first().boundingBox();
  await context.close();
  assert.deepEqual(errors, []);
  if (item.backendOf === "[data-plate]") {
    const loaded = new Set(plates);
    assert.equal(loaded.size, 1, `the hero loads one plate, not ${[...loaded].join(" and ")}`);
    assert.ok(region !== null && region.width >= item.viewport.width - 1, "the live hero fills the width");
  }
  return { image, backend: used };
};

const compare = async (first: Buffer, second: Buffer) => {
  if (browser === undefined) throw new Error("No browser.");
  const page = await openPage(browser);
  const result = await page.evaluate(
    async ([a, b, delta]) => {
      const decode = async (base64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("No 2D context.");
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [left, right] = await Promise.all([decode(a), decode(b)]);
      if (left.width !== right.width || left.height !== right.height) return { sameSize: false, mean: 255, outliers: 1, spread: 0 };
      let total = 0;
      let outliers = 0;
      let sum = 0;
      let squares = 0;
      const pixels = left.width * left.height;
      for (let index = 0; index < left.data.length; index += 4) {
        let largest = 0;
        for (let channel = 0; channel < 3; channel++) {
          const value = left.data[index + channel] ?? 0;
          const difference = Math.abs(value - (right.data[index + channel] ?? 0));
          total += difference;
          largest = Math.max(largest, difference);
          sum += value;
          squares += value * value;
        }
        if (largest > delta) outliers += 1;
      }
      const mean = sum / (pixels * 3);
      return { sameSize: true, mean: total / (pixels * 3), outliers: outliers / pixels, spread: Math.sqrt(squares / (pixels * 3) - mean * mean) };
    },
    [first.toString("base64"), second.toString("base64"), tolerance.outlierDelta] as const,
  );
  await page.close();
  return result;
};

test("each renderer draws the same image with WebGPU and with WebGL 2", async (t) => {
  if (server === undefined) throw new Error("No server.");
  const missing = await hardwareProblem();
  if (missing !== undefined) {
    t.skip(`This machine cannot compare the backends: ${missing}`);
    return;
  }
  const origin = server.origin;
  for (const item of cases) {
    await t.test(item.name, async () => {
      const webgpu = await capture(origin, item, "webgpu");
      const webgl2 = await capture(origin, item, "webgl2");
      assert.equal(webgpu.backend, "webgpu");
      assert.equal(webgl2.backend, "webgl2");
      const difference = await compare(webgpu.image, webgl2.image);
      t.diagnostic(`${item.name}: mean difference ${difference.mean.toFixed(3)}, outliers ${(difference.outliers * 100).toFixed(3)}%`);
      assert.ok(difference.sameSize, "the images have the same size");
      assert.ok(difference.spread > 8, "the image is not blank");
      assert.ok(difference.mean <= tolerance.meanLimit, `mean difference ${difference.mean.toFixed(3)} > ${tolerance.meanLimit}`);
      assert.ok(difference.outliers <= tolerance.outlierLimit, `outliers ${(difference.outliers * 100).toFixed(3)}% > ${tolerance.outlierLimit * 100}%`);
    });
  }
});

test("the hero keeps its animation after a resize across 960px", async (t) => {
  if (browser === undefined || server === undefined) throw new Error("No browser.");
  const missing = await hardwareProblem();
  if (missing !== undefined) {
    t.skip(`This machine has no hardware GPU: ${missing}`);
    return;
  }
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: 0 });
  await page.goto(`${server.origin}/`);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-plate]")?.dataset["gpu"] !== undefined, undefined, { timeout: 20000 });
  for (const [width, plate] of [[390, "phone"], [1440, "plate"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction((name) => {
      const still = document.querySelector<HTMLImageElement>("[data-plate] img");
      return still !== null && still.complete && new URL(still.currentSrc).pathname.startsWith(`/assets/${name}`);
    }, plate);
    const canvas = page.locator("[data-plate].is-live canvas");
    const first = await canvas.screenshot({ animations: "allow" });
    await page.clock.runFor(500);
    const second = await canvas.screenshot({ animations: "allow" });
    assert.notDeepEqual(first, second, `at ${width}px, the hero still moves`);
  }
  await page.close();
  assert.deepEqual(errors, []);
});

test("the code of each language fits the catalog screen of Fig. 1, wide and tall", async (t) => {
  if (browser === undefined || server === undefined) throw new Error("No browser.");
  const missing = await hardwareProblem();
  if (missing !== undefined) {
    t.skip(`This machine has no hardware GPU: ${missing}`);
    return;
  }
  for (const width of [390, 1440]) {
    const page = await openPage(browser, { viewport: { width, height: 900 } });
    await page.goto(`${server.origin}/`);
    await page.locator(".engine-stage").evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".engine-stage")?.dataset["engine"] === "live", undefined, { timeout: 20000 });
    for (const language of await page.locator("button[data-language]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-language") ?? ""))) {
      const overflow = await page.evaluate((id) => {
        document.querySelector<HTMLButtonElement>(`button[data-language="${id}"]`)?.click();
        const screen = document.querySelector<HTMLElement>("[data-catalog-screen]");
        return screen === null ? -1 : screen.scrollHeight - screen.clientHeight;
      }, language);
      assert.ok(overflow === 0, `at ${width}px, the ${language} code overflows the catalog screen by ${overflow}px`);
    }
    await page.close();
  }
});
