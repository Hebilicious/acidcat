export interface DrawableCanvas extends HTMLCanvasElement {
  requestPaint: () => void;
  updateElementGeometry: (element: Element, options: { canvasTransform: DOMMatrix }) => void;
  getElementImageDefaultSize: (element: Element) => { readonly width: number; readonly height: number };
}

export const isDrawableCanvas = (canvas: HTMLCanvasElement): canvas is DrawableCanvas =>
  ["requestPaint", "updateElementGeometry", "getElementImageDefaultSize"].every((name) => typeof Reflect.get(canvas, name) === "function");

export interface ElementDrawingQueue extends GPUQueue {
  drawElementImageToTexture: (source: { source: Element }, destination: { texture: GPUTexture; premultipliedAlpha: boolean }) => void;
}

export interface ElementTextureContext extends WebGL2RenderingContext {
  texElementSubImage2D: (target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, element: Element) => void;
}

export const canDrawElements = (queue: GPUQueue): queue is ElementDrawingQueue => typeof Reflect.get(queue, "drawElementImageToTexture") === "function";
export const hasElementTextures = (gl: WebGL2RenderingContext): gl is ElementTextureContext => typeof Reflect.get(gl, "texElementSubImage2D") === "function";

export const softwareRenderer = /swiftshader|llvmpipe|softpipe|software/i;

export const supportsWebgl2Elements = (): boolean =>
  typeof WebGL2RenderingContext !== "undefined" && typeof Reflect.get(WebGL2RenderingContext.prototype, "texElementSubImage2D") === "function";

export const supportsWebgpuElements = (): boolean =>
  typeof GPUQueue !== "undefined" && typeof Reflect.get(GPUQueue.prototype, "drawElementImageToTexture") === "function";

export const supportsHtmlInCanvas = (): boolean =>
  typeof Reflect.get(HTMLCanvasElement.prototype, "requestPaint") === "function" && (supportsWebgl2Elements() || supportsWebgpuElements());

/** The margin around the viewport inside which a renderer starts its work. Each figure starts below it at load. */
export const nearMargin = "30% 0px";

/** Resolves when the element comes near the viewport. Rejects when `signal` aborts first. */
export const whenNear = (element: Element, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting !== true) return;
        observer.disconnect();
        resolve();
      },
      { rootMargin: nearMargin },
    );
    observer.observe(element);
    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
        reject(signal.reason);
      },
      { once: true },
    );
  });

export const onNear = (element: Element, signal: AbortSignal, start: () => void): void => {
  whenNear(element, signal).then(start, () => undefined);
};

// lib.dom does not declare GPUBufferUsage, GPUTextureUsage and GPUMapMode. These are their values in the WebGPU specification.
export const bufferUsage = { mapRead: 0x1, copyDst: 0x8, uniform: 0x40 } as const;
export const textureUsage = { copySrc: 0x1, copyDst: 0x2, textureBinding: 0x4, renderAttachment: 0x10 } as const;
const mapRead = 0x1;

/**
 * Clears a texture of one pixel and reads it back. Some adapters give a device that draws nothing and reports no error
 * until a read, so a device that fails this check falls back to WebGL 2.
 */
const drawsPixels = async (device: GPUDevice): Promise<boolean> => {
  const texture = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: textureUsage.renderAttachment | textureUsage.copySrc });
  const buffer = device.createBuffer({ size: 4, usage: bufferUsage.mapRead | bufferUsage.copyDst });
  const encoder = device.createCommandEncoder();
  encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: "clear", clearValue: [1, 0.5, 0, 1], storeOp: "store" }] }).end();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 1]);
  device.queue.submit([encoder.finish()]);
  const pixel = await buffer.mapAsync(mapRead).then(
    () => Array.from(new Uint8Array(buffer.getMappedRange())),
    () => [],
  );
  texture.destroy();
  buffer.destroy();
  return pixel[0] === 255 && pixel[1] === 128 && pixel[2] === 0 && pixel[3] === 255;
};

const newDevice = async (): Promise<GPUDevice | undefined> => {
  const gpu: unknown = Reflect.get(navigator, "gpu");
  if (typeof GPU === "undefined" || !(gpu instanceof GPU)) return undefined;
  const adapter = await gpu.requestAdapter({ powerPreference: "low-power" }).catch(() => null);
  if (adapter === null || adapter.info.isFallbackAdapter || softwareRenderer.test(adapter.info.description)) return undefined;
  return adapter.requestDevice().catch(() => undefined);
};

let spare: GPUDevice | undefined;
let webgpu: Promise<boolean> | undefined;

const checkWebgpu = async (): Promise<boolean> => {
  const checked = await newDevice();
  if (checked === undefined) return false;
  if (await drawsPixels(checked)) {
    spare = checked;
    return true;
  }
  checked.destroy();
  return false;
};

/** Gives a new WebGPU device on a hardware adapter that draws, or `undefined`. The first call checks the adapter. */
export const requestDevice = async (): Promise<GPUDevice | undefined> => {
  if (!(await (webgpu ??= checkWebgpu()))) return undefined;
  const device = spare;
  spare = undefined;
  return device ?? newDevice();
};

const probeWorker = `
let renderer = null;
try {
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
  if (gl !== null) {
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    renderer = String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
} catch {}
postMessage(renderer);
`;

const rendererOnMainThread = (): string | undefined => {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (gl === null) return undefined;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL));
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return renderer;
};

// The first call that reads the renderer of a WebGL context waits for the GPU process, so a worker waits in its place.
// The worker stays open: when a worker that made a WebGL context ends, the main thread spends about 30 ms to release it.
const rendererInWorker = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
      resolve(rendererOnMainThread());
      return;
    }
    const url = URL.createObjectURL(new Blob([probeWorker], { type: "text/javascript" }));
    const worker = new Worker(url);
    const finish = (renderer: string | undefined) => {
      URL.revokeObjectURL(url);
      resolve(renderer);
    };
    worker.addEventListener("message", (event: MessageEvent<unknown>) => finish(typeof event.data === "string" ? event.data : rendererOnMainThread()));
    worker.addEventListener("error", () => finish(rendererOnMainThread()));
  });

let webgl2: Promise<boolean> | undefined;

/** Tells, without blocking the main thread, whether WebGL 2 draws on a hardware GPU. */
export const hardwareWebgl2 = (): Promise<boolean> =>
  (webgl2 ??= rendererInWorker().then((renderer) => renderer !== undefined && !softwareRenderer.test(renderer)));

/** Tells whether WebGPU or WebGL 2 draws on a hardware GPU, the WebGPU check first. */
export const hardwareGpu = async (): Promise<boolean> => (await (webgpu ??= checkWebgpu())) || (await hardwareWebgl2());

/** Ends the current task, so that the browser can paint and handle input before the next step. */
export const yieldToMain = (): Promise<void> => {
  const scheduler: unknown = Reflect.get(globalThis, "scheduler");
  const yielding: unknown = typeof scheduler === "object" && scheduler !== null ? Reflect.get(scheduler, "yield") : undefined;
  if (typeof yielding === "function") return Promise.resolve(Reflect.apply(yielding, scheduler, [])).then(() => undefined);
  return new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Waits `ms` milliseconds. It uses `scheduler.postTask` where the browser has it: a test that installs a fake clock
 * fakes `setTimeout`, and a wait for the GPU must still end.
 */
export const pause = (ms: number): Promise<void> => {
  const scheduler: unknown = Reflect.get(globalThis, "scheduler");
  const postTask: unknown = typeof scheduler === "object" && scheduler !== null ? Reflect.get(scheduler, "postTask") : undefined;
  if (typeof postTask === "function") return Promise.resolve(Reflect.apply(postTask, scheduler, [() => undefined, { delay: ms }])).then(() => undefined);
  return new Promise((resolve) => setTimeout(resolve, ms));
};
