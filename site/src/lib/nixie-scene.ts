import { AdditiveBlending, BoxGeometry, Color, BufferGeometry, CanvasTexture, CylinderGeometry, Float32BufferAttribute, Group, InstancedMesh, LatheGeometry, LineBasicMaterial, LineSegments, type Material, Mesh, MeshBasicMaterial, MeshPhongMaterial, Object3D, PlaneGeometry, SRGBColorSpace, ShaderMaterial, Vector2 } from "three";



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

function cathode(code: string) {
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
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  return new MeshBasicMaterial({ map, transparent: true, depthWrite: false });
}

function buildTube() {
  const group = new Group();
  const metal = (color: number, shine: number) =>
    new MeshPhongMaterial({
      color,
      shininess: shine,
      specular: 0xffdd9a,
    });
  const brass = metal(0xb47c39, 48);
  const copper = metal(0x9c4a26, 74);
  const steel = metal(0x302a29, 68);
  function turn(profile: readonly (readonly [number, number])[], material: Material) {
    const geometry = new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), 64);
    const mesh = new Mesh(geometry, material);
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
  const teeth = new InstancedMesh(new BoxGeometry(.016, .12, .014), brass, 108);
  const tooth = new Object3D();
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
    const lead = new Mesh(new CylinderGeometry(.012, .015, 1.37, 8), copper);
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
  const cage = new BufferGeometry();
  cage.setAttribute("position", new Float32BufferAttribute(wire, 3));
  group.add(
    new LineSegments(
      cage,
      new LineBasicMaterial({
        color: 0xb7845a,
        transparent: true,
        opacity: .17,
        depthWrite: false,
      }),
    ),
  );
  for (const y of [.568, 1.878]) {
    turn([[.318, y], [.327, y + .008], [.323, y + .023], [.308, y + .027]], copper);
  }

  const glass = new ShaderMaterial({
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

const haloVertex = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const haloFragment = `
uniform vec3 tint;
uniform float strength;
uniform float ring;
uniform float time;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float d = length(p * vec2(1.0, 0.72));
  float glow = exp(-d * d * 18.0) * strength;
  float beam = smoothstep(0.16, 0.0, abs(p.x)) * smoothstep(-0.05, 0.2, p.y) * smoothstep(0.45, 0.25, p.y) * strength * 0.3;
  float pulse = 0.85 + 0.15 * sin(time * 3.0);
  float halo = smoothstep(0.025, 0.0, abs(d - 0.27 - 0.012 * sin(time * 4.0))) * ring;
  vec3 color = tint * (glow * pulse + beam) + vec3(0.25, 0.9, 1.0) * halo * 1.6;
  float a = clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0);
  gl_FragColor = vec4(a > 0.001 ? color / a : vec3(0.0), a);
}
`;

export interface BulbLight {
  readonly material: ShaderMaterial;
  strength: number;
  ring: number;
}

function halo(): BulbLight {
  const material = new ShaderMaterial({
    vertexShader: haloVertex,
    fragmentShader: haloFragment,
    uniforms: { tint: { value: new Color(1.0, 0.45, 0.12) }, strength: { value: 0 }, ring: { value: 0 }, time: { value: 0 } },
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  return { material, strength: 0, ring: 0 };
}

export function tubeBank(labels: string[], socketY: number) {
  const template = buildTube();
  return labels.map((label, index) => {
    const tube = template.clone();
    const emission = cathode(label);
    const filament = new Mesh(new PlaneGeometry(.89, 1.15), emission);
    filament.position.set(0, 1.23, .27);
    filament.renderOrder = 1;
    tube.add(filament);
    tube.scale.set(52, 35, 44);
    tube.position.set((index - (labels.length - 1) / 2) * 86, socketY, 16);
    const light = halo();
    const glow = new Mesh(new PlaneGeometry(3.2, 2.9), light.material);
    glow.position.set(0, 1.05, -.4);
    glow.renderOrder = 4;
    tube.add(glow);
    return { tube, emission, light };
  });
}
