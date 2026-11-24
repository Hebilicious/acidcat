import type { Pass, PassOptions, UniformValues } from "./pass.ts";
import { softwareRenderer } from "./support.ts";
import { glslVertex, toGlsl } from "./shader.ts";
import type { ShaderSource } from "./shader.ts";

interface ElementTextureContext extends WebGL2RenderingContext {
  texElementSubImage2D: (target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, element: Element) => void;
}

const hasElementTextures = (gl: WebGL2RenderingContext): gl is ElementTextureContext => typeof Reflect.get(gl, "texElementSubImage2D") === "function";

const compile = (gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("WebGL cannot create a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) throw new Error(gl.getShaderInfoLog(shader) ?? "The shader does not compile.");
  return shader;
};

export const createWebgl2Pass = (canvas: HTMLCanvasElement, source: ShaderSource, options: PassOptions): Pass => {
  const gl = canvas.getContext("webgl2", {
    alpha: options.alpha,
    premultipliedAlpha: true,
    antialias: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
  });
  if (gl === null) throw new Error("WebGL 2 is not available.");
  if (options.elements === true && !hasElementTextures(gl)) throw new Error("WebGL 2 cannot draw HTML into a texture.");
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const software = softwareRenderer.test(String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL)));

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, glslVertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, toGlsl(source)));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) throw new Error(gl.getProgramInfoLog(program) ?? "The program does not link.");
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const textures = new Map(
    source.textures.map((texture, unit) => {
      const handle = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, texture.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.uniform1i(gl.getUniformLocation(program, texture.name), unit);
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

  const locations = new Map(Object.keys(source.uniforms).map((name) => [name, gl.getUniformLocation(program, name)]));

  return {
    backend: "webgl2",
    software,
    setImage: (name, image) => {
      const target = texture(name);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
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
      gl.viewport(0, 0, canvas.width, canvas.height);
      for (const [name, value] of Object.entries(values)) {
        const location = locations.get(name);
        if (location === undefined || location === null) continue;
        if (typeof value === "number") gl.uniform1f(location, value);
        else gl.uniform2f(location, value[0], value[1]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy: () => {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
};
