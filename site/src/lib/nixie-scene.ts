import type { Material } from "three";

type Three = typeof import("three");

const glassFragment = `
varying vec3 normalEye;
varying vec3 viewEye;
void main() {
  vec3 n = normalize(normalEye);
  vec3 v = normalize(viewEye);
  vec3 r = reflect(-v,n);
  float rim = pow(1.0 - max(dot(n,v),0.0),2.4);
  float window = exp(-pow((r.x + .83)*10.,2.)) * smoothstep(-.62,.35,r.y);
  float strip = exp(-pow((r.x - .94)*24.,2.)) * smoothstep(-.85,-.25,r.y);
  float overhead = exp(-pow((r.y-.86)*16.,2.)) * smoothstep(-.4,.6,-r.x);
  vec3 color = vec3(.17,.23,.28)*rim + vec3(.75,.87,1.)*window + vec3(.95,.71,.38)*(strip+overhead);
  gl_FragColor = vec4(color + vec3(.045,.036,.03), clamp(.075 + rim*.65 + window*.47 + strip*.62 + overhead*.55,0.,.9));
  #include <colorspace_fragment>
}`;

const strokes: Record<string, string> = {
  T: "M1 2H21 M11 2V39",
  S: "M20 5Q17 1 11 1Q1 1 1 10Q1 16 11 20Q21 24 21 31Q21 40 11 40Q4 40 1 35",
  P: "M2 39V2H11Q21 2 21 12Q21 22 11 22H2",
  Y: "M1 2L11 20L21 2 M11 20V39",
  G: "M20 7Q17 1 11 1Q1 1 1 13V28Q1 40 11 40Q21 40 21 30V22H12",
  O: "M11 1Q21 1 21 13V28Q21 40 11 40Q1 40 1 28V13Q1 1 11 1Z",
  R: "M2 39V2H11Q21 2 21 12Q21 22 11 22H2 M11 22L21 39",
  K: "M2 2V39 M21 2L2 23 M9 16L21 39",
  L: "M2 2V39H21",
};

function cathode(three: Three, code: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const scale = Math.min(5, 202 / (26 * code.length));
    ctx.translate(128 - (26 * code.length - 4) * scale / 2, 128 - 21 * scale);
    ctx.scale(scale, scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const letter of code) {
      const path = strokes[letter];
      for (
        const [width, color, blur] of [
          [3.6, "#ff580e", 22],
          [1.85, "#ff8a3d", 7],
          [.65, "#fff0c9", 1],
        ] as const
      ) {
        ctx.strokeStyle = color;
        ctx.shadowColor = "#ff580e";
        ctx.shadowBlur = blur;
        ctx.lineWidth = width;
        if (path) ctx.stroke(new Path2D(path));
        else {
          ctx.font = "38px monospace";
          ctx.strokeText(letter, 0, 39);
        }
      }
      ctx.translate(26, 0);
    }
  }
  const map = new three.CanvasTexture(canvas);
  map.colorSpace = three.SRGBColorSpace;
  return new three.MeshBasicMaterial({ map, transparent: true, depthWrite: false });
}

function buildTube(three: Three) {
  const group = new three.Group();
  const metal = (color: number, shine: number) =>
    new three.MeshPhongMaterial({
      color,
      shininess: shine,
      specular: 0xffdd9a,
    });
  const brass = metal(0xb47c39, 48);
  const copper = metal(0x9c4a26, 74);
  const steel = metal(0x302a29, 68);
  function turn(profile: readonly (readonly [number, number])[], material: Material) {
    const geometry = new three.LatheGeometry(profile.map(([r, y]) => new three.Vector2(r, y)), 64);
    const mesh = new three.Mesh(geometry, material);
    group.add(mesh);
    return mesh;
  }
  turn([
    [0, .05],
    [.42, .05],
    [.49, .08],
    [.49, .12],
    [.46, .14],
    [.46, .3],
    [.49, .32],
    [.49, .36],
    [.42, .39],
    [0, .39],
  ], brass);
  turn([[.463, .15], [.47, .16], [.47, .28], [.463, .29]], steel);
  const teeth = new three.InstancedMesh(new three.BoxGeometry(.016, .12, .014), brass, 108);
  const tooth = new three.Object3D();
  for (let i = 0; i < teeth.count; i++) {
    const angle = i * Math.PI * 2 / teeth.count;
    tooth.position.set(Math.sin(angle) * .47, .22, Math.cos(angle) * .47);
    tooth.rotation.set(0, angle, -.22, "YXZ");
    tooth.updateMatrix();
    teeth.setMatrixAt(i, tooth.matrix);
  }
  group.add(teeth);
  turn(
    [[.42, .38], [.435, .39], [.435, .423], [.40, .435], [.40, .455], [.385, .46], [0, .46]],
    copper,
  );
  turn([[0, .48], [.34, .48], [.35, .52], [.34, .55], [0, .55]], steel);
  for (const x of [-.21, 0, .21]) {
    const lead = new three.Mesh(new three.CylinderGeometry(.012, .015, 1.37, 8), copper);
    lead.position.set(x, 1.20, -.16);
    group.add(lead);
  }
  const wire: number[] = [];
  const around = 19;
  const rowHeight = .087;
  function vertex(col: number, row: number, corner: number) {
    const angle = (col + (row % 2) / 2 + Math.cos(corner) * .575) * 2 * Math.PI / around;
    wire.push(
      .318 * Math.sin(angle),
      .6 + row * rowHeight + Math.sin(corner) * rowHeight / 1.5,
      .318 * Math.cos(angle),
    );
  }
  for (let row = 0; row < 15; row++) {
    for (let col = 0; col < around; col++) {
      for (let side = 0; side < 3; side++) {
        vertex(col, row, (side + .5) * Math.PI / 3);
        vertex(col, row, (side + 1.5) * Math.PI / 3);
      }
    }
  }
  const cage = new three.BufferGeometry();
  cage.setAttribute("position", new three.Float32BufferAttribute(wire, 3));
  group.add(
    new three.LineSegments(
      cage,
      new three.LineBasicMaterial({
        color: 0xb7845a,
        transparent: true,
        opacity: .24,
        depthWrite: false,
      }),
    ),
  );
  for (const y of [.568, 1.878]) {
    turn([[.318, y], [.327, y + .008], [.323, y + .023], [.308, y + .027]], copper);
  }

  const glass = new three.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: `varying vec3 normalEye; varying vec3 viewEye;
      void main(){ vec4 eye=modelViewMatrix*vec4(position,1.); normalEye=normalMatrix*normal;
      viewEye=-eye.xyz; gl_Position=projectionMatrix*eye; }`,
    fragmentShader: glassFragment,
  });
  const envelope = turn([
    [.37, .42],
    [.398, .45],
    [.414, .52],
    [.42, .68],
    [.42, 1.76],
    [.412, 1.83],
    [.39, 1.905],
    [.35, 1.98],
    [.29, 2.04],
    [.21, 2.088],
    [.12, 2.113],
    [.065, 2.125],
    [.043, 2.145],
    [.027, 2.21],
    [.012, 2.234],
    [0, 2.24],
  ], glass);
  envelope.renderOrder = 3;
  return group;
}

function createScene(
  three: Three,
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
  codes: string[],
) {
  const renderer = new three.WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true });
  const scene = new three.Scene();
  const cell = 1.18;
  const width = cell * codes.length;
  const height = cell * 1.95;
  const camera = new three.OrthographicCamera(
    -width / 2,
    width / 2,
    height / 2,
    -height / 2,
    .1,
    25,
  );
  camera.position.set(0, 2.34, 9);
  camera.lookAt(0, 1.13, 0);
  scene.add(new three.HemisphereLight(0xffeed3, 0x1b1327, 1.2));
  for (
    const [x, y, z, color, power] of [[-4, 5, 4, 0xffe0b7, 2.5], [4, 3, -2, 0x9edbff, 2], [
      0,
      1,
      4,
      0xff8036,
      .48,
    ]] as const
  ) {
    const light = new three.DirectionalLight(color, power);
    light.position.set(x, y, z);
    scene.add(light);
  }
  const template = buildTube(three);
  const tubes = codes.map((code, index) => {
    const tube = template.clone();
    tube.position.x = cell * (index - (codes.length - 1) / 2);
    const emission = cathode(three, code);
    const filament = new three.Mesh(new three.PlaneGeometry(.82, 1.02), emission);
    filament.position.set(0, 1.23, .13);
    filament.renderOrder = 1;
    tube.add(filament);
    scene.add(tube);
    return { tube, emission };
  });
  const hover = codes.map(() => 0);
  function draw(seconds: number, target: number, local: number) {
    for (const [i, { tube, emission }] of tubes.entries()) {
      const goal = i === target ? 1 : 0;
      hover[i] = (hover[i] ?? 0) + (goal - (hover[i] ?? 0)) * .14;
      const lift = hover[i] ?? 0;
      tube.rotation.y = .055 * Math.sin(seconds * .56 + i * .9) * (1 - lift) + local * .38 * lift;
      tube.rotation.z = .02 * Math.sin(seconds * .41 + i * 1.7) * (1 - lift);
      tube.position.y = .08 * lift + .012 * Math.sin(seconds * .8 + i * 1.3);
      const flicker = .97 + .03 * Math.sin(seconds * 19 + i * 2.1) * Math.sin(seconds * 7 - i * 1.3);
      const surge = 1 + lift * (.35 + .15 * Math.sin(seconds * 31 + i));
      emission.opacity = Math.min(1, Math.max(.025, (seconds - i * .08) * 6)) * flicker * Math.min(1.35, surge);
      emission.color.setScalar(1 + lift * .6);
    }
    renderer.render(scene, camera);
  }
  return {
    renderer,
    draw,
    dispose() {
      const resources = new Set<{ dispose(): void }>();
      scene.traverse((object) => {
        if (object instanceof three.Mesh || object instanceof three.LineSegments) {
          if (object.geometry instanceof three.BufferGeometry) resources.add(object.geometry);
          for (
            const material of Array.isArray(object.material) ? object.material : [object.material]
          ) {
            if (material instanceof three.Material) resources.add(material);
          }
          if (object instanceof three.InstancedMesh) object.dispose();
        }
      });
      for (const { emission } of tubes) emission.map?.dispose();
      for (const resource of resources) resource.dispose();
      renderer.dispose();
    },
  };
}

export function observeTubes(host: HTMLElement) {
  const canvas = host.querySelector("canvas");
  const codes = Array.from(host.querySelectorAll(".filament"), (span) => span.textContent.trim());
  if (!canvas || !codes.length) return;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const fine = matchMedia("(pointer: fine)");
  let scene: ReturnType<typeof createScene> | undefined;
  let visible = false;
  let near = false;
  let loading = false;
  let stopped = false;
  let software = false;
  let dirty = true;
  let frame = 0;
  let elapsed = 0;
  let previous = 0;
  let target = -1;
  let local = 0;

  function render(time: number) {
    frame = 0;
    if (!scene || !canvas || !visible || document.hidden || motion.matches) return;
    if (dirty) {
      scene.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
      scene.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      dirty = false;
    }
    if (previous) elapsed += Math.min(.1, (time - previous) / 1000);
    previous = time;
    scene.draw(software ? 2 : elapsed, target, local);
    host.dataset.lit = "";
    if (!software) frame = requestAnimationFrame(render);
  }
  function update() {
    cancelAnimationFrame(frame);
    previous = 0;
    if (motion.matches) delete host.dataset.lit;
    if (
      scene && visible && !document.hidden && !motion.matches &&
      (!software || dirty || !host.hasAttribute("data-lit"))
    ) {
      frame = requestAnimationFrame(render);
    }
  }
  async function load() {
    if (!near || motion.matches || !canvas || scene || loading) return;
    loading = true;
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true });
    if (!gl) return;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    software = debug !== null &&
      /swiftshader|llvmpipe|softpipe|software/i.test(
        String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)),
      );
    try {
      const three = await import("three");
      if (stopped || motion.matches) return;
      scene = createScene(three, canvas, gl, codes);
      update();
    } catch {
      delete host.dataset.lit;
    } finally {
      loading = false;
    }
  }
  function preference() {
    update();
    void load();
  }
  function tilt(event: PointerEvent) {
    if (!fine.matches || software || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    if (u < 0 || u >= 1 || v < 0 || v > 1) {
      reset();
      return;
    }
    const column = u * codes.length;
    target = Math.floor(column);
    local = (column - target) * 2 - 1;
    for (const [index, item] of host.querySelectorAll("li").entries()) item.toggleAttribute("data-active", index === target);
  }
  function reset() {
    target = -1;
    local = 0;
    for (const item of host.querySelectorAll("li")) item.removeAttribute("data-active");
  }
  const preload = new IntersectionObserver((entries) => {
    near = entries.some((entry) => entry.isIntersecting);
    void load();
  }, { rootMargin: "280px" });
  const viewport = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    update();
  });
  const resize = new ResizeObserver(() => {
    dirty = true;
    update();
  });
  preload.observe(host);
  viewport.observe(canvas);
  resize.observe(canvas);
  motion.addEventListener("change", preference);
  document.addEventListener("visibilitychange", update);
  host.addEventListener("pointermove", tilt);
  host.addEventListener("pointerleave", reset);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    preload.disconnect();
    viewport.disconnect();
    motion.removeEventListener("change", preference);
    document.removeEventListener("visibilitychange", update);
    host.removeEventListener("pointermove", tilt);
    host.removeEventListener("pointerleave", reset);
    scene?.dispose();
  };
}
