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

const softwareRenderer = /swiftshader|llvmpipe|softpipe|software/i;

export function mountCatalogEngine(host: HTMLElement) {
  const eligible = matchMedia("(min-width: 901px) and (prefers-reduced-motion: no-preference)");
  if (typeof WebGL2RenderingContext === "undefined" ||
      typeof Reflect.get(WebGL2RenderingContext.prototype, "texElementSubImage2D") !== "function") return;
  const stage = host.parentElement ?? host;

  let near = false;
  let loading = false;
  let stop: (() => void) | undefined;
  let engine: Promise<typeof import("./catalog-engine.js")> | undefined;

  const prepare = (): { canvas: DrawableCanvas; gl: ElementTextureContext } | undefined => {
    const canvas = document.createElement("canvas");
    if (!isDrawableCanvas(canvas)) return undefined;
    canvas.setAttribute("content", "drawable");
    canvas.className = "holo-canvas";
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true });
    if (!gl || !hasElementTextures(gl)) return undefined;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
    if (softwareRenderer.test(gpu)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return undefined;
    }
    return { canvas, gl };
  };

  let prepared = eligible.matches ? prepare() : undefined;
  const fallBack = () => {
    delete stage.dataset["engine"];
  };
  if (prepared) {
    stage.dataset["engine"] = "pending";
    engine = import("./catalog-engine.js");
    engine.catch(fallBack);
  }

  async function activate() {
    if (!eligible.matches || !near || stop || loading) return;
    prepared ??= prepare();
    if (!prepared) {
      fallBack();
      return;
    }
    const { canvas, gl } = prepared;
    loading = true;
    try {
      engine ??= import("./catalog-engine.js");
      const { buildMachine } = await engine;
      if (!eligible.matches || !near) return;
      stop = buildMachine(host, canvas, gl);
      stage.dataset["engine"] = "live";
    } catch {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      prepared = undefined;
      fallBack();
    } finally {
      loading = false;
    }
  }

  new IntersectionObserver(([entry]) => {
    near = entry?.isIntersecting ?? false;
    if (near) void activate();
  }, { rootMargin: "900px" }).observe(stage);
  eligible.addEventListener("change", () => {
    if (eligible.matches) void activate();
    else {
      stop?.();
      stop = undefined;
      prepared = undefined;
      fallBack();
    }
  });
}
