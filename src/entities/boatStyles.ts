/**
 * Foam Fleet: the four hull shapes, plus a few "where is the hull wall / deck?" helpers that
 * the paint patterns use to stick decals on in the right place.
 *
 * Hulls 0-2 are toy plastic ('mono' and 'cat'). Hull 3 is the BoneBoat ('bone'): a shark skeleton, built
 * in boneBoat.ts. It has no painted walls, so the decal helpers below never run for it.
 *
 * Local axes: +Z = bow (front), +Y = up, +X = the boat's LEFT. Waterline is y = 0.
 */
import * as THREE from 'three';
import { smoothstep } from './boatGeo';

export interface StyleSpec {
  kind: 'mono' | 'cat' | 'bone';
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
  /** How far the painted wall bulges out past the outline (the bevel size of the hull slab). */
  bulge: number;
  /** Side-to-side center of each hull: 0 for one-piece hulls, the pontoon offset for the catamaran. */
  hullX: number;
  /** The flag mast stands here on the deck (x is negative: the boat's right side, out of the captain's way). */
  mastX: number;
  mastZ: number;
  /** The blaster sits this much higher than the deck (the BoneBoat's skull is taller than a plastic bow). Default 0. */
  turretLift?: number;
}

export const STYLES: readonly StyleSpec[] = [
  // 0: sleek speedboat. Long, pointy bow.
  {
    kind: 'mono', zStern: -2.1, zBow: 2.5, deckY: 0.55, turretZ: 0.95, seatZ: -0.7, windZ: 0.05,
    windW: 1.15, motorZ: -2.45, rimUp: 0.16, stack: false,
    hw: (u) => 0.85 * (0.9 + 0.1 * smoothstep(0, 0.4, u)) * (1 - 0.95 * Math.pow(Math.max(0, (u - 0.5) / 0.5), 1.8)),
    bulge: 0.12, hullX: 0, mastX: -0.5, mastZ: -1.45,
  },
  // 1: chunky tug. Wide, tall, blunt round bow, smokestack.
  {
    kind: 'mono', zStern: -1.9, zBow: 2.1, deckY: 0.7, turretZ: 0.7, seatZ: -0.65, windZ: -0.05,
    windW: 1.7, motorZ: -2.25, rimUp: 0.26, stack: true,
    hw: (u) => 1.15 * (0.94 + 0.06 * smoothstep(0, 0.3, u)) * Math.sqrt(Math.max(0.02, 1 - Math.pow(Math.max(0, (u - 0.62) / 0.38), 2.4))),
    bulge: 0.12, hullX: 0, mastX: -0.7, mastZ: -1.25,
  },
  // 2: catamaran. Two slim pontoons with a deck across them (hw is for ONE pontoon).
  {
    kind: 'cat', zStern: -2.2, zBow: 2.4, deckY: 0.6, turretZ: 0.7, seatZ: -0.75, windZ: 0.0,
    windW: 1.4, motorZ: -2.1, rimUp: 0, stack: false,
    hw: (u) => 0.36 * (u < 0.12 ? 0.8 + (0.2 * u) / 0.12 : 1) * (1 - 0.9 * Math.pow(Math.max(0, (u - 0.55) / 0.45), 1.5)),
    bulge: 0.1, hullX: 0.92, mastX: -0.95, mastZ: -1.5,
  },
  // 3: BoneBoat. A shark skeleton: ribs for hull walls, a spine for a keel, a skull at the bow, a forked tail.
  // deckY is the top of the floor plate. The skull is taller than a plastic bow, so the blaster stands on a short
  // pedestal (turretLift) and its barrel clears the cranium. The flag mast stands on the tail's stern bone.
  // hw is a rough outline only (the decal helpers are never used on this hull); the real rib widths are in boneBoat.ts.
  {
    kind: 'bone', zStern: -2.6, zBow: 2.5, deckY: 0.42, turretZ: 0.5, seatZ: -0.58, windZ: 0.1,
    windW: 0, motorZ: -2.3, rimUp: 0, stack: false, turretLift: 0.12,
    hw: (u) => 0.95 * Math.sin(Math.PI * Math.min(1, 0.1 + 0.85 * u)),
    bulge: 0, hullX: 0, mastX: -0.5, mastZ: -1.85,
  },
];

/** Hull number from a BoatLook (any number is fine: it wraps, junk falls back to the speedboat). */
export function styleFor(hull: number): StyleSpec {
  const n = Number.isFinite(hull) ? Math.trunc(hull) : 0;
  const k = STYLES.length;
  return STYLES[((n % k) + k) % k];
}

/** Outline of a hull seen from above: x = sideways, y = forward (z). `inset` shrinks it. */
export function planPoints(s: StyleSpec, inset = 0, cx = 0, n = 14): THREE.Vector2[] {
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

// ───────────────────────────── where things are (for decals) ─────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Top of the vertical part of the painted wall (above this the edge curves in). */
export function wallTop(s: StyleSpec): number {
  return s.kind === 'cat' ? 0.34 : s.deckY - s.bulge - 0.02;
}

/** Height of the top surface of the deck boards. */
export function deckTop(s: StyleSpec): number {
  return s.kind === 'cat' ? s.deckY : s.deckY + 0.03;
}

/** First and last z of the deck. */
export function deckRange(s: StyleSpec): [number, number] {
  if (s.kind === 'cat') return [-1.65, 1.25];
  return [s.zStern + 0.14, s.zBow - 0.14 * 1.4];
}

/** Half width of the deck at z (0 outside the deck). */
export function deckHalfWidth(s: StyleSpec, z: number): number {
  const [z0, z1] = deckRange(s);
  if (z < z0 || z > z1) return 0;
  if (s.kind === 'cat') return 1.3;
  return Math.max(0.04, s.hw((z - z0) / (z1 - z0)) - 0.14);
}

/** True where the seat, captain, dashboard, blaster base, mast or smokestack stand (decals skip these spots). */
export function keepOut(s: StyleSpec, x: number, z: number): boolean {
  if (Math.abs(x) < 0.52 && z > s.seatZ - 0.5 && z < s.windZ + 0.4) return true;
  if (Math.hypot(x, z - s.turretZ) < 0.72) return true;
  if (Math.hypot(x - s.mastX, z - s.mastZ) < 0.3) return true;
  if (s.stack && Math.hypot(x - 0.65, z - (s.seatZ - 0.9)) < 0.36) return true;
  return false;
}

/**
 * A point on the OUTSIDE of a hull wall, `off` meters proud of the paint.
 * side = +1 (the boat's left) or -1 (right). For the catamaran this is the outer wall of that side's pontoon.
 * Written into `out` as [x, y, z].
 */
export function wallPoint(s: StyleSpec, side: number, z: number, y: number, off: number, out: number[]): void {
  const L = s.zBow - s.zStern;
  const u = clamp01((z - s.zStern) / L);
  const u0 = clamp01(u - 0.01);
  const u1 = clamp01(u + 0.01);
  const hw = Math.max(0.04, s.hw(u));
  const slope = (s.hw(u1) - s.hw(u0)) / Math.max(1e-6, (u1 - u0) * L); // how fast the hull narrows per meter
  // Outward direction on the water plane: sideways, tilted toward the bow where the hull narrows.
  const nl = Math.hypot(1, slope);
  const nx = side / nl;
  const nz = -slope / nl;
  const out0 = s.bulge + off;
  out[0] = s.hullX * side + side * hw + nx * out0;
  out[1] = y;
  out[2] = s.zStern + L * u + nz * out0;
}
