import * as THREE from 'three';

/**
 * The shark's body, built once and shared by every shark (see sharkRig.ts).
 *
 * Model space: the middle of the body is the origin, the nose points to +Z, the tail to -Z and +Y is up
 * (the same "bow toward +Z" rule as the boats). A shark is about 3.2 m from nose to tail fin; the MEGA
 * SHARK is the same model scaled up and wearing a captain's hat.
 *
 * It is cut into four pieces, so the rig can wag it with plain matrices (nothing is skinned):
 *   front  the head and chest: dorsal fin, side fins, big eyes, blush, gills, top teeth
 *   jaw    the lower jaw (it opens by turning about JAW_Y / JAW_Z)
 *   mid    the middle of the body (turns about HINGE1_Z)
 *   tail   the thin end and the tail fin (turns about HINGE2_Z, a bit more than mid)
 * Each hinge has a little ball that fills the gap when the body bends, so there are no cracks.
 */

export const MEGA_SCALE = 3;
export const NOSE_Z = 1.6;
export const HINGE1_Z = -0.4;
export const HINGE2_Z = -0.95;
export const JAW_Y = -0.22;
export const JAW_Z = 0.78;

export interface SharkGeometries {
  front: THREE.BufferGeometry;
  jaw: THREE.BufferGeometry;
  mid: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
}

interface Paint {
  back: number;
  belly: number;
  fin: number;
}

/** Slate-blue with a white belly; the MEGA SHARK is a goofy purple-grey. */
const NORMAL_PAINT: Paint = { back: 0x5a7da0, belly: 0xf1f7fb, fin: 0x47668a };
const MEGA_PAINT: Paint = { back: 0x7d6e98, belly: 0xece7f3, fin: 0x625377 };

const EYE_WHITE = 0xffffff;
const PUPIL = 0x141c28;
const TEETH = 0xfffbe6;
const MOUTH = 0x8c2e40;
const TONGUE = 0xff8fa3;
const BLUSH = 0xff9db0;
const GILL = 0x364b63;

const TAU = Math.PI * 2;

// ───────────────────────────── The outline ─────────────────────────────

interface Ring {
  z: number;
  rx: number;
  ry: number;
}

/** Cross-sections along the body, nose to tail: a chubby, friendly torpedo with the widest part at the head. */
const RINGS: readonly Ring[] = [
  { z: 1.6, rx: 0, ry: 0 }, // nose tip
  { z: 1.55, rx: 0.15, ry: 0.13 },
  { z: 1.42, rx: 0.33, ry: 0.28 },
  { z: 1.2, rx: 0.49, ry: 0.43 },
  { z: 0.9, rx: 0.58, ry: 0.52 },
  { z: 0.5, rx: 0.61, ry: 0.56 },
  { z: 0.1, rx: 0.58, ry: 0.54 },
  { z: HINGE1_Z, rx: 0.49, ry: 0.47 },
  { z: HINGE2_Z, rx: 0.27, ry: 0.27 },
  { z: -1.12, rx: 0.17, ry: 0.2 },
  { z: -1.2, rx: 0.1, ry: 0.13 },
  { z: -1.23, rx: 0, ry: 0 }, // end cap
];
const FRONT_RINGS = RINGS.slice(0, 8);
const MID_RINGS = RINGS.slice(7, 9);
const TAIL_RINGS = RINGS.slice(8);

/** Body radii at any z, by linear interpolation of RINGS (used to stick teeth, gills and eyes on the skin). */
function radiiAt(z: number): { rx: number; ry: number } {
  for (let i = 0; i + 1 < RINGS.length; i++) {
    const a = RINGS[i];
    const b = RINGS[i + 1];
    if (z <= a.z && z >= b.z) {
      const t = (a.z - z) / (a.z - b.z);
      return { rx: a.rx + (b.rx - a.rx) * t, ry: a.ry + (b.ry - a.ry) * t };
    }
  }
  return { rx: 0.5, ry: 0.5 };
}

// Fin outlines. Dorsal and tail: (z, y) in the part's own space. Side fins: (x, z) for the +X side.
const DORSAL: ReadonlyArray<readonly [number, number]> = [
  [0.42, 0.4],
  [0.36, 0.66],
  [0.24, 0.92],
  [0.06, 1.18],
  [-0.18, 1.4],
  [-0.14, 1.06],
  [-0.22, 0.8],
  [-0.4, 0.58],
  [-0.46, 0.34],
];
/** Tail fin, relative to the tail hinge: a crescent with a longer top lobe. */
const CAUDAL: ReadonlyArray<readonly [number, number]> = [
  [-0.08, 0.07],
  [-0.32, 0.4],
  [-0.64, 0.82],
  [-0.48, 0.28],
  [-0.38, 0.0],
  [-0.46, -0.24],
  [-0.64, -0.48],
  [-0.32, -0.22],
  [-0.08, -0.07],
];
const PECTORAL: ReadonlyArray<readonly [number, number]> = [
  [0.45, 0.7],
  [0.75, 0.48],
  [1.15, -0.12],
  [0.78, 0.0],
  [0.45, 0.18],
];

// ───────────────────────────── Little builders ─────────────────────────────

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** A placement matrix: scale first, then rotate (x, y, z in radians), then move. */
function place(px: number, py: number, pz: number, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(_p.set(px, py, pz), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

type Painter = (x: number, y: number, z: number, out: THREE.Color) => void;
type RingPainter = (sinPhi: number, out: THREE.Color) => void;

/** Collects triangles with vertex colors, then turns them into one flat-shaded BufferGeometry. */
class Parts {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];

  /** Add a copy of `geo` moved by `m`. `paint` is one hex color or a function of each moved vertex. */
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, paint: number | Painter): void {
    const src = geo.index ? geo.toNonIndexed() : geo;
    const p = src.getAttribute('position');
    const flip = m.determinant() < 0; // a mirrored copy turns triangles inside out: swap them back
    for (let i = 0; i + 2 < p.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const j = flip ? i + (k === 0 ? 0 : k === 1 ? 2 : 1) : i + k;
        _p.fromBufferAttribute(p, j).applyMatrix4(m);
        this.pos.push(_p.x, _p.y, _p.z);
        if (typeof paint === 'number') _c.setHex(paint);
        else paint(_p.x, _p.y, _p.z, _c);
        this.col.push(_c.r, _c.g, _c.b);
      }
    }
    if (src !== geo) src.dispose();
  }

  /**
   * A smooth solid swept along Z through elliptical rings (shifted so `zOffset` becomes z = 0). `paint` colors
   * each vertex by the sine of its angle around the ring: +1 is the very top, -1 the very bottom.
   */
  addSpindle(rings: readonly Ring[], zOffset: number, sides: number, paint: RingPainter): void {
    for (let k = 0; k + 1 < rings.length; k++) {
      const a = rings[k];
      const b = rings[k + 1];
      for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * TAU;
        const a1 = ((i + 1) / sides) * TAU;
        const c0 = Math.cos(a0);
        const s0 = Math.sin(a0);
        const c1 = Math.cos(a1);
        const s1 = Math.sin(a1);
        const za = a.z - zOffset;
        const zb = b.z - zOffset;
        this.tri(a.rx * c0, a.ry * s0, za, s0, a.rx * c1, a.ry * s1, za, s1, b.rx * c1, b.ry * s1, zb, s1, paint);
        this.tri(a.rx * c0, a.ry * s0, za, s0, b.rx * c1, b.ry * s1, zb, s1, b.rx * c0, b.ry * s0, zb, s0, paint);
      }
    }
  }

  /** One triangle, wound so it faces away from the Z axis (the spindles are convex). */
  private tri(
    ax: number, ay: number, az: number, sa: number,
    bx: number, by: number, bz: number, sb: number,
    cx: number, cy: number, cz: number, sc: number,
    paint: RingPainter,
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-12) return; // a sliver at a pointy end
    const outward = nx * (ax + bx + cx) + ny * (ay + by + cy) >= 0;
    const order = outward ? [0, 1, 2] : [0, 2, 1];
    const xs = [ax, bx, cx];
    const ys = [ay, by, cy];
    const zs = [az, bz, cz];
    const ss = [sa, sb, sc];
    for (const o of order) {
      this.pos.push(xs[o], ys[o], zs[o]);
      paint(ss[o], _c);
      this.col.push(_c.r, _c.g, _c.b);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals(); // flat shading ignores them, but a plain material would not
    g.computeBoundingSphere();
    return g;
  }
}

/** Slate-blue on top, white underneath, with a soft edge along the sides. */
function bodyPainter(p: Paint): RingPainter {
  return (sinPhi, out) => {
    out.setHex(p.back);
    out.lerp(_c2.setHex(p.belly), smooth(0.05, -0.5, sinPhi));
  };
}

/** A flat fin standing in the YZ plane. Points are (z, y); the result is `thick` thick across X. */
function finGeo(points: ReadonlyArray<readonly [number, number]>, thick: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  points.forEach(([z, y], i) => (i === 0 ? shape.moveTo(-z, y) : shape.lineTo(-z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  g.rotateY(Math.PI / 2); // shape x -> -z, extrusion -> x
  return g;
}

/** A flat fin lying in the XZ plane. Points are (x, z); the result is `thick` thick up and down. */
function plateGeo(points: ReadonlyArray<readonly [number, number]>, thick: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  g.rotateX(-Math.PI / 2); // shape y -> -z, extrusion -> y
  return g;
}

/** A unit sphere without an index, ready to be scaled into eyes, cheeks, balls and so on. */
function plainSphere(w: number, h: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h);
  const flat = g.toNonIndexed();
  g.dispose();
  return flat;
}

// ───────────────────────────── The shark ─────────────────────────────

export function buildSharkGeometries(mega: boolean): SharkGeometries {
  const paint = mega ? MEGA_PAINT : NORMAL_PAINT;
  const body = bodyPainter(paint);
  const sphere = plainSphere(10, 7);
  const ball = plainSphere(12, 8);
  const small = plainSphere(8, 6);
  const tiny = plainSphere(6, 4);
  const tooth = new THREE.ConeGeometry(0.05, 0.13, 4, 1);
  const slit = new THREE.BoxGeometry(1, 1, 1);
  const free: THREE.BufferGeometry[] = [sphere, ball, small, tiny, tooth, slit];

  // ---- front: head and chest ----
  const front = new Parts();
  front.addSpindle(FRONT_RINGS, 0, 12, body);

  const dorsal = finGeo(DORSAL, 0.09);
  free.push(dorsal);
  front.add(dorsal, place(0, 0, 0), paint.fin);

  const pectoral = plateGeo(PECTORAL, 0.07);
  free.push(pectoral);
  for (const side of [1, -1]) {
    front.add(pectoral, place(0, -0.15, 0, side, 1, 1, 0, 0, -0.4 * side), paint.fin);
  }

  // Big, slightly cross-eyed eyes that bulge out of the head: goofy and friendly.
  for (const side of [1, -1]) {
    const ex = 0.4 * side;
    const ey = 0.27;
    const ez = 1.02;
    front.add(sphere, place(ex, ey, ez, 0.21, 0.21, 0.21), EYE_WHITE);
    const nl = Math.hypot(-0.1 * side, 0.28, 0.95);
    const nx = (-0.1 * side) / nl;
    const ny = 0.28 / nl;
    const nz = 0.95 / nl;
    const px = ex + nx * 0.165;
    const py = ey + ny * 0.165;
    const pz = ez + nz * 0.165;
    front.add(small, place(px, py, pz, 0.115, 0.115, 0.115), PUPIL);
    front.add(tiny, place(px + nx * 0.07 + 0.05 * side, py + ny * 0.07 + 0.06, pz + nz * 0.07, 0.04, 0.04, 0.04), EYE_WHITE);
  }

  // Pink cheeks.
  for (const side of [1, -1]) front.add(sphere, place(0.555 * side, -0.04, 0.92, 0.045, 0.085, 0.12), BLUSH);

  // Three gill slits on each side.
  for (const gz of [0.3, 0.2, 0.1]) {
    const gx = radiiAt(gz).rx * 0.985;
    for (const side of [1, -1]) front.add(slit, place(gx * side, -0.02, gz, 0.03, 0.3, 0.035), GILL);
  }

  // The red roof of the mouth, visible when the jaw drops.
  front.add(sphere, place(0, -0.455, 1.08, 0.36, 0.04, 0.45), MOUTH);

  // The grin: a dark gum line along the rim of the head with a row of small, even teeth. The corners curve up.
  const toothZs = [1.42, 1.3, 1.18, 1.06, 0.94];
  const rim = (z: number): { x: number; y: number } => {
    const r = radiiAt(z);
    const y = -0.2 + 0.13 * clamp01((1.5 - z) / 0.75);
    return { x: r.rx * Math.sqrt(Math.max(0, 1 - (y / r.ry) * (y / r.ry))), y };
  };
  const addUpperTooth = (x: number, y: number, z: number): void => {
    front.add(tooth, place(x, y - 0.045, z, 1, 1, 1, Math.PI, Math.PI / 4, 0), TEETH);
    front.add(tiny, place(x, y + 0.03, z, 0.065, 0.045, 0.09), MOUTH);
  };
  addUpperTooth(0, -0.19, 1.49);
  for (const z of toothZs) {
    const r = rim(z);
    addUpperTooth(r.x, r.y, z);
    addUpperTooth(-r.x, r.y, z);
  }

  if (mega) {
    // A little captain's hat, worn at a jaunty angle: white crown, navy band, black peak, gold badge.
    const hat = place(0, 0.47, 0.7, 1, 1, 1, -0.12, 0, 0.16);
    const crown = new THREE.CylinderGeometry(0.255, 0.285, 0.16, 12);
    const band = new THREE.CylinderGeometry(0.28, 0.3, 0.07, 12);
    free.push(crown, band);
    front.add(band, place(0, 0.035, 0).premultiply(hat), 0x1d3557);
    front.add(crown, place(0, 0.15, 0).premultiply(hat), 0xfafaf5);
    front.add(sphere, place(0, 0.02, 0.27, 0.2, 0.025, 0.15).premultiply(hat), 0x151b2b);
    front.add(small, place(0, 0.045, 0.3, 0.05, 0.05, 0.035).premultiply(hat), 0xffc928);
  }

  // ---- jaw (its own space: the origin is the hinge) ----
  const jaw = new Parts();
  const jawCy = -0.06;
  jaw.add(sphere, place(0, jawCy, 0.38, 0.45, 0.15, 0.42), (x, y, z, out) => {
    out.setHex(paint.belly);
    out.lerp(_c2.setHex(MOUTH), smooth(jawCy - 0.04, jawCy + 0.03, y)); // red inside, white outside
  });
  jaw.add(sphere, place(0, 0.08, 0.34, 0.17, 0.05, 0.25), TONGUE);
  for (let i = 0; i < 9; i++) {
    const psi = ((-100 + i * 25) * Math.PI) / 180;
    const tx = 0.335 * Math.sin(psi);
    const tz = 0.38 + 0.313 * Math.cos(psi);
    jaw.add(tooth, place(tx, 0.075, tz, 1, 1, 1, 0, Math.PI / 4, 0), TEETH);
  }

  // ---- mid: the middle of the body (its own space: the origin is hinge 1) ----
  const mid = new Parts();
  const h1 = radiiAt(HINGE1_Z);
  mid.add(ball, place(0, 0, 0, h1.rx, h1.ry, h1.rx), (x, y, z, out) => {
    out.setHex(paint.back);
    out.lerp(_c2.setHex(paint.belly), smooth(0.02, -0.28, y / h1.ry));
  });
  mid.addSpindle(MID_RINGS, HINGE1_Z, 12, body);

  // ---- tail: the thin end and the tail fin (its own space: the origin is hinge 2) ----
  const tail = new Parts();
  const h2 = radiiAt(HINGE2_Z);
  tail.add(ball, place(0, 0, 0, h2.rx, h2.ry, h2.rx), (x, y, z, out) => {
    out.setHex(paint.back);
    out.lerp(_c2.setHex(paint.belly), smooth(0.02, -0.28, y / h2.ry));
  });
  tail.addSpindle(TAIL_RINGS, HINGE2_Z, 12, body);
  const caudal = finGeo(CAUDAL, 0.08);
  free.push(caudal);
  tail.add(caudal, place(0, 0, 0), paint.fin);

  const out: SharkGeometries = { front: front.build(), jaw: jaw.build(), mid: mid.build(), tail: tail.build() };
  for (const g of free) g.dispose();
  return out;
}

/**
 * A faint V of spray that trails the fin, drawn flat on the water: two thin ribbons that fade out toward
 * their far ends. Origin at the shark's waterline point, nose toward +Z.
 */
export function buildSprayGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const v = (x: number, y: number, z: number, alpha: number): void => {
    pos.push(x, y, z);
    col.push(1, 1, 1, alpha);
  };
  for (const side of [1, -1]) {
    const ax = 0;
    const az = 0.62; // just ahead of the fin
    const bx = 0.95 * side;
    const bz = -1.15; // behind it, out to the side
    v(ax, -0.04, az, 0.9);
    v(bx, -0.04, bz, 0);
    v(ax, 0.2, az, 0.9);
    v(ax, 0.2, az, 0.9);
    v(bx, -0.04, bz, 0);
    v(bx, 0.05, bz, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.computeBoundingSphere();
  return g;
}
