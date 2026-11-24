import type { Pass, PassOptions, UniformValues } from "./pass.ts";
import { toWgsl, uniformSlots } from "./wgsl.ts";
import type { ShaderSource } from "./shader.ts";

interface ElementDrawingQueue extends GPUQueue {
  drawElementImageToTexture: (source: { source: Element }, destination: { texture: GPUTexture; premultipliedAlpha: boolean }) => void;
}

const canDrawElements = (queue: GPUQueue): queue is ElementDrawingQueue => typeof Reflect.get(queue, "drawElementImageToTexture") === "function";

const format = "rgba8unorm";

// lib.dom does not declare GPUBufferUsage and GPUTextureUsage. These are their values in the WebGPU specification.
const bufferUsage = { copyDst: 0x8, uniform: 0x40 } as const;
const textureUsage = { copyDst: 0x2, textureBinding: 0x4, renderAttachment: 0x10 } as const;

const downsample = `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linear: sampler;
struct Varyings { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> Varyings {
  let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let corner = corners[index];
  return Varyings(vec4f(corner, 0.0, 1.0), vec2f(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5));
}
@fragment
fn fragmentMain(input: Varyings) -> @location(0) vec4f {
  return textureSampleLevel(source, linear, input.uv, 0.0);
}
`;

const mipLevels = (width: number, height: number) => Math.floor(Math.log2(Math.max(width, height))) + 1;

const mipmapper = async (device: GPUDevice) => {
  const module = device.createShaderModule({ code: downsample });
  const pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module, entryPoint: "vertexMain" },
    fragment: { module, entryPoint: "fragmentMain", targets: [{ format }] },
  });
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  return (texture: GPUTexture) => {
    const encoder = device.createCommandEncoder();
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: sampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store" }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  };
};

export const createWebgpuPass = async (canvas: HTMLCanvasElement, source: ShaderSource, options: PassOptions, device: GPUDevice): Promise<Pass> => {
  const { queue } = device;
  if (options.elements === true && !canDrawElements(queue)) throw new Error("WebGPU cannot draw HTML into a texture.");
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  const module = device.createShaderModule({ code: toWgsl(source) });
  const [pipeline, generateMipmaps] = await Promise.all([
    device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module, entryPoint: "vertexMain" },
      fragment: { module, entryPoint: "fragmentMain", targets: [{ format: canvasFormat }] },
    }),
    source.textures.some((texture) => texture.mipmaps) ? mipmapper(device) : () => {},
  ]);

  const slots = uniformSlots(source);
  const uniformData = new Float32Array(Math.max(1, slots.length) * 4);
  const uniformBuffer = device.createBuffer({ size: uniformData.byteLength, usage: bufferUsage.uniform | bufferUsage.copyDst });
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" });
  const placeholder = device.createTexture({ size: [1, 1], format, usage: textureUsage.textureBinding });
  const textures = new Map(source.textures.map((texture) => [texture.name, { mipmaps: texture.mipmaps, texture: placeholder }]));
  let bindGroup: GPUBindGroup | undefined;

  const context = canvas.getContext("webgpu");
  if (!(context instanceof GPUCanvasContext)) throw new Error("The canvas has no WebGPU context.");
  context.configure({ device, format: canvasFormat, alphaMode: options.alpha ? "premultiplied" : "opaque" });

  const replace = (name: string, width: number, height: number): GPUTexture => {
    const slot = textures.get(name);
    if (slot === undefined) throw new Error(`The shader has no texture "${name}".`);
    if (slot.texture !== placeholder && slot.texture.width === width && slot.texture.height === height) return slot.texture;
    if (slot.texture !== placeholder) slot.texture.destroy();
    slot.texture = device.createTexture({
      size: [width, height],
      format,
      mipLevelCount: slot.mipmaps ? mipLevels(width, height) : 1,
      usage: textureUsage.textureBinding | textureUsage.copyDst | textureUsage.renderAttachment,
    });
    bindGroup = undefined;
    return slot.texture;
  };

  const group = (): GPUBindGroup =>
    (bindGroup ??= device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        ...(slots.length === 0 ? [] : [{ binding: 0, resource: { buffer: uniformBuffer } }]),
        ...source.textures.flatMap((texture, index) => [
          { binding: 1 + index * 2, resource: (textures.get(texture.name)?.texture ?? placeholder).createView() },
          { binding: 2 + index * 2, resource: sampler },
        ]),
      ],
    }));

  return {
    backend: "webgpu",
    setImage: (name, image) => {
      const texture = replace(name, image.width, image.height);
      queue.copyExternalImageToTexture({ source: image }, { texture }, [image.width, image.height]);
      if (texture.mipLevelCount > 1) generateMipmaps(texture);
    },
    setElement: (name, element, width, height) => {
      if (!canDrawElements(queue)) return;
      const texture = replace(name, width, height);
      queue.drawElementImageToTexture({ source: element }, { texture, premultipliedAlpha: true });
      if (texture.mipLevelCount > 1) generateMipmaps(texture);
    },
    draw: (values: UniformValues) => {
      for (const [index, name] of slots.entries()) {
        const value = values[name];
        if (value === undefined) continue;
        if (typeof value === "number") uniformData[index * 4] = value;
        else uniformData.set(value, index * 4);
      }
      queue.writeBuffer(uniformBuffer, 0, uniformData);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", clearValue: [0, 0, 0, 0], storeOp: "store" }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group());
      pass.draw(3);
      pass.end();
      queue.submit([encoder.finish()]);
    },
    idle: () => queue.onSubmittedWorkDone(),
    destroy: () => {
      context.unconfigure();
      device.destroy();
    },
  };
};
