/**
 * Foam Fleet: small geometry and material helpers shared by the boat model files.
 *
 * `Part` is the trick that keeps boats cheap to draw: lots of little pieces that share a color
 * get baked into ONE mesh. `MaterialBag` remembers every material a boat makes so dispose() can
 * free them all.
 */
import * as THREE from 'three';

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Perceived brightness of a 0xRRGGBB color, 0 (black) .. 1 (white). */
export function luminance(color: number): number {
  const r = ((color >> 16) & 255) / 255;
  const g = ((color >> 8) & 255) / 255;
  const b = (color & 255) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Collects many small geometries (already positioned) and bakes them into ONE flat-shaded mesh. */
export class Part {
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

  /** One triangle from nine numbers, already in boat space (used for painted decals). */
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    this.verts.push(ax, ay, az, bx, by, bz, cx, cy, cz);
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
export function xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

export function roundedRect(w: number, d: number, r: number, cx: number, cz: number): THREE.Shape {
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
export function extrude(shape: THREE.Shape, topY: number, height: number, bevelThickness = 0, bevelSize = 0): THREE.BufferGeometry {
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
export function limb(part: Part, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CapsuleGeometry(radius, Math.max(0.01, len - 2 * radius), 2, 6);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  const mid = a.clone().add(b).multiplyScalar(0.5);
  part.add(g, new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
}

/** Every material one boat makes, so dispose() can free them all. */
export class MaterialBag {
  private readonly list: THREE.Material[] = [];

  /** Flat-shaded toy plastic. */
  std(color: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.55, metalness: 0, ...o });
    this.list.push(m);
    return m;
  }

  /** Unlit color (flames, the team marker). */
  basic(color: number, o: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ color, ...o });
    this.list.push(m);
    return m;
  }

  /** Track a material made elsewhere. */
  track<T extends THREE.Material>(m: T): T {
    this.list.push(m);
    return m;
  }

  dispose(): void {
    for (const m of this.list) m.dispose();
    this.list.length = 0;
  }
}
