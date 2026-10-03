/**
 * Foam Fleet: the BoneBoat (hull 3), a boat built from a giant, friendly shark skeleton.
 *
 * Reading it from the chase camera (behind and above) and in the Garage (a turntable, a bit above):
 *   - a wide, low SKULL at the bow with big glowing eyes in the player color and a toothy open grin,
 *   - curved RIBS along both sides that make the hull (thin, with water showing through the gaps),
 *   - a SPINE for a keel, a floor plate inside so it reads as a boat,
 *   - a bony DORSAL FIN (a see-through tent of bones) behind the captain,
 *   - a forked TAIL FIN at the stern (the flag mast stands on the stern bone just in front of it),
 *   - two little PECTORAL FIN bones near the waterline.
 *
 * Paint patterns do not paint this hull. They tint the tips (rib ends, teeth tips, tail and fin tips) in
 * the player color and decide how much: solid = tips, stripes = bands on the ribs, flames = long tips with
 * little flame tongues, dots = beads on the ribs, shark = nearly all-colored teeth and a colored jaw.
 *
 * Like the other hulls it is built at runtime from primitives, merged into a handful of meshes (ivory bone,
 * darker ivory floor, white teeth, player-color tips, dark eye sockets, glowing eyes).
 *
 * Local axes: +Z = bow (front), +Y = up, +X = the boat's LEFT. Waterline is y = 0.
 */
import * as THREE from 'three';
import type { PatternId } from '../types';
import { extrude, MaterialBag, Part, smoothstep, xf } from './boatGeo';
import type { StyleSpec } from './boatStyles';

export interface BoneBuild {
  /** Static meshes to add to the boat root (already baked; they never move on their own). */
  meshes: THREE.Mesh[];
  /** Ivory materials: boat.ts adds them to the white hit flash (the player-color tips flash via the hull material). */
  flash: THREE.MeshStandardMaterial[];
  /** The soft glow around the eyes: boat.ts pulses its opacity. */
  eyeHalo: THREE.MeshBasicMaterial;
}

// ───────────────────────────── palette ─────────────────────────────

const BONE = 0xece0bd; // warm ivory
const SHADE = 0xc9b585; // darker ivory (floor plate, fin ribs, the discs between vertebrae)
const TOOTH = 0xfaf4e2; // bright teeth
const SOCKET = 0x242833; // dark eye sockets

// ───────────────────────────── what each paint pattern does ─────────────────────────────

interface Plan {
  /** Share (0..1) of each rib's length, from its tip, that takes the player color. */
  rib: number;
  /** Same for the teeth. */
  tooth: number;
  /** Same for the tail tines and the dorsal fin's spars. */
  tail: number;
  fin: number;
  /** A colored band around the middle of every rib, and every other vertebra colored. */
  band: boolean;
  /** A colored bead on every rib and on the tail root. */
  bead: boolean;
  /** A little flame tongue streaming back from each rib tip. */
  tongue: boolean;
  /** The front of the lower jaw is colored too. */
  jaw: boolean;
}

function planFor(pattern: PatternId): Plan {
  const base: Plan = { rib: 0.22, tooth: 0.4, tail: 0.25, fin: 0.18, band: false, bead: false, tongue: false, jaw: false };
  switch (pattern) {
    case 'stripes': return { ...base, rib: 0.18, band: true };
    case 'flames': return { ...base, rib: 0.5, tail: 0.6, fin: 0.5, tongue: true };
    case 'dots': return { ...base, rib: 0.15, tail: 0.2, fin: 0.15, bead: true };
    case 'shark': return { ...base, rib: 0.15, tooth: 0.85, tail: 0.4, fin: 0.25, jaw: true };
    default: return base; // 'solid' (and anything unknown)
  }
}

// ───────────────────────────── tiny geometry kit ─────────────────────────────

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const RIGHT = new THREE.Vector3(1, 0, 0);

const at = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** The same points mirrored across the middle of the boat. */
const mirror = (pts: THREE.Vector3[]): THREE.Vector3[] => pts.map((p) => at(-p.x, p.y, p.z));

/**
 * One triangle, turned (if needed) so that it faces the way (ox, oy, oz) points. Building solids this way
 * means a mistake in vertex order can never leave a face inside-out.
 */
function tri(part: Part, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ox: number, oy: number, oz: number): void {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  if (nx * ox + ny * oy + nz * oz >= 0) part.tri(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  else part.tri(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
}

/**
 * A faceted tube along a polyline, with a radius at every point (so it can taper). The start is closed flat
 * (or left open); the end is closed flat (`tip` = 0), left open (`tip` = null), or comes to a point `tip` meters long.
 */
function tube(part: Part, pts: THREE.Vector3[], radii: number[], sides = 6, startCap = true, tip: number | null = 0): void {
  const n = pts.length;
  if (n < 2) return;
  const rad = (i: number): number => radii[Math.min(i, radii.length - 1)];

  const T: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) T.push(pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());

  // Frames by parallel transport, so the rings never twist along the tube.
  const ref = Math.abs(T[0].y) < 0.9 ? UP : RIGHT;
  const N: THREE.Vector3[] = [new THREE.Vector3().crossVectors(ref, T[0]).normalize()];
  for (let i = 1; i < n; i++) {
    const p = N[i - 1];
    const q = p.clone().addScaledVector(T[i], -p.dot(T[i]));
    if (q.lengthSq() < 1e-6) q.crossVectors(T[i], Math.abs(T[i].x) < 0.9 ? RIGHT : UP);
    N.push(q.normalize());
  }

  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const B = new THREE.Vector3().crossVectors(T[i], N[i]);
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      ring.push(pts[i].clone().addScaledVector(N[i], Math.cos(a) * rad(i)).addScaledVector(B, Math.sin(a) * rad(i)));
    }
    rings.push(ring);
  }

  for (let i = 0; i + 1 < n; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    const mz = (pts[i].z + pts[i + 1].z) / 2;
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      const a = rings[i][k];
      const b = rings[i][k2];
      const c = rings[i + 1][k2];
      const d = rings[i + 1][k];
      const ox = (a.x + b.x + c.x + d.x) / 4 - mx;
      const oy = (a.y + b.y + c.y + d.y) / 4 - my;
      const oz = (a.z + b.z + c.z + d.z) / 4 - mz;
      tri(part, a, d, c, ox, oy, oz);
      tri(part, a, c, b, ox, oy, oz);
    }
  }

  if (startCap) {
    for (let k = 0; k < sides; k++) tri(part, pts[0], rings[0][(k + 1) % sides], rings[0][k], -T[0].x, -T[0].y, -T[0].z);
  }
  if (tip !== null) {
    const last = n - 1;
    const end = pts[last];
    const apex = tip > 0 ? end.clone().addScaledVector(T[last], tip) : end;
    for (let k = 0; k < sides; k++) {
      const a = rings[last][k];
      const b = rings[last][(k + 1) % sides];
      if (tip > 0) {
        const ox = (a.x + b.x) / 2 - end.x + T[last].x * 0.5 * rad(last);
        const oy = (a.y + b.y) / 2 - end.y + T[last].y * 0.5 * rad(last);
        const oz = (a.z + b.z) / 2 - end.z + T[last].z * 0.5 * rad(last);
        tri(part, a, b, apex, ox, oy, oz);
      } else {
        tri(part, end, a, b, T[last].x, T[last].y, T[last].z);
      }
    }
  }
}

/**
 * Like `tube`, but the last `f` share of the length goes into `tint` (the player color), a hair thicker so it reads
 * like a painted tip. The end comes to a point `tip` meters long.
 */
function tubeTint(bone: Part, tint: Part, pts: THREE.Vector3[], radii: number[], f: number, sides = 6, tip = 0.08): void {
  if (f <= 0.01) {
    tube(bone, pts, radii, sides, true, tip);
    return;
  }
  const n = pts.length;
  const rad = (i: number): number => radii[Math.min(i, radii.length - 1)];
  const grown = (r: number): number => r * 1.07;
  if (f >= 0.99) {
    tube(tint, pts, radii.map(grown), sides, true, tip);
    return;
  }
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const target = cum[n - 1] * (1 - f);
  let j = 1;
  while (j < n - 1 && cum[j] < target) j++; // the split lies between points j - 1 and j
  const t = (target - cum[j - 1]) / Math.max(1e-6, cum[j] - cum[j - 1]);
  const sp = pts[j - 1].clone().lerp(pts[j], t);
  const sr = lerp(rad(j - 1), rad(j), t);
  tube(bone, [...pts.slice(0, j), sp], [...pts.slice(0, j).map((_, i) => rad(i)), sr], sides, true, null);
  tube(tint, [sp, ...pts.slice(j)], [grown(sr), ...pts.slice(j).map((_, i) => grown(rad(j + i)))], sides, false, tip);
}

const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _unit = new THREE.Vector3(1, 1, 1);

/** A tapered cylinder from a to b (radius ra at a, rb at b). */
function frustum(part: Part, a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, sides = 6): void {
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-5) return;
  _dir.divideScalar(len);
  _mid.addVectors(a, b).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, _dir);
  part.add(new THREE.CylinderGeometry(rb, ra, len, sides, 1), new THREE.Matrix4().compose(_mid, q, _unit));
}

/** A cone with its base at `base` and its point at `tipAt`. */
function cone(part: Part, base: THREE.Vector3, tipAt: THREE.Vector3, r: number, sides = 6): void {
  _dir.subVectors(tipAt, base);
  const len = _dir.length();
  if (len < 1e-5) return;
  _dir.divideScalar(len);
  _mid.addVectors(base, tipAt).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, _dir);
  part.add(new THREE.ConeGeometry(r, len, sides, 1), new THREE.Matrix4().compose(_mid, q, _unit));
}

function ball(part: Part, p: THREE.Vector3, r: number, w = 6, h = 4): void {
  part.add(new THREE.SphereGeometry(r, w, h), xf(p.x, p.y, p.z));
}

/**
 * A pointy tooth from `base` along the unit vector `dir`, `len` long. The last `f` share of it is the tinted tip.
 */
function tooth(bone: Part, tint: Part, base: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, f: number): void {
  const tipAt = base.clone().addScaledVector(dir, len);
  if (f <= 0.02) {
    cone(bone, base, tipAt, r, 5);
    return;
  }
  const split = base.clone().addScaledVector(dir, len * (1 - f));
  if (f < 0.98) frustum(bone, base, split, r, r * f, 5);
  cone(tint, split, tipAt, f < 0.98 ? r * f * 1.1 : r * 1.05, 5);
}

/** Point where a rising polyline (bottom to top) crosses height y. */
function pointAtY(pts: THREE.Vector3[], y: number): THREE.Vector3 {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (y >= a.y && y <= b.y) return a.clone().lerp(b, (y - a.y) / Math.max(1e-6, b.y - a.y));
  }
  return pts[pts.length - 1].clone();
}

// ───────────────────────────── the skull's shape ─────────────────────────────

interface Sec {
  z: number;
  /** Half width. */
  hw: number;
  /** Top and bottom of the head at this z. */
  top: number;
  bot: number;
}

/** Back of the skull to the tip of the snout. Wide and low: the barrel of the blaster passes over it. */
const SKULL: readonly Sec[] = [
  { z: 0.85, hw: 0.55, top: 0.76, bot: 0.3 },
  { z: 1.15, hw: 0.62, top: 0.76, bot: 0.3 },
  { z: 1.55, hw: 0.55, top: 0.7, bot: 0.46 },
  { z: 1.95, hw: 0.4, top: 0.62, bot: 0.48 },
  { z: 2.3, hw: 0.22, top: 0.55, bot: 0.47 },
  { z: 2.5, hw: 0.07, top: 0.5, bot: 0.46 },
];
const SKULL_P = 2.6; // cross sections are rounded boxes (a superellipse with this exponent)
const SKULL_SIDES = 12;

function secAt(z: number): Sec {
  const first = SKULL[0];
  const last = SKULL[SKULL.length - 1];
  if (z <= first.z) return first;
  if (z >= last.z) return last;
  let i = 0;
  while (i + 2 < SKULL.length && SKULL[i + 1].z < z) i++;
  const a = SKULL[i];
  const b = SKULL[i + 1];
  const t = (z - a.z) / (b.z - a.z);
  return { z, hw: lerp(a.hw, b.hw, t), top: lerp(a.top, b.top, t), bot: lerp(a.bot, b.bot, t) };
}

/** Height of the skull's top (or underside) surface at sideways position x and depth z. */
function skullY(x: number, z: number, upper: boolean): number {
  const s = secAt(z);
  const mid = (s.top + s.bot) / 2;
  const hh = (s.top - s.bot) / 2;
  const u = Math.min(1, Math.abs(x) / Math.max(1e-3, s.hw));
  const f = Math.pow(1 - Math.pow(u, SKULL_P), 1 / SKULL_P);
  return upper ? mid + hh * f : mid - hh * f;
}

function skullRing(s: Sec): THREE.Vector3[] {
  const mid = (s.top + s.bot) / 2;
  const hh = (s.top - s.bot) / 2;
  const e = 2 / SKULL_P;
  const ring: THREE.Vector3[] = [];
  for (let k = 0; k < SKULL_SIDES; k++) {
    const a = (k / SKULL_SIDES) * Math.PI * 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    ring.push(at(s.hw * Math.sign(c) * Math.pow(Math.abs(c), e), mid + hh * Math.sign(sn) * Math.pow(Math.abs(sn), e), s.z));
  }
  return ring;
}

/** The skull as a closed loft through the sections. */
function loftSkull(part: Part): void {
  const rings = SKULL.map(skullRing);
  const mids = SKULL.map((s) => at(0, (s.top + s.bot) / 2, s.z));
  for (let i = 0; i + 1 < rings.length; i++) {
    const m = mids[i].clone().add(mids[i + 1]).multiplyScalar(0.5);
    for (let k = 0; k < SKULL_SIDES; k++) {
      const k2 = (k + 1) % SKULL_SIDES;
      const a = rings[i][k];
      const b = rings[i][k2];
      const c = rings[i + 1][k2];
      const d = rings[i + 1][k];
      const ox = (a.x + b.x + c.x + d.x) / 4 - m.x;
      const oy = (a.y + b.y + c.y + d.y) / 4 - m.y;
      const oz = (a.z + b.z + c.z + d.z) / 4 - m.z;
      tri(part, a, d, c, ox, oy, oz);
      tri(part, a, c, b, ox, oy, oz);
    }
  }
  const last = rings.length - 1;
  for (let k = 0; k < SKULL_SIDES; k++) {
    const k2 = (k + 1) % SKULL_SIDES;
    tri(part, mids[0], rings[0][k2], rings[0][k], 0, 0, -1);
    tri(part, mids[last], rings[last][k], rings[last][k2], 0, 0, 1);
  }
}

// ───────────────────────────── the rest of the shapes ─────────────────────────────

const RIB_Z = [-1.5, -1.05, -0.6, -0.15, 0.3, 0.7]; // six pairs of ribs
const RIB_STEPS = 10;
const RIB_SWING = Math.PI / 2 + 0.35; // how far around the quarter-ellipse a rib goes (a little past vertical: the tip curls in)

/** Half width of the ribcage at depth z: widest in the middle of the cockpit. */
function ribWidth(z: number): number {
  return z >= -0.05 ? 0.95 - 0.28 * (z + 0.05) ** 2 : 0.95 - 0.31 * ((z + 0.05) / 1.5) ** 2;
}

/** The floor plate's outline (x = half width, then mirrored), as a Shape in (x, z). */
function floorShape(): THREE.Shape {
  const profile: [number, number][] = [
    [-1.74, 0.3], [-1.5, 0.5], [-1.1, 0.62], [-0.6, 0.68], [-0.1, 0.69], [0.4, 0.65], [0.8, 0.52], [0.98, 0.4],
  ];
  const right = new THREE.SplineCurve(profile.map(([z, w]) => new THREE.Vector2(w, z))).getPoints(24);
  const left = right.map((p) => new THREE.Vector2(-p.x, p.y)).reverse();
  return new THREE.Shape([...right, ...left]);
}

// ───────────────────────────── the builder ─────────────────────────────

/**
 * Build the skeleton hull. `tintMat` is the boat's paint material (player color, with the hit flash), used for every
 * tinted tip. `color` is the player color (it lights the eyes).
 */
export function buildBoneHull(s: StyleSpec, pattern: PatternId, color: number, tintMat: THREE.Material, mats: MaterialBag): BoneBuild {
  const plan = planFor(pattern);
  const yF = s.deckY; // top of the floor plate
  const keel = yF - 0.3; // the spine's height under the floor: its underside just clears the waterline

  const bone = new Part();
  const shade = new Part();
  const teeth = new Part();
  const tint = new Part();
  const dark = new Part();
  const floor = new Part();
  const eyes = new Part();
  const halo = new Part();

  // ── floor plate: a darker ivory slab on top of the ribs, so it reads as a boat ──
  floor.add(extrude(floorShape(), yF, 0.07, 0.02, 0.02));

  // ── spine: a keel of vertebrae under the floor that rises into the tail at the stern and meets the skull at the bow ──
  const spine = new THREE.CatmullRomCurve3(
    [
      at(0, yF + 0.62, -2.18), at(0, yF + 0.48, -2.1), at(0, yF + 0.24, -2.0), at(0, yF + 0.06, -1.85),
      at(0, keel + 0.1, -1.6), at(0, keel + 0.02, -1.1), at(0, keel, -0.2), at(0, keel + 0.05, 0.5), at(0, keel + 0.28, 0.9),
    ],
    false,
    'centripetal',
  );
  const VERT = 12;
  for (let i = 0; i < VERT; i++) {
    const pa = spine.getPointAt((i + 0.06) / VERT);
    const pm = spine.getPointAt((i + 0.5) / VERT);
    const pb = spine.getPointAt((i + 0.94) / VERT);
    const sc = lerp(0.62, 1, smoothstep(0, 0.28, (i + 0.5) / VERT)); // slimmer toward the tail
    const into = plan.band && i % 2 === 1 ? tint : bone;
    frustum(into, pa, pm, 0.1 * sc, 0.068 * sc);
    frustum(into, pm, pb, 0.068 * sc, 0.1 * sc);
    if (i + 1 < VERT) frustum(shade, pb, spine.getPointAt((i + 1.06) / VERT), 0.062 * sc, 0.062 * sc); // the disc between two vertebrae
  }

  // ── ribs: curved bones from the spine, out and up, forming the hull sides; the tips take the player color ──
  for (const z0 of RIB_Z) {
    const W = ribWidth(z0);
    const H = 0.655 * Math.pow(W / 0.95, 0.6);
    for (const side of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      const radii: number[] = [];
      for (let k = 0; k < RIB_STEPS; k++) {
        const u = k / (RIB_STEPS - 1);
        const th = u * RIB_SWING;
        pts.push(at(side * W * Math.sin(th), keel + H * (1 - Math.cos(th)), z0 - 0.16 * u * u)); // ribs lean back a little
        radii.push(lerp(0.078, 0.032, Math.pow(u, 0.8)));
      }
      tubeTint(bone, tint, pts, radii, plan.rib, 6, 0.09);
      const tipPt = pts[pts.length - 1];
      if (plan.band) tube(tint, pts.slice(3, 5), [radii[3] * 1.2, radii[4] * 1.2], 6, true, 0);
      if (plan.bead) ball(tint, pts[5], 0.078);
      if (plan.tongue) {
        cone(tint, tipPt.clone().add(at(0, 0.02, 0)), tipPt.clone().add(at(-side * 0.05, 0.1, -0.34)), 0.058);
        cone(tint, tipPt.clone().add(at(0, -0.04, 0)), tipPt.clone().add(at(side * 0.04, 0.02, -0.22)), 0.04);
      }
    }
  }

  // ── skull: wide and low, big eyes, a toothy open grin ──
  loftSkull(bone);

  // the jaw: a U of bone hugging the skull, hanging open, with teeth pointing up
  const jawCurve = new THREE.CatmullRomCurve3(
    [
      at(-0.62, 0.3, 0.92), at(-0.66, 0.2, 1.35), at(-0.58, 0.14, 1.8), at(-0.38, 0.11, 2.12), at(0, 0.1, 2.3),
      at(0.38, 0.11, 2.12), at(0.58, 0.14, 1.8), at(0.66, 0.2, 1.35), at(0.62, 0.3, 0.92),
    ],
    false,
    'centripetal',
  );
  const JAW = 28;
  const jaw = jawCurve.getSpacedPoints(JAW);
  const jawR = jaw.map((_, i) => lerp(0.075, 0.062, Math.sin((i / JAW) * Math.PI)));
  if (plan.jaw) {
    const a = 7;
    const b = JAW - 7;
    tube(bone, jaw.slice(0, a + 1), jawR.slice(0, a + 1), 6, true, null);
    tube(tint, jaw.slice(a, b + 1), jawR.slice(a, b + 1).map((r) => r * 1.1), 6, false, null);
    tube(bone, jaw.slice(b), jawR.slice(b), 6, false, 0);
  } else {
    tube(bone, jaw, jawR, 6, true, 0);
  }
  for (const side of [-1, 1]) ball(bone, at(side * 0.62, 0.3, 0.92), 0.095); // the jaw hinge

  for (let i = 3; i <= JAW - 3; i += 2) {
    const p = jaw[i];
    if (p.z < 1.2) continue;
    const dir = at(-p.x * 0.45, 1, 0.12).normalize();
    tooth(teeth, tint, p.clone().add(at(0, 0.04, 0)), dir, 0.14, 0.047, plan.tooth);
  }
  // the upper teeth hang from the roof of the mouth (rim of the palate), bigger toward the front
  for (const z of [1.3, 1.47, 1.64, 1.81, 1.98, 2.15, 2.3]) {
    for (const side of [-1, 1]) {
      const x = side * (secAt(z).hw - 0.07);
      const base = at(x, skullY(x, z, false) + 0.03, z);
      tooth(teeth, tint, base, at(side * 0.1, -1, 0.1).normalize(), 0.16, 0.052, plan.tooth);
    }
  }
  tooth(teeth, tint, at(0, skullY(0, 2.42, false) + 0.02, 2.42), at(0, -1, 0.35).normalize(), 0.15, 0.05, plan.tooth);

  // eyes: a dark socket with an ivory rim and an orb glowing in the player color (plus a soft halo)
  const white = new THREE.Color(0xffffff);
  const eyeColor = new THREE.Color(color).lerp(white, 0.3);
  const eyeMat = mats.basic(eyeColor.getHex(), { toneMapped: false });
  const haloMat = mats.basic(color, { transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false });
  for (const side of [-1, 1]) {
    const x = side * 0.38;
    const z = 1.42;
    const n = at(side * 0.32, 1, 0.12).normalize();
    const c = at(x, skullY(x, z, true), z).addScaledVector(n, -0.02);
    const qUp = new THREE.Quaternion().setFromUnitVectors(UP, n);
    const qFwd = new THREE.Quaternion().setFromUnitVectors(FWD, n);
    dark.add(new THREE.SphereGeometry(0.2, 8, 5), new THREE.Matrix4().compose(c, qUp, at(1, 0.45, 1)));
    shade.add(new THREE.TorusGeometry(0.19, 0.034, 5, 12), new THREE.Matrix4().compose(c.clone().addScaledVector(n, 0.04), qFwd, _unit));
    halo.add(new THREE.SphereGeometry(0.17, 8, 6), xf(c.x + n.x * 0.03, c.y + n.y * 0.03, c.z + n.z * 0.03));
    eyes.add(new THREE.SphereGeometry(0.115, 8, 6), xf(c.x + n.x * 0.06, c.y + n.y * 0.06, c.z + n.z * 0.06));
  }

  // ── dorsal fin: a see-through tent of bones behind the captain (two legs and a leading spar, with rungs) ──
  const fb = yF + 0.02; // the fin's feet rest on the floor
  const lead = [at(0, fb, -1.05), at(0, fb + 0.36, -1.14), at(0, fb + 0.7, -1.32), at(0, fb + 1.0, -1.62)];
  const legL = [at(0.3, fb, -1.5), at(0.22, fb + 0.32, -1.54), at(0.1, fb + 0.66, -1.58), at(0, fb + 1.0, -1.62)];
  const legR = mirror(legL);
  // every spar runs from its foot up to the tip, so the tinted share is the tip end
  tubeTint(bone, tint, lead, [0.065, 0.055, 0.045, 0.035], plan.fin, 6, 0.1);
  tubeTint(bone, tint, legL, [0.05, 0.045, 0.038, 0.03], plan.fin, 6, 0.0);
  tubeTint(bone, tint, legR, [0.05, 0.045, 0.038, 0.03], plan.fin, 6, 0.0);
  for (const h of [fb + 0.36, fb + 0.68]) {
    const pl = pointAtY(lead, h);
    const pa = pointAtY(legL, h);
    const pb = pointAtY(legR, h);
    tube(shade, [pl, pa], [0.028], 5, true, 0);
    tube(shade, [pl, pb], [0.028], 5, true, 0);
    tube(shade, [pa, pb], [0.028], 5, true, 0);
  }
  const fl = at(0, fb, -1.05);
  const fr = at(0.3, fb, -1.5);
  const fs = at(-0.3, fb, -1.5);
  tube(shade, [fl, fr], [0.04], 5, true, 0);
  tube(shade, [fl, fs], [0.04], 5, true, 0);
  tube(shade, [fr, fs], [0.04], 5, true, 0);
  if (plan.tongue) cone(tint, at(0, fb + 1.0, -1.62), at(0, fb + 1.12, -1.98), 0.06);

  // ── tail: a stern bone across the back (the flag mast stands on its right end), the spine rising into a forked fan of bones ──
  tube(bone, [at(-0.52, yF - 0.02, -1.85), at(0.52, yF - 0.02, -1.85)], [0.06], 6, true, 0);
  for (const sx of [-1, 1]) ball(bone, at(sx * 0.52, yF - 0.02, -1.85), 0.075);
  tube(bone, [at(0, yF + 0.05, -1.85), at(0, yF + 0.1, -2.1)], [0.05], 5, true, 0); // bracket holding the motor
  const R = at(0, yF + 0.62, -2.18); // where the fork starts
  ball(bone, R, 0.105);
  if (plan.bead) ball(tint, R.clone().add(at(0, 0.12, -0.04)), 0.07);
  for (const side of [-1, 1]) {
    const tine = [R, at(side * 0.16, yF + 0.82, -2.32), at(side * 0.38, yF + 1.02, -2.47), at(side * 0.56, yF + 1.22, -2.6)];
    tubeTint(bone, tint, tine, [0.07, 0.06, 0.048, 0.036], plan.tail, 6, 0.1);
    tube(bone, [R, at(side * 0.15, yF + 0.74, -2.3), at(side * 0.3, yF + 0.9, -2.46)], [0.045, 0.036, 0.03], 5, true, 0.05);
  }
  tube(bone, [R, at(0, yF + 0.8, -2.42)], [0.04, 0.03], 5, true, 0.05);
  // the notched back edge of the fin ties the tips together
  tube(
    shade,
    [
      at(-0.56, yF + 1.22, -2.6), at(-0.3, yF + 0.9, -2.46), at(0, yF + 0.8, -2.42),
      at(0.3, yF + 0.9, -2.46), at(0.56, yF + 1.22, -2.6),
    ],
    [0.024],
    5,
    true,
    0,
  );

  // ── pectoral fin bones: three thin rays on each side, just above the waterline ──
  for (const side of [-1, 1]) {
    const rays: [number, number, number, number, number][] = [
      // [base z, tip x, tip y, tip z, how much the middle of the ray arches up]
      [0.55, 1.22, 0.15, 0.0, 0.04],
      [0.35, 1.3, 0.13, -0.28, 0.04],
      [0.15, 1.15, 0.11, -0.52, 0.03],
    ];
    for (const [bz, tx, ty, tz, rise] of rays) {
      const a = at(side * 0.5, 0.26, bz);
      const b = at(side * tx, ty, tz);
      const m = a.clone().lerp(b, 0.5).add(at(0, rise, 0));
      tubeTint(bone, tint, [a, m, b], [0.05, 0.036, 0.022], plan.rib, 5, 0.06);
    }
  }

  // ───────── bake the parts into meshes ─────────
  const flashOpts = { emissive: 0xffffff, emissiveIntensity: 0 }; // emissive = hit flash
  const boneMat = mats.std(BONE, flashOpts);
  const shadeMat = mats.std(SHADE, { roughness: 0.8, ...flashOpts });
  const toothMat = mats.std(TOOTH, flashOpts);
  const darkMat = mats.std(SOCKET, { roughness: 0.8 });

  const meshes: THREE.Mesh[] = [];
  const bake = (part: Part, mat: THREE.Material, shadow: boolean, receive = false): void => {
    const m = part.mesh(mat, shadow);
    if (!m) return;
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false; // never moves relative to the boat
    m.updateMatrix();
    meshes.push(m);
  };
  bake(bone, boneMat, true);
  bake(shade, shadeMat, true);
  bake(floor, shadeMat, true, true);
  bake(teeth, toothMat, true);
  bake(tint, tintMat, true);
  bake(dark, darkMat, false);
  bake(eyes, eyeMat, false);
  bake(halo, haloMat, false);

  return { meshes, flash: [boneMat, shadeMat, toothMat], eyeHalo: haloMat };
}
