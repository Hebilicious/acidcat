export type UniformType = "float" | "vec2";

export interface ShaderTexture {
  readonly name: string;
  readonly mipmaps: boolean;
}

/**
 * A full-screen fragment shader, written once in a subset of GLSL ES 3.00 that `toGlsl` and `toWgsl` both accept.
 *
 * The body declares constants, functions and `void main()`, which ends the body. `main` reads `vUv` (0 to 1, with the
 * origin at the bottom left) and assigns `outColor`. Each local starts with its type and a value (`vec2 p = uv;`);
 * a loop is `for (int i = 0; i < N; i++)`. Texture reads are `texture(name, uv)` and `textureLod(name, uv, level)`.
 * Use `atan2(y, x)`, and no `?:`, `mod`, `gl_FragCoord`, matrices, swizzle assignments or integer arithmetic.
 */
export interface ShaderSource {
  readonly uniforms: Readonly<Record<string, UniformType>>;
  readonly textures: readonly ShaderTexture[];
  readonly body: string;
}

export const glslVertex = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const toGlsl = (source: ShaderSource): string =>
  [
    "#version 300 es",
    "precision highp float;",
    ...source.textures.map((texture) => `uniform sampler2D ${texture.name};`),
    ...Object.entries(source.uniforms).map(([name, type]) => `uniform ${type} ${name};`),
    "in vec2 vUv;",
    "out vec4 outColor;",
    "float atan2(float y, float x) { return atan(y, x); }",
    source.body,
  ].join("\n");
