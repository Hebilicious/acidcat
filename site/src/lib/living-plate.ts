import cleanAvif from "../assets/hero/clean.avif?url";
import cleanWebp from "../assets/hero/clean.webp?url";
import data from "../assets/hero/data.webp?url";
import { art, phoneCrop, phoneMedia } from "./plate-crop.ts";
import { createPlate, framingSpan } from "./plate-renderer.ts";
import type { PlateFraming } from "./plate-renderer.ts";

const catX = (art.pad + 0.555 * 1672) / art.width;
const fullRect = [0, 1] as const;
const phoneRect = [phoneCrop.x / art.width, phoneCrop.width / art.width] as const;

/** Frames the still image of the hero, and brings it to life on a hardware GPU, until `signal` aborts. */
export const mountPlate = (root: HTMLElement, signal: AbortSignal): void => {
  const canvas = root.querySelector("canvas");
  const still = root.querySelector("img");
  const phoneSource = root.querySelector<HTMLSourceElement>("source[data-phone]");
  if (canvas === null || still === null || phoneSource === null) return;

  const wide = window.matchMedia("(min-width: 1200px)");
  const phone = window.matchMedia(phoneMedia);
  const framing = (): PlateFraming => {
    const targetX = wide.matches ? 0.76 : phone.matches ? 0.5 : 0.7;
    return { aspect: art.width / art.height, focusX: catX, targetX, zoom: 1 };
  };

  const phonePlates = new Set(phoneSource.srcset.split(",").map((candidate) => new URL(candidate.trim().split(" ")[0] ?? "", document.baseURI).href));
  const plateRect = () => (phonePlates.has(still.currentSrc) ? phoneRect : fullRect);

  let size = { width: 0, height: 0 };
  const place = () => {
    if (size.width === 0 || size.height === 0) return;
    const { span, center } = framingSpan(size.width, size.height, framing());
    const [start, width] = plateRect();
    const spanX = span[0] / width;
    const centerX = (center[0] - start) / width;
    const x = spanX < 1 ? Math.min(1, Math.max(0, (centerX - spanX / 2) / (1 - spanX))) : 0.5;
    const y = span[1] < 1 ? (center[1] - span[1] / 2) / (1 - span[1]) : 0.5;
    root.style.setProperty("--plate-position", `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`);
  };
  // The observer gives the size after layout, so reading it forces no layout.
  const resizes = new ResizeObserver(([entry]) => {
    if (entry === undefined) return;
    size = { width: entry.contentRect.width, height: entry.contentRect.height };
    place();
  });
  resizes.observe(root);
  signal.addEventListener("abort", () => resizes.disconnect(), { once: true });
  still.addEventListener("load", place, { signal });

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let shown = "";
  const sources = () => {
    shown = still.currentSrc;
    const avif = shown.endsWith(".avif");
    return { artPad: art.pad, plate: shown, plateRect: plateRect(), clean: avif ? cleanAvif : cleanWebp, data };
  };
  still
    .decode()
    .catch(() => undefined)
    .then(() => (signal.aborted ? undefined : createPlate(canvas, sources(), framing, signal)))
    .then(
      (plate) => {
        if (plate === undefined) {
          if (!signal.aborted) canvas.remove();
          return;
        }
        root.classList.add("is-live");
        root.dataset["gpu"] = plate.backend;
        let visible = true;
        const sync = () => (visible && document.visibilityState === "visible" ? plate.start() : plate.stop());
        let swap = Promise.resolve();
        const followStillPlate = () => {
          const source = still.currentSrc;
          const rect = plateRect();
          swap = swap.then(async () => {
            if (source === shown || !still.complete || signal.aborted) return;
            shown = source;
            await plate.setPlate(source, rect);
          });
          swap.catch(() => {
            plate.stop();
            canvas.remove();
            root.classList.remove("is-live");
          });
        };
        still.addEventListener("load", followStillPlate, { signal });
        followStillPlate();
        const visibility = new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? false;
          sync();
        });
        visibility.observe(root);
        signal.addEventListener("abort", () => visibility.disconnect(), { once: true });
        document.addEventListener("visibilitychange", sync, { signal });
        document.addEventListener(
          "acidcat:surface",
          (event) => {
            plate.setActive(event instanceof CustomEvent && typeof event.detail === "string");
          },
          { signal },
        );
      },
      () => {
        canvas.remove();
      },
    );
};
