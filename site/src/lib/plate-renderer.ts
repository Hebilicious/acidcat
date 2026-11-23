import { fragmentSource, vertexSource } from "./plate-shader.ts";

export interface PlateSources {
  readonly artPad: number;
  readonly plate: string;
  readonly clean: string;
  readonly data: string;
}

export interface PlateFraming {
  readonly aspect: number;
  readonly focusX: number;
  readonly targetX: number;
  readonly zoom: number;
}

export interface PlateState {
  time?: number;
  camera?: readonly [number, number];
  reveal?: number;
}

export interface PlateHandle {
  readonly software: boolean;
  readonly render: (state?: PlateState) => void;
  readonly start: () => void;
  readonly stop: () => void;
  readonly setActive: (active: boolean) => void;
}

const FOCUS_DEPTH = 0.64;

const loadImage = async (source: string): Promise<HTMLImageElement> => {
  const image = new Image();
  image.decoding = "async";
  image.src = source;
  await image.decode();
  return image;
};

const compile = (gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("WebGL cannot create a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "The shader does not compile.");
  }
  return shader;
};

const link = (gl: WebGL2RenderingContext): WebGLProgram => {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(gl.getProgramInfoLog(program) ?? "The program does not link.");
  }
  return program;
};

const upload = (gl: WebGL2RenderingContext, unit: number, image: HTMLImageElement, mipmaps: boolean): WebGLTexture => {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mipmaps) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  return texture;
};

export const framingSpan = (width: number, height: number, framing: PlateFraming): { span: [number, number]; center: [number, number] } => {
  const viewAspect = width / height;
  const span: [number, number] = viewAspect > framing.aspect ? [1, framing.aspect / viewAspect] : [viewAspect / framing.aspect, 1];
  span[0] /= framing.zoom;
  span[1] /= framing.zoom;
  const clamp = (value: number, size: number) => Math.min(1 - size / 2, Math.max(size / 2, value));
  const centerX = clamp(framing.focusX - (framing.targetX - 0.5) * span[0], span[0]);
  return { span, center: [centerX, clamp(0.5, span[1])] };
};

export const createPlate = async (canvas: HTMLCanvasElement, sources: PlateSources, framing: () => PlateFraming): Promise<PlateHandle> => {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
  if (gl === null) throw new Error("WebGL 2 is not available.");

  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL));
  const software = /swiftshader|llvmpipe|softpipe|software/i.test(renderer);

  const [plate, clean, data] = await Promise.all([loadImage(sources.plate), loadImage(sources.clean), loadImage(sources.data)]);

  const program = link(gl);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  upload(gl, 0, plate, true);
  upload(gl, 1, clean, false);
  upload(gl, 2, data, false);

  const uniform = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform1i(uniform("uPlate"), 0);
  gl.uniform1i(uniform("uClean"), 1);
  gl.uniform1i(uniform("uData"), 2);
  gl.uniform1f(uniform("uFocus"), FOCUS_DEPTH);
  gl.uniform2f(uniform("uImageSize"), data.naturalWidth, data.naturalHeight);
  gl.uniform1f(uniform("uArtPad"), sources.artPad);
  const locations = {
    resolution: uniform("uResolution"),
    span: uniform("uSpan"),
    center: uniform("uCenter"),
    camera: uniform("uCamera"),
    light: uniform("uLight"),
    time: uniform("uTime"),
    reveal: uniform("uReveal"),
    active: uniform("uActive"),
  };

  const pointer = { x: 0, y: 0, active: 0 };
  const eased = { x: 0, y: 0, active: 0 };
  const started = performance.now();
  let frame = 0;
  let running = false;

  let scale = 1;
  let budgetFrames = 0;
  let budgetTime = 0;
  let last = 0;

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio, 1.75) * scale;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };

  const render = (state: PlateState = {}) => {
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    const { span, center } = framingSpan(canvas.width, canvas.height, framing());
    const elapsed = (performance.now() - started) / 1000;
    const time = state.time ?? elapsed;
    const camera = state.camera ?? [eased.x + Math.sin(time * 0.31) * 0.22, eased.y + Math.cos(time * 0.23) * 0.12];
    gl.uniform2f(locations.resolution, canvas.width, canvas.height);
    gl.uniform2f(locations.span, span[0], span[1]);
    gl.uniform2f(locations.center, center[0], center[1]);
    gl.uniform2f(locations.camera, camera[0], camera[1]);
    gl.uniform2f(locations.light, eased.x * 1.4, -eased.y * 1.4 + 0.3);
    gl.uniform1f(locations.time, time);
    gl.uniform1f(locations.reveal, state.reveal ?? Math.min(1, elapsed / 2.4));
    gl.uniform1f(locations.active, eased.active);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const measure = (now: number) => {
    const delta = last === 0 ? 0 : now - last;
    last = now;
    if (delta === 0 || delta > 250) return;
    budgetTime += delta;
    budgetFrames += 1;
    if (budgetFrames < 8) return;
    const average = budgetTime / budgetFrames;
    budgetFrames = 0;
    budgetTime = 0;
    if (average > 26) scale = Math.max(0.45, scale * 0.8);
    else if (average < 18) scale = Math.min(1, scale / 0.8);
  };

  const tick = (now: number) => {
    measure(now);
    eased.x += (pointer.x - eased.x) * 0.05;
    eased.y += (pointer.y - eased.y) * 0.05;
    eased.active += (pointer.active - eased.active) * 0.06;
    render();
    if (running) frame = requestAnimationFrame(tick);
  };

  const fine = window.matchMedia("(pointer: fine)");
  if (fine.matches) {
    window.addEventListener(
      "pointermove",
      (event) => {
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
        pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
        pointer.active = 1;
      },
      { passive: true },
    );
    document.addEventListener("pointerleave", () => {
      pointer.active = 0;
    });
  }

  return {
    software,
    render,
    start: () => {
      if (running) return;
      running = true;
      last = 0;
      frame = requestAnimationFrame(tick);
    },
    stop: () => {
      running = false;
      cancelAnimationFrame(frame);
    },
    setActive: (active) => {
      pointer.active = active ? 1 : 0;
    },
  };
};
