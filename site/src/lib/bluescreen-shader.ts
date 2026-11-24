import type { ShaderSource } from "./gpu/shader.ts";

export const bluescreenShader: ShaderSource = {
  uniforms: {
    uResolution: "vec2",
    uPointer: "vec2",
    uPointerActive: "float",
    uTime: "float",
    uReveal: "float",
    uIntensity: "float",
  },
  textures: [{ name: "uContent", mipmaps: true }],
  body: `float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

vec4 content(vec2 uv) {
  return texture(uContent, uv);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 px = uv * uResolution;
  float t = uTime;

  vec2 toPointer = px - uPointer;
  float lens = uPointerActive * exp(-dot(toPointer, toPointer) / (2.0 * 140.0 * 140.0));
  uv -= toPointer / uResolution * lens * 0.06 * uIntensity;

  float beamY = fract(t * 0.16) * 1.4 - 0.2;
  float beamOffset = (uv.y - beamY) * 18.0;
  float beam = exp(-beamOffset * beamOffset);
  float row = floor(px.y / 3.0);
  float glitch = step(0.985, hash(vec2(row, floor(t * 12.0)))) * (hash(vec2(row, t)) - 0.5) * 0.012 * uIntensity * uIntensity;
  uv.x += glitch + beam * 0.0025 * uIntensity * sin(px.y * 0.35 + t * 20.0);

  vec2 center = uv - 0.5;
  float fringe = (0.00035 + length(center) * 0.0012 + beam * 0.0018) * (1.0 + lens * 2.0) * uIntensity;
  vec4 base = content(uv);
  float r = content(uv + vec2(fringe, 0.0)).r;
  float b = content(uv - vec2(fringe, 0.0)).b;
  vec3 color = vec3(r, base.g, b);
  float alpha = max(base.a, max(content(uv + vec2(fringe, 0.0)).a, content(uv - vec2(fringe, 0.0)).a));

  vec4 glowNear = textureLod(uContent, uv, 3.0);
  vec4 glowFar = textureLod(uContent, uv, 5.0);
  vec3 glowColor = glowNear.rgb * 0.55 + glowFar.rgb * 0.75;
  float signal = max(glowColor.g - glowColor.r * 0.6, 0.0) + max(glowColor.b - glowColor.r, 0.0) * 0.6;
  vec3 bloom = glowColor * (0.35 + signal * 1.6);

  float scan = 1.0 - uIntensity * (0.1 - 0.1 * sin(px.y * 3.14159 * 0.5));
  float flicker = 1.0 - uIntensity * (0.03 - 0.03 * noise(vec2(t * 7.0, 0.0)));
  color *= scan * flicker;
  color += vec3(0.25, 0.95, 1.0) * beam * 0.18 * alpha * uIntensity;
  color += vec3(0.2, 0.9, 1.0) * lens * 0.12 * alpha;

  float buildRow = uv.y * 0.85 + noise(px * vec2(0.08, 0.3)) * 0.15;
  float shown = smoothstep(buildRow - 0.04, buildRow, uReveal * 1.1);
  float edge = shown * (1.0 - smoothstep(buildRow, buildRow + 0.06, uReveal * 1.1 - 0.06));
  color += vec3(0.3, 1.0, 0.9) * edge * 0.9 * alpha;

  float rays = noise(vec2(px.x * 0.035, t * 0.4)) * noise(vec2(px.x * 0.11, t * 0.9 + 3.0));
  float haze = pow(clamp(uv.y, 0.0, 1.0), 5.0) * (0.25 + rays) * uReveal * smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x);
  float emitterOffset = (uv.y - 0.985) * 90.0;
  float emitter = exp(-emitterOffset * emitterOffset) * smoothstep(0.0, 0.08, uv.x) * smoothstep(1.0, 0.92, uv.x) * uReveal;
  vec3 projection = vec3(0.2, 0.85, 1.0) * (haze * 0.22 + emitter * 0.9);

  vec3 premultiplied = color * alpha * shown + bloom * shown * 0.9 * uIntensity + vec3(0.2, 0.9, 1.0) * edge * 0.2 + projection * (1.0 - alpha * 0.8);
  float outAlpha = clamp(alpha * shown + length(bloom) * 0.6 * shown * uIntensity + edge * 0.2 + (haze * 0.22 + emitter * 0.9) * 0.6, 0.0, 1.0);
  outColor = vec4(premultiplied, outAlpha);
}
`,
};
