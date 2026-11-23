interface ElementImageSize {
  readonly width: number;
  readonly height: number;
}

export interface DrawableCanvas extends HTMLCanvasElement {
  requestPaint: () => void;
  updateElementGeometry: (element: Element, options: { canvasTransform: DOMMatrix }) => void;
  getElementImageDefaultSize: (element: Element) => ElementImageSize;
}

export interface ElementTextureContext extends WebGL2RenderingContext {
  texElementSubImage2D: (target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, element: Element) => void;
}

const isDrawableCanvas = (canvas: HTMLCanvasElement): canvas is DrawableCanvas =>
  ["requestPaint", "updateElementGeometry", "getElementImageDefaultSize"].every((name) => typeof Reflect.get(canvas, name) === "function");

const hasElementTextures = (gl: WebGL2RenderingContext): gl is ElementTextureContext => typeof Reflect.get(gl, "texElementSubImage2D") === "function";

export function mountCatalogEngine(host: HTMLElement) {
  const eligible = matchMedia("(min-width: 901px) and (prefers-reduced-motion: no-preference)");
  if (typeof WebGL2RenderingContext === "undefined" ||
      typeof Reflect.get(WebGL2RenderingContext.prototype, "texElementSubImage2D") !== "function") return;

  let near = false;
  let loading = false;
  let stop: (() => void) | undefined;

  async function activate() {
    if (!eligible.matches || !near || stop || loading) return;
    const canvas = document.createElement("canvas");
    if (!isDrawableCanvas(canvas)) return;
    canvas.setAttribute("content", "drawable");
    canvas.className = "holo-canvas";
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true });
    if (!gl || !hasElementTextures(gl)) return;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
    if (/swiftshader|llvmpipe|softpipe|software/i.test(gpu)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return;
    }
    loading = true;
    try {
      const { buildMachine } = await import("./catalog-engine.js");
      if (eligible.matches && near) stop = buildMachine(host, canvas, gl);
    } finally {
      loading = false;
      if (!stop) gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  new IntersectionObserver(([entry]) => {
    near = entry?.isIntersecting ?? false;
    if (near) void activate();
  }, { rootMargin: "240px" }).observe(host.parentElement ?? host);
  eligible.addEventListener("change", () => {
    if (eligible.matches) void activate();
    else {
      stop?.();
      stop = undefined;
    }
  });
}
