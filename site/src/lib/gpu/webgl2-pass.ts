import type { Pass, PassOptions, UniformValues } from "./pass.ts";
import { hasElementTextures, pause } from "./support.ts";
import { glslVertex, toGlsl } from "./shader.ts";
import type { ShaderSource } from "./shader.ts";

const compile = (gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("WebGL cannot create a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
};

export const createWebgl2Pass = (canvas: HTMLCanvasElement, source: ShaderSource, options: PassOptions): Pass => {
  const gl = canvas.getContext("webgl2", {
    alpha: options.alpha,
    premultipliedAlpha: true,
    antialias: false,
    powerPreference: "high-performance",
  });
  if (gl === null) throw new Error("WebGL 2 is not available.");
  if (options.elements === true && !hasElementTextures(gl)) throw new Error("WebGL 2 cannot draw HTML into a texture.");
  // With this extension, the driver compiles and links in the background. Each query of the program waits for the link,
  // so the pass makes its first query at its first draw.
  gl.getExtension("KHR_parallel_shader_compile");
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, glslVertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, toGlsl(source)));
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const textures = new Map(
    source.textures.map((texture, unit) => {
      const handle = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, texture.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      return [texture.name, { handle, unit, mipmaps: texture.mipmaps, width: 0, height: 0 }];
    }),
  );
  const texture = (name: string) => {
    const found = textures.get(name);
    if (found === undefined) throw new Error(`The shader has no texture "${name}".`);
    gl.activeTexture(gl.TEXTURE0 + found.unit);
    gl.bindTexture(gl.TEXTURE_2D, found.handle);
    return found;
  };

  let locations: ReadonlyMap<string, WebGLUniformLocation | null> | undefined;
  const link = (): ReadonlyMap<string, WebGLUniformLocation | null> => {
    if (locations !== undefined) return locations;
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) throw new Error(gl.getProgramInfoLog(program) ?? "The program does not link.");
    gl.useProgram(program);
    for (const [unit, { name }] of source.textures.entries()) gl.uniform1i(gl.getUniformLocation(program, name), unit);
    locations = new Map(Object.keys(source.uniforms).map((name) => [name, gl.getUniformLocation(program, name)]));
    return locations;
  };

  return {
    backend: "webgl2",
    setImage: (name, image) => {
      const target = texture(name);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      if (target.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    },
    setElement: (name, element, width, height) => {
      if (!hasElementTextures(gl)) return;
      const target = texture(name);
      if (target.width !== width || target.height !== height) {
        target.width = width;
        target.height = height;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, element);
      if (target.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    },
    draw: (values: UniformValues) => {
      const uniforms = link();
      gl.viewport(0, 0, canvas.width, canvas.height);
      for (const [name, value] of Object.entries(values)) {
        const location = uniforms.get(name);
        if (location === undefined || location === null) continue;
        if (typeof value === "number") gl.uniform1f(location, value);
        else gl.uniform2f(location, value[0], value[1]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    idle: async () => {
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (fence === null) return;
      gl.flush();
      while (!gl.isContextLost() && gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) await pause(4);
      gl.deleteSync(fence);
    },
    destroy: () => {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
};
