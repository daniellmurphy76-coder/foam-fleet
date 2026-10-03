/**
 * The ocean waves: ONE table, used by both the CPU (boats, darts, particles
 * ask "how high is the water here?") and the GPU (the water shader draws it).
 *
 * Because the shader source is generated from the very same numbers, a boat
 * always sits exactly on the surface you can see. If you change a wave below,
 * both sides change together.
 *
 * Each wave is a simple sine ripple moving in one direction:
 *     height = amp * sin(k * (dir . position) - w * time + phase)
 * Four of them added together look like a gentle, rolling sea.
 */
import type * as THREE from 'three';

const GRAVITY = 9.81;
/** Slows every wave down a little so the lagoon feels calm and sunny. */
const CALMNESS = 0.8;

/** angle: travel direction in radians from +X toward +Z. length: crest to crest in meters. */
const WAVE_SPECS = [
  { angle: 0.3, length: 38, amp: 0.15, phase: 0.0 },
  { angle: 1.05, length: 24, amp: 0.1, phase: 1.7 },
  { angle: -0.55, length: 14, amp: 0.06, phase: 3.1 },
  { angle: 1.95, length: 8.5, amp: 0.04, phase: 4.6 },
] as const;

/** Round to 6 decimals so the JS number and the GLSL literal are identical. */
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

interface Wave {
  dx: number;
  dz: number;
  /** wave number: radians per meter */
  k: number;
  /** angular speed: radians per second (deep-water physics: w = sqrt(g * k)) */
  w: number;
  amp: number;
  phase: number;
}

const WAVES: readonly Wave[] = WAVE_SPECS.map((s) => {
  const k = r6((Math.PI * 2) / s.length);
  return {
    dx: r6(Math.cos(s.angle)),
    dz: r6(Math.sin(s.angle)),
    k,
    w: r6(Math.sqrt(GRAVITY * k) * CALMNESS),
    amp: s.amp,
    phase: s.phase,
  };
});

/** Tallest the water can ever get (all four crests lining up), in meters. */
export const MAX_WAVE_HEIGHT = WAVES.reduce((sum, w) => sum + w.amp, 0);

const COUNT = WAVES.length;
// Flat typed arrays keep the hot loops tight (boats, darts and particles call this a lot).
const DX = Float64Array.from(WAVES, (w) => w.dx);
const DZ = Float64Array.from(WAVES, (w) => w.dz);
const K = Float64Array.from(WAVES, (w) => w.k);
const W = Float64Array.from(WAVES, (w) => w.w);
const A = Float64Array.from(WAVES, (w) => w.amp);
const P = Float64Array.from(WAVES, (w) => w.phase);

/** Water surface height at (x, z) at time t. Matches the shader exactly. */
export function waveHeight(x: number, z: number, t: number): number {
  let h = 0;
  for (let i = 0; i < COUNT; i++) {
    h += A[i] * Math.sin(K[i] * (DX[i] * x + DZ[i] * z) - W[i] * t + P[i]);
  }
  return h;
}

/** Unit surface normal, written into `out`. Matches the shader exactly. */
export function waveNormal(x: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  // The slope of a sine is a cosine; add the slopes up, then tip the "up" vector against them.
  let gx = 0;
  let gz = 0;
  for (let i = 0; i < COUNT; i++) {
    const c = A[i] * K[i] * Math.cos(K[i] * (DX[i] * x + DZ[i] * z) - W[i] * t + P[i]);
    gx += c * DX[i];
    gz += c * DZ[i];
  }
  const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
  return out.set(-gx * inv, inv, -gz * inv);
}

const f = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/**
 * GLSL twins of waveHeight / waveNormal, written from the same table.
 * Paste into any shader; takes the XZ position in world meters.
 */
export const WAVE_GLSL = /* glsl */ `
float waveHeight(vec2 p, float t) {
  float h = 0.0;
${WAVES.map(
  (v) => `  h += ${f(v.amp)} * sin(${f(v.k)} * dot(p, vec2(${f(v.dx)}, ${f(v.dz)})) - ${f(v.w)} * t + ${f(v.phase)});`,
).join('\n')}
  return h;
}

vec3 waveNormal(vec2 p, float t) {
  float gx = 0.0;
  float gz = 0.0;
  float c = 0.0;
${WAVES.map(
  (v) =>
    `  c = ${f(v.amp)} * ${f(v.k)} * cos(${f(v.k)} * dot(p, vec2(${f(v.dx)}, ${f(v.dz)})) - ${f(v.w)} * t + ${f(v.phase)});\n  gx += c * ${f(v.dx)};\n  gz += c * ${f(v.dz)};`,
).join('\n')}
  return normalize(vec3(-gx, 1.0, -gz));
}
`;
