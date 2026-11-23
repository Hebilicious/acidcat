import { AdditiveBlending, PlaneGeometry, InstancedMesh, TorusGeometry, BoxGeometry, CubicBezierCurve3, CylinderGeometry, ExtrudeGeometry, Group, Mesh, MeshPhongMaterial, MeshStandardMaterial, ShaderMaterial, Shape, TubeGeometry, Vector3 } from "three";
import { machinedFinish } from "./engine-finish.js";
import type * as Three from "three";

export function hardware(scene: Three.Scene) {
  const finish = machinedFinish();
  const metal = (color: number, roughness: number) => new MeshStandardMaterial({ color, metalness: 0.93, map: finish.color, bumpMap: finish.relief, bumpScale: .72, roughnessMap: finish.relief, roughness });
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
    const geometry = new ExtrudeGeometry(shape, { depth, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3 });
    const uv = geometry.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 137, uv.getY(i) / 137);
    mesh(group, geometry, material, 0, 0, z);
  }
  function cable(group: Three.Group, start: Three.Vector3, end: Three.Vector3, droop: number, radius: number, material: Three.Material) {
    const bend = new Vector3((end.x - start.x) * .4, -droop, 6);
    const curve = new CubicBezierCurve3(start, start.clone().add(bend), end.clone().add(new Vector3(-bend.x, bend.y, bend.z)), end);
    mesh(group, new TubeGeometry(curve, 24, radius, 8, false), material, 0, 0, 0);
  }
  function cornerCasting() {
    const outline = new Shape();
    outline.moveTo(0, 13);
    outline.lineTo(13, 0);
    outline.lineTo(57, 0);
    outline.lineTo(50, 8);
    outline.lineTo(19, 8);
    outline.lineTo(9, 18);
    outline.lineTo(9, 28);
    outline.lineTo(0, 35);
    outline.closePath();
    return new ExtrudeGeometry(outline, { depth: 3, bevelSize: 1.6, bevelThickness: 1.6, bevelSegments: 2 });
  }
  const casting = cornerCasting();
  function device(w: number, h: number, x: number, y: number, catalog: boolean) {
    const group = new Group();
    group.position.set(x, y, 0);
    group.rotation.set(catalog ? 0.17 : 0.13, catalog ? -0.24 : 0.20, catalog ? 0.018 : -0.008);
    scene.add(group);
    const margin = catalog ? 40 : 29;
    const width = w + margin, height = h + margin;
    const shade = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { bounds: { value: [width, height] } },
      vertexShader: "varying vec2 v; void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader: `varying vec2 v; uniform vec2 bounds;
        void main(){
          vec2 d = abs(v-.5)*(bounds+60.)-.5*bounds+6.;
          float distanceToEdge = length(max(d,0.))+min(max(d.x,d.y),0.)-6.;
          gl_FragColor = vec4(.005,.008,.012,.65*exp(-max(distanceToEdge,0.)*.12));
        }`,
    });
    mesh(group, new PlaneGeometry(width+60,height+60), shade, 4,-8,-53);
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
        const corner = mesh(group, casting, copper, dx * (width / 2 - 1), dy * (height / 2 - 1), 5);
        corner.scale.set(-dx, -dy, 1);
        for (const inset of [20, 44]) {
          mesh(group, bolt, nickel, dx * (width / 2 - inset), dy * (height / 2 - 5), 10).scale.setScalar(.68);
        }
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
    for (const dy of [-1, 1]) {
      const lip = mesh(group, unitBox, nickel, 0, dy*(h/2 + margin/2 - 2), 3);
      lip.scale.set(w - 12, 1.3, 2);
      for (const dx of [-1, 1]) {
        const clamp = mesh(group, unitBox, copper, dx*(w/2 - 24), dy*(h/2 + margin/4), 4.5);
        clamp.scale.set(32, margin/2, 4);
        for (const k of [-1, 1]) mesh(group, bolt, brass, clamp.position.x + k*10, clamp.position.y, 8);
      }
    }
    if (catalog) {
      const rail = new Group();
      const socketY = h / 2 + 48;
      rail.position.set(0, socketY - 7, 9);
      group.add(rail);
      slab(rail, 424, 11, -21, 30, 3, steel);
      slab(rail, 418, 4, 9, 3, 1, brass);
      for (const side of [-1, 1]) {
        const post = mesh(group, cylinder, copper, side * 194, socketY - 20, -3);
        post.scale.set(8, 30, 8);
        for (const y of [socketY - 16, socketY - 31]) {
          mesh(group, cylinder, brass, post.position.x, y, -3).scale.set(12, 5, 12);
        }
        const foot = new Group();
        foot.position.set(side * w * .36, -height / 2 - 14, -16);
        group.add(foot);
        slab(foot, 39, 24, -16, 35, 4, steel);
        const sole = new Group();
        sole.position.y = -12;
        foot.add(sole);
        slab(sole, 72, 8, -22, 50, 3, brass);
      }
      for (let socket = -2; socket <= 2; socket++) {
        cable(group, new Vector3(socket * 86, socketY - 6, 1), new Vector3(socket * 86 + 42, h / 2 + 19, -7), 16, 2.8, rubber);
        cable(group, new Vector3(socket * 86 + 6, socketY - 6, 0), new Vector3(socket * 86 + 49, h / 2 + 19, -7), 13, 1.6, copper);
      }
      const columnX = w / 2 + 29;
      const column = mesh(group, cylinder, copper, columnX, 0, -16);
      column.scale.set(11, 224, 11);
      for (let branch = -2; branch <= 2; branch++) {
        for (const offset of [-8, 8]) {
          const collar = mesh(group, cylinder, brass, columnX, branch * 48 + offset, -16);
          collar.scale.set(13, 4, 13);
        }
      }
      const wheel = new Group();
      wheel.position.set(columnX,-113,6);
      wheel.rotation.y = .31;
      group.add(wheel);
      mesh(wheel,new TorusGeometry(16,2.7,10,42),copper,0,0,0);
      for (let spoke = 0; spoke < 3; spoke++) {
        const bar = mesh(wheel,unitBox,brass,0,0,0);
        bar.scale.set(30,2.6,2.6);
        bar.rotation.z = spoke*Math.PI/3;
      }
      mesh(wheel,bolt,nickel,0,0,2);
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
    const curve = new CubicBezierCurve3(start, start.clone().add(new Vector3(78, -20, 14)), end.clone().sub(new Vector3(83, 25, 6)), end);
    const fluid = new ShaderMaterial({
      uniforms: { time, excitation },
      vertexShader: 'varying vec2 v; void main(){ v=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `varying vec2 v;
        uniform float time, excitation;
        void main(){
          float pulse = pow(.5+.5*cos(v.x*38.-time*3.2), 5.);
          float tube = .55+.45*cos(v.y*6.283);
          vec3 acid = mix(vec3(.18,.48,.04), vec3(.75,1.,.22), pulse);
          vec2 cell = vec2(fract(v.x*13.-time*.65)-.5, sin(v.y*6.283 + floor(v.x*13.-time*.65)*2.4));
          float bubble = length(cell*vec2(3.4,1.7));
          acid += vec3(.52,.62,.40)*(1.-smoothstep(.08,.24,abs(bubble-.69)));
          gl_FragColor = vec4(mix(acid, vec3(.6,1.,.74), excitation*.72)*(.62+.38*tube)+excitation*.12,1.);
        }`,
    });
    mesh(scene, new TubeGeometry(curve, 54, 4.2, 14, false), fluid, 0, 0, 0);
    mesh(scene, new TubeGeometry(curve, 54, 7, 18, false), glass, 0, 0, 0);
    const halo = new ShaderMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      uniforms: { excitation },
      vertexShader: `varying vec3 eyeNormal; void main(){eyeNormal=normalMatrix*normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec3 eyeNormal; uniform float excitation; void main(){
        float falloff=pow(max(normalize(eyeNormal).z,0.),3.);
        gl_FragColor=vec4(.48,.95,.06,falloff*(.17+.22*excitation));
      }`,
    });
    mesh(scene, new TubeGeometry(curve, 54, 14, 20, false), halo, 0, 0, 0);
    const axis = new Vector3(0, 1, 0);
    function sleeve(t: number, radius: number, length: number, material: Three.Material, geometry = cylinder) {
      const part = mesh(scene, geometry, material, 0, 0, 0);
      part.position.copy(curve.getPointAt(t));
      part.quaternion.setFromUnitVectors(axis, curve.getTangentAt(t));
      part.scale.set(radius, length, radius);
      return part;
    }
    const nut = new CylinderGeometry(1, 1, 1, 6);
    for (const side of [0, 1]) {
      const sign = side === 0 ? 1 : -1;
      const flange = sleeve(side, 17, 8, steel);
      for (let i = 0; i < 6; i++) {
        const angle = i * Math.PI / 3;
        const stud = mesh(scene, nut, nickel, 0, 0, 0);
        stud.position.set(Math.cos(angle)*13, sign*5, Math.sin(angle)*13).applyQuaternion(flange.quaternion).add(flange.position);
        stud.quaternion.copy(flange.quaternion);
        stud.scale.set(2.4, 4, 2.4);
      }
      sleeve(side + sign*.045, 12, 12, brass, nut);
      sleeve(side + sign*.09, 9, 6, copper);
    }
    const ring = new TorusGeometry(7.2, 1.4, 8, 20).rotateX(Math.PI / 2);
    const seams = new InstancedMesh(ring, glass, 16);
    const station = new Group();
    for (let i = 0; i < seams.count; i++) {
      const t = .14 + i * .048;
      station.position.copy(curve.getPointAt(t));
      station.quaternion.setFromUnitVectors(axis, curve.getTangentAt(t));
      station.updateMatrix();
      seams.setMatrixAt(i, station.matrix);
    }
    scene.add(seams);
    for (const t of [.32, .69]) {
      sleeve(t, 9.3, 11, copper);
      sleeve(t, 10.5, 5, brass, nut);
    }
  }
  return { device, pipe, finish };
}
