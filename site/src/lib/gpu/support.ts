export interface DrawableCanvas extends HTMLCanvasElement {
  requestPaint: () => void;
  updateElementGeometry: (element: Element, options: { canvasTransform: DOMMatrix }) => void;
  getElementImageDefaultSize: (element: Element) => { readonly width: number; readonly height: number };
}

export const isDrawableCanvas = (canvas: HTMLCanvasElement): canvas is DrawableCanvas =>
  ["requestPaint", "updateElementGeometry", "getElementImageDefaultSize"].every((name) => typeof Reflect.get(canvas, name) === "function");

export const softwareRenderer = /swiftshader|llvmpipe|softpipe|software/i;

export const supportsWebgl2Elements = (): boolean =>
  typeof WebGL2RenderingContext !== "undefined" && typeof Reflect.get(WebGL2RenderingContext.prototype, "texElementSubImage2D") === "function";

export const supportsWebgpuElements = (): boolean =>
  typeof GPUQueue !== "undefined" && typeof Reflect.get(GPUQueue.prototype, "drawElementImageToTexture") === "function";

export const supportsHtmlInCanvas = (): boolean =>
  typeof Reflect.get(HTMLCanvasElement.prototype, "requestPaint") === "function" && (supportsWebgl2Elements() || supportsWebgpuElements());

export const requestDevice = async (): Promise<{ adapter: GPUAdapter; device: GPUDevice } | undefined> => {
  const gpu: unknown = Reflect.get(navigator, "gpu");
  if (!(gpu instanceof GPU)) return undefined;
  const adapter = await gpu.requestAdapter({ powerPreference: "low-power" }).catch(() => null);
  if (adapter === null || adapter.info.isFallbackAdapter || softwareRenderer.test(adapter.info.description)) return undefined;
  const device = await adapter.requestDevice().catch(() => undefined);
  return device === undefined ? undefined : { adapter, device };
};
