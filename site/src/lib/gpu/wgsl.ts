import type { ShaderSource } from "./shader.ts";

const wgslTypes: Readonly<Record<string, string>> = { float: "f32", vec2: "vec2f", vec3: "vec3f", vec4: "vec4f", int: "i32" };
const typeNames = Object.keys(wgslTypes).join("|");

const wgslType = (glsl: string): string => {
  const type = wgslTypes[glsl];
  if (type === undefined) throw new Error(`The shader subset has no type "${glsl}".`);
  return type;
};

const translateSignature = (returns: string, name: string, parameters: string): string => {
  const list = parameters
    .split(",")
    .map((parameter) => parameter.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2);
  const signature = list.map(([type, parameter]) => `${parameter}_: ${wgslType(type)}`).join(", ");
  const copies = list.map(([, parameter]) => `\n  var ${parameter} = ${parameter}_;`).join("");
  return `fn ${name}(${signature}) -> ${wgslType(returns)} {${copies}`;
};

const translateBody = (source: ShaderSource): string => {
  const main = source.body.lastIndexOf("void main() {");
  const end = source.body.lastIndexOf("}");
  if (main < 0 || end < main) throw new Error("The shader body must end with void main().");
  const body = `${source.body.slice(0, main)}fn shade(vUv: vec2f) -> vec4f {\n  var outColor: vec4f;${source.body.slice(main + "void main() {".length, end)}  return outColor;\n}\n`;
  const uniforms = Object.keys(source.uniforms);
  const uniform = new RegExp(`(?<![.\\w])(${uniforms.join("|")})\\b`, "g");
  const translated = body
    .replace(new RegExp(`^(${typeNames}) (\\w+)\\(([^)]*)\\) \\{$`, "gm"), (_, returns: string, name: string, parameters: string) => translateSignature(returns, name, parameters))
    .replace(new RegExp(`^const (${typeNames}) (\\w+) =`, "gm"), (_, type: string, name: string) => `const ${name}: ${wgslType(type)} =`)
    .replace(new RegExp(`\\b(${typeNames}) (\\w+) =`, "g"), (_, type: string, name: string) => `var ${name}: ${wgslType(type)} =`)
    .replace(new RegExp(`\\b(${typeNames})\\(`, "g"), (_, type: string) => `${wgslType(type)}(`)
    .replace(/\btextureLod\((\w+), /g, "textureSampleLevel($1, $1Sampler, ")
    .replace(/\btexture\((\w+), /g, "textureSample($1, $1Sampler, ");
  return uniforms.length === 0 ? translated : translated.replace(uniform, "u.$1");
};

export const uniformSlots = (source: ShaderSource): readonly string[] => Object.keys(source.uniforms);

export const toWgsl = (source: ShaderSource): string => {
  const slots = uniformSlots(source);
  const struct = slots.length === 0 ? "" : `struct Uniforms {\n${slots.map((name) => `  @align(16) ${name}: ${wgslType(source.uniforms[name] ?? "")},`).join("\n")}\n}\n@group(0) @binding(0) var<uniform> u: Uniforms;\n`;
  const bindings = source.textures
    .map((texture, index) => `@group(0) @binding(${1 + index * 2}) var ${texture.name}: texture_2d<f32>;\n@group(0) @binding(${2 + index * 2}) var ${texture.name}Sampler: sampler;\n`)
    .join("");
  return `${struct}${bindings}
struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> Varyings {
  let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let corner = corners[index];
  return Varyings(vec4f(corner, 0.0, 1.0), corner * 0.5 + 0.5);
}

${translateBody(source)}
@fragment
fn fragmentMain(input: Varyings) -> @location(0) vec4f {
  return shade(input.uv);
}
`;
};
