import { BufferGeometry, DirectionalLight, ExternalTexture, FogExp2, InstancedMesh, LineSegments, Material, Mesh, OrthographicCamera, PMREMGenerator, PlaneGeometry, Raycaster, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer } from "three";
import type * as Three from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { DrawableCanvas, ElementTextureContext } from "./holo.js";
import { tubeBank } from "./nixie-scene.js";
import { hardware } from "./engine-hardware.js";

const crt = `
uniform sampler2D content;
uniform float time, excitation;
uniform vec2 size;
varying vec2 v;
void main() {
  vec2 p = v - .5;
  vec2 uv = .5 + p * (1. + .024 * dot(p,p));
  uv.y = 1. - uv.y;
  vec2 fringe = vec2(.55 / size.x, 0.);
  vec4 ink = texture2D(content, uv);
  vec3 type = vec3(texture2D(content, uv+fringe).r, ink.g, texture2D(content, uv-fringe).b);

  float vignette = max(.12, 1.-2.0*dot(p,p));
  float scan = .95 + .05*cos(gl_FragCoord.y*2.1);
  float beam = exp(-18.*abs(fract(time*.095)-uv.y));
  vec3 glass = mix(vec3(.012,.016,.019), vec3(.045,.084,.074), vignette);
  glass += vec3(.075,.085,.064)*smoothstep(.62,1.2, v.y-.24*v.x);
  vec2 spread = 1.6 / size;
  float glow = texture2D(content, uv+spread).a + texture2D(content, uv-spread).a;
  glass += (.025 + type*.085)*glow;
  vec3 phosphor = type;
  gl_FragColor = vec4((glass*(1.+beam*.09+excitation*.75)+phosphor*ink.a*(1.28+excitation*.24))*scan*(.994+.006*sin(time*35.)),1.);
}`;

export function buildMachine(host: HTMLElement, canvas: DrawableCanvas, gl: ElementTextureContext) {
  const renderer = new WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true });
  const scene = new Scene();
  const camera = new OrthographicCamera(-600, 600, 312, -312, 1, 2500);
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
  const time = { value: 0 };
  const inputs = Array.from(host.querySelectorAll<HTMLElement>("[data-catalog-screen], [data-surface]"));
  const catalogWidth = 600;
  const catalogHeight = 436;
  const inlet = device(catalogWidth, catalogHeight, -274, -40, true);
  const rail = host.querySelector<HTMLElement>(".language-rail");
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-language]"));
  const railMarker = document.createTextNode("");
  rail?.before(railMarker);
  if (rail) host.after(rail);
  const bulbs = tubeBank(buttons.map(button => button.textContent.trim()), catalogHeight / 2 + 48);
  for (const { tube } of bulbs) inlet.add(tube);
  const screens = inputs.map((element, index) => {
    const catalog = index === 0;
    const w = catalog ? catalogWidth : 384;
    const h = catalog ? catalogHeight : 68;
    const y = catalog ? 0 : (3 - index) * 108;
    const chassis = catalog ? inlet : device(w, h, 383, y, false);
    const excitation = { value: 0 };
    if (!catalog) {
      const outlet = inlet.localToWorld(new Vector3(catalogWidth / 2 + 30, (3 - index) * 48, -18));
      const port = chassis.localToWorld(new Vector3(-w / 2 - 19, 0, -18));
      pipe(outlet, port, time, excitation);
    }
    const texture = gl.createTexture();
    const external = new ExternalTexture(texture);
    const material = new ShaderMaterial({
      uniforms: { content: { value: external }, time, excitation, size: { value: new Vector2(w, h) } },
      vertexShader: 'varying vec2 v; void main(){v=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: crt,
    });
    const face = new Mesh(new PlaneGeometry(w, h), material);
    face.position.z = 10;
    chassis.add(face);
    const marker = document.createTextNode("");
    element.before(marker);
    element.style.width = w + "px";
    element.style.height = h + "px";
    element.setAttribute("drawable", "");
    canvas.append(element);
    return { element, marker, w, h, face, chassis, texture, external, excitation, width: 0, height: 0 };
  });
  host.before(canvas);
  host.hidden = true;
  const events = new AbortController();
  const options = { signal: events.signal };
  host.addEventListener("languagechange", () => canvas.requestPaint(), options);
  let hovered: string | null = null;
  document.addEventListener("acidcat:surface", event => {
    hovered = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : null;
  }, options);
  const pointer = new Vector2();
  const ray = new Raycaster();
  function announce(id: string | null) {
    if (hovered !== id) document.dispatchEvent(new CustomEvent("acidcat:surface", { detail: id }));
  }
  canvas.addEventListener("pointermove", event => {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width - 0.5, 0.5 - (event.clientY - rect.top) / rect.height);
    if (event.target === canvas) {
      ray.setFromCamera(pointer.clone().multiplyScalar(2), camera);
      const hit = screens.find(screen => screen.element.dataset["surface"] && ray.intersectObject(screen.chassis).length > 0);
      announce(hit?.element.dataset["surface"] ?? null);
    }
  }, options);
  canvas.addEventListener("pointerleave", () => {
    pointer.set(0, 0);
    announce(null);
  }, options);

  canvas.addEventListener("paint", () => {
    for (const screen of screens) {
      const size = canvas.getElementImageDefaultSize(screen.element);
      const width = Math.ceil(size.width);
      const height = Math.ceil(size.height);
      if (!width || !height) continue;
      gl.bindTexture(gl.TEXTURE_2D, screen.texture);
      if (width !== screen.width || height !== screen.height) {
        screen.width = width;
        screen.height = height;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, screen.element);
    }
    renderer.resetState();
  }, options);
  let projectionDirty = true;
  const resize = new ResizeObserver(() => {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    projectionDirty = true;
    canvas.requestPaint();
  });
  resize.observe(canvas);
  const project = (face: Three.Object3D, x: number, y: number) => {
    const point = face.localToWorld(new Vector3(x, y, 0)).project(camera);
    return new Vector2((point.x + 1) * canvas.clientWidth / 2, (1 - point.y) * canvas.clientHeight / 2);
  };
  let visible = false;
  let frame = 0;
  camera.position.set(0, 0, 1300);
  function draw(now: number) {
    time.value = now / 1000;
    const dx = pointer.x * 60 - camera.position.x;
    const dy = pointer.y * 45 - camera.position.y;
    if (projectionDirty || Math.abs(dx) + Math.abs(dy) > 0.12) {
      camera.position.x += dx * 0.12;
      camera.position.y += dy * 0.12;
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
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
      projectionDirty = false;
    }
    for (const screen of screens) screen.excitation.value = Number(screen.element.dataset["surface"] === hovered);
    for (const [i, { tube, emission }] of bulbs.entries()) {
      const button = buttons[i];
      const hover = button?.matches(":hover, :focus-visible");
      const selected = button?.getAttribute("aria-pressed") === "true";
      emission.opacity = selected || hover ? 1 : .69;
      emission.color.setScalar(selected || hover ? 1.45 : .78);
      tube.rotation.y += ((hover ? .17 : 0) - tube.rotation.y) * .12;
    }
    renderer.render(scene, camera);
    frame = requestAnimationFrame(draw);
  }
  function schedule() {
    cancelAnimationFrame(frame);
    if (visible && !document.hidden) frame = requestAnimationFrame(draw);
  }
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    schedule();
  });
  observer.observe(canvas);
  document.addEventListener("visibilitychange", schedule, options);
  canvas.requestPaint();
  function restore() {
    if (events.signal.aborted) return;
    events.abort();
    cancelAnimationFrame(frame);
    observer.disconnect();
    resize.disconnect();
    for (const { element, marker, texture, external } of screens) {
      marker.replaceWith(element);
      element.removeAttribute("drawable");
      element.style.removeProperty("width");
      element.style.removeProperty("height");
      gl.deleteTexture(texture);
      external.dispose();
    }
    if (rail) railMarker.replaceWith(rail);
    for (const button of buttons) button.removeAttribute("style");
    for (const { emission } of bulbs) emission.map?.dispose();
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
    renderer.dispose();
    renderer.forceContextLoss();
  }
  canvas.addEventListener("webglcontextlost", restore, options);
  return restore;
}
