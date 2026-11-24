import { NodeMaterial, NormalBlending, SRGBColorSpace } from "three/webgpu";
import type { Blending, Node } from "three/webgpu";
import { colorSpaceToWorking, vec4 } from "three/tsl";

export interface ShaderOptions {
  readonly transparent?: boolean;
  readonly depthWrite?: boolean;
  readonly blending?: Blending;
}

/**
 * A material that outputs `color` and `alpha` with no lighting and no fog. `color` is in display (sRGB) values, as
 * the eye sees them, and the renderer writes it back out unchanged.
 */
export const shaderMaterial = (color: Node<"vec3">, alpha: Node<"float"> | number, options: ShaderOptions = {}): NodeMaterial => {
  const material = new NodeMaterial();
  material.fog = false;
  material.transparent = options.transparent ?? false;
  material.depthWrite = options.depthWrite ?? true;
  material.blending = options.blending ?? NormalBlending;
  material.fragmentNode = colorSpaceToWorking(vec4(color, alpha), SRGBColorSpace);
  return material;
};
