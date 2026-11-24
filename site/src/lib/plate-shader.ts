import type { ShaderSource } from "./gpu/shader.ts";

export const plateShader: ShaderSource = {
  uniforms: {
    uResolution: "vec2",
    uSpan: "vec2",
    uCenter: "vec2",
    uCamera: "vec2",
    uLight: "vec2",
    uTime: "float",
    uReveal: "float",
    uFocus: "float",
    uActive: "float",
    uImageSize: "vec2",
    uArtPad: "float",
    uPlateRect: "vec2",
  },
  textures: [
    { name: "uPlate", mipmaps: true },
    { name: "uClean", mipmaps: false },
    { name: "uData", mipmaps: false },
  ],
  body: `const float ASPECT = 1672.0 / 941.0;
const vec2 EYE = vec2(0.580, 0.135);
const vec2 REACTOR = vec2(0.615, 0.385);

float hash(vec2 p) {
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

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 5; octave++) {
    value += amplitude * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    amplitude *= 0.5;
  }
  return value;
}

float box(vec2 uv, vec4 rect, float feather) {
  vec2 lo = smoothstep(rect.xy - feather, rect.xy + feather, uv);
  vec2 hi = 1.0 - smoothstep(rect.zw - feather, rect.zw + feather, uv);
  return lo.x * lo.y * hi.x * hi.y;
}

float disc(vec2 uv, vec2 center, float radius, float feather) {
  vec2 d = (uv - center) * vec2(ASPECT, 1.0);
  return 1.0 - smoothstep(radius - feather, radius + feather, length(d));
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float acidOf(vec3 c) {
  return smoothstep(0.08, 0.32, c.g - max(c.r * 0.82, c.b)) * smoothstep(0.25, 0.7, c.g);
}

float cyanOf(vec3 c) {
  return smoothstep(0.06, 0.3, min(c.g, c.b) - c.r) * smoothstep(0.3, 0.8, max(c.g, c.b));
}

float amberOf(vec3 c) {
  return smoothstep(0.12, 0.4, c.r - c.b) * smoothstep(0.15, 0.45, c.r - c.g) * smoothstep(0.35, 0.8, c.r);
}

float brassOf(vec3 c) {
  float warm = smoothstep(0.02, 0.18, c.r - c.b) * smoothstep(-0.05, 0.12, c.g - c.b);
  return warm * smoothstep(0.25, 0.85, luma(c));
}

vec2 toArt(vec2 uv) {
  return vec2((uv.x * uImageSize.x - uArtPad) / 1672.0, uv.y);
}

vec2 toImage(vec2 screen) {
  vec2 uv = vec2(screen.x, 1.0 - screen.y);
  return (uv - 0.5) * uSpan + uCenter;
}

vec2 plateUv(vec2 uv) {
  return vec2((uv.x - uPlateRect.x) / uPlateRect.y, uv.y);
}

vec4 data(vec2 uv) {
  return texture(uData, uv);
}

vec2 parallax(vec2 uv, vec2 shift) {
  vec2 p = uv;
  for (int iteration = 0; iteration < 4; iteration++) {
    float depth = data(p).r;
    p = uv - shift * (depth - uFocus);
  }
  return p;
}

void main() {
  vec2 screen = vUv;
  vec2 base = toImage(screen);
  float t = uTime;

  vec2 edge = min(base, 1.0 - base);
  vec2 shift = uCamera * vec2(0.018, 0.012) * smoothstep(0.0, 0.05, edge.x) * smoothstep(0.0, 0.05, edge.y);

  vec2 haze = vec2(fbm(base * 9.0 + vec2(0.0, -t * 0.35)), fbm(base * 9.0 + vec2(5.2, -t * 0.4))) - 0.5;
  vec2 artBase = toArt(base);
  float steamZone = box(artBase, vec4(0.24, -0.1, 0.42, 0.34), 0.06) + box(artBase, vec4(0.6, 0.52, 0.8, 0.8), 0.06) + box(artBase, vec4(-0.1, 0.78, 0.12, 1.1), 0.05);
  vec2 hazed = base + haze * 0.0035 * steamZone;

  vec2 plasmaZone = vec2(box(toArt(hazed), vec4(0.035, 0.12, 0.14, 0.40), 0.01), 0.0);
  float wave = sin(hazed.y * 95.0 + t * 7.0) * 0.5 + sin(hazed.y * 41.0 - t * 4.3) * 0.5;
  hazed.x += wave * 0.0022 * plasmaZone.x;

  vec2 fgUv = parallax(hazed, shift);
  vec2 artFg = toArt(fgUv);
  float bandLeft = box(artFg, vec4(0.225, 0.2, 0.455, 0.345), 0.012);
  float bandRight = box(artFg, vec4(0.665, 0.29, 0.76, 0.41), 0.012);
  fgUv.y += (sin(t * 1.3) * bandLeft + sin(t * 1.1 + 2.0) * bandRight) * 0.007;
  fgUv.x += (cos(t * 0.9) * bandLeft - cos(t * 0.8 + 1.0) * bandRight) * 0.0025 * 1672.0 / uImageSize.x;
  vec2 bgUv = hazed - shift * (data(hazed).r * 0.35 - uFocus * 0.35);
  float matte = data(fgUv).g;
  float cut = data(bgUv).b;

  vec2 midUv = hazed - shift * (0.62 - uFocus) * 0.8;
  vec3 mid = texture(uPlate, plateUv(midUv)).rgb;
  float lift = luma(mid) - luma(texture(uClean, midUv).rgb);
  vec2 px = 1.0 / uImageSize;
  float matteWide = data(midUv).g;
  for (int k = 0; k < 8; k++) {
    float angle = float(k) * 0.785398;
    matteWide = max(matteWide, data(midUv + vec2(cos(angle), sin(angle)) * px * 7.0).g);
  }
  float ringAlpha = smoothstep(0.015, 0.16, lift) * data(midUv).b * (1.0 - matteWide);

  vec3 fg = texture(uPlate, plateUv(fgUv)).rgb;
  vec3 plateBg = texture(uPlate, plateUv(bgUv)).rgb;
  vec3 cleanBg = texture(uClean, bgUv).rgb;
  vec3 bg = mix(plateBg, cleanBg, cut);
  bg = mix(bg, mid, ringAlpha);
  float apart = length((fgUv - bgUv) * uImageSize);
  float layered = smoothstep(0.25, 2.5, apart);
  float front = mix(1.0, matte, layered);
  vec3 color = mix(bg, fg, front);
  vec2 uv = mix(mix(bgUv, midUv, ringAlpha), fgUv, front);

  vec3 glowLow = textureLod(uPlate, plateUv(uv), 4.5).rgb;
  vec3 glowWide = textureLod(uPlate, plateUv(uv), 6.5).rgb;

  float pulse = 0.5 + 0.5 * sin(t * 2.1);
  float slow = 0.5 + 0.5 * sin(t * 0.9 + 1.3);

  float acid = acidOf(color);
  float cyan = cyanOf(color);
  float amber = amberOf(color);

  vec2 art = toArt(uv);
  vec2 ringA = (art - vec2(0.515, 0.215)) * vec2(1.0 / 0.225, 1.0 / 0.11);
  vec2 ringB = (art - vec2(0.48, 0.485)) * vec2(1.0 / 0.28, 1.0 / 0.085);
  float bandA = 1.0 - smoothstep(0.12, 0.3, abs(length(ringA) - 1.0));
  float bandB = 1.0 - smoothstep(0.12, 0.3, abs(length(ringB) - 1.0));
  float sweepA = pow(0.5 + 0.5 * cos(atan2(ringA.y, ringA.x) - t * 1.15), 10.0) + pow(0.5 + 0.5 * cos(atan2(ringA.y, ringA.x) - t * 1.15 + 3.14159), 18.0) * 0.6;
  float sweepB = pow(0.5 + 0.5 * cos(atan2(ringB.y, ringB.x) + t * 0.85), 10.0) + pow(0.5 + 0.5 * cos(atan2(ringB.y, ringB.x) + t * 0.85 + 2.2), 16.0) * 0.5;
  float ringLight = (bandA * sweepA + bandB * sweepB) * (acid + cyan * 1.2);

  float eye = disc(art, EYE, 0.022, 0.012);
  float reactor = disc(art, REACTOR, 0.04, 0.02);
  float core = (eye + reactor) * acid;

  float nixieZone = box(art, vec4(0.16, 0.24, 0.285, 0.43), 0.004);
  float tube = floor((art.x - 0.168) / 0.0275);
  float flicker = 0.82 + 0.18 * step(0.12, noise(vec2(tube * 7.1, t * 9.0))) - 0.35 * step(0.965, noise(vec2(tube * 3.3, t * 2.3)));

  float fibreZone = box(art, vec4(0.015, 0.54, 0.16, 0.8), 0.01);
  float sparkle = step(0.82, noise(art * vec2(260.0, 120.0) + vec2(0.0, t * 1.6)));

  float cityZone = disc(art, vec2(0.86, 0.17), 0.145, 0.01);
  float twinkle = 0.75 + 0.5 * noise(art * 380.0 + t * 1.3);

  float vialZone = box(art, vec4(0.79, 0.48, 1.0, 0.75), 0.02);
  float bubble = noise(vec2(art.x * 220.0, art.y * 90.0 + t * 3.0));

  float wobble = pulse - 0.5;
  float drift = slow - 0.5;

  vec3 lit = color;
  lit += color * acid * 0.36 * wobble * (1.0 - nixieZone);
  lit += color * cyan * 0.24 * drift;
  lit += vec3(0.75, 1.0, 0.35) * ringLight * 0.85;
  lit += color * core * (0.7 * wobble + 0.6 * uActive);
  lit = mix(lit, lit * flicker, nixieZone * amber);
  lit += vec3(0.4, 1.0, 0.95) * fibreZone * cyan * sparkle * 0.55;
  lit = mix(lit, lit * twinkle, cityZone * smoothstep(0.35, 0.8, luma(color)));
  lit += vec3(0.6, 1.0, 0.25) * vialZone * acid * smoothstep(0.7, 0.95, bubble) * 0.45;

  lit += glowLow * acidOf(glowLow) * 0.5 * wobble + glowWide * acidOf(glowWide) * 0.4 * drift;
  lit += glowLow * amberOf(glowLow) * nixieZone * 0.45 * (flicker - 0.9);

  vec2 texel = 1.0 / uImageSize;
  float dx = data(uv + vec2(texel.x * 2.0, 0.0)).r - data(uv - vec2(texel.x * 2.0, 0.0)).r;
  float dy = data(uv + vec2(0.0, texel.y * 2.0)).r - data(uv - vec2(0.0, texel.y * 2.0)).r;
  vec3 normal = normalize(vec3(-dx * 60.0, dy * 60.0, 1.0));
  vec3 lightDir = normalize(vec3(uLight, 0.9));
  float spec = pow(max(dot(reflect(-lightDir, normal), vec3(0.0, 0.0, 1.0)), 0.0), 22.0);
  float brass = brassOf(color) * matte;
  lit += vec3(1.0, 0.86, 0.55) * spec * brass * 0.55 * uActive;

  float sheen = pow(0.5 + 0.5 * sin((uv.x * 1.4 - uv.y * 0.8) * 6.0 - t * 0.7), 40.0);
  lit += vec3(1.0, 0.9, 0.6) * sheen * brass * 0.18;

  vec2 steamUv = screen * vec2(uResolution.x / uResolution.y, 1.0);
  float steam = fbm(steamUv * 2.2 + vec2(t * 0.04, -t * 0.09));
  steam = smoothstep(0.5, 0.95, steam + fbm(steamUv * 5.0 - vec2(0.0, t * 0.16)) * 0.35);
  float steamMask = clamp(steamZone, 0.0, 1.0) * (1.0 - matte * 0.85);
  lit += vec3(0.55, 0.72, 0.6) * steam * steamMask * 0.16;

  vec3 motes = vec3(0.0);
  for (int layer = 0; layer < 3; layer++) {
    float fl = float(layer);
    float scale = 14.0 + fl * 9.0;
    vec2 p = screen * vec2(uResolution.x / uResolution.y, 1.0) * scale;
    p += uCamera * (2.0 + fl * 3.0);
    p.y -= t * (0.25 + fl * 0.18);
    p.x += sin(t * 0.3 + fl) * 0.6;
    vec2 cell = floor(p);
    vec2 local = fract(p) - 0.5;
    float seed = hash(cell + fl * 31.0);
    if (seed > 0.88) {
      vec2 offset = vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5;
      float d = length(local - offset * 0.7);
      float size = 0.04 + 0.06 * hash(cell + 1.9);
      float twinkleMote = 0.5 + 0.5 * sin(t * (1.0 + seed * 3.0) + seed * 40.0);
      vec3 tint = mix(vec3(0.75, 1.0, 0.35), vec3(0.35, 0.9, 1.0), step(0.96, seed));
      motes += tint * smoothstep(size, 0.0, d) * twinkleMote * (0.5 - fl * 0.12);
    }
  }
  lit += motes * 0.55;

  lit = mix(color, lit, smoothstep(0.0, 1.0, uReveal));

  outColor = vec4(lit, 1.0);
}
`,
};
