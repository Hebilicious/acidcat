import type { ShaderSource } from "./shader.ts";
import { requestDevice, supportsWebgpuElements } from "./support.ts";
import { createWebgl2Pass } from "./webgl2-pass.ts";

export type Backend = "webgpu" | "webgl2";

export type UniformValues = Readonly<Record<string, number | readonly [number, number]>>;

export interface PassOptions {
  readonly alpha: boolean;
  readonly elements?: boolean;
  readonly preserveDrawingBuffer?: boolean;
}

export interface Pass {
  readonly backend: Backend;
  readonly software: boolean;
  readonly setImage: (name: string, image: HTMLImageElement) => void;
  readonly setElement: (name: string, element: Element, width: number, height: number) => void;
  readonly draw: (values: UniformValues) => void;
  readonly destroy: () => void;
}

/**
 * Draws `source` over the whole canvas with WebGPU when the browser gives a hardware adapter (and, for `elements`,
 * draws HTML into WebGPU textures), and with WebGL 2 otherwise.
 */
export const createPass = async (canvas: HTMLCanvasElement, source: ShaderSource, options: PassOptions): Promise<Pass> => {
  const elementsOnWebgpu = options.elements !== true || supportsWebgpuElements();
  if (elementsOnWebgpu) {
    const gpu = await requestDevice();
    if (gpu !== undefined) {
      const { createWebgpuPass } = await import("./webgpu-pass.ts");
      const pass = await createWebgpuPass(canvas, source, options, gpu.device).catch(() => undefined);
      if (pass !== undefined) return pass;
      gpu.device.destroy();
    }
  }
  return createWebgl2Pass(canvas, source, options);
};
