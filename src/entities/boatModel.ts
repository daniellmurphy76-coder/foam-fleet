/**
 * Foam Fleet: the toy-boat 3D model.
 *
 * Everything here is built from primitives at runtime (no model files). To keep the number of
 * draw calls low, all the static pieces that share a color are merged into ONE mesh
 * (see `Part`). Only the bits that move on their own (turret, captain's head, flame, shield,
 * pennant) stay as separate objects, and `buildBoatRig` hands them to boat.ts as handles.
 *
 * Local axes: +Z = bow (front), +Y = up, +X = the boat's LEFT. Waterline is y = 0.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';

// ───────────────────────────── what boat.ts gets back ─────────────────────────────

export interface BoatRig {
  /** Add this to the scene. Its position/rotation are driven by the boat. */
  root: THREE.Group;
  /** Paint material for hull + captain's hat; boat.ts pulses its emissive for the hit flash. */
  hullMat: THREE.MeshStandardMaterial;
  /** Blue blaster parts; glows while Rapid Fire is active. */
  blasterGlowMat: THREE.MeshStandardMaterial;
  /** Turns left/right (local Y rotation) to follow the aim target. */
  turretYaw: THREE.Group;
  /** Tilts the barrel up/down (local X rotation, negative = muzzle up). */
  turretPitch: THREE.Group;
  /** Slides back along Z when the blaster fires. */
  turretRecoil: THREE.Group;
  /** Empty marker at the very tip of the barrel; its world position is where darts start. */
  muzzle: THREE.Object3D;
  muzzleFlash: THREE.Mesh;
  /** Two extra little barrels, shown during Triple Shot. */
  sideBarrels: THREE.Object3D;
  /** The captain's head: turns into corners. */
  head: THREE.Group;
  /** Engine flame; scale.z = length. Shown while boosting. */
  flame: THREE.Group;
  /** Pennant that flutters. */
  flag: THREE.Group;
  /** Holder for the translucent bubble: show/hide it and scale it (use SHIELD_SIZE for the base scale). */
  shield: THREE.Group;
  /** The bubble itself, inside `shield`. Spin it for a shimmer (spinning the group would spin the ellipsoid). */
  shieldSpin: THREE.Mesh;
  shieldMat: THREE.MeshStandardMaterial;
  /** Height above the waterline of the middle of the boat (for the dart hit sphere). */
  centerY: number;
  /** Free every geometry and material this rig made. */
  dispose(): void;
}

/** Size (half extents, meters) of the shield bubble that wraps the boat. */
export const SHIELD_SIZE = { x: 1.6, y: 1.7, z: 3.0 };

// ───────────────────────────── palette ─────────────────────────────

const TRIM = 0xf7f7f2; // white trim
const DECK = 0xf2dfae; // sandy deck boards
const GLASS = 0xbfeaff;
const VEST = 0xff9a1f; // the captain's life vest
const SHORTS = 0x2a64c8;
const DARK = 0x2b2f3a;
const BLASTER_ORANGE = 0xff7a1a;
const BLASTER_BLUE = 0x2f7bff;
const SKIN_TONES = [0xf7d2b0, 0xe8b48a, 0xc68b5c, 0x8d5a3a];

// ───────────────────────────── hull styles ─────────────────────────────

interface StyleSpec {
  kind: 'mono' | 'cat';
  zStern: number;
  zBow: number;
  deckY: number;
  turretZ: number;
  seatZ: number;
  windZ: number;
  windW: number;
  motorZ: number;
  /** How tall the white rim sticks up above the deck. */
  rimUp: number;
  stack: boolean;
  /** Half width of the hull along its length (u = 0 at the stern .. 1 at the bow). */
  hw: (u: number) => number;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const STYLES: readonly StyleSpec[] = [
  // 0: sleek speedboat. Long, pointy bow.
  {
    kind: 'mono', zStern: -2.1, zBow: 2.5, deckY: 0.55, turretZ: 0.95, seatZ: -0.7, windZ: 0.05,
    windW: 1.15, motorZ: -2.45, rimUp: 0.16, stack: false,
    hw: (u) => 0.85 * (0.9 + 0.1 * smoothstep(0, 0.4, u)) * (1 - 0.95 * Math.pow(Math.max(0, (u - 0.5) / 0.5), 1.8)),
  },
  // 1: chunky tug. Wide, tall, blunt round bow, smokestack.
  {
    kind: 'mono', zStern: -1.9, zBow: 2.1, deckY: 0.7, turretZ: 0.7, seatZ: -0.65, windZ: -0.05,
    windW: 1.7, motorZ: -2.25, rimUp: 0.26, stack: true,
    hw: (u) => 1.15 * (0.94 + 0.06 * smoothstep(0, 0.3, u)) * Math.sqrt(Math.max(0.02, 1 - Math.pow(Math.max(0, (u - 0.62) / 0.38), 2.4))),
  },
  // 2: catamaran. Two slim pontoons with a deck across them (hw is for ONE pontoon).
  {
    kind: 'cat', zStern: -2.2, zBow: 2.4, deckY: 0.6, turretZ: 0.7, seatZ: -0.75, windZ: 0.0,
    windW: 1.4, motorZ: -2.1, rimUp: 0, stack: false,
    hw: (u) => 0.36 * (u < 0.12 ? 0.8 + (0.2 * u) / 0.12 : 1) * (1 - 0.9 * Math.pow(Math.max(0, (u - 0.55) / 0.45), 1.5)),
  },
];

// ───────────────────────────── little geometry helpers ─────────────────────────────

/** Collects many small geometries (already positioned) and bakes them into ONE flat-shaded mesh. */
class Part {
  private verts: number[] = [];

  /** Takes ownership of `g` (it is disposed here). `m` positions it inside the boat. */
  add(g: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    const flat = g.index ? g.toNonIndexed() : g;
    if (m) flat.applyMatrix4(m);
    const p = flat.getAttribute('position');
    for (let i = 0; i < p.count; i++) this.verts.push(p.getX(i), p.getY(i), p.getZ(i));
    if (flat !== g) flat.dispose();
    g.dispose();
  }

  /** Bake into a mesh, or null if nothing was added. */
  mesh(material: THREE.Material, shadow = true): THREE.Mesh | null {
    if (this.verts.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.verts, 3));
    geo.computeVertexNormals(); // not indexed, so every face gets its own flat normal
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = shadow;
    return mesh;
  }
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Position + rotation (radians, applied yaw-pitch-roll) + scale as a matrix. */
function xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** Outline of a hull seen from above: x = sideways, y = forward (z). `inset` shrinks it. */
function planPoints(s: StyleSpec, inset = 0, cx = 0, n = 14): THREE.Vector2[] {
  const z0 = s.zStern + inset;
  const z1 = s.zBow - inset * 1.4;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pts.push(new THREE.Vector2(cx + Math.max(0.04, s.hw(u) - inset), z0 + (z1 - z0) * u));
  }
  for (let i = n; i >= 0; i--) {
    const u = i / n;
    pts.push(new THREE.Vector2(cx - Math.max(0.04, s.hw(u) - inset), z0 + (z1 - z0) * u));
  }
  return pts;
}

function roundedRect(w: number, d: number, r: number, cx: number, cz: number): THREE.Shape {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cz - d / 2, y1 = cz + d / 2;
  const sh = new THREE.Shape();
  sh.moveTo(x0 + r, y0);
  sh.lineTo(x1 - r, y0);
  sh.quadraticCurveTo(x1, y0, x1, y0 + r);
  sh.lineTo(x1, y1 - r);
  sh.quadraticCurveTo(x1, y1, x1 - r, y1);
  sh.lineTo(x0 + r, y1);
  sh.quadraticCurveTo(x0, y1, x0, y1 - r);
  sh.lineTo(x0, y0 + r);
  sh.quadraticCurveTo(x0, y0, x0 + r, y0);
  return sh;
}

/**
 * Turn a top-down outline into a solid slab. The top face sits at y = topY and the slab is `height` tall.
 * (ExtrudeGeometry pushes along +Z; rotating it by 90 degrees about X turns "extrude" into "down"
 * and the outline's y into the world's z.) Bevels round the edges so it looks like chunky plastic.
 */
function extrude(shape: THREE.Shape, topY: number, height: number, bevelThickness = 0, bevelSize = 0): THREE.BufferGeometry {
  const bevel = bevelThickness > 0 || bevelSize > 0;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, height - 2 * bevelThickness),
    bevelEnabled: bevel,
    bevelThickness,
    bevelSize,
    bevelSegments: 2,
    steps: 1,
    curveSegments: 4,
  });
  g.rotateX(Math.PI / 2);
  g.translate(0, topY - bevelThickness, 0);
  return g;
}

/** A capsule "limb" going from point a to point b (used for the captain's arms). */
function limb(part: Part, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CapsuleGeometry(radius, Math.max(0.01, len - 2 * radius), 2, 6);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  const mid = a.clone().add(b).multiplyScalar(0.5);
  part.add(g, new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
}

interface Parts {
  hull: Part;
  trim: Part;
  deck: Part;
  glass: Part;
  vest: Part;
  dark: Part;
  blue: Part;
  shorts: Part;
}

// ───────────────────────────── hull builders ─────────────────────────────

/** One-piece hull (styles 0 and 1): painted body, white stripe, white rim, sandy deck. */
function buildMonoHull(s: StyleSpec, P: Parts): void {
  const B = 0.12; // how much the bevel bulges the hull wall outward
  P.hull.add(extrude(new THREE.Shape(planPoints(s)), s.deckY, s.deckY + 0.5, B, B));
  // white stripe just proud of the painted wall
  P.trim.add(extrude(new THREE.Shape(planPoints(s)), 0.34, 0.12, 0.015, B + 0.02));
  // white rim (gunwale) around the edge of the deck
  const rim = new THREE.Shape(planPoints(s));
  rim.holes.push(new THREE.Path(planPoints(s, 0.14)));
  P.trim.add(extrude(rim, s.deckY + s.rimUp, s.rimUp + 0.1, 0.03, B + 0.015));
  // deck boards
  P.deck.add(extrude(new THREE.Shape(planPoints(s, 0.14)), s.deckY + 0.03, 0.06));
}

/** Catamaran hull (style 2): two pontoons, a deck across them, front and rear beams. */
function buildCatHull(s: StyleSpec, P: Parts): void {
  const B = 0.1;
  for (const side of [-1, 1]) {
    const cx = side * 0.92;
    P.hull.add(extrude(new THREE.Shape(planPoints(s, 0, cx)), 0.46, 0.96, B, B));
    P.trim.add(extrude(new THREE.Shape(planPoints(s, 0.12, cx)), 0.5, 0.06)); // white strip on top
    P.trim.add(extrude(new THREE.Shape(planPoints(s, 0, cx)), 0.3, 0.1, 0.012, B + 0.02)); // waterline stripe
  }
  P.deck.add(extrude(roundedRect(2.75, 3.1, 0.3, 0, -0.2), s.deckY, 0.12, 0.02, 0.02));
  P.trim.add(new THREE.BoxGeometry(2.0, 0.14, 0.2), xf(0, 0.5, 1.55)); // front beam
  P.trim.add(new THREE.BoxGeometry(2.0, 0.34, 0.14), xf(0, 0.55, -1.85)); // rear beam (motor sits here)
}

// ───────────────────────────── the big builder ─────────────────────────────

export function buildBoatRig(style: number, color: number, id: number): BoatRig {
  const s = STYLES[((Math.trunc(style) % 3) + 3) % 3];
  const y = s.deckY;

  // Materials: every boat gets its own so colors and flashes never leak between boats.
  const materials: THREE.Material[] = [];
  const std = (c: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.55, metalness: 0, ...o });
    materials.push(m);
    return m;
  };
  const hullMat = std(color, { emissive: 0xffffff, emissiveIntensity: 0 }); // emissive = hit flash
  const trimMat = std(TRIM);
  const deckMat = std(DECK, { roughness: 0.8 });
  const glassMat = std(GLASS, { transparent: true, opacity: 0.45, roughness: 0.1, depthWrite: false });
  const vestMat = std(VEST);
  const shortsMat = std(SHORTS);
  const darkMat = std(DARK, { roughness: 0.7 });
  const orangeMat = std(BLASTER_ORANGE);
  const blueMat = std(BLASTER_BLUE, { emissive: BLASTER_BLUE, emissiveIntensity: 0 }); // glows for Rapid Fire
  const skinMat = std(SKIN_TONES[((id % 4) + 4) % 4]);
  const flagMat = std(color, { side: THREE.DoubleSide });
  const flameOuterMat = new THREE.MeshBasicMaterial({ color: 0xff9d1c, transparent: true, opacity: 0.9, depthWrite: false });
  const flameInnerMat = new THREE.MeshBasicMaterial({ color: 0xfff0a0, transparent: true, opacity: 0.95, depthWrite: false });
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xfff1b8, transparent: true, opacity: 0.9, depthWrite: false });
  const shieldMat = std(0x7fe9ff, {
    transparent: true, opacity: 0.28, roughness: 0.15, emissive: 0x2fb8ff, emissiveIntensity: 0.35,
    depthWrite: false, side: THREE.DoubleSide,
  });
  materials.push(flameOuterMat, flameInnerMat, flashMat);

  const P: Parts = {
    hull: new Part(), trim: new Part(), deck: new Part(), glass: new Part(),
    vest: new Part(), dark: new Part(), blue: new Part(), shorts: new Part(),
  };

  // ── hull ──
  if (s.kind === 'mono') buildMonoHull(s, P);
  else buildCatHull(s, P);

  // ── dashboard, windshield, seat ──
  P.trim.add(new THREE.BoxGeometry(s.windW * 0.95, 0.28, 0.34), xf(0, y + 0.14, s.windZ - 0.12));
  P.glass.add(new THREE.BoxGeometry(s.windW, 0.44, 0.04), xf(0, y + 0.5, s.windZ + 0.1, -0.6));
  for (const sx of [-1, 1]) {
    P.trim.add(new THREE.BoxGeometry(0.05, 0.5, 0.06), xf(sx * (s.windW / 2), y + 0.5, s.windZ + 0.1, -0.6));
  }
  P.trim.add(new THREE.BoxGeometry(0.74, 0.2, 0.5), xf(0, y + 0.1, s.seatZ)); // seat
  P.trim.add(new THREE.BoxGeometry(0.74, 0.55, 0.12), xf(0, y + 0.4, s.seatZ - 0.3, -0.15)); // backrest

  // ── captain: body in a life vest, shorts, arms to the steering wheel ──
  P.vest.add(new THREE.CapsuleGeometry(0.24, 0.3, 2, 8), xf(0, y + 0.62, s.seatZ));
  for (const sx of [-1, 1]) {
    P.shorts.add(new THREE.BoxGeometry(0.2, 0.2, 0.55), xf(sx * 0.14, y + 0.3, s.seatZ + 0.35)); // legs
    limb(
      P.vest,
      new THREE.Vector3(sx * 0.27, y + 0.82, s.seatZ),
      new THREE.Vector3(sx * 0.11, y + 0.66, s.windZ - 0.3),
      0.07,
    );
  }
  P.dark.add(new THREE.TorusGeometry(0.13, 0.028, 5, 10), xf(0, y + 0.66, s.windZ - 0.3, -0.9)); // steering wheel

  // ── tug: smokestack off to the side ──
  if (s.stack) {
    P.trim.add(new THREE.CylinderGeometry(0.16, 0.2, 0.8, 8), xf(0.65, y + 0.45, s.seatZ - 0.9));
    P.hull.add(new THREE.CylinderGeometry(0.21, 0.21, 0.18, 8), xf(0.65, y + 0.84, s.seatZ - 0.9));
    P.dark.add(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 8), xf(0.65, y + 0.95, s.seatZ - 0.9));
  }

  // ── outboard motor on the back ──
  P.dark.add(new THREE.BoxGeometry(0.4, 0.45, 0.42), xf(0, 0.5, s.motorZ)); // cowling
  P.dark.add(new THREE.BoxGeometry(0.14, 0.7, 0.2), xf(0, 0.0, s.motorZ)); // leg
  P.dark.add(new THREE.CylinderGeometry(0.1, 0.12, 0.16, 8), xf(0, 0.38, s.motorZ - 0.28, Math.PI / 2)); // exhaust nozzle

  // ── pennant pole ──
  const poleZ = s.zStern + 0.65;
  P.trim.add(new THREE.CylinderGeometry(0.025, 0.03, 1.3, 6), xf(-0.5, y + 0.65, poleZ));

  // ── the blaster's fixed base ──
  P.blue.add(new THREE.CylinderGeometry(0.4, 0.46, 0.22, 10), xf(0, y + 0.11, s.turretZ));

  // ───────── assemble the static meshes ─────────
  const root = new THREE.Group();
  root.rotation.order = 'YXZ'; // yaw first, then pitch, then roll (so tilting happens in the boat's own frame)

  const staticMesh = (part: Part, mat: THREE.Material, shadow = true, receive = false): void => {
    const m = part.mesh(mat, shadow);
    if (!m) return;
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false; // never moves relative to the boat
    m.updateMatrix();
    root.add(m);
  };
  staticMesh(P.hull, hullMat);
  staticMesh(P.trim, trimMat);
  staticMesh(P.deck, deckMat, true, true);
  staticMesh(P.glass, glassMat, false);
  staticMesh(P.vest, vestMat);
  staticMesh(P.shorts, shortsMat);
  staticMesh(P.dark, darkMat);
  staticMesh(P.blue, blueMat);

  // ── captain's head (turns into corners) ──
  const head = new THREE.Group();
  head.position.set(0, y + 1.0, s.seatZ + 0.02);
  const headPart = new Part();
  headPart.add(new THREE.SphereGeometry(0.27, 8, 6), xf(0, 0.22, 0));
  const headMesh = headPart.mesh(skinMat);
  const hatPart = new Part();
  hatPart.add(new THREE.SphereGeometry(0.3, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), xf(0, 0.3, 0)); // cap dome
  hatPart.add(new THREE.BoxGeometry(0.46, 0.04, 0.28), xf(0, 0.31, 0.28, 0.15)); // cap visor
  const hatMesh = hatPart.mesh(hullMat);
  const eyePart = new Part();
  for (const sx of [-1, 1]) eyePart.add(new THREE.SphereGeometry(0.045, 5, 4), xf(sx * 0.1, 0.22, 0.245));
  const eyeMesh = eyePart.mesh(darkMat, false);
  for (const m of [headMesh, hatMesh, eyeMesh]) if (m) head.add(m);
  root.add(head);

  // ── pennant ──
  const flag = new THREE.Group();
  flag.position.set(-0.5, y + 1.3, poleZ);
  const flagGeo = new THREE.BufferGeometry();
  flagGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.15, 0, 0, -0.15, 0, 0, 0, -0.8], 3));
  flagGeo.computeVertexNormals();
  const flagMesh = new THREE.Mesh(flagGeo, flagMat);
  flagMesh.castShadow = true;
  flag.add(flagMesh);
  root.add(flag);

  // ── engine flame: two nested cones pointing backward (-Z), base at the exhaust ──
  const flame = new THREE.Group();
  flame.position.set(0, 0.38, s.motorZ - 0.38);
  const outerGeo = new THREE.ConeGeometry(0.2, 1.8, 7, 1, true);
  outerGeo.translate(0, 0.9, 0);
  outerGeo.rotateX(-Math.PI / 2); // tip now points toward -Z, base at the origin
  const innerGeo = new THREE.ConeGeometry(0.11, 1.1, 6, 1, true);
  innerGeo.translate(0, 0.55, 0);
  innerGeo.rotateX(-Math.PI / 2);
  flame.add(new THREE.Mesh(outerGeo, flameOuterMat), new THREE.Mesh(innerGeo, flameInnerMat));
  flame.visible = false;
  root.add(flame);

  // ───────── blaster turret ─────────
  const turret = new THREE.Group();
  turret.position.set(0, y + 0.22, s.turretZ);
  root.add(turret);
  const turretYaw = new THREE.Group();
  turret.add(turretYaw);

  // body (turns with the yaw)
  const yo = new Part();
  const yb = new Part();
  yo.add(new THREE.BoxGeometry(0.6, 0.42, 0.8), xf(0, 0.21, -0.1)); // chunky housing
  yb.add(new THREE.BoxGeometry(0.5, 0.1, 0.55), xf(0, 0.47, -0.12)); // top cap
  yb.add(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 8), xf(0, 0.76, -0.2)); // dart magazine
  yo.add(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 8), xf(0, 1.04, -0.2)); // magazine cap
  yb.add(new THREE.BoxGeometry(0.14, 0.34, 0.14), xf(0, 0.1, -0.56, 0.25)); // grip
  for (const m of [yo.mesh(orangeMat), yb.mesh(blueMat)]) if (m) turretYaw.add(m);

  // barrel assembly (tilts, then slides back on recoil)
  const turretPitch = new THREE.Group();
  turretPitch.position.set(0, 0.24, 0.25);
  turretYaw.add(turretPitch);
  const turretRecoil = new THREE.Group();
  turretPitch.add(turretRecoil);

  const po = new Part();
  const pb = new Part();
  const alongZ = Math.PI / 2;
  po.add(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 10), xf(0, 0, 0.25, alongZ)); // shroud
  pb.add(new THREE.CylinderGeometry(0.14, 0.14, 1.0, 8), xf(0, 0, 0.5, alongZ)); // barrel
  po.add(new THREE.CylinderGeometry(0.215, 0.215, 0.14, 10), xf(0, 0, 1.0, alongZ)); // muzzle ring
  pb.add(new THREE.BoxGeometry(0.05, 0.12, 0.05), xf(0, 0.26, 0.55)); // sight
  for (const m of [po.mesh(orangeMat), pb.mesh(blueMat)]) if (m) turretRecoil.add(m);

  // two extra barrels that appear for Triple Shot (splayed by the same angle as the darts)
  const spread = (CONFIG.blaster.tripleSpreadDeg * Math.PI) / 180;
  const sideB = new Part();
  const sideO = new Part();
  for (const sx of [-1, 1]) {
    sideB.add(new THREE.CylinderGeometry(0.1, 0.1, 0.8, 8), xf(sx * 0.32, -0.02, 0.55, alongZ, sx * spread));
    sideO.add(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 8), xf(sx * 0.32 + sx * Math.sin(spread) * 0.4, -0.02, 0.95, alongZ, sx * spread));
  }
  const sideBarrels = new THREE.Group();
  for (const m of [sideB.mesh(blueMat), sideO.mesh(orangeMat)]) if (m) sideBarrels.add(m);
  sideBarrels.visible = false;
  turretRecoil.add(sideBarrels);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 1.07);
  turretRecoil.add(muzzle);
  const muzzleFlash = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), flashMat);
  muzzleFlash.position.set(0, 0, 1.2);
  muzzleFlash.visible = false;
  turretRecoil.add(muzzleFlash);

  // ── shield bubble: a faceted ellipsoid that wraps the whole boat ──
  const shield = new THREE.Group();
  shield.scale.set(SHIELD_SIZE.x, SHIELD_SIZE.y, SHIELD_SIZE.z);
  shield.position.set(0, 0.75, 0);
  shield.visible = false;
  const shieldSpin = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), shieldMat);
  shield.add(shieldSpin);
  root.add(shield);

  return {
    root,
    hullMat,
    blasterGlowMat: blueMat,
    turretYaw,
    turretPitch,
    turretRecoil,
    muzzle,
    muzzleFlash,
    sideBarrels,
    head,
    flame,
    flag,
    shield,
    shieldSpin,
    shieldMat,
    centerY: 0.85,
    dispose(): void {
      root.removeFromParent();
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      for (const m of materials) m.dispose();
      materials.length = 0;
    },
  };
}
