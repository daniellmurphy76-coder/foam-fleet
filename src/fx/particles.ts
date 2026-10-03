import * as THREE from 'three';
import type { WorldQuery } from '../types';

/**
 * The two GPU "layers" that all of Foam Fleet's particle effects are drawn with.
 *
 *  - BillboardLayer: camera-facing quads (water droplets, confetti, stars, sparkles, rings).
 *  - FoamLayer: flat quads lying on the water surface (wake foam, ripples).
 *
 * Each layer is exactly ONE draw call, no matter how many particles are alive.
 * Particles live in plain Float32Arrays (not objects), so the per-frame loop never
 * allocates. When a particle dies we copy the LAST particle into its slot ("swap-remove"),
 * which keeps the live ones packed at the front so the GPU only draws `count` instances.
 *
 * Both layers build their quads in the vertex shader, so they look right from any camera
 * and any viewport (split screen included), with no dependence on gl_PointSize limits.
 */

const TAU = Math.PI * 2;
/** Seconds a droplet takes to melt away once it touches the water. */
const SETTLE_FADE = 0.14;
/** Foam floats this far above the wave so it never z-fights with the water. */
const FOAM_LIFT = 0.07;
/** Billboards are nudged this many meters toward the camera so they never get buried in a hull or the sea. */
const CAMERA_BIAS = 0.35;

// ───────────────────────────── Billboard particle kinds ─────────────────────────────

/** Kinds of billboard particle. Each one has a row in KINDS below. */
export const P = {
  DROPLET: 0, // water drop that arcs and falls
  SPRAY: 1, // smaller, cheaper drop from boat wakes
  PUFF: 2, // soft white cloud
  CONFETTI: 3, // spinning foam rectangle
  BIT: 4, // round foam confetti
  STAR: 5, // five-point star
  RING: 6, // expanding ring
  SPARKLE: 7, // four-point twinkle
  GLINT: 8, // tiny twinkling dot
  FLASH: 9, // bright soft pop at the moment of a hit
  MIST: 10, // faint soft cloud off a fast boat (low priority)
  NOTE: 11, // cartoon music note (one head with a flag), floats up
  NOTE2: 12, // cartoon music notes (two heads joined by a beam), floats up
} as const;

/** Kinds of flat foam on the water. */
export const F = {
  BLOB: 0,
  RIPPLE: 1,
  WAKE: 2, // soft streak left behind a moving boat (stretched along its own axis)
} as const;

/** Wake streaks are drawn this many times longer than they are wide. */
const WAKE_STRETCH = 3.0;

// Shape ids: these numbers are matched in the fragment shader.
const SHAPE_DISC = 0;
const SHAPE_STAR = 1;
const SHAPE_SPARKLE = 2;
const SHAPE_RING = 3;
const SHAPE_RECT = 4;
const SHAPE_SOFT = 5;
const SHAPE_FLASH = 6; // like SOFT, but drawn in front of whatever it overlaps
const SHAPE_NOTE = 7; // music note with a dark outline
const SHAPE_NOTE2 = 8; // beamed pair of music notes with a dark outline

// How a particle's size changes over its life.
const SIZE_LERP = 0; // ease from size0 to size1
const SIZE_POP = 1; // pop up with a little overshoot, then shrink to nothing (size0 = peak)
const SIZE_TWINKLE = 2; // grow then shrink with a flicker (size0 = peak)
const SIZE_HOLD = 3; // pop up with a little overshoot, then stay that size (size0); alpha does the fading

interface KindDef {
  shape: number;
  sizeMode: number;
  /** Meters per second squared, positive = falls, negative = floats up. */
  gravity: number;
  /** Air drag: fraction of velocity lost per second. */
  drag: number;
  /** Max spin in radians per second (random sign). */
  spin: number;
  /** Fraction of the life spent fading out at the end (1 = fade the whole time). */
  fade: number;
  /** Stop and fade when it touches the water. */
  water: boolean;
  /** Skipped when the pool is nearly full, so wake spray can never crowd out hit bursts. */
  soft: boolean;
}

const KINDS: KindDef[] = [
  /* DROPLET  */ { shape: SHAPE_DISC, sizeMode: SIZE_LERP, gravity: 9.8, drag: 0.1, spin: 0, fade: 0.3, water: true, soft: false },
  /* SPRAY    */ { shape: SHAPE_DISC, sizeMode: SIZE_LERP, gravity: 9.5, drag: 0.4, spin: 0, fade: 0.4, water: true, soft: true },
  /* PUFF     */ { shape: SHAPE_SOFT, sizeMode: SIZE_LERP, gravity: 0.4, drag: 3.0, spin: 0, fade: 0.7, water: false, soft: false },
  /* CONFETTI */ { shape: SHAPE_RECT, sizeMode: SIZE_POP, gravity: 7.0, drag: 2.2, spin: 14, fade: 0.35, water: false, soft: false },
  /* BIT      */ { shape: SHAPE_DISC, sizeMode: SIZE_POP, gravity: 7.0, drag: 2.2, spin: 0, fade: 0.35, water: false, soft: false },
  /* STAR     */ { shape: SHAPE_STAR, sizeMode: SIZE_POP, gravity: 3.0, drag: 3.2, spin: 9, fade: 0.3, water: false, soft: false },
  /* RING     */ { shape: SHAPE_RING, sizeMode: SIZE_LERP, gravity: 0, drag: 0, spin: 0, fade: 1.0, water: false, soft: false },
  /* SPARKLE  */ { shape: SHAPE_SPARKLE, sizeMode: SIZE_TWINKLE, gravity: -1.4, drag: 1.6, spin: 3, fade: 0.4, water: false, soft: false },
  /* GLINT    */ { shape: SHAPE_DISC, sizeMode: SIZE_TWINKLE, gravity: -1.4, drag: 1.6, spin: 0, fade: 0.4, water: false, soft: false },
  /* FLASH    */ { shape: SHAPE_FLASH, sizeMode: SIZE_LERP, gravity: 0, drag: 0, spin: 0, fade: 1.0, water: false, soft: false },
  /* MIST     */ { shape: SHAPE_SOFT, sizeMode: SIZE_LERP, gravity: 0.4, drag: 3.0, spin: 0, fade: 0.7, water: false, soft: true },
  /* NOTE     */ { shape: SHAPE_NOTE, sizeMode: SIZE_HOLD, gravity: -2.2, drag: 1.4, spin: 0.35, fade: 0.4, water: false, soft: false },
  /* NOTE2    */ { shape: SHAPE_NOTE2, sizeMode: SIZE_HOLD, gravity: -2.2, drag: 1.4, spin: 0.35, fade: 0.4, water: false, soft: false },
];

// Layout of one particle inside the `sim` Float32Array.
const X = 0, Y = 1, Z = 2;
const VX = 3, VY = 4, VZ = 5;
const AGE = 6, LIFE = 7;
const S0 = 8, S1 = 9;
const SPIN = 10, ROT = 11;
const KIND = 12, GRAV = 13, DRAG = 14;
/** > 0 once the particle has touched the water: seconds left of its quick fade. */
const DIE = 15;
const STRIDE = 16;

// ───────────────────────────── Shared GPU helpers ─────────────────────────────

/** A unit quad as an instanced geometry. `corners` are x,y pairs. */
function makeQuad(corners: number[]): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos: number[] = [];
  for (let i = 0; i < corners.length; i += 2) pos.push(corners[i], corners[i + 1], 0);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = 0;
  return g;
}

function dynamicAttr(capacity: number, itemSize: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

/** Send only the first `count` instances to the GPU. */
function upload(attr: THREE.InstancedBufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

/** easeOutBack-style pop: 0 -> slightly over 1 -> back to 1, then shrinks to 0 at the end of life. */
function pop(u: number): number {
  if (u < 0.15) {
    const x = u / 0.15 - 1;
    return 1 + 2.70158 * x * x * x + 1.70158 * x * x;
  }
  const k = (u - 0.15) / 0.85;
  return 1 - k * k;
}

// ───────────────────────────── Billboard layer ─────────────────────────────

const BILLBOARD_VERT = /* glsl */ `
attribute vec3 aOffset;     // particle center, world space
attribute vec4 aColor;      // rgb (linear) + alpha
attribute vec2 aSizeRot;    // diameter in meters, spin angle
attribute float aShape;
uniform float uBias;
varying vec2 vCorner;
varying vec4 vColor;
varying float vShape;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(aOffset, 1.0);
  float c = cos(aSizeRot.y);
  float s = sin(aSizeRot.y);
  vec2 q = position.xy;
  vec2 r = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  mvPosition.xy += r * aSizeRot.x * 0.5;   // build the quad in view space = always faces the camera
  // Nudge toward the camera so particles are never buried in a hull or the sea.
  // Flashes and rings (shapes 3 and 6) get a big nudge so they show in full even when centred on a hull.
  mvPosition.z += ((aShape > 5.5 && aShape < 6.5) || (aShape > 2.5 && aShape < 3.5)) ? uBias * 4.5 : uBias;
  vCorner = q;
  vColor = aColor;
  vShape = aShape;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BILLBOARD_FRAG = /* glsl */ `
varying vec2 vCorner;
varying vec4 vColor;
varying float vShape;
#include <fog_pars_fragment>

// Chunky five-point star with one arm pointing up (a signed-distance star: negative inside).
float starShape(vec2 p) {
  const float an = 0.628319;                   // pi / 5: half the angle of one arm
  const float en = 0.923998;                   // pi / 3.4: how pointy the arms are
  vec2 acs = vec2(cos(an), sin(an));
  vec2 ecs = vec2(cos(en), sin(en));
  p.x = abs(p.x);
  float bn = mod(atan(p.x, p.y + 1e-5), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= 0.92 * acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, 0.92 * acs.y / ecs.y);
  float sd = length(p) * sign(p.x);
  return 1.0 - smoothstep(-0.03, 0.05, sd);
}

// Capsule: distance to the segment a-b, minus its radius.
float sdSeg(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Oval tilted counter-clockwise by ang (a note head). The distance is an approximation, plenty for soft edges.
float sdHead(vec2 p, vec2 c, vec2 rad, float ang) {
  vec2 q = p - c;
  float cs = cos(ang);
  float sn = sin(ang);
  q = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  float k0 = length(q / rad);
  float k1 = length(q / (rad * rad));
  return k0 * (k0 - 1.0) / max(k1, 1e-4);
}

// A music note (one head and a flag) or a pair of heads joined by a beam. Negative inside.
float noteShape(vec2 p, bool pair) {
  float sd;
  if (pair) {
    sd = sdHead(p, vec2(-0.52, -0.58), vec2(0.30, 0.22), 0.5);
    sd = min(sd, sdHead(p, vec2(0.20, -0.38), vec2(0.30, 0.22), 0.5));
    sd = min(sd, sdSeg(p, vec2(-0.25, -0.50), vec2(-0.25, 0.56), 0.065));
    sd = min(sd, sdSeg(p, vec2(0.47, -0.30), vec2(0.47, 0.72), 0.065));
    sd = min(sd, sdSeg(p, vec2(-0.25, 0.56), vec2(0.47, 0.72), 0.09));
  } else {
    sd = sdHead(p, vec2(-0.22, -0.52), vec2(0.34, 0.25), 0.5);
    sd = min(sd, sdSeg(p, vec2(0.08, -0.45), vec2(0.08, 0.72), 0.065));
    sd = min(sd, sdSeg(p, vec2(0.08, 0.72), vec2(0.50, 0.40), 0.09));
    sd = min(sd, sdSeg(p, vec2(0.50, 0.40), vec2(0.42, 0.02), 0.08));
  }
  return sd;
}

void main() {
  vec2 p = vCorner;
  float d = length(p);
  float a;
  vec3 rgb = vColor.rgb;
  if (vShape < 0.5) {            // crisp disc (droplets, foam bits)
    a = 1.0 - smoothstep(0.76, 1.0, d);
  } else if (vShape < 1.5) {     // star
    a = starShape(p);
  } else if (vShape < 2.5) {     // four-point twinkle with a bright core
    float s = sqrt(abs(p.x)) + sqrt(abs(p.y));
    a = max(1.0 - smoothstep(0.75, 1.0, s), 1.0 - smoothstep(0.18, 0.32, d));
  } else if (vShape < 3.5) {     // ring
    a = 1.0 - smoothstep(0.04, 0.11, abs(d - 0.8));
  } else if (vShape < 4.5) {     // rounded rectangle (confetti)
    vec2 q = abs(p) - vec2(0.62, 0.34);
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.12;
    a = 1.0 - smoothstep(-0.04, 0.04, sd);
  } else if (vShape < 6.5) {     // soft puff / flash
    a = 1.0 - smoothstep(0.35, 1.0, d);
  } else {                       // music note: the particle's color with a dark outline so it reads on sky and sea
    float sd = noteShape(p, vShape > 7.5);
    a = 1.0 - smoothstep(0.06, 0.11, sd);
    rgb = mix(vec3(0.01, 0.02, 0.07), rgb, 1.0 - smoothstep(-0.03, 0.03, sd));
  }
  a *= vColor.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(rgb, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Pooled camera-facing particles: one draw call. */
export class BillboardLayer {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;
  /** Soft kinds (wake spray) stop spawning above this many live particles. */
  private readonly softCap: number;
  private count = 0;

  private readonly sim: Float32Array;
  private readonly aOffset: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aSizeRot: THREE.InstancedBufferAttribute;
  private readonly aShape: THREE.InstancedBufferAttribute;
  private readonly offsetArr: Float32Array;
  private readonly colorArr: Float32Array;
  private readonly sizeRotArr: Float32Array;
  private readonly shapeArr: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.softCap = Math.floor(capacity * 0.75);
    this.sim = new Float32Array(capacity * STRIDE);

    this.geometry = makeQuad([-1, -1, 1, -1, 1, 1, -1, 1]);
    this.aOffset = dynamicAttr(capacity, 3);
    this.aColor = dynamicAttr(capacity, 4);
    this.aSizeRot = dynamicAttr(capacity, 2);
    this.aShape = dynamicAttr(capacity, 1);
    this.offsetArr = this.aOffset.array as Float32Array;
    this.colorArr = this.aColor.array as Float32Array;
    this.sizeRotArr = this.aSizeRot.array as Float32Array;
    this.shapeArr = this.aShape.array as Float32Array;
    this.geometry.setAttribute('aOffset', this.aOffset);
    this.geometry.setAttribute('aColor', this.aColor);
    this.geometry.setAttribute('aSizeRot', this.aSizeRot);
    this.geometry.setAttribute('aShape', this.aShape);

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uBias: { value: CAMERA_BIAS } }]),
      vertexShader: BILLBOARD_VERT,
      fragmentShader: BILLBOARD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: false, // keep foam bright white instead of letting the filmic curve grey it
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'fx-billboards';
    this.mesh.frustumCulled = false; // instances are spread all over the arena
    this.mesh.renderOrder = 14; // after the (possibly transparent) water
    this.mesh.visible = false;
  }

  get alive(): number {
    return this.count;
  }

  /**
   * Spawn one particle. Position/velocity in world space, sizes are diameters in meters.
   * `rot` is the starting spin angle (random when omitted; music notes pass a small tilt so they stay upright).
   * Returns quietly when the pool is full (a missing droplet is never worth a crash).
   */
  emit(
    kind: number,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number,
    color: THREE.Color,
    rot?: number,
  ): void {
    const kd = KINDS[kind];
    if (this.count >= (kd.soft ? this.softCap : this.capacity)) return;
    const i = this.count++;
    const s = this.sim;
    const o = i * STRIDE;
    s[o + X] = x; s[o + Y] = y; s[o + Z] = z;
    s[o + VX] = vx; s[o + VY] = vy; s[o + VZ] = vz;
    s[o + AGE] = 0; s[o + LIFE] = life;
    s[o + S0] = size0; s[o + S1] = size1;
    s[o + SPIN] = (Math.random() * 2 - 1) * kd.spin;
    s[o + ROT] = rot ?? Math.random() * TAU;
    s[o + KIND] = kind;
    s[o + GRAV] = kd.gravity;
    s[o + DRAG] = kd.drag;
    s[o + DIE] = 0;
    const c = i * 4;
    this.colorArr[c] = color.r; this.colorArr[c + 1] = color.g; this.colorArr[c + 2] = color.b;
    this.shapeArr[i] = kd.shape;
  }

  update(dt: number, t: number, world: WorldQuery): void {
    const s = this.sim;
    const off = this.offsetArr, col = this.colorArr, sr = this.sizeRotArr;

    let i = 0;
    while (i < this.count) {
      const o = i * STRIDE;
      const kd = KINDS[s[o + KIND] | 0];
      const life = s[o + LIFE];
      let age = s[o + AGE];
      let alphaMul = 1;

      const die = s[o + DIE];
      if (die > 0) {
        // Touched the water: frozen in place, melting away.
        const left = die - dt;
        if (left <= 0) { this.removeAt(i); continue; }
        s[o + DIE] = left;
        alphaMul = left / SETTLE_FADE;
      } else {
        age += dt;
        if (age >= life) { this.removeAt(i); continue; }
        s[o + AGE] = age;
      }

      // Motion: drag, gravity, then move.
      const drag = s[o + DRAG];
      const damp = drag > 0 ? Math.max(0, 1 - drag * dt) : 1;
      let vx = s[o + VX] * damp;
      let vy = s[o + VY] * damp - s[o + GRAV] * dt;
      let vz = s[o + VZ] * damp;
      let x = s[o + X] + vx * dt;
      let y = s[o + Y] + vy * dt;
      let z = s[o + Z] + vz * dt;

      if (kd.water && vy < 0 && die <= 0) {
        const wy = world.waveHeight(x, z, t);
        if (y <= wy) {
          y = wy;
          vx = 0; vy = 0; vz = 0;
          s[o + GRAV] = 0;
          s[o + DRAG] = 0;
          s[o + DIE] = SETTLE_FADE;
        }
      }
      s[o + X] = x; s[o + Y] = y; s[o + Z] = z;
      s[o + VX] = vx; s[o + VY] = vy; s[o + VZ] = vz;
      const rot = s[o + ROT] + s[o + SPIN] * dt;
      s[o + ROT] = rot;

      // Look: size and alpha follow the particle's life (u runs 0 -> 1).
      const u = Math.min(1, age / life);
      let size: number;
      if (kd.sizeMode === SIZE_LERP) {
        const e = 1 - (1 - u) * (1 - u); // ease-out
        size = s[o + S0] + (s[o + S1] - s[o + S0]) * e;
      } else if (kd.sizeMode === SIZE_POP) {
        size = s[o + S0] * pop(u);
      } else if (kd.sizeMode === SIZE_HOLD) {
        size = s[o + S0] * pop(u < 0.15 ? u : 0.15); // pop(0.15) = 1: full size from then on
      } else {
        size = s[o + S0] * Math.sin(Math.PI * u) * (0.8 + 0.2 * Math.sin(age * 30 + rot * 5));
      }
      let a = (1 - u) / kd.fade;
      if (a > 1) a = 1;
      a *= alphaMul;

      const p3 = i * 3;
      off[p3] = x; off[p3 + 1] = y; off[p3 + 2] = z;
      col[i * 4 + 3] = a < 0 ? 0 : a;
      sr[i * 2] = size < 0 ? 0 : size;
      sr[i * 2 + 1] = rot;
      i++;
    }

    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      upload(this.aOffset, this.count);
      upload(this.aColor, this.count);
      upload(this.aSizeRot, this.count);
      upload(this.aShape, this.count);
    }
  }

  /** Move the last live particle into slot i (its look is rewritten later in the same update). */
  private removeAt(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.sim.copyWithin(i * STRIDE, last * STRIDE, last * STRIDE + STRIDE);
    const c = this.colorArr;
    c[i * 4] = c[last * 4];
    c[i * 4 + 1] = c[last * 4 + 1];
    c[i * 4 + 2] = c[last * 4 + 2];
    this.shapeArr[i] = this.shapeArr[last];
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.clear();
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ───────────────────────────── Foam layer (flat on the water) ─────────────────────────────

const FOAM_VERT = /* glsl */ `
attribute vec3 aOffset;     // center, world space (y follows the waves)
attribute vec4 aParams;     // diameter, rotation, alpha, kind
varying vec2 vP;
varying vec3 vInfo;         // alpha, kind, seed
#include <fog_pars_vertex>
void main() {
  float c = cos(aParams.y);
  float s = sin(aParams.y);
  vec2 q = position.xy;
  // Wake streaks (kind 2) are stretched along their own x axis; blobs and ripples stay round.
  vec2 sq = vec2(q.x * (aParams.w > 1.5 ? ${WAKE_STRETCH.toFixed(1)} : 1.0), q.y);
  vec2 r = vec2(c * sq.x - s * sq.y, s * sq.x + c * sq.y) * aParams.x * 0.5;
  vec4 mvPosition = modelViewMatrix * vec4(aOffset.x + r.x, aOffset.y, aOffset.z + r.y, 1.0);
  vP = q;
  vInfo = vec3(aParams.z, aParams.w, aParams.y);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FOAM_FRAG = /* glsl */ `
varying vec2 vP;
varying vec3 vInfo;
#include <fog_pars_fragment>
void main() {
  float d = length(vP);
  float ang = atan(vP.y, vP.x + 1e-5);
  float seed = vInfo.z * 3.0;
  // Slightly lumpy edge so every blob has its own outline.
  float wob = 1.0 + 0.05 * sin(ang * 3.0 + seed) + 0.03 * sin(ang * 5.0 - seed * 1.7);
  float rr = d / wob;
  float a;
  vec3 col;
  if (vInfo.y < 0.5) {            // foam blob
    a = 1.0 - smoothstep(0.6, 0.98, rr);
    col = mix(vec3(0.80, 0.94, 1.0), vec3(1.0), 1.0 - smoothstep(0.45, 0.95, rr));
  } else if (vInfo.y < 1.5) {     // ripple ring
    a = 1.0 - smoothstep(0.05, 0.14, abs(rr - 0.82));
    col = vec3(1.0);
  } else {                        // wake streak: soft right out to the edge so overlapping streaks melt into one trail
    a = 1.0 - smoothstep(0.2, 1.0, d);
    col = mix(vec3(0.86, 0.96, 1.0), vec3(1.0), 1.0 - smoothstep(0.2, 0.8, d));
  }
  a *= vInfo.x;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// Layout of one foam patch inside its `sim` array.
const FX = 0, FZ = 1, FVX = 2, FVZ = 3, FAGE = 4, FLIFE = 5, FS0 = 6, FS1 = 7, FROT = 8, FKIND = 9, FA0 = 10, FDRAG = 11, FFADE = 12;
const FSTRIDE = 13;

/** Pooled flat foam patches that sit on the water and follow the waves: one draw call. */
export class FoamLayer {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;
  /** Boat-wake streaks stop spawning above this many live ones, so a crowd of boats can't carpet the water. */
  private readonly wakeCap: number;
  private count = 0;
  private wakeCount = 0;
  private readonly sim: Float32Array;
  private readonly aOffset: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;
  private readonly offsetArr: Float32Array;
  private readonly paramsArr: Float32Array;

  constructor(capacity: number, wakeCap: number = Math.floor(capacity * 0.5)) {
    this.capacity = capacity;
    this.wakeCap = wakeCap;
    this.sim = new Float32Array(capacity * FSTRIDE);
    this.geometry = makeQuad([-1, -1, 1, -1, 1, 1, -1, 1]);
    this.aOffset = dynamicAttr(capacity, 3);
    this.aParams = dynamicAttr(capacity, 4);
    this.offsetArr = this.aOffset.array as Float32Array;
    this.paramsArr = this.aParams.array as Float32Array;
    this.geometry.setAttribute('aOffset', this.aOffset);
    this.geometry.setAttribute('aParams', this.aParams);

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: FOAM_VERT,
      fragmentShader: FOAM_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'fx-foam';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12; // drawn after the water, before the billboards
    this.mesh.visible = false;
  }

  get alive(): number {
    return this.count;
  }

  /** How many boat-wake streaks are alive right now (the wake emitter thins itself out as this nears the cap). */
  get wakeAlive(): number {
    return this.wakeCount;
  }

  /**
   * Spawn a flat patch. Sizes are diameters in meters. `fade` is the fraction of the life
   * spent fading out at the end (0.75 = holds for a quarter of its life, then fades).
   * `rot` is the patch's angle on the water (it matters for stretched wake streaks); it is random when omitted.
   */
  emit(
    kind: number,
    x: number, z: number, vx: number, vz: number,
    life: number, size0: number, size1: number,
    alpha: number, fade: number, drag: number,
    rot?: number,
  ): void {
    if (this.count >= this.capacity) return;
    if (kind === F.WAKE) {
      if (this.wakeCount >= this.wakeCap) return;
      this.wakeCount++;
    }
    const o = this.count++ * FSTRIDE;
    const s = this.sim;
    s[o + FX] = x; s[o + FZ] = z; s[o + FVX] = vx; s[o + FVZ] = vz;
    s[o + FAGE] = 0; s[o + FLIFE] = life;
    s[o + FS0] = size0; s[o + FS1] = size1;
    s[o + FROT] = rot ?? Math.random() * TAU;
    s[o + FKIND] = kind;
    s[o + FA0] = alpha; s[o + FDRAG] = drag; s[o + FFADE] = fade;
  }

  update(dt: number, t: number, world: WorldQuery): void {
    const s = this.sim;
    const off = this.offsetArr, par = this.paramsArr;

    let i = 0;
    while (i < this.count) {
      const o = i * FSTRIDE;
      const age = s[o + FAGE] + dt;
      const life = s[o + FLIFE];
      if (age >= life) {
        // swap-remove
        if (s[o + FKIND] === F.WAKE) this.wakeCount--;
        const last = --this.count;
        if (i !== last) s.copyWithin(o, last * FSTRIDE, last * FSTRIDE + FSTRIDE);
        continue;
      }
      s[o + FAGE] = age;

      const damp = Math.max(0, 1 - s[o + FDRAG] * dt);
      const vx = s[o + FVX] * damp;
      const vz = s[o + FVZ] * damp;
      const x = s[o + FX] + vx * dt;
      const z = s[o + FZ] + vz * dt;
      s[o + FVX] = vx; s[o + FVZ] = vz; s[o + FX] = x; s[o + FZ] = z;

      const u = age / life;
      const e = 1 - (1 - u) * (1 - u);
      const size = s[o + FS0] + (s[o + FS1] - s[o + FS0]) * e;
      let a = (1 - u) / s[o + FFADE];
      if (a > 1) a = 1;
      a *= s[o + FA0];

      const p3 = i * 3, p4 = i * 4;
      off[p3] = x;
      off[p3 + 1] = world.waveHeight(x, z, t) + FOAM_LIFT; // ride the waves
      off[p3 + 2] = z;
      par[p4] = size;
      par[p4 + 1] = s[o + FROT];
      par[p4 + 2] = a;
      par[p4 + 3] = s[o + FKIND];
      i++;
    }

    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      upload(this.aOffset, this.count);
      upload(this.aParams, this.count);
    }
  }

  clear(): void {
    this.count = 0;
    this.wakeCount = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.clear();
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
