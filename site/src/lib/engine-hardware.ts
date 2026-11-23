import { BoxGeometry, CubicBezierCurve3, CylinderGeometry, ExtrudeGeometry, Group, Mesh, MeshPhongMaterial, MeshStandardMaterial, ShaderMaterial, Shape, TubeGeometry, Vector3 } from "three";
import type * as Three from "three";

export function hardware(scene: Three.Scene) {
  const metal = (color: number, roughness: number) => new MeshStandardMaterial({ color, metalness: 0.86, roughness });
  const brass = metal(0xc9944e, 0.31);
  const copper = metal(0xb1653b, 0.28);
  const steel = metal(0x384043, 0.39);
  const nickel = metal(0xe3d6a6, 0.24);
  const rubber = new MeshStandardMaterial({ color: 0x10191c, roughness: 0.62 });
  const phosphor = new MeshStandardMaterial({ color: 0x9cfa74, emissive: 0x71e149, emissiveIntensity: 0.75 });
  const glass = new MeshPhongMaterial({ color: 0xb7ddd0, shininess: 110, transparent: true, opacity: 0.23, depthWrite: false });
  const unitBox = new BoxGeometry();
  const bolt = new CylinderGeometry(3.7, 4.6, 2.3, 8).rotateX(Math.PI / 2);
  const cylinder = new CylinderGeometry(1, 1, 1, 24);
  function mesh(parent: Three.Object3D, geometry: Three.BufferGeometry, material: Three.Material, x: number, y: number, z: number) {
    const part = new Mesh(geometry, material);
    part.position.set(x, y, z);
    parent.add(part);
    return part;
  }
  function slab(group: Three.Group, w: number, h: number, z: number, depth: number, bevel: number, material: Three.Material) {
    const shape = new Shape();
    const x = w / 2, y = h / 2, cut = Math.min(9, y / 3);
    shape.moveTo(-x + cut, -y);
    shape.lineTo(x - cut, -y);
    shape.lineTo(x, -y + cut);
    shape.lineTo(x, y - cut);
    shape.lineTo(x - cut, y);
    shape.lineTo(-x + cut, y);
    shape.lineTo(-x, y - cut);
    shape.lineTo(-x, -y + cut);
    shape.closePath();
    mesh(group, new ExtrudeGeometry(shape, { depth, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3 }), material, 0, 0, z);
  }
  function device(w: number, h: number, x: number, y: number, catalog: boolean) {
    const group = new Group();
    group.position.set(x, y, 0);
    group.rotation.set(catalog ? 0.17 : 0.13, catalog ? -0.24 : 0.20, catalog ? 0.018 : -0.008);
    scene.add(group);
    const margin = catalog ? 40 : 29;
    slab(group, w + margin - 6, h + margin - 4, -48, 33, 5, steel);
    for (const z of [-42, -33, -24]) {
      slab(group, w + margin, h + margin, z, 3, 1, copper);
    }
    slab(group, w + margin + 2, h + margin + 2, -13, 4, 2, copper);
    slab(group, w + margin, h + margin, -7, 9, 3, brass);
    slab(group, w + 9, h + 8, 4, 2, 2, steel);
    slab(group, w + 3, h + 2, 7, 1, 1, rubber);
    for (const dx of [-1, 1]) {
      for (const dy of [-1, 1]) {
        const bx = dx * (w / 2 + margin / 3.5);
        const by = dy * (h / 2 + margin / 3.5);
        mesh(group, bolt, nickel, bx, by, 6);
        const slot = mesh(group, unitBox, rubber, bx, by, 7.3);
        slot.scale.set(4.5, 0.85, 0.3);
        slot.rotation.z = dx * dy * 0.6;
      }
    }
    for (let i = -2; i <= 2; i++) {
      const grille = mesh(group, unitBox, steel, w / 2 + margin / 3.6, i * 4.6, 5.4);
      grille.scale.set(catalog ? 8 : 5, 1.6, 1);
    }
    const indicator = mesh(group, bolt, phosphor, -w / 2 + 10, h / 2 + margin / 3.7, 5.5);
    indicator.scale.set(1.5, 0.46, 0.7);
    if (catalog) {
      const columnX = w / 2 + 29;
      const column = mesh(group, cylinder, copper, columnX, 0, -16);
      column.scale.set(11, 224, 11);
      for (let branch = -2; branch <= 2; branch++) {
        for (const offset of [-8, 8]) {
          const collar = mesh(group, cylinder, brass, columnX, branch * 48 + offset, -16);
          collar.scale.set(13, 4, 13);
        }
      }
      const gauge = new Group();
      gauge.position.set(columnX, 119, -10);
      group.add(gauge);
      const dial = (radius: number, depth: number, z: number, material: Three.Material) => {
        const disk = mesh(gauge, cylinder, material, 0, 0, z);
        disk.rotation.x = Math.PI / 2;
        disk.scale.set(radius, depth, radius);
      };
      dial(21, 13, 0, brass);
      dial(18.5, 3, 7, steel);
      dial(16.5, 2, 9, nickel);
      for (let i = 0; i <= 8; i++) {
        const angle = (i - 4) * Math.PI / 6;
        const tick = mesh(gauge, unitBox, rubber, 13 * Math.sin(angle), 13 * Math.cos(angle), 10.2);
        tick.rotation.z = -angle;
        tick.scale.set(1.3, i % 2 ? 3 : 5, 0.5);
      }
      const needle = mesh(gauge, unitBox, copper, 3.6, 4.3, 11.2);
      needle.scale.set(1.8, 15, 0.8);
      needle.rotation.z = -0.7;
      dial(2.5, 2, 12, steel);
      for (let i = -6; i <= 6; i++) {
        const vent = mesh(group, unitBox, steel, i * 12, -h / 2 - 11, 5.6);
        vent.scale.set(8, 2, 1);
      }
    }
    return group;
  }
  function pipe(start: Three.Vector3, end: Three.Vector3, time: Three.IUniform<number>, excitation: Three.IUniform<number>) {
    const curve = new CubicBezierCurve3(start, start.clone().add(new Vector3(95, 0, 5)), end.clone().sub(new Vector3(100, 0, 0)), end);
    const fluid = new ShaderMaterial({
      uniforms: { time, excitation },
      vertexShader: 'varying vec2 v; void main(){ v=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `varying vec2 v;
        uniform float time, excitation;
        void main(){
          float pulse = pow(.5+.5*cos(v.x*38.-time*3.2), 5.);
          float tube = .55+.45*cos(v.y*6.283);
          vec3 acid = mix(vec3(.18,.48,.04), vec3(.75,1.,.22), pulse);
          gl_FragColor = vec4(mix(acid, vec3(.6,1.,.74), excitation*.72)*(.62+.38*tube)+excitation*.12,1.);
        }`,
    });
    mesh(scene, new TubeGeometry(curve, 54, 4.2, 14, false), fluid, 0, 0, 0);
    mesh(scene, new TubeGeometry(curve, 54, 7, 18, false), glass, 0, 0, 0);
    const axis = new Vector3(0, 1, 0);
    for (const t of [0.035, 0.09, 0.14, 0.51, 0.88, 0.93, 0.975]) {
      const joint = mesh(scene, cylinder, t === 0.09 || t === 0.93 ? copper : brass, 0, 0, 0);
      joint.position.copy(curve.getPointAt(t));
      joint.quaternion.setFromUnitVectors(axis, curve.getTangentAt(t));
      const small = t === 0.51 || t === 0.14 || t === 0.88;
      joint.scale.set(small ? 8 : 11, small ? 4 : 10, small ? 8 : 11);
    }
  }
  return { device, pipe };
}
