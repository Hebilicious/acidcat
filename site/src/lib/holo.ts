interface ElementImageSize {
  readonly width: number;
  readonly height: number;
}

interface DrawableCanvas extends HTMLCanvasElement {
  requestPaint: () => void;
  updateElementGeometry: (element: Element, options: { canvasTransform: DOMMatrix }) => void;
  getElementImageDefaultSize: (element: Element) => ElementImageSize;
}

interface ElementTextureContext extends WebGL2RenderingContext {
  texElementSubImage2D: (target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, element: Element) => void;
}

const isDrawableCanvas = (canvas: HTMLCanvasElement): canvas is DrawableCanvas =>
  ["requestPaint", "updateElementGeometry", "getElementImageDefaultSize"].every((name) => typeof Reflect.get(canvas, name) === "function");

const hasElementTextures = (gl: WebGL2RenderingContext): gl is ElementTextureContext => typeof Reflect.get(gl, "texElementSubImage2D") === "function";

export const supportsHtmlInCanvas = (): boolean =>
  typeof Reflect.get(HTMLCanvasElement.prototype, "requestPaint") === "function" &&
  typeof Reflect.get(WebGL2RenderingContext.prototype, "texElementSubImage2D") === "function";

const vertexSource = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D uContent;
uniform vec2 uResolution;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uTime;
uniform float uReveal;
in vec2 vUv;
out vec4 outColor;

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

vec4 content(vec2 uv) {
  return texture(uContent, uv);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 px = uv * uResolution;
  float t = uTime;

  vec2 toPointer = px - uPointer;
  float lens = uPointerActive * exp(-dot(toPointer, toPointer) / (2.0 * 140.0 * 140.0));
  uv -= toPointer / uResolution * lens * 0.06;

  float beamY = fract(t * 0.16) * 1.4 - 0.2;
  float beam = exp(-pow((uv.y - beamY) * 18.0, 2.0));
  float row = floor(px.y / 3.0);
  float glitch = step(0.985, hash(vec2(row, floor(t * 12.0)))) * (hash(vec2(row, t)) - 0.5) * 0.012;
  uv.x += glitch + beam * 0.0025 * sin(px.y * 0.35 + t * 20.0);

  vec2 center = uv - 0.5;
  float fringe = (0.00035 + length(center) * 0.0012 + beam * 0.0018) * (1.0 + lens * 2.0);
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

  float scan = 0.9 + 0.1 * sin(px.y * 3.14159 * 0.5);
  float flicker = 0.97 + 0.03 * noise(vec2(t * 7.0, 0.0));
  color *= scan * flicker;
  color += vec3(0.25, 0.95, 1.0) * beam * 0.18 * alpha;
  color += vec3(0.2, 0.9, 1.0) * lens * 0.12 * alpha;

  float buildRow = uv.y * 0.85 + noise(px * vec2(0.08, 0.3)) * 0.15;
  float shown = smoothstep(buildRow - 0.04, buildRow, uReveal * 1.1);
  float edge = shown * (1.0 - smoothstep(buildRow, buildRow + 0.06, uReveal * 1.1 - 0.06));
  color += vec3(0.3, 1.0, 0.9) * edge * 0.9 * alpha;

  float rays = noise(vec2(px.x * 0.035, t * 0.4)) * noise(vec2(px.x * 0.11, t * 0.9 + 3.0));
  float haze = pow(clamp(uv.y, 0.0, 1.0), 5.0) * (0.25 + rays) * uReveal * smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x);
  float emitter = exp(-pow((uv.y - 0.985) * 90.0, 2.0)) * smoothstep(0.0, 0.08, uv.x) * smoothstep(1.0, 0.92, uv.x) * uReveal;
  vec3 projection = vec3(0.2, 0.85, 1.0) * (haze * 0.22 + emitter * 0.9);

  vec3 premultiplied = color * alpha * shown + bloom * shown * 0.9 + vec3(0.2, 0.9, 1.0) * edge * 0.2 + projection * (1.0 - alpha * 0.8);
  float outAlpha = clamp(alpha * shown + length(bloom) * 0.6 * shown + edge * 0.2 + (haze * 0.22 + emitter * 0.9) * 0.6, 0.0, 1.0);
  outColor = vec4(premultiplied, outAlpha);
}
`;

const compile = (gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("WebGL cannot create a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) throw new Error(gl.getShaderInfoLog(shader) ?? "The shader does not compile.");
  return shader;
};

export interface Hologram {
  readonly destroy: () => void;
}

export const createHologram = (host: HTMLElement): Hologram | undefined => {
  if (host.parentElement === null) return undefined;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("content", "drawable");
  canvas.className = "holo-canvas";
  if (!isDrawableCanvas(canvas)) return undefined;
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false });
  if (gl === null || !hasElementTextures(gl)) return undefined;

  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL));
  if (/swiftshader|llvmpipe|softpipe|software/i.test(renderer)) return undefined;

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) return undefined;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "uContent"), 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const uniforms = {
    resolution: gl.getUniformLocation(program, "uResolution"),
    pointer: gl.getUniformLocation(program, "uPointer"),
    pointerActive: gl.getUniformLocation(program, "uPointerActive"),
    time: gl.getUniformLocation(program, "uTime"),
    reveal: gl.getUniformLocation(program, "uReveal"),
  };

  const content = host;
  content.setAttribute("drawable", "");
  content.classList.remove("will-reveal");
  content.before(canvas);
  canvas.append(content);

  let size: ElementImageSize = { width: 0, height: 0 };
  let uploaded = false;
  let visibleSince = -1;
  let frame = 0;
  let visible = false;
  const pointer = { x: -9999, y: -9999, active: 0, target: 0 };
  const started = performance.now();

  const fit = () => {
    canvas.style.height = `${content.offsetHeight}px`;
    const ratio = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(content.offsetHeight * ratio));
  };
  const resizer = new ResizeObserver(fit);
  resizer.observe(content);
  fit();

  const draw = () => {
    if (!uploaded) return;
    const now = performance.now();
    pointer.active += (pointer.target - pointer.active) * 0.12;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uniforms.resolution, canvas.clientWidth, canvas.clientHeight);
    gl.uniform2f(uniforms.pointer, pointer.x, pointer.y);
    gl.uniform1f(uniforms.pointerActive, pointer.active);
    gl.uniform1f(uniforms.time, (now - started) / 1000);
    gl.uniform1f(uniforms.reveal, visibleSince < 0 ? 0 : Math.min(1, (now - visibleSince) / 1600));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  canvas.addEventListener("paint", () => {
    const next = canvas.getElementImageDefaultSize(content);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (next.width !== size.width || next.height !== size.height) {
      size = next;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size.width, size.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, content);
    gl.generateMipmap(gl.TEXTURE_2D);
    canvas.updateElementGeometry(content, { canvasTransform: new DOMMatrix() });
    uploaded = true;
    draw();
  });

  const loop = () => {
    if (!visible) return;
    canvas.requestPaint();
    draw();
    frame = requestAnimationFrame(loop);
  };

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    if (visible && visibleSince < 0 && (entry?.intersectionRatio ?? 0) > 0) visibleSince = performance.now();
    cancelAnimationFrame(frame);
    if (visible) frame = requestAnimationFrame(loop);
  }, { threshold: [0, 0.2] });
  observer.observe(canvas);

  const onMove = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    pointer.x = event.clientX - box.left;
    pointer.y = event.clientY - box.top;
    pointer.target = 1;
  };
  const onLeave = () => {
    pointer.target = 0;
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.requestPaint();

  return {
    destroy: () => {
      observer.disconnect();
      resizer.disconnect();
      cancelAnimationFrame(frame);
    },
  };
};
