/**
 * Foam Fleet: paint patterns for the Boat Garage (stripes, flames, polka dots, shark teeth).
 *
 * A pattern is a pile of flat "decal" triangles stuck on the outside of the hull walls and on
 * the deck. Every decal color becomes ONE merged mesh. A patterned boat also gets a deck painted
 * in the hull color (the sandy boards would hide the pattern from the chase camera, which looks
 * down at the deck). The plain "solid" paint keeps the sandy deck.
 *
 * Everything is placed with numbers, no randomness, so a boat looks the same every time.
 */
import * as THREE from 'three';
import type { PatternId } from '../types';
import { luminance, MaterialBag, Part } from './boatGeo';
import { deckHalfWidth, deckRange, deckTop, keepOut, wallPoint, wallTop, type StyleSpec } from './boatStyles';

const NAVY = 0x1f2a56; // ink for light paint colors (yellow, turquoise...)
const WHITE = 0xffffff;
const MOUTH = 0x7a1020; // shark mouth
const WALL_OFF = 0.03; // decals float this far off the hull wall (past the white trim stripe, which is 0.02 proud)
const LAYER_STEP = 0.012; // each layer of decals sits a hair higher than the one under it
const DECK_LIFT = 0.02;
const MOUTH_LO = 0.05; // shark mouth band on the hull wall: bottom and top (meters above the waterline)
const MOUTH_HI = 0.3;
const SIDES = [-1, 1] as const;

export interface PaintJob {
  /** True for every pattern except solid: the deck is painted in the hull color. */
  paintDeck: boolean;
  /** Decal parts. The caller bakes each into a mesh with its material. */
  decals: { part: Part; mat: THREE.Material }[];
  /** The decal materials, so the white hit flash covers them too. */
  flash: THREE.MeshStandardMaterial[];
}

interface Ctx {
  s: StyleSpec;
  /** Light paint colors need dark ink and the other way around. */
  dark: boolean;
  /** Start a decal part in a color; higher layers draw on top of lower ones. */
  mk(color: number, layer: number): Part;
}

export function buildPaint(s: StyleSpec, pattern: PatternId, hull: number, mats: MaterialBag): PaintJob {
  const job: PaintJob = { paintDeck: false, decals: [], flash: [] };
  const c: Ctx = {
    s,
    dark: luminance(hull) < 0.6,
    mk(color, layer) {
      const m = mats.std(color, {
        side: THREE.DoubleSide, roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0,
        polygonOffset: true, polygonOffsetFactor: -1 - layer, polygonOffsetUnits: -1 - layer,
      });
      const part = new Part();
      job.decals.push({ part, mat: m });
      job.flash.push(m);
      return part;
    },
  };
  switch (pattern) {
    case 'stripes': stripes(c); break;
    case 'flames': flames(c); break;
    case 'dots': dots(c); break;
    case 'shark': shark(c); break;
    default: return job; // 'solid' (and anything unknown): plain paint, sandy deck
  }
  job.paintDeck = true;
  return job;
}

// ───────────────────────────── decal drawing helpers ─────────────────────────────

const A = [0, 0, 0];
const B = [0, 0, 0];
const C = [0, 0, 0];
const D = [0, 0, 0];

/** `n + 1` values from a to b, at most `step` apart. */
function span(a: number, b: number, step: number): number[] {
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

function quad(part: Part, a: number[], b: number[], c: number[], d: number[]): void {
  part.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  part.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
}

/** A band on the hull wall: at each z the band runs from height lo[i] up to hi[i]. */
function wallStrip(part: Part, s: StyleSpec, side: number, off: number, zs: number[], lo: number[], hi: number[]): void {
  for (let i = 0; i + 1 < zs.length; i++) {
    wallPoint(s, side, zs[i], lo[i], off, A);
    wallPoint(s, side, zs[i], hi[i], off, B);
    wallPoint(s, side, zs[i + 1], hi[i + 1], off, C);
    wallPoint(s, side, zs[i + 1], lo[i + 1], off, D);
    quad(part, A, B, C, D);
  }
}

/** A triangle on the hull wall, corners given as (z, height). */
function wallTri(
  part: Part, s: StyleSpec, side: number, off: number,
  z0: number, y0: number, z1: number, y1: number, z2: number, y2: number,
): void {
  wallPoint(s, side, z0, y0, off, A);
  wallPoint(s, side, z1, y1, off, B);
  wallPoint(s, side, z2, y2, off, C);
  part.tri(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
}

/** A round dot on the hull wall. */
function wallDisc(part: Part, s: StyleSpec, side: number, off: number, zc: number, yc: number, r: number): void {
  const n = 10;
  wallPoint(s, side, zc, yc, off, A);
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    wallPoint(s, side, zc + Math.cos(a0) * r, yc + Math.sin(a0) * r, off, B);
    wallPoint(s, side, zc + Math.cos(a1) * r, yc + Math.sin(a1) * r, off, C);
    part.tri(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
  }
}

/** A band on the deck: at each z[i] it runs from x = xa[i] to x = xb[i]. */
function deckStrip(part: Part, y: number, zs: number[], xa: number[], xb: number[]): void {
  for (let i = 0; i + 1 < zs.length; i++) {
    part.tri(xa[i], y, zs[i], xb[i], y, zs[i], xb[i + 1], y, zs[i + 1]);
    part.tri(xa[i], y, zs[i], xb[i + 1], y, zs[i + 1], xa[i + 1], y, zs[i + 1]);
  }
}

function deckTri(part: Part, y: number, x0: number, z0: number, x1: number, z1: number, x2: number, z2: number): void {
  part.tri(x0, y, z0, x1, y, z1, x2, y, z2);
}

function deckDisc(part: Part, y: number, cx: number, cz: number, r: number): void {
  const n = 10;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    part.tri(cx, y, cz, cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r);
  }
}

const wallOff = (layer: number): number => WALL_OFF + layer * LAYER_STEP;
const deckY = (s: StyleSpec, layer: number): number => deckTop(s) + DECK_LIFT + layer * LAYER_STEP;
const fill = (n: number, v: number): number[] => new Array<number>(n).fill(v);

/**
 * Flame tongues pointing backward (toward the stern), front to back. Each tongue is wide at the front and
 * tapers to a point. `emit` gets the z samples and a 1 -> 0 width profile for each tongue.
 */
function tongues(zFront: number, zBack: number, baseLen: number, emit: (zs: number[], prof: number[]) => void): void {
  const total = zFront - zBack;
  if (total < 0.3) return;
  const n = Math.max(1, Math.round(total / baseLen));
  const len = total / n;
  const K = 6;
  for (let t = 0; t < n; t++) {
    const zs: number[] = [];
    const prof: number[] = [];
    for (let i = 0; i <= K; i++) {
      const p = i / K;
      zs.push(zFront - (t + p) * len);
      prof.push(Math.pow(1 - p, 0.8));
    }
    emit(zs, prof);
  }
}

// ───────────────────────────── the patterns ─────────────────────────────

/** Two racing stripes down the deck (a second pair on the wide catamaran) and a band along each side. */
function stripes(c: Ctx): void {
  const { s } = c;
  const ink = c.mk(c.dark ? WHITE : NAVY, 0);
  const L = s.zBow - s.zStern;

  const zs = span(s.zStern + 0.08 * L, s.zStern + 0.92 * L, 0.14);
  for (const side of SIDES) wallStrip(ink, s, side, WALL_OFF, zs, fill(zs.length, 0.05), fill(zs.length, 0.17));

  const [z0, z1] = deckRange(s);
  const centers = deckHalfWidth(s, s.seatZ) > 1 ? [0.19, 1.0] : [0.19];
  for (const cx of centers) {
    const half = cx > 0.5 ? 0.07 : 0.065;
    const dz: number[] = [];
    for (let z = z0 + 0.1; z <= z1 - 0.1; z += 0.15) {
      if (deckHalfWidth(s, z) < cx + half + 0.06) break; // the bow gets too narrow
      dz.push(z);
    }
    if (dz.length < 2) continue;
    for (const sx of SIDES) {
      deckStrip(ink, deckY(s, 0), dz, fill(dz.length, sx * (cx - half)), fill(dz.length, sx * (cx + half)));
    }
  }
}

/** Flame tongues licking back from the bow along both sides, on the hull wall and along the deck edge. */
function flames(c: Ctx): void {
  const { s } = c;
  // Warm yellow flames on dark paint, red ones on light paint, each with a brighter core.
  const outer = c.mk(c.dark ? 0xffb81a : 0xd62a1f, 0);
  const core = c.mk(c.dark ? 0xfff3a8 : 0xff8f1f, 1);
  const L = s.zBow - s.zStern;

  // hull walls: the flames rise from the waterline
  const H = Math.min(0.34, wallTop(s) - 0.06);
  tongues(s.zStern + 0.93 * L, s.zStern + 0.06 * L, 0.8, (zs, prof) => {
    for (const side of SIDES) {
      const lo = fill(zs.length, 0.04);
      wallStrip(outer, s, side, wallOff(0), zs, lo, prof.map((p) => 0.04 + H * p));
      wallStrip(core, s, side, wallOff(1), zs, lo, prof.map((p) => 0.04 + H * 0.5 * p));
    }
  });

  // deck: tongues hug the edge, starting where the bow is still wide enough
  const [z0, z1] = deckRange(s);
  let zFront = z1;
  while (zFront > z0 && deckHalfWidth(s, zFront) < 0.3) zFront -= 0.05;
  tongues(zFront, z0 + 0.1, 0.8, (zs, prof) => {
    for (const sx of SIDES) {
      const edge = zs.map((z) => deckHalfWidth(s, z) - 0.02);
      const w = prof.map((p, i) => Math.max(0, Math.min(0.26 * p, edge[i] - 0.05)));
      deckStrip(outer, deckY(s, 0), zs, edge.map((e, i) => sx * (e - w[i])), edge.map((e) => sx * e));
      // the bright core sits inside the tongue, clear of the deck edge and the tongue's outline
      deckStrip(core, deckY(s, 1), zs, edge.map((e, i) => sx * (e - 0.75 * w[i])), edge.map((e, i) => sx * (e - 0.2 * w[i])));
    }
  });
}

/** Polka dots: a row along each hull wall and a staggered scatter over the deck. */
function dots(c: Ctx): void {
  const { s } = c;
  const ink = c.mk(c.dark ? WHITE : NAVY, 0);
  const L = s.zBow - s.zStern;

  for (const z of span(s.zStern + 0.14 * L, s.zStern + 0.86 * L, 0.4)) {
    for (const side of SIDES) wallDisc(ink, s, side, WALL_OFF, z, 0.115, 0.07);
  }

  const [z0, z1] = deckRange(s);
  let row = 0;
  for (let z = z0 + 0.3; z <= z1 - 0.2; z += 0.42, row++) {
    const room = deckHalfWidth(s, z) - 0.17;
    for (let k = -4; k <= 3; k++) {
      const x = k * 0.5 + (row % 2 === 1 ? 0.25 : 0);
      if (Math.abs(x) > room || keepOut(s, x, z)) continue;
      deckDisc(ink, deckY(s, 0), x, z, 0.1);
    }
  }
}

/** Shark teeth: a red mouth with interlocking white teeth around the bow, plus teeth along the bow deck edge. */
function shark(c: Ctx): void {
  const { s } = c;
  const mouth = c.mk(MOUTH, 0);
  const teeth = c.mk(WHITE, 1);
  const L = s.zBow - s.zStern;

  // hull wall: top teeth point down, bottom teeth point up, and they interlock
  const za = s.zStern + 0.5 * L;
  const zb = s.zStern + 0.93 * L;
  const zs = span(za, zb, 0.12);
  const nT = Math.max(2, Math.round((zb - za) / 0.26));
  const tw = (zb - za) / nT;
  for (const side of SIDES) {
    wallStrip(mouth, s, side, wallOff(0), zs, fill(zs.length, MOUTH_LO), fill(zs.length, MOUTH_HI));
    for (let i = 0; i < nT; i++) {
      const t0 = za + i * tw;
      const t1 = t0 + tw;
      wallTri(teeth, s, side, wallOff(1), t0, MOUTH_HI, t1, MOUTH_HI, (t0 + t1) / 2, MOUTH_HI - 0.14);
      if (i < nT - 1) {
        wallTri(teeth, s, side, wallOff(1), (t0 + t1) / 2, MOUTH_LO, (t0 + t1) / 2 + tw, MOUTH_LO, t1, MOUTH_LO + 0.12);
      }
    }
  }

  const y0 = deckY(s, 0);
  const y1 = deckY(s, 1);
  const [dz0, dz1] = deckRange(s);
  if (s.kind === 'cat') {
    // the whole front edge of the wide deck is one big grin
    const zf = dz1 - 0.01;
    const half = deckHalfWidth(s, zf) - 0.1;
    deckStrip(mouth, y0, [zf - 0.22, zf], [-half, -half], [half, half]);
    const n = 10;
    const w = (2 * half) / n;
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * w;
      deckTri(teeth, y1, x0, zf, x0 + w, zf, x0 + w / 2, zf - 0.17);
    }
    return;
  }

  // one-piece hulls: a red "gum" band along each bow edge, teeth pointing inward
  let zEnd = dz1;
  while (zEnd > dz0 && deckHalfWidth(s, zEnd) < 0.3) zEnd -= 0.05;
  const zStart = s.turretZ - 0.5;
  if (zEnd - zStart < 0.5) return;
  const dzs = span(zStart, zEnd, 0.12);
  const edge = (z: number): number => deckHalfWidth(s, z) - 0.01;
  const nD = Math.max(2, Math.round((zEnd - zStart) / 0.24));
  const dw = (zEnd - zStart) / nD;
  for (const sx of SIDES) {
    deckStrip(mouth, y0, dzs, dzs.map((z) => sx * Math.max(0.04, edge(z) - 0.2)), dzs.map((z) => sx * edge(z)));
    for (let i = 0; i < nD; i++) {
      const t0 = zStart + i * dw;
      const t1 = t0 + dw;
      const tm = (t0 + t1) / 2;
      deckTri(teeth, y1, sx * edge(t0), t0, sx * edge(t1), t1, sx * (edge(tm) - 0.17), tm);
    }
  }
}
