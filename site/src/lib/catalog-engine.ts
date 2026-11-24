import { BufferGeometry, DirectionalLight, ExternalTexture, FogExp2, InstancedMesh, LineSegments, Material, Mesh, OrthographicCamera, PMREMGenerator, PlaneGeometry, Raycaster, Scene, Vector2, Vector3, WebGPURenderer } from "three/webgpu";
import type * as Three from "three/webgpu";
import { abs, cos, dot, exp, float, fract, max, mix, screenCoordinate, sin, smoothstep, texture, uniform, uv, vec2, vec3 } from "three/tsl";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { canDrawElements, hasElementTextures, textureUsage } from "./gpu/support.js";
import type { DrawableCanvas } from "./gpu/support.js";
import { tubeBank } from "./nixie-scene.js";
import { hardware } from "./engine-hardware.js";
import { shaderMaterial } from "./engine-shader.js";

export type MachineGpu = { readonly kind: "webgpu"; readonly device: GPUDevice } | { readonly kind: "webgl2"; readonly gl: WebGL2RenderingContext };

export interface MachineOptions {
  readonly layout: MachineLayout;
  /** Renders one frame each time the content or the pointer changes, with no animation and a still camera. */
  readonly still: boolean;
}

interface ScreenTexture {
  readonly sample: (at: Three.Node<"vec2">) => Three.TextureNode;
  readonly upload: (element: Element, width: number, height: number) => void;
  readonly dispose: () => void;
}

const webgpuScreenTexture = (device: GPUDevice): ScreenTexture => {
  const create = (width: number, height: number) =>
    device.createTexture({ size: [width, height], format: "rgba8unorm", usage: textureUsage.textureBinding | textureUsage.copyDst | textureUsage.renderAttachment });
  let target = create(1, 1);
  let external = new ExternalTexture(target);
  const samples: Three.TextureNode[] = [];
  return {
    sample: (at) => {
      const node = texture(external, at);
      samples.push(node);
      return node;
    },
    upload: (element, width, height) => {
      if (!canDrawElements(device.queue)) return;
      if (target.width !== width || target.height !== height) {
        target.destroy();
        external.dispose();
        target = create(width, height);
        external = new ExternalTexture(target);
        for (const node of samples) node.value = external;
      }
      device.queue.drawElementImageToTexture({ source: element }, { texture: target, premultipliedAlpha: false });
    },
    dispose: () => {
      external.dispose();
      target.destroy();
    },
  };
};

const webgl2ScreenTexture = (gl: WebGL2RenderingContext): ScreenTexture => {
  const handle = gl.createTexture();
  const external = new ExternalTexture(handle);
  const size = { width: 0, height: 0 };
  return {
    sample: (at) => texture(external, at),
    upload: (element, width, height) => {
      if (!hasElementTextures(gl)) return;
      const unit: unknown = gl.getParameter(gl.ACTIVE_TEXTURE);
      const bound: unknown = gl.getParameter(gl.TEXTURE_BINDING_2D);
      const flip: unknown = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
      const premultiply: unknown = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
      gl.bindTexture(gl.TEXTURE_2D, handle);
      if (size.width !== width || size.height !== height) {
        size.width = width;
        size.height = height;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, element);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip === true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply === true);
      gl.bindTexture(gl.TEXTURE_2D, bound instanceof WebGLTexture ? bound : null);
      if (typeof unit === "number") gl.activeTexture(unit);
    },
    dispose: () => {
      external.dispose();
      gl.deleteTexture(handle);
    },
  };
};

function crt(screen: ScreenTexture, time: Three.UniformNode<"float", number>, excitation: Three.UniformNode<"float", number>, width: number, height: number) {
  const p = uv().sub(0.5);
  const curvature = dot(p, p);
  const warped = p.mul(curvature.mul(0.024).add(1)).add(0.5);
  const at = vec2(warped.x, warped.y.oneMinus());
  const fringe = vec2(0.55 / width, 0);
  const ink = screen.sample(at);
  const type = vec3(screen.sample(at.add(fringe)).r, ink.g, screen.sample(at.sub(fringe)).b);
  const vignette = max(0.12, curvature.mul(2).oneMinus());
  const scan = cos(screenCoordinate.y.mul(2.1)).mul(0.05).add(0.95);
  const beam = exp(abs(fract(time.mul(0.095)).sub(at.y)).mul(-18));
  const rows = sin(at.y.mul(height * 1.35)).mul(0.5).add(0.5);
  const spread = vec2(1.6 / width, 1.6 / height);
  const glow = screen.sample(at.add(spread)).a.add(screen.sample(at.sub(spread)).a);
  const glass = mix(vec3(0.01, 0.016, 0.028), vec3(0.03, 0.078, 0.12), vignette)
    .add(vec3(0.04, 0.09, 0.13).mul(smoothstep(0.62, 1.2, uv().y.sub(uv().x.mul(0.24)))))
    .add(vec3(0.01, 0.03, 0.045).mul(rows).mul(vignette))
    .add(vec3(0.012, 0.035, 0.055).add(type.mul(0.085)).mul(glow))
    .add(vec3(0.1, 0.55, 0.85).mul(beam).mul(0.035));
  const phosphor = mix(type, type.mul(vec3(0.82, 0.97, 1.12)).add(vec3(0, 0.025, 0.05).mul(ink.a)), 0.55);
  const lit = glass.mul(beam.mul(0.09).add(1).add(excitation.mul(0.75))).add(phosphor.mul(ink.a).mul(excitation.mul(0.24).add(1.28)));
  return shaderMaterial(lit.mul(scan).mul(sin(time.mul(35)).mul(0.006).add(0.994)), float(1));
}

export type MachineLayout = "wide" | "tall";


export async function buildMachine(host: HTMLElement, canvas: DrawableCanvas, gpu: MachineGpu, options: MachineOptions): Promise<() => void> {
  const tall = options.layout === "tall";
  const still = options.still;
  const renderer = gpu.kind === "webgpu"
    ? new WebGPURenderer({ canvas, device: gpu.device, alpha: true, antialias: true })
    : new WebGPURenderer({ canvas, context: gpu.gl, alpha: true, antialias: true, forceWebGL: true });
  await renderer.init();
  const screenTexture = () => gpu.kind === "webgpu" ? webgpuScreenTexture(gpu.device) : webgl2ScreenTexture(gpu.gl);
  const scene = new Scene();
  const camera = tall ? new OrthographicCamera(-250, 250, 780, -390, 1, 2500) : new OrthographicCamera(-600, 600, 312, -312, 1, 2500);
  scene.fog = new FogExp2(0x111a19, .00015);
  const studio = new RoomEnvironment();
  const pmrem = new PMREMGenerator(renderer);
  const reflections = pmrem.fromScene(studio, 0.035);
  studio.dispose();
  pmrem.dispose();
  scene.environment = reflections.texture;
  scene.environmentIntensity = 0.86;
  const key = new DirectionalLight(0xffdfad, 2.1);
  key.position.set(-220, 500, 660);
  scene.add(key);
  const { device, pipe, finish } = hardware(scene);
  const time = uniform(still ? 0 : performance.now() / 1000);
  const inputs = Array.from(host.querySelectorAll<HTMLElement>("[data-catalog-screen], [data-surface]"));
  const catalogWidth = tall ? 420 : 600;
  const catalogHeight = tall ? 420 : 436;
  const inlet = tall ? device(catalogWidth, catalogHeight, -14, 420, true, [0.08, 0, 0]) : device(catalogWidth, catalogHeight, -274, -40, true);
  const surfaceWidth = tall ? 380 : 384;
  const rail = host.querySelector<HTMLElement>(".language-rail");
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-language]"));
  const railMarker = document.createTextNode("");
  rail?.before(railMarker);
  if (rail) host.after(rail);
  const bulbs = tubeBank(buttons.map(button => button.textContent.trim()), catalogHeight / 2 + 48);
  for (const { tube } of bulbs) inlet.add(tube);
  const screens = inputs.map((element, index) => {
    const catalog = index === 0;
    const w = catalog ? catalogWidth : surfaceWidth;
    const h = catalog ? catalogHeight : 68;
    const y = catalog ? 0 : (3 - index) * 108;
    const chassis = catalog ? inlet : tall ? device(w, h, 30, 80 - (index - 1) * 100, false, [0.06, 0.08, 0]) : device(w, h, 383, y, false);
    const excitation = uniform(0);
    if (!catalog) {
      const outlet = tall
        ? inlet.localToWorld(new Vector3(-catalogWidth / 2 + 30 + (index - 1) * 20, -catalogHeight / 2 - 24, -18))
        : inlet.localToWorld(new Vector3(catalogWidth / 2 + 30, (3 - index) * 48, -18));
      const port = chassis.localToWorld(new Vector3(-w / 2 - 19, 0, -18));
      pipe(outlet, port, time, excitation, tall ? { out: new Vector3(-6, -70, 14), in: new Vector3(70, 0, 6) } : undefined);
    }
    const content = screenTexture();
    const face = new Mesh(new PlaneGeometry(w, h), crt(content, time, excitation, w, h));
    face.position.z = 10;
    chassis.add(face);
    const marker = document.createTextNode("");
    element.before(marker);
    element.style.width = w + "px";
    element.style.height = h + "px";
    element.setAttribute("drawable", "");
    canvas.append(element);
    return { element, marker, w, h, face, chassis, content, excitation };
  });
  host.before(canvas);
  host.hidden = true;
  const events = new AbortController();
  const listen = { signal: events.signal };
  let hovered: string | null = null;
  const pointer = new Vector2();
  const ray = new Raycaster();
  let projectionDirty = true;
  let visible = false;
  let frame = 0;
  let painted = false;
  camera.position.set(0, 0, 1300);

  const project = (face: Three.Object3D, x: number, y: number) => {
    const point = face.localToWorld(new Vector3(x, y, 0)).project(camera);
    return new Vector2((point.x + 1) * canvas.clientWidth / 2, (1 - point.y) * canvas.clientHeight / 2);
  };

  function place() {
    for (const { face, w, h, element } of screens) {
      const top = project(face, -w/2, h/2);
      const right = project(face, w/2, h/2).sub(top).divideScalar(w);
      const down = project(face, -w/2, -h/2).sub(top).divideScalar(h);
      canvas.updateElementGeometry(element, { canvasTransform: new DOMMatrix([right.x, right.y, down.x, down.y, top.x, top.y]) });
    }
    for (const [index, { tube }] of bulbs.entries()) {
      const button = buttons[index];
      if (!button) continue;
      const top = project(tube, -.56, 2.28);
      const bottom = project(tube, .56, 0);
      button.style.left = top.x + "px";
      button.style.top = top.y + "px";
      button.style.width = bottom.x - top.x + "px";
      button.style.height = bottom.y - top.y + "px";
    }
  }

  function update(now: number) {
    if (!still) time.value = now / 1000;
    const dx = still ? 0 : pointer.x * 60 - camera.position.x;
    const dy = still ? 0 : pointer.y * 45 - camera.position.y;
    if (projectionDirty || Math.abs(dx) + Math.abs(dy) > 0.12) {
      camera.position.x += dx * 0.12;
      camera.position.y += dy * 0.12;
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      place();
      projectionDirty = false;
    }
    const ease = still ? 1 : 0.12;
    for (const screen of screens) screen.excitation.value = Number(screen.element.dataset["surface"] === hovered);
    for (const [i, { tube, emission, light }] of bulbs.entries()) {
      const button = buttons[i];
      const hover = button?.matches(":hover") ?? false;
      const focus = button?.matches(":focus-visible") ?? false;
      const selected = button?.getAttribute("aria-pressed") === "true";
      const target = selected ? 1.25 : hover || focus ? 0.7 : 0.16;
      light.strength += (target - light.strength) * ease;
      light.ring += ((focus ? 1 : 0) - light.ring) * (still ? 1 : .18);
      light.uniforms.strength.value = light.strength;
      light.uniforms.ring.value = light.ring;
      light.uniforms.time.value = time.value + i;
      emission.opacity = selected ? 1 : hover || focus ? .95 : .78;
      emission.color.setScalar(selected ? 1.8 : hover || focus ? 1.3 : 1.0);
      tube.rotation.y += ((hover ? .17 : 0) - tube.rotation.y) * ease;
    }
  }

  function render() {
    if (!painted) return;
    update(performance.now());
    renderer.render(scene, camera);
  }

  function draw(now: number) {
    update(now);
    renderer.render(scene, camera);
    frame = requestAnimationFrame(draw);
  }

  function schedule() {
    cancelAnimationFrame(frame);
    if (still) {
      if (visible) frame = requestAnimationFrame(render);
    } else if (visible && !document.hidden && painted) {
      frame = requestAnimationFrame(draw);
    }
  }

  function announce(id: string | null) {
    if (hovered !== id) document.dispatchEvent(new CustomEvent("acidcat:surface", { detail: id }));
  }

  const catalogScreen = screens[0]?.element;
  const fitCatalog = () => {
    if (catalogScreen) fitToHeight(catalogScreen);
    canvas.requestPaint();
  };
  host.addEventListener("languagechange", fitCatalog, listen);
  void document.fonts.ready.then(() => events.signal.aborted || fitCatalog());
  document.addEventListener("acidcat:surface", event => {
    hovered = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : null;
    if (still) schedule();
  }, listen);
  canvas.addEventListener("pointermove", event => {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width - 0.5, 0.5 - (event.clientY - rect.top) / rect.height);
    if (event.target === canvas) {
      ray.setFromCamera(pointer.clone().multiplyScalar(2), camera);
      const hit = screens.find(screen => screen.element.dataset["surface"] && ray.intersectObject(screen.chassis).length > 0);
      announce(hit?.element.dataset["surface"] ?? null);
    }
  }, listen);
  canvas.addEventListener("pointerleave", () => {
    pointer.set(0, 0);
    announce(null);
  }, listen);
  if (still) {
    for (const button of buttons) {
      for (const type of ["pointerenter", "pointerleave", "focus", "blur"]) button.addEventListener(type, schedule, listen);
    }
  }

  canvas.addEventListener("paint", () => {
    for (const screen of screens) {
      const size = canvas.getElementImageDefaultSize(screen.element);
      const width = Math.ceil(size.width);
      const height = Math.ceil(size.height);
      if (width && height) screen.content.upload(screen.element, width, height);
    }
    const first = !painted;
    painted = true;
    if (still || first) schedule();
  }, listen);
  const resize = new ResizeObserver(() => {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    projectionDirty = true;
    canvas.requestPaint();
  });
  resize.observe(canvas);
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    schedule();
  });
  observer.observe(canvas);
  document.addEventListener("visibilitychange", schedule, listen);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  update(performance.now());
  renderer.render(scene, camera);
  fitCatalog();

  function restore() {
    if (events.signal.aborted) return;
    events.abort();
    cancelAnimationFrame(frame);
    observer.disconnect();
    resize.disconnect();
    for (const { element, marker, content } of screens) {
      marker.replaceWith(element);
      element.removeAttribute("drawable");
      element.style.removeProperty("width");
      element.style.removeProperty("height");
      content.dispose();
    }
    if (rail) railMarker.replaceWith(rail);
    for (const button of buttons) button.removeAttribute("style");
    for (const { emission, light } of bulbs) {
      emission.map?.dispose();
      light.material.dispose();
    }
    finish.color.dispose();
    finish.relief.dispose();
    host.hidden = false;
    canvas.remove();
    reflections.dispose();
    scene.traverse(object => {
      if (object instanceof InstancedMesh) object.dispose();
      if (object instanceof Mesh || object instanceof LineSegments) {
        if (object.geometry instanceof BufferGeometry) object.geometry.dispose();
        if (object.material instanceof Material) object.material.dispose();
      }
    });
    void renderer.dispose();
  }
  renderer.onDeviceLost = restore;
  return restore;
}

const smallestCodeScale = 0.6;

function fitToHeight(screen: HTMLElement) {
  const code = [...screen.querySelectorAll<HTMLElement>(".catalog-code")].find(element => element.offsetParent !== null);
  if (!code) return;
  let scale = 1;
  code.style.zoom = "";
  while (screen.scrollHeight > screen.clientHeight && scale > smallestCodeScale) {
    scale -= 0.05;
    code.style.zoom = String(scale);
  }
}
