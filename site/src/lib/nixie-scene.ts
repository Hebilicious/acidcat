import { AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, CylinderGeometry, Float32BufferAttribute, Group, InstancedMesh, LatheGeometry, LineBasicMaterial, LineSegments, type Material, Mesh, MeshBasicMaterial, MeshPhongMaterial, NodeMaterial, Object3D, PlaneGeometry, SRGBColorSpace, Vector2 } from "three/webgpu";
import type { Node, UniformNode } from "three/webgpu";
import { abs, clamp, dot, exp, length, max, normalView, normalize, positionView, pow, reflect, select, sin, smoothstep, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import { shaderMaterial } from "./engine-shader.js";

const gaussian = (offset: Node<"float">, sharpness: number) => {
  const scaled = offset.mul(sharpness);
  return exp(scaled.mul(scaled).negate());
};

function glassMaterial() {
  const n = normalView;
  const v = normalize(positionView.negate());
  const r = reflect(v.negate(), n);
  const rim = pow(max(dot(n, v), 0).oneMinus(), 2.4);
  const window = gaussian(r.x.add(0.83), 10).mul(smoothstep(-0.62, 0.35, r.y));
  const strip = gaussian(r.x.sub(0.94), 24).mul(smoothstep(-0.85, -0.25, r.y));
  const overhead = gaussian(r.y.sub(0.86), 16).mul(smoothstep(-0.4, 0.6, r.x.negate()));
  const color = vec3(0.17, 0.23, 0.28).mul(rim).add(vec3(0.75, 0.87, 1).mul(window)).add(vec3(0.95, 0.71, 0.38).mul(strip.add(overhead)));
  const material = new NodeMaterial();
  material.fog = false;
  material.transparent = true;
  material.depthWrite = false;
  material.fragmentNode = vec4(color.add(vec3(0.045, 0.036, 0.03)), clamp(rim.mul(0.65).add(window.mul(0.47)).add(strip.mul(0.62)).add(overhead.mul(0.55)).add(0.075), 0, 0.9));
  return material;
}

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

  const glass = glassMaterial();
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

export interface BulbLight {
  readonly material: NodeMaterial;
  readonly uniforms: { readonly strength: UniformNode<"float", number>; readonly ring: UniformNode<"float", number>; readonly time: UniformNode<"float", number> };
  strength: number;
  ring: number;
}

function halo(): BulbLight {
  const strength = uniform(0);
  const ring = uniform(0);
  const time = uniform(0);
  const p = uv().sub(0.5);
  const d = length(p.mul(vec2(1, 0.72)));
  const glow = exp(d.mul(d).mul(-18)).mul(strength);
  const beam = smoothstep(0.16, 0, abs(p.x)).mul(smoothstep(-0.05, 0.2, p.y)).mul(smoothstep(0.45, 0.25, p.y)).mul(strength).mul(0.3);
  const pulse = sin(time.mul(3)).mul(0.15).add(0.85);
  const outline = smoothstep(0.025, 0, abs(d.sub(0.27).sub(sin(time.mul(4)).mul(0.012)))).mul(ring);
  const color = vec3(1, 0.45, 0.12).mul(glow.mul(pulse).add(beam)).add(vec3(0.25, 0.9, 1).mul(outline).mul(1.6));
  const alpha = clamp(max(color.r, max(color.g, color.b)), 0, 1);
  const material = shaderMaterial(select(alpha.greaterThan(0.001), color.div(alpha), vec3(0)), alpha, { transparent: true, depthWrite: false, blending: AdditiveBlending });
  return { material, uniforms: { strength, ring, time }, strength: 0, ring: 0 };
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
