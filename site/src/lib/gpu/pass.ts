import type { ShaderSource } from "./shader.ts";
import { hardwareWebgl2, requestDevice, supportsWebgpuElements } from "./support.ts";
import { createWebgl2Pass } from "./webgl2-pass.ts";

export type Backend = "webgpu" | "webgl2";

export type UniformValues = Readonly<Record<string, number | readonly [number, number]>>;

export interface PassOptions {
  readonly alpha: boolean;
  readonly elements?: boolean;
}

export interface Pass {
  readonly backend: Backend;
  readonly setImage: (name: string, image: ImageBitmap) => void;
  readonly setElement: (name: string, element: Element, width: number, height: number) => void;
  readonly draw: (values: UniformValues) => void;
  /** Resolves when the GPU has done the work that the pass gave it, without blocking the main thread. */
  readonly idle: () => Promise<void>;
  readonly destroy: () => void;
}

/**
 * Draws `source` over the whole canvas with WebGPU when the browser gives a hardware adapter (and, for `elements`,
 * draws HTML into WebGPU textures), and with WebGL 2 otherwise. Gives `undefined` when neither draws on a hardware GPU.
 */
export const createPass = async (canvas: HTMLCanvasElement, source: ShaderSource, options: PassOptions): Promise<Pass | undefined> => {
  if (options.elements !== true || supportsWebgpuElements()) {
    const device = await requestDevice();
    if (device !== undefined) {
      const { createWebgpuPass } = await import("./webgpu-pass.ts");
      const pass = await createWebgpuPass(canvas, source, options, device).catch(() => undefined);
      if (pass !== undefined) return pass;
      device.destroy();
    }
  }
  if (!(await hardwareWebgl2())) return undefined;
  return createWebgl2Pass(canvas, source, options);
};
