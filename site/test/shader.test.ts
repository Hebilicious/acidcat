import assert from "node:assert/strict";
import { test } from "node:test";
import { toGlsl, toWgsl } from "../src/lib/gpu/shader.ts";
import type { ShaderSource } from "../src/lib/gpu/shader.ts";

const source: ShaderSource = {
  uniforms: { uTime: "float", uSize: "vec2" },
  textures: [{ name: "uImage", mipmaps: true }],
  body: `const vec2 CENTER = vec2(0.5, 0.5);

float wave(vec2 p, float speed) {
  p = p * 2.0;
  return sin(p.x * speed + uTime);
}

void main() {
  vec2 uv = vUv - CENTER;
  float total = 0.0;
  for (int k = 0; k < 3; k++) {
    total += wave(uv, float(k)) * atan2(uv.y, uv.x);
  }
  vec4 base = texture(uImage, uv) + textureLod(uImage, uv, 2.0);
  outColor = vec4(base.rgb * total / uSize.x, 1.0);
}
`,
};

test("toWgsl translates the shader subset to WGSL", () => {
  const wgsl = toWgsl(source);
  assert.match(wgsl, /struct Uniforms \{\n {2}@align\(16\) uTime: f32,\n {2}@align\(16\) uSize: vec2f,\n\}/);
  assert.match(wgsl, /@binding\(1\) var uImage: texture_2d<f32>;\n@group\(0\) @binding\(2\) var uImageSampler: sampler;/);
  assert.match(wgsl, /const CENTER: vec2f = vec2f\(0\.5, 0\.5\);/);
  assert.match(wgsl, /fn wave\(p_: vec2f, speed_: f32\) -> f32 \{\n {2}var p = p_;\n {2}var speed = speed_;/);
  assert.match(wgsl, /return sin\(p\.x \* speed \+ u\.uTime\);/);
  assert.match(wgsl, /fn shade\(vUv: vec2f\) -> vec4f \{\n {2}var outColor: vec4f;/);
  assert.match(wgsl, /for \(var k: i32 = 0; k < 3; k\+\+\)/);
  assert.match(wgsl, /wave\(uv, f32\(k\)\) \* atan2\(uv\.y, uv\.x\)/);
  assert.match(wgsl, /textureSample\(uImage, uImageSampler, uv\) \+ textureSampleLevel\(uImage, uImageSampler, uv, 2\.0\)/);
  assert.match(wgsl, /outColor = vec4f\(base\.rgb \* total \/ u\.uSize\.x, 1\.0\);\n {2}return outColor;\n\}/);
  assert.doesNotMatch(wgsl, /\b(float|vec[234]|int)\b/);
});

test("toGlsl declares the uniforms, the textures and atan2 before the body", () => {
  const glsl = toGlsl(source);
  assert.ok(glsl.startsWith("#version 300 es\nprecision highp float;\nuniform sampler2D uImage;\nuniform float uTime;\nuniform vec2 uSize;\nin vec2 vUv;\nout vec4 outColor;\n"));
  assert.ok(glsl.includes("float atan2(float y, float x) { return atan(y, x); }"));
  assert.ok(glsl.endsWith(source.body));
});
