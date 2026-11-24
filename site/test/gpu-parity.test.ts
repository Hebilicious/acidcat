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
  { name: "the hero at 390px, after three seconds", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", region: "[data-plate] canvas", backendOf: "[data-plate]" },
  { name: "the wide Fig. 1 at 1440px, still", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", region: ".holo-canvas", backendOf: ".engine-stage", scroll: ".engine-stage" },
  { name: "the tall Fig. 1 at 390px, still", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", region: ".holo-canvas", backendOf: ".engine-stage", scroll: ".engine-stage" },
  { name: "the key specifications of Fig. 2 at 1440px, still", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", region: ".spec-frame canvas", backendOf: ".spec-frame canvas", scroll: ".spec-frame" },
  { name: "the console of Fig. 4 at 390px, still", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", region: ".cores .bluescreen-canvas", backendOf: ".cores .bluescreen-canvas", scroll: ".console" },
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

const capture = async (origin: string, item: Case, backend: Backend): Promise<{ image: Buffer; backend: string | undefined }> => {
  if (browser === undefined) throw new Error("No browser.");
  const context = await browser.newContext({ viewport: item.viewport, reducedMotion: item.reducedMotion });
  if (backend === "webgl2") await hideWebgpu(context);
  await stubGitHub(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
  await page.waitForTimeout(1500);
  const image = await page.locator(item.region).first().screenshot({ animations: "allow" });
  const used = await page.locator(item.backendOf).first().evaluate((element) => (element instanceof HTMLElement ? element.dataset["gpu"] : undefined));
  await context.close();
  assert.deepEqual(errors, []);
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
  if (browser === undefined || server === undefined) throw new Error("No browser.");
  const probe = await openPage(browser);
  await probe.goto(`${server.origin}/404`);
  const missing = await missingHardware(probe);
  await probe.close();
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
