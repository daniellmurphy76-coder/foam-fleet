/**
 * Small helpers shared by the world files: a seeded random number generator
 * (so the map is the same every time), a clean-up bag, and a tool that glues
 * many little shapes into one big mesh so the GPU draws them in a single call.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Tiny seeded random generator: same seed, same numbers, every time. Returns 0..1. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collects everything we create so dispose() can release it all. */
export class Bag {
  private items: { dispose(): void }[] = [];
  add<T extends { dispose(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }
  disposeAll(): void {
    for (const it of this.items) it.dispose();
    this.items.length = 0;
  }
}

/** How much a vertex sways in the breeze, from its world position (0 = rock solid, 1 = palm top). */
export type SwayFn = (x: number, y: number, z: number) => number;
/** Picks a triangle's color from its centre (x, y, z) and how much it faces up (ny, -1..1). */
export type ColorFn = (cx: number, cy: number, cz: number, ny: number) => THREE.Color;

interface AddOptions {
  /** Moves/rotates/scales the shape into place. */
  matrix?: THREE.Matrix4;
  /** One flat color... */
  color?: THREE.ColorRepresentation;
  /** ...or a color per triangle (island sand bands, rock tops), from coordinates BEFORE `matrix`. Wins over `color`. */
  colorFn?: ColorFn;
  /** Sway weight per vertex, called with world positions (AFTER `matrix`). */
  sway?: SwayFn;
  /** Gives every palm its own rhythm. */
  swayPhase?: number;
}

/**
 * Collects shapes and merges them into one BufferGeometry with the attributes
 * position, normal, color (vertex color) and aSway (weight, phase).
 * Everything ends up non-indexed, which is what flat shading wants anyway.
 */
export class MeshBuilder {
  private parts: THREE.BufferGeometry[] = [];
  private tmpColor = new THREE.Color();
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();

  /** Adds a COPY of `geometry`; the original is left alone (the caller may dispose it). */
  add(geometry: THREE.BufferGeometry, opts: AddOptions = {}): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    }
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const count = pos.count;

    // 1) Colors, worked out in the shape's own space (before it is moved into place).
    const colors = new Float32Array(count * 3);
    if (opts.colorFn) {
      const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
      for (let i = 0; i < count; i += 3) {
        this.tmpA.fromBufferAttribute(pos, i);
        this.tmpB.fromBufferAttribute(pos, i + 1);
        this.tmpC.fromBufferAttribute(pos, i + 2);
        const cx = (this.tmpA.x + this.tmpB.x + this.tmpC.x) / 3;
        const cy = (this.tmpA.y + this.tmpB.y + this.tmpC.y) / 3;
        const cz = (this.tmpA.z + this.tmpB.z + this.tmpC.z) / 3;
        const ny = (nrm.getY(i) + nrm.getY(i + 1) + nrm.getY(i + 2)) / 3;
        const c = opts.colorFn(cx, cy, cz, ny);
        for (let k = 0; k < 3; k++) {
          colors[(i + k) * 3] = c.r;
          colors[(i + k) * 3 + 1] = c.g;
          colors[(i + k) * 3 + 2] = c.b;
        }
      }
    } else {
      this.tmpColor.set(opts.color ?? 0xffffff);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = this.tmpColor.r;
        colors[i * 3 + 1] = this.tmpColor.g;
        colors[i * 3 + 2] = this.tmpColor.b;
      }
    }

    // 2) Move it into place.
    if (opts.matrix) g.applyMatrix4(opts.matrix);

    // 3) Sway weights, from world meters (the merged mesh sits at the world origin).
    const sway = new Float32Array(count * 2);
    if (opts.sway) {
      for (let i = 0; i < count; i++) {
        sway[i * 2] = opts.sway(pos.getX(i), pos.getY(i), pos.getZ(i));
        sway[i * 2 + 1] = opts.swayPhase ?? 0;
      }
    }

    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aSway', new THREE.BufferAttribute(sway, 2));
    this.parts.push(g);
    return this;
  }

  /** Glue everything together. Returns null if nothing was added. */
  build(): THREE.BufferGeometry | null {
    if (this.parts.length === 0) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return merged;
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

/** Position + Euler rotation (radians) + optional scale -> Matrix4. Reuses one scratch matrix: use the result right away. */
export function placement(
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz)).clone();
}

/** Tips the up axis (0, 1, 0) onto a unit normal. */
export function quatFromUpTo(normal: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromUnitVectors(UP, normal);
}
const UP = new THREE.Vector3(0, 1, 0);

/** The standard "toy" material: matte, flat shaded, takes vertex colors. */
export function toyMaterial(opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.85,
    metalness: 0,
    ...opts,
  });
}

/** Wraps a canvas drawing into a CanvasTexture. Returns null if there is no DOM (e.g. a test). */
export function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}
