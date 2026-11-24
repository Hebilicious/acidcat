import { createPass } from "./gpu/pass.ts";
import type { Backend } from "./gpu/pass.ts";
import { plateShader } from "./plate-shader.ts";

export interface PlateSources {
  readonly artPad: number;
  readonly plate: string;
  readonly clean: string;
  readonly data: string;
}

export interface PlateFraming {
  readonly aspect: number;
  readonly focusX: number;
  readonly targetX: number;
  readonly zoom: number;
}

export interface PlateState {
  time?: number;
  camera?: readonly [number, number];
  reveal?: number;
}

export interface PlateHandle {
  readonly backend: Backend;
  readonly software: boolean;
  readonly render: (state?: PlateState) => void;
  readonly start: () => void;
  readonly stop: () => void;
  readonly setActive: (active: boolean) => void;
}

const FOCUS_DEPTH = 0.64;

const loadImage = async (source: string): Promise<HTMLImageElement> => {
  const image = new Image();
  image.decoding = "async";
  image.src = source;
  await image.decode();
  return image;
};

export const framingSpan = (width: number, height: number, framing: PlateFraming): { span: [number, number]; center: [number, number] } => {
  const viewAspect = width / height;
  const span: [number, number] = viewAspect > framing.aspect ? [1, framing.aspect / viewAspect] : [viewAspect / framing.aspect, 1];
  span[0] /= framing.zoom;
  span[1] /= framing.zoom;
  const clamp = (value: number, size: number) => Math.min(1 - size / 2, Math.max(size / 2, value));
  const centerX = clamp(framing.focusX - (framing.targetX - 0.5) * span[0], span[0]);
  return { span, center: [centerX, clamp(0.5, span[1])] };
};

export const createPlate = async (canvas: HTMLCanvasElement, sources: PlateSources, framing: () => PlateFraming): Promise<PlateHandle> => {
  const [pass, plate, clean, data] = await Promise.all([
    createPass(canvas, plateShader, { alpha: false, preserveDrawingBuffer: true }),
    loadImage(sources.plate),
    loadImage(sources.clean),
    loadImage(sources.data),
  ]);
  pass.setImage("uPlate", plate);
  pass.setImage("uClean", clean);
  pass.setImage("uData", data);
  const imageSize = [data.naturalWidth, data.naturalHeight] as const;

  const pointer = { x: 0, y: 0, active: 0 };
  const eased = { x: 0, y: 0, active: 0 };
  const started = performance.now();
  let frame = 0;
  let running = false;

  let scale = 1;
  let budgetFrames = 0;
  let budgetTime = 0;
  let last = 0;

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio, 1.75) * scale;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };

  const render = (state: PlateState = {}) => {
    resize();
    const { span, center } = framingSpan(canvas.width, canvas.height, framing());
    const elapsed = (performance.now() - started) / 1000;
    const time = state.time ?? elapsed;
    const camera: readonly [number, number] = state.camera ?? [eased.x + Math.sin(time * 0.31) * 0.22, eased.y + Math.cos(time * 0.23) * 0.12];
    pass.draw({
      uResolution: [canvas.width, canvas.height],
      uSpan: span,
      uCenter: center,
      uCamera: camera,
      uLight: [eased.x * 1.4, -eased.y * 1.4 + 0.3],
      uTime: time,
      uReveal: state.reveal ?? Math.min(1, elapsed / 2.4),
      uFocus: FOCUS_DEPTH,
      uActive: eased.active,
      uImageSize: imageSize,
      uArtPad: sources.artPad,
    });
  };

  const measure = (now: number) => {
    const delta = last === 0 ? 0 : now - last;
    last = now;
    if (delta === 0 || delta > 250) return;
    budgetTime += delta;
    budgetFrames += 1;
    if (budgetFrames < 8) return;
    const average = budgetTime / budgetFrames;
    budgetFrames = 0;
    budgetTime = 0;
    if (average > 26) scale = Math.max(0.45, scale * 0.8);
    else if (average < 18) scale = Math.min(1, scale / 0.8);
  };

  const tick = (now: number) => {
    measure(now);
    eased.x += (pointer.x - eased.x) * 0.05;
    eased.y += (pointer.y - eased.y) * 0.05;
    eased.active += (pointer.active - eased.active) * 0.06;
    render();
    if (running) frame = requestAnimationFrame(tick);
  };

  const fine = window.matchMedia("(pointer: fine)");
  if (fine.matches) {
    window.addEventListener(
      "pointermove",
      (event) => {
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
        pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
        pointer.active = 1;
      },
      { passive: true },
    );
    document.addEventListener("pointerleave", () => {
      pointer.active = 0;
    });
  }

  return {
    backend: pass.backend,
    software: pass.software,
    render,
    start: () => {
      if (running) return;
      running = true;
      last = 0;
      frame = requestAnimationFrame(tick);
    },
    stop: () => {
      running = false;
      cancelAnimationFrame(frame);
    },
    setActive: (active) => {
      pointer.active = active ? 1 : 0;
    },
  };
};
