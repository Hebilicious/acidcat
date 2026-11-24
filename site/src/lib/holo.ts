import type { MachineGpu } from "./catalog-engine.ts";
import { hardwareGpu, hardwareWebgl2, isDrawableCanvas, nearMargin, requestDevice, supportsHtmlInCanvas, supportsWebgl2Elements, supportsWebgpuElements, yieldToMain } from "./gpu/support.ts";
import type { DrawableCanvas } from "./gpu/support.ts";

interface Prepared {
  readonly canvas: DrawableCanvas;
  readonly gpu: MachineGpu;
}

const drawableCanvas = (): DrawableCanvas | undefined => {
  const canvas = document.createElement("canvas");
  if (!isDrawableCanvas(canvas)) return undefined;
  canvas.setAttribute("content", "drawable");
  canvas.className = "holo-canvas";
  return canvas;
};

const prepare = async (webgpu: boolean): Promise<Prepared | undefined> => {
  const canvas = drawableCanvas();
  if (canvas === undefined) return undefined;
  if (webgpu && supportsWebgpuElements()) {
    const device = await requestDevice();
    if (device !== undefined) return { canvas, gpu: { kind: "webgpu", device } };
  }
  if (!supportsWebgl2Elements() || !(await hardwareWebgl2())) return undefined;
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: true });
  return gl === null ? undefined : { canvas, gpu: { kind: "webgl2", gl } };
};

const release = ({ gpu }: Prepared) => {
  if (gpu.kind === "webgpu") gpu.device.destroy();
  else gpu.gl.getExtension("WEBGL_lose_context")?.loseContext();
};

export function mountCatalogEngine(host: HTMLElement) {
  if (!supportsHtmlInCanvas()) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const wide = matchMedia("(min-width: 901px)");
  const layout = () => (wide.matches ? "wide" : "tall");
  const stage = host.parentElement ?? host;

  let near = false;
  let loading = false;
  let stop: (() => void) | undefined;

  const fallBack = () => {
    delete stage.dataset["engine"];
    delete stage.dataset["gpu"];
  };

  async function build(prepared: Prepared): Promise<boolean> {
    try {
      const { buildMachine } = await import("./catalog-engine.ts");
      if (!near) {
        release(prepared);
        return true;
      }
      stage.dataset["layout"] = layout();
      stop = await buildMachine(host, prepared.canvas, prepared.gpu, { layout: layout(), still: still.matches });
      stage.dataset["engine"] = "live";
      stage.dataset["gpu"] = prepared.gpu.kind;
      return true;
    } catch {
      release(prepared);
      return false;
    }
  }

  async function activate() {
    if (!near || stop || loading) return;
    loading = true;
    const first = await prepare(true);
    const built = first !== undefined && (await build(first));
    const second = built || first?.gpu.kind !== "webgpu" ? undefined : await prepare(false);
    if (!built && (second === undefined || !(await build(second)))) fallBack();
    loading = false;
  }

  const rebuild = () => {
    stop?.();
    stop = undefined;
    stage.dataset["engine"] = "pending";
    void activate();
  };

  void yieldToMain().then(hardwareGpu).then((hardware) => {
    if (!hardware) return;
    stage.dataset["engine"] = "pending";
    stage.dataset["layout"] = layout();
    new IntersectionObserver(([entry]) => {
      near = entry?.isIntersecting ?? false;
      if (near) void activate();
    }, { rootMargin: nearMargin }).observe(stage);
    still.addEventListener("change", rebuild);
    wide.addEventListener("change", rebuild);
  });
}
