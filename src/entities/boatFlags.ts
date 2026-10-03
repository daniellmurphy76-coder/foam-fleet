/**
 * Foam Fleet: the flag on its little stern mast, and the floating team marker diamond.
 *
 * The flag is a small cloth with a symbol (star, heart, skull, lightning bolt or smiley) on BOTH faces,
 * turned a bit toward the stern so the chase camera sees it. In Team Up the cloth takes the team color.
 */
import * as THREE from 'three';
import type { FlagId } from '../types';
import { luminance, MaterialBag, Part, xf } from './boatGeo';

const NAVY = 0x1f2a56;
const DARK = 0x2b2f3a;

/** The resting angle of the cloth (radians): swept back toward the stern, still facing the camera. */
export const FLAG_YAW = 0.5;
const CLOTH_W = 0.66;
const CLOTH_H = 0.44;
const CLOTH_T = 0.022;
const MAST_H = 1.5;
/** Where the team marker floats above the waterline (meters). */
export const MARKER_HEIGHT = 3.2;

export interface FlagBuild {
  /** Pivot at the top of the mast: the boat flutters it. An empty group when there is no flag. */
  group: THREE.Group;
  hasFlag: boolean;
}

type Kind = 'ink' | 'gold' | 'feat';
interface Piece {
  kind: Kind;
  geo: THREE.BufferGeometry;
}

function polygon(pts: number[][]): THREE.BufferGeometry {
  return new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))));
}

function disc(r: number, x = 0, y = 0, segs = 16): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(r, segs);
  g.translate(x, y, 0);
  return g;
}

function rect(w: number, h: number, x: number, y: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  g.translate(x, y, 0);
  return g;
}

/** A lightning bolt, about 0.36 tall. */
const BOLT = [[0.07, 0.18], [-0.08, -0.01], [0.0, -0.01], [-0.07, -0.18], [0.1, 0.03], [0.02, 0.03]];

function heartPoints(): number[][] {
  const pts: number[][] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 28; i++) {
    const t = (i / 28) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([x, y]);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  const k = 0.31 / (hi - lo); // about 0.31 tall
  const mid = (hi + lo) / 2;
  return pts.map(([x, y]) => [x * k, (y - mid) * k]);
}

/** The flat shapes of a symbol, centered on (0, 0), facing +Z. */
function pieces(flag: FlagId): Piece[] {
  switch (flag) {
    case 'star': {
      const pts: number[][] = [];
      for (let i = 0; i < 10; i++) {
        const a = Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 0.18 : 0.075;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return [{ kind: 'gold', geo: polygon(pts) }];
    }
    case 'heart':
      return [{ kind: 'ink', geo: polygon(heartPoints()) }];
    case 'lightning':
      return [{ kind: 'gold', geo: polygon(BOLT) }];
    case 'smile': {
      const mouth = new THREE.RingGeometry(0.095, 0.125, 14, 1, Math.PI * 1.15, Math.PI * 0.7);
      mouth.translate(0, 0.02, 0);
      return [
        { kind: 'gold', geo: disc(0.18, 0, 0, 20) },
        { kind: 'feat', geo: disc(0.03, -0.065, 0.06, 8) },
        { kind: 'feat', geo: disc(0.03, 0.065, 0.06, 8) },
        { kind: 'feat', geo: mouth },
      ];
    }
    case 'skull':
      return [
        { kind: 'ink', geo: disc(0.14, 0, 0.04, 14) },
        { kind: 'ink', geo: rect(0.15, 0.1, 0, -0.085) },
        { kind: 'feat', geo: disc(0.04, -0.055, 0.04, 8) },
        { kind: 'feat', geo: disc(0.04, 0.055, 0.04, 8) },
        { kind: 'feat', geo: polygon([[0, -0.015], [-0.022, -0.06], [0.022, -0.06]]) },
        { kind: 'feat', geo: rect(0.012, 0.07, -0.035, -0.105) },
        { kind: 'feat', geo: rect(0.012, 0.07, 0.035, -0.105) },
      ];
    default:
      return [];
  }
}

/**
 * Build the flag on a mast at (mastX, deckY, mastZ). The pole itself is added to `mast` (a merged part the
 * caller bakes into the boat); the cloth and symbol go in the returned group. Nothing is built for 'none'.
 */
export function buildFlag(
  flag: FlagId, cloth: number, mastX: number, mastZ: number, deckY: number, mast: Part, mats: MaterialBag,
): FlagBuild {
  const group = new THREE.Group();
  const list = pieces(flag);
  if (list.length === 0) return { group, hasFlag: false };

  mast.add(new THREE.CylinderGeometry(0.025, 0.032, MAST_H, 6), xf(mastX, deckY + MAST_H / 2, mastZ));
  mast.add(new THREE.SphereGeometry(0.05, 6, 4), xf(mastX, deckY + MAST_H + 0.03, mastZ));
  group.position.set(mastX, deckY + MAST_H - 0.26, mastZ);
  group.rotation.y = FLAG_YAW;

  // Cloth: a thin slab hinged on the mast, reaching toward the boat's middle.
  const clothPart = new Part();
  clothPart.add(new THREE.BoxGeometry(CLOTH_W, CLOTH_H, CLOTH_T), xf(CLOTH_W / 2, 0, 0));
  const clothMesh = clothPart.mesh(mats.std(cloth, { side: THREE.DoubleSide }), false);
  if (clothMesh) group.add(clothMesh);

  // Symbol colors: light ink on dark cloth, navy ink on light cloth.
  const dark = luminance(cloth) < 0.6;
  const color: Record<Kind, number> = {
    ink: dark ? 0xffffff : NAVY,
    gold: dark ? 0xffe14a : NAVY,
    feat: dark ? DARK : 0xffffff,
  };
  const parts = new Map<Kind, Part>();
  const cx = CLOTH_W / 2;
  for (const p of list) {
    let part = parts.get(p.kind);
    if (!part) {
      part = new Part();
      parts.set(p.kind, part);
    }
    // Features sit a hair above the symbol they decorate.
    const z = p.kind === 'feat' ? 0.019 : 0.014;
    part.add(p.geo.clone(), xf(cx, 0, z)); // the face that looks toward the bow
    part.add(p.geo, xf(cx, 0, -z, 0, 0, 0, -1, 1, 1)); // the face toward the stern: mirrored so it reads the right way round
  }
  for (const [kind, part] of parts) {
    const layer = kind === 'feat' ? 1 : 0;
    const mat = mats.std(color[kind], {
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 - layer, polygonOffsetUnits: -1 - layer,
    });
    const m = part.mesh(mat, false);
    if (m) group.add(m);
  }
  return { group, hasFlag: true };
}

/** The Team Up diamond: a bright octahedron with a white outline so it reads against sky and water. */
export function buildMarker(color: number, mats: MaterialBag): THREE.Group {
  const g = new THREE.Group();
  g.position.y = MARKER_HEIGHT;
  const geo = new THREE.OctahedronGeometry(0.3, 0);
  geo.scale(1, 1.5, 1);
  const body = new THREE.Mesh(geo, mats.basic(color, { fog: false, toneMapped: false }));
  const rim = new THREE.Mesh(geo, mats.basic(0xffffff, { side: THREE.BackSide, fog: false, toneMapped: false }));
  rim.scale.setScalar(1.25);
  g.add(rim, body);
  return g;
}
