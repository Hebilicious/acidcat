import { bluescreenShader } from "./bluescreen-shader.ts";
import { createPass } from "./gpu/pass.ts";
import { isDrawableCanvas, whenNear } from "./gpu/support.ts";

export { supportsHtmlInCanvas } from "./gpu/support.ts";

export interface Bluescreen {
  readonly replay: () => void;
  readonly destroy: () => void;
}

export interface BluescreenOptions {
  readonly intensity?: number;
  readonly revealMs?: number;
  readonly replayMs?: number;
  /** Draws one frame each time the content or the pointer changes, with no animation. */
  readonly still?: boolean;
}

/** Draws `host` as a blue screen until `signal` aborts. Gives `undefined` when the browser cannot, or when `signal` aborts first. */
export const createBluescreen = async (host: HTMLElement, options: BluescreenOptions, signal: AbortSignal): Promise<Bluescreen | undefined> => {
  const intensity = options.intensity ?? 1;
  const still = options.still ?? false;
  let revealMs = options.revealMs ?? 1600;
  if (host.parentElement === null) return undefined;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("content", "drawable");
  canvas.className = "bluescreen-canvas";
  if (!isDrawableCanvas(canvas)) return undefined;
  const near = await whenNear(host, signal).then(
    () => true,
    () => false,
  );
  if (!near) return undefined;
  const pass = await createPass(canvas, bluescreenShader, { alpha: true, elements: true }).catch(() => undefined);
  if (pass === undefined) return undefined;
  if (signal.aborted) {
    pass.destroy();
    return undefined;
  }
  canvas.dataset["gpu"] = pass.backend;

  const content = host;
  content.setAttribute("drawable", "");
  content.classList.remove("will-reveal");
  content.before(canvas);
  canvas.append(content);

  let uploaded = false;
  let visibleSince = -1;
  let frame = 0;
  let visible = false;
  const pointer = { x: -9999, y: -9999, active: 0, target: 0 };
  const started = performance.now();

  const draw = () => {
    if (!uploaded) return;
    const now = performance.now();
    pointer.active = still ? pointer.target : pointer.active + (pointer.target - pointer.active) * 0.12;
    pass.draw({
      uResolution: [canvas.clientWidth, canvas.clientHeight],
      uPointer: [pointer.x, pointer.y],
      uPointerActive: pointer.active,
      uTime: still ? 0 : (now - started) / 1000,
      uReveal: still ? 1 : visibleSince < 0 ? 0 : Math.min(1, (now - visibleSince) / revealMs),
      uIntensity: intensity,
    });
  };

  const fit = () => {
    canvas.style.height = `${content.offsetHeight}px`;
    const ratio = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(content.offsetHeight * ratio));
    if (still) draw();
  };
  const resizer = new ResizeObserver(fit);
  resizer.observe(content);
  fit();

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    observer.disconnect();
    resizer.disconnect();
    cancelAnimationFrame(frame);
    pass.destroy();
    canvas.replaceWith(content);
    content.removeAttribute("drawable");
  };

  canvas.addEventListener("paint", () => {
    const size = canvas.getElementImageDefaultSize(content);
    pass.setElement("uContent", content, Math.ceil(size.width), Math.ceil(size.height));
    canvas.updateElementGeometry(content, { canvasTransform: new DOMMatrix() });
    uploaded = true;
    try {
      draw();
    } catch {
      destroy();
    }
  });

  const loop = () => {
    if (!visible) return;
    draw();
    frame = requestAnimationFrame(loop);
  };

  const observer = new IntersectionObserver(
    ([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible && visibleSince < 0 && (entry?.intersectionRatio ?? 0) > 0) visibleSince = performance.now();
      cancelAnimationFrame(frame);
      if (visible && !still) frame = requestAnimationFrame(loop);
    },
    { threshold: [0, 0.2] },
  );
  observer.observe(canvas);

  canvas.addEventListener("pointermove", (event) => {
    const box = canvas.getBoundingClientRect();
    pointer.x = event.clientX - box.left;
    pointer.y = event.clientY - box.top;
    pointer.target = 1;
    if (still) draw();
  });
  canvas.addEventListener("pointerleave", () => {
    pointer.target = 0;
    if (still) draw();
  });
  canvas.requestPaint();
  signal.addEventListener("abort", destroy, { once: true });

  return {
    replay: () => {
      revealMs = options.replayMs ?? revealMs;
      visibleSince = performance.now();
      canvas.requestPaint();
    },
    destroy,
  };
};
