/**
 * Everything that sits in or on the water: sandy islands with palm trees, rock
 * clusters, the striped lighthouse, the giant rubber duck and the ring of red and
 * white buoys around the edge of the arena.
 *
 * To keep the GPU happy, all the fixed stuff is glued into just two meshes:
 *   - "solid": sand, rocks, trunks, huts, the lighthouse
 *   - "foliage": palm fronds (double sided, so you can see the underside)
 * Palm trunks and fronds sway in the breeze using a tiny bit of shader code.
 * The duck and the buoys bob on the same waves the boats ride (see waves.ts).
 */
import * as THREE from 'three';
import { shoreRadius, type DuckSpec, type IslandSpec, type Layout, type RockClusterSpec } from './layout';
import { Bag, MeshBuilder, mulberry32, placement, toyMaterial } from './util';
import { waveHeight, waveNormal } from './waves';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

// ───────────────────────────── Islands ─────────────────────────────

/**
 * Cross-section of an island, from far out under water to the middle:
 * [u, y] where u = distance from the center as a fraction of the beach radius.
 * Positive y is a fraction of the island's top height; negative y is meters below the water.
 */
const PROFILE: readonly (readonly [number, number])[] = [
  [1.45, -1.6],
  [1.15, -0.55],
  [1.0, 0], // the waterline (matches shoreRadius, and the foam in the water shader)
  [0.9, 0.3],
  [0.72, 0.62],
  [0.5, 0.84],
  [0.26, 0.97],
  [0.0, 1.0],
];

const islandTop = (r: number): number => 1.1 + r * 0.05;

/** Height of the island surface at fraction `u` of the beach radius. */
function surfaceY(r: number, u: number): number {
  const top = islandTop(r);
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const [u0, y0] = PROFILE[i];
    const [u1, y1] = PROFILE[i + 1];
    if (u <= u0 && u >= u1) {
      const f = (u0 - u) / (u0 - u1);
      const a = y0 > 0 ? y0 * top : y0;
      const b = y1 > 0 ? y1 * top : y1;
      return a + (b - a) * f;
    }
  }
  return top;
}

const _c = new THREE.Color();
/** Slightly different brightness per triangle, so flat colors don't look dead. Same input, same answer. */
function tint(hex: number, x: number, z: number, amount = 0.05): THREE.Color {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return _c.set(hex).multiplyScalar(1 - amount + (n - Math.floor(n)) * amount * 2);
}

function islandGeometry(isl: IslandSpec, rand: () => number): THREE.BufferGeometry {
  const segs = isl.r > 15 ? 28 : 20;
  const top = islandTop(isl.r);

  // A grid of points: one ring per profile row, `segs` points around each (the very middle is one point).
  const rings: THREE.Vector3[][] = PROFILE.map(([u, py]) => {
    const row: THREE.Vector3[] = [];
    const count = u === 0 ? 1 : segs;
    for (let i = 0; i < count; i++) {
      const th = (i / segs) * TAU;
      const rad = shoreRadius(isl, th) * u;
      let y = py > 0 ? py * top : py;
      if (u > 0.05 && u < 0.95) y += (rand() - 0.5) * 0.16 * top; // lumpy dunes (the waterline ring stays exact)
      row.push(new THREE.Vector3(isl.x + Math.cos(th) * rad, y, isl.z + Math.sin(th) * rad));
    }
    return row;
  });

  const verts: number[] = [];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
    // Wind each triangle so it faces up/outward (the ground always has a +Y normal).
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    const ny = e1.z * e2.x - e1.x * e2.z;
    if (ny >= 0) verts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    else verts.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
  };
  for (let j = 0; j < rings.length - 1; j++) {
    const outer = rings[j];
    const inner = rings[j + 1];
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % segs;
      if (inner.length === 1) {
        tri(outer[i], inner[0], outer[i2]);
      } else {
        tri(outer[i], inner[i], outer[i2]);
        tri(outer[i2], inner[i], inner[i2]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.computeVertexNormals(); // not indexed, so every triangle gets its own flat normal
  return g;
}

// ───────────────────────────── Palms ─────────────────────────────

/** One palm frond lying along +X: rises a little, then droops. A V-shaped strip of 16 triangles. */
function frondGeometry(): THREE.BufferGeometry {
  const L = 4.6;
  const halfWidth = [0.55, 0.95, 0.9, 0.6, 0];
  const v: number[] = [];
  const spine = (i: number): [number, number] => {
    const t = i / 4;
    return [L * t, L * (0.4 * t - 0.95 * t * t)];
  };
  const push = (a: number[], b: number[], c: number[]): void => {
    v.push(...a, ...b, ...c);
  };
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = spine(i);
    const [x1, y1] = spine(i + 1);
    const l0 = [x0, y0 - 0.1, halfWidth[i]];
    const r0 = [x0, y0 - 0.1, -halfWidth[i]];
    const c0 = [x0, y0 + 0.12, 0];
    const l1 = [x1, y1 - 0.1, halfWidth[i + 1]];
    const r1 = [x1, y1 - 0.1, -halfWidth[i + 1]];
    const c1 = [x1, y1 + 0.12, 0];
    push(l0, c0, l1);
    push(c0, c1, l1);
    push(c0, r0, c1);
    push(r0, r1, c1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

const TRUNK_COLORS = [0x9a6a3a, 0xb27c47];
const FROND_COLORS = [0x2fbf52, 0x25a847, 0x3acd5e];

function addPalm(
  solid: MeshBuilder,
  foliage: MeshBuilder,
  trunkSeg: THREE.BufferGeometry,
  frond: THREE.BufferGeometry,
  nut: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rand: () => number,
): void {
  const height = 5.5 + rand() * 3;
  const lean = 0.12 + rand() * 0.2;
  const dir = rand() * TAU;
  const lx = Math.cos(dir);
  const lz = Math.sin(dir);
  const bend = height * Math.tan(lean) * 0.9; // sideways offset at the very top
  const phase = rand() * TAU; // every palm sways to its own beat
  const SEGS = 6;

  const trunkPoint = (s: number): THREE.Vector3 => new THREE.Vector3(x + lx * bend * s * s, y + height * s, z + lz * bend * s * s);
  // 0 at the foot of the trunk, 1 at the crown; grows faster toward the top so the base stays still.
  const swayWeight = (py: number): number => Math.pow(Math.min(1, Math.max(0, (py - y) / height)), 1.6);

  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const dirv = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let i = 0; i < SEGS; i++) {
    const a = trunkPoint(i / SEGS);
    const b = trunkPoint((i + 1) / SEGS);
    dirv.subVectors(b, a);
    const len = dirv.length();
    q.setFromUnitVectors(UP, dirv.normalize());
    pos.addVectors(a, b).multiplyScalar(0.5);
    // trunkSeg is a unit tube (radius 1, height 1, narrower at the top); scale to the right thickness and length.
    const r0 = 0.55 - 0.27 * (i / SEGS);
    scl.set(r0, len * 1.08, r0);
    m.compose(pos, q, scl);
    solid.add(trunkSeg, {
      matrix: m.clone(),
      color: TRUNK_COLORS[i % 2],
      sway: (_px, py) => swayWeight(py),
      swayPhase: phase,
    });
  }

  const crown = trunkPoint(1);
  // Coconuts tucked under the crown
  for (let k = 0; k < 3; k++) {
    const a = phase + (k / 3) * TAU;
    solid.add(nut, {
      matrix: placement(crown.x + Math.cos(a) * 0.5, crown.y - 0.35, crown.z + Math.sin(a) * 0.5, 0, 0, 0, 0.3 + rand() * 0.06),
      color: 0x5b3a21,
      sway: () => 1,
      swayPhase: phase,
    });
  }
  // Fronds fan out all around
  const FRONDS = 8;
  for (let k = 0; k < FRONDS; k++) {
    const yaw = (k / FRONDS) * TAU + (rand() - 0.5) * 0.35;
    const tilt = 0.1 + rand() * 0.5;
    const size = 0.85 + rand() * 0.3;
    foliage.add(frond, {
      matrix: placement(crown.x, crown.y, crown.z, 0, yaw, tilt, size),
      color: FROND_COLORS[k % FROND_COLORS.length],
      // Tips swing a bit more than the base of the frond.
      sway: (px, _py, pz) => 1 + Math.min(1, Math.hypot(px - crown.x, pz - crown.z) / 4.6) * 0.5,
      swayPhase: phase,
    });
  }
}

// ───────────────────────────── Other props ─────────────────────────────

function addRock(solid: MeshBuilder, base: THREE.BufferGeometry, x: number, z: number, radius: number, rand: () => number): void {
  const g = base.clone();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const flat = 0.65 + rand() * 0.2;
  const salt = rand() * 50;
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i);
    const py = p.getY(i);
    const pz = p.getZ(i);
    // Same position -> same wobble, so shared corners move together and the rock stays closed.
    const n = Math.sin(px * 12.9898 + py * 78.233 + pz * 37.719 + salt) * 43758.5453;
    const j = 0.82 + (n - Math.floor(n)) * 0.36;
    p.setXYZ(i, px * j, py * j * flat, pz * j);
  }
  g.computeVertexNormals();
  solid.add(g, {
    matrix: placement(x, radius * 0.3, z, 0, rand() * TAU, 0, radius),
    colorFn: (cx, cy, cz, ny) => tint(ny > 0.55 ? 0xb9c2c9 : ny > -0.1 ? 0x8f9aa3 : 0x6d767e, cx + cy, cz, 0.06),
  });
  g.dispose();
}

function addRockCluster(solid: MeshBuilder, base: THREE.BufferGeometry, c: RockClusterSpec): void {
  const rand = mulberry32(c.seed * 977);
  for (let i = 0; i < c.rocks; i++) {
    const a = rand() * TAU;
    const d = i === 0 ? 0 : c.r * (0.3 + rand() * 0.3);
    const radius = (i === 0 ? 2.4 : 1.1 + rand() * 1.2) * Math.max(0.8, c.r / 5);
    addRock(solid, base, c.x + Math.cos(a) * d, c.z + Math.sin(a) * d, radius, rand);
  }
}

/** Adds the tower, gallery, roof and stone base. Returns where the lantern (the glowing bit) should go. */
function addLighthouse(solid: MeshBuilder, x: number, baseY: number, z: number): THREE.Vector3 {
  const tube = new THREE.CylinderGeometry(1, 1, 1, 12);
  const cone = new THREE.ConeGeometry(1, 1, 12);
  const ball = new THREE.IcosahedronGeometry(1, 0);
  const torus = new THREE.TorusGeometry(1, 0.05, 4, 16);

  const rBottom = 2.7;
  const rTop = 1.75;
  const stripeH = 4.2;
  const stripes = 5;
  const towerBase = baseY + 1.0;
  solid.add(tube, { matrix: placement(x, baseY + 0.55, z, 0, 0, 0, 3.8, 1.6, 3.8), color: 0x9aa3ab }); // stone foot
  for (let k = 0; k < stripes; k++) {
    const r0 = rBottom + (rTop - rBottom) * (k / stripes);
    const r1 = rBottom + (rTop - rBottom) * ((k + 1) / stripes);
    // CylinderGeometry(1,1,1) scaled per axis can't taper, so use a real tapered tube for each stripe.
    const seg = new THREE.CylinderGeometry(r1, r0, stripeH, 12);
    solid.add(seg, { matrix: placement(x, towerBase + stripeH * (k + 0.5), z), color: k % 2 === 0 ? 0xf7f7f2 : 0xe0382c });
    seg.dispose();
  }
  const topY = towerBase + stripeH * stripes;
  solid.add(tube, { matrix: placement(x, topY + 0.2, z, 0, 0, 0, 2.7, 0.4, 2.7), color: 0x3f4850 }); // gallery floor
  solid.add(torus, { matrix: placement(x, topY + 0.95, z, Math.PI / 2, 0, 0, 2.55), color: 0x3f4850 }); // railing
  solid.add(cone, { matrix: placement(x, topY + 0.4 + 2.1 + 0.95, z, 0, 0, 0, 2.2, 1.9, 2.2), color: 0xd9382c }); // roof
  solid.add(ball, { matrix: placement(x, topY + 0.4 + 2.1 + 1.95, z, 0, 0, 0, 0.3), color: 0xf7f7f2 }); // tip

  tube.dispose();
  cone.dispose();
  ball.dispose();
  torus.dispose();
  return new THREE.Vector3(x, topY + 0.4 + 1.05, z);
}

function addHut(solid: MeshBuilder, x: number, baseY: number, z: number): void {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const roof = new THREE.ConeGeometry(1, 1, 4);
  solid.add(box, { matrix: placement(x, baseY - 0.1, z, 0, 0, 0, 3.7, 1.0, 3.3), color: 0xcfc3a2 }); // foundation
  solid.add(box, { matrix: placement(x, baseY + 1.1, z, 0, 0, 0, 3.2, 2.2, 2.8), color: 0xfaf0d2 }); // walls
  solid.add(box, { matrix: placement(x, baseY + 0.8, z + 1.42, 0, 0, 0, 0.9, 1.5, 0.1), color: 0x7a4b2e }); // door
  solid.add(box, { matrix: placement(x + 1.62, baseY + 1.4, z, 0, 0, 0, 0.1, 0.65, 0.8), color: 0x5aa9d6 }); // window
  solid.add(roof, { matrix: placement(x, baseY + 3.05, z, 0, Math.PI / 4, 0, 3.0, 1.7, 3.0), color: 0xe0483a }); // red roof
  box.dispose();
  roof.dispose();
}

function addUmbrella(solid: MeshBuilder, x: number, baseY: number, z: number): void {
  const pole = new THREE.CylinderGeometry(0.07, 0.07, 2.5, 5);
  const canopy = new THREE.ConeGeometry(1.8, 0.8, 8, 1, true);
  solid.add(pole, { matrix: placement(x, baseY + 1.1, z, 0, 0, 0.08), color: 0xeeeeee });
  solid.add(canopy, {
    matrix: placement(x, baseY + 2.5, z, 0, 0, 0.08),
    colorFn: (cx, _cy, cz) => _c.set(Math.floor((Math.atan2(cz, cx) + Math.PI) / (Math.PI / 4)) % 2 === 0 ? 0xe8382c : 0xffffff),
  });
  pole.dispose();
  canopy.dispose();
}

// ───────────────────────────── The rubber duck ─────────────────────────────

function createDuck(spec: DuckSpec, bag: Bag): THREE.Group {
  const sphere = new THREE.SphereGeometry(1, 28, 20);
  const b = new MeshBuilder();
  const part = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number, rx = 0, rz = 0): void => {
    b.add(sphere, { matrix: placement(x, y, z, rx, 0, rz, sx, sy, sz), color });
  };
  const YELLOW = 0xffc61a;
  part(0, 1.5, 0, 6.0, 4.3, 6.8, YELLOW); // body
  part(0, 3.9, -6.2, 2.3, 1.7, 3.2, YELLOW, 0.6); // tail, tipped up
  part(5.4, 2.7, -0.3, 1.1, 2.6, 4.0, 0xeeb000, 0, 0.25); // wings
  part(-5.4, 2.7, -0.3, 1.1, 2.6, 4.0, 0xeeb000, 0, -0.25);
  part(0, 6.9, 2.8, 3.2, 3.2, 3.2, YELLOW); // head
  part(0, 6.5, 5.9, 1.9, 0.7, 2.1, 0xff8a1f); // beak
  part(0, 5.8, 5.6, 1.6, 0.45, 1.7, 0xf0720f);
  part(1.5, 7.7, 5.1, 0.5, 0.55, 0.45, 0x1a1a22); // eyes
  part(-1.5, 7.7, 5.1, 0.5, 0.55, 0.45, 0x1a1a22);
  part(1.4, 7.95, 5.45, 0.15, 0.15, 0.15, 0xffffff); // sparkle in each eye
  part(-1.6, 7.95, 5.45, 0.15, 0.15, 0.15, 0xffffff);
  sphere.dispose();

  const geo = bag.add(b.build() as THREE.BufferGeometry);
  // Glossy smooth rubber (the rest of the map is flat shaded; the duck is the exception).
  const mat = bag.add(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0, emissive: 0x241800 }),
  );
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'rubber-duck-body';

  const group = new THREE.Group();
  group.name = 'rubber-duck';
  group.add(mesh);
  group.position.set(spec.x, 0, spec.z);
  group.rotation.y = spec.heading;
  return group;
}

// ───────────────────────────── Putting it together ─────────────────────────────

export interface Props {
  update(t: number, dt: number): void;
}

/** Wind sway for palms: nudges vertices sideways by (aSway.x * a little), out of step per palm (aSway.y). */
function addSway(mat: THREE.MeshStandardMaterial, time: { value: number }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aSway;\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed.x += sin(uTime * 1.3 + aSway.y) * 0.22 * aSway.x;
        transformed.z += cos(uTime * 1.1 + aSway.y * 1.7) * 0.17 * aSway.x;`,
      );
  };
  mat.customProgramCacheKey = () => 'foamfleet-palm-sway';
}

export function createProps(root: THREE.Group, bag: Bag, layout: Layout): Props {
  const solid = new MeshBuilder();
  const foliage = new MeshBuilder();

  const trunkSeg = new THREE.CylinderGeometry(0.9, 1, 1, 6, 1, false); // unit tube, a bit narrower at the top
  const frond = frondGeometry();
  const nut = new THREE.IcosahedronGeometry(1, 0);
  const rockBase = new THREE.IcosahedronGeometry(1, 1);

  let lantern: THREE.Vector3 | null = null;

  // --- Islands (sand, palms, huts, umbrellas, the lighthouse) ---
  for (const isl of layout.islands) {
    const rand = mulberry32(isl.seed);
    const top = islandTop(isl.r);
    const g = islandGeometry(isl, rand);
    solid.add(g, {
      colorFn: (cx, cy, cz) => {
        if (cy < -0.05) return tint(0xd4b46f, cx, cz);
        if (cy < 0.12 * top) return tint(0xe6c88a, cx, cz);
        if (cy < 0.6 * top) return tint(0xf4dc9c, cx, cz);
        if (isl.grass && cy > 0.9 * top) return tint(0x7fd052, cx, cz, 0.08);
        return tint(0xf9e8b4, cx, cz);
      },
    });
    g.dispose();

    const keepClear: { x: number; z: number; r: number }[] = [];
    const spot = (u: number, th: number): { x: number; y: number; z: number } => {
      const rad = shoreRadius(isl, th) * u;
      return { x: isl.x + Math.cos(th) * rad, y: surfaceY(isl.r, u), z: isl.z + Math.sin(th) * rad };
    };
    if (isl.hut) {
      const p = spot(0.3, isl.seed * 0.7);
      addHut(solid, p.x, p.y, p.z);
      keepClear.push({ x: p.x, z: p.z, r: 3.6 });
    }
    if (!isl.hut && isl.palms >= 4 && !isl.lighthouse) {
      const p = spot(0.4, isl.seed * 1.3);
      addUmbrella(solid, p.x, p.y, p.z);
      keepClear.push({ x: p.x, z: p.z, r: 2.4 });
    }
    if (isl.lighthouse) {
      lantern = addLighthouse(solid, isl.x, top - 0.2, isl.z);
      keepClear.push({ x: isl.x, z: isl.z, r: 4.6 });
    }

    // Palms: random spots on the dry sand, kept apart from each other and from huts.
    const placed: { x: number; y: number; z: number }[] = [];
    for (let tries = 0; tries < 80 && placed.length < isl.palms; tries++) {
      const p = spot(0.12 + rand() * 0.5, rand() * TAU);
      const clear =
        placed.every((q) => Math.hypot(q.x - p.x, q.z - p.z) > 3.4) &&
        keepClear.every((k) => Math.hypot(k.x - p.x, k.z - p.z) > k.r);
      if (clear) placed.push(p);
    }
    for (const p of placed) addPalm(solid, foliage, trunkSeg, frond, nut, p.x, p.y - 0.2, p.z, rand);
  }

  // --- Rocks ---
  for (const c of layout.rocks) addRockCluster(solid, rockBase, c);

  trunkSeg.dispose();
  frond.dispose();
  nut.dispose();
  rockBase.dispose();

  // --- Materials (one clock shared by both, so everything sways together) ---
  const swayTime = { value: 0 };
  const solidMat = bag.add(toyMaterial());
  const foliageMat = bag.add(toyMaterial({ side: THREE.DoubleSide }));
  addSway(solidMat, swayTime);
  addSway(foliageMat, swayTime);

  const solidGeo = solid.build();
  if (solidGeo) {
    const mesh = new THREE.Mesh(bag.add(solidGeo), solidMat);
    mesh.name = 'islands-and-rocks';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  const foliageGeo = foliage.build();
  if (foliageGeo) {
    const mesh = new THREE.Mesh(bag.add(foliageGeo), foliageMat);
    mesh.name = 'palm-fronds';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // --- Lighthouse lantern: a glowing glass room that pulses ---
  let lanternMat: THREE.MeshBasicMaterial | null = null;
  if (lantern) {
    lanternMat = bag.add(new THREE.MeshBasicMaterial({ color: 0xfff0a0 }));
    const glass = new THREE.Mesh(bag.add(new THREE.CylinderGeometry(1.3, 1.3, 2.1, 10)), lanternMat);
    glass.position.copy(lantern);
    glass.name = 'lighthouse-lantern';
    root.add(glass);
  }

  // --- Duck ---
  const duck = createDuck(layout.duck, bag);
  root.add(duck);
  const duckNormal = new THREE.Vector3();
  const duckTilt = new THREE.Quaternion();
  const duckYaw = new THREE.Quaternion();

  // --- Edge buoys: one InstancedMesh, each instance bobbing on the waves ---
  const buoyParts = new MeshBuilder();
  const can = new THREE.CylinderGeometry(0.75, 0.95, 1.5, 10);
  const band = new THREE.CylinderGeometry(0.88, 0.9, 0.4, 10);
  const mast = new THREE.CylinderGeometry(0.1, 0.1, 1.7, 5);
  const lamp = new THREE.IcosahedronGeometry(0.3, 0);
  buoyParts.add(can, { matrix: placement(0, 0.45, 0), color: 0xe8362b });
  buoyParts.add(band, { matrix: placement(0, 0.6, 0), color: 0xffffff });
  buoyParts.add(mast, { matrix: placement(0, 1.8, 0), color: 0xeeeeee });
  buoyParts.add(lamp, { matrix: placement(0, 2.75, 0), color: 0xffd23a });
  can.dispose();
  band.dispose();
  mast.dispose();
  lamp.dispose();
  const buoyGeo = bag.add(buoyParts.build() as THREE.BufferGeometry);
  const buoyMat = bag.add(toyMaterial());
  const { count, ringRadius } = layout.edgeBuoys;
  const buoys = new THREE.InstancedMesh(buoyGeo, buoyMat, count);
  buoys.name = 'edge-buoys';
  buoys.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  buoys.frustumCulled = false; // bounds would only cover the first instance
  buoys.castShadow = false;
  buoys.receiveShadow = true;
  const bx = new Float32Array(count);
  const bz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    bx[i] = Math.cos((i / count) * TAU) * ringRadius;
    bz[i] = Math.sin((i / count) * TAU) * ringRadius;
  }
  root.add(buoys);
  bag.add({ dispose: () => buoys.dispose() }); // frees the instance matrix buffer

  const m4 = new THREE.Matrix4();
  const qb = new THREE.Quaternion();
  const nb = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  const updateBuoys = (t: number): void => {
    for (let i = 0; i < count; i++) {
      waveNormal(bx[i], bz[i], t, nb);
      qb.setFromUnitVectors(UP, nb);
      pb.set(bx[i], waveHeight(bx[i], bz[i], t) - 0.15, bz[i]);
      m4.compose(pb, qb, one);
      buoys.setMatrixAt(i, m4);
    }
    buoys.instanceMatrix.needsUpdate = true;
  };
  updateBuoys(0);

  return {
    update(t: number): void {
      swayTime.value = t;
      updateBuoys(t);

      // Duck: ride the wave under its middle, lean with the surface, and slowly turn back and forth.
      const h = waveHeight(layout.duck.x, layout.duck.z, t);
      duck.position.y = h + 0.1 * Math.sin(t * 1.3);
      waveNormal(layout.duck.x, layout.duck.z, t, duckNormal);
      duckTilt.setFromUnitVectors(UP, duckNormal);
      duckYaw.setFromAxisAngle(UP, layout.duck.heading + 0.18 * Math.sin(t * 0.25));
      duck.quaternion.copy(duckTilt).multiply(duckYaw);

      if (lanternMat) lanternMat.color.setHSL(0.14, 1, 0.72 + 0.14 * Math.sin(t * 3));
    },
  };
}
