import { probeSolid } from '../ai/steering';
import type { WorldQuery } from '../types';
import type { Shark } from './sharkState';

/**
 * How sharks steer: smooth turning, a fan of probes that bends their path around islands, and a last-ditch
 * push-out so a shark can never end up inside an island or outside the lagoon.
 */

const TAU = Math.PI * 2;

/** A shark's center stays this far (plus the island's radius) from every island: the shark is about 3 m long. */
export const HARD_R = 1.7;
export const MEGA_HARD_R = 4.4;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Wrap an angle into -PI..PI. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** How strongly the heading error asks for a turn (turn speed = error * gain, up to the shark's limit). */
const TURN_GAIN = 3;
/** Sidesteps to try when the way ahead is blocked, as angles from the wanted heading (both sides are tried). */
const OFFSETS = [0.2, 0.42, 0.68, 0.98, 1.32, 1.72, 2.2, 2.8];

/**
 * Pick a heading close to `want` that has `look` meters of open water. The probes come from the same
 * helper the bots use (probeSolid: islands and the lagoon edge). The smallest sidestep that is fully clear
 * wins, on the side the shark went last time (so it does not dither); the result is smoothed over time.
 * `look` is cut short at the goal itself, so an island behind a boat does not scare a shark off.
 */
export function steerAround(s: Shark, want: number, look: number, goalDist: number, world: WorldQuery, dt: number): number {
  const r = s.mega ? MEGA_HARD_R : HARD_R;
  const margin = s.mega ? 3 : 2;
  const inset = r + 2;
  const reach = Math.max(4, Math.min(look, goalDist));
  const c0 = probeSolid(s.x, s.z, Math.sin(want), Math.cos(want), r, world, margin, inset, reach);
  let best = 0;
  let urgency = 0;
  if (c0 < reach) {
    urgency = 1 - c0 / reach;
    let bestScore = c0 / reach;
    let found = false;
    for (let k = 0; k < OFFSETS.length && !found; k++) {
      for (let pass = 0; pass < 2; pass++) {
        const off = (pass === 0 ? s.avoidSide : -s.avoidSide) * OFFSETS[k];
        const h = want + off;
        const c = probeSolid(s.x, s.z, Math.sin(h), Math.cos(h), r, world, margin, inset, reach);
        if (c >= reach) {
          best = off;
          found = true;
          break;
        }
        const score = c / reach - 0.06 * OFFSETS[k] + (pass === 0 ? 0.03 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = off;
        }
      }
    }
  }
  // Ease toward the chosen sidestep: faster when an island is close.
  const rate = (2.5 + 9 * urgency) * dt;
  s.avoidOff += clamp(best - s.avoidOff, -rate, rate);
  if (best > 0.05) s.avoidSide = 1;
  else if (best < -0.05) s.avoidSide = -1;
  return want + s.avoidOff;
}

/**
 * Turn toward `steerHeading` with a limited turning speed that itself changes gently (no sudden twitches),
 * ease the speed toward `speedTarget`, and move.
 */
export function swimStep(s: Shark, steerHeading: number, turnMax: number, speedTarget: number, dt: number): void {
  const err = wrapPi(steerHeading - s.heading);
  const wantTurn = clamp(err * TURN_GAIN, -turnMax, turnMax);
  const turnAccel = (s.mega ? 3.5 : 7) * dt;
  s.turnVel += clamp(wantTurn - s.turnVel, -turnAccel, turnAccel);
  s.heading = wrapPi(s.heading + s.turnVel * dt);

  // Sharp turns cost a little speed, like leaning into a corner.
  const slow = 1 - 0.35 * Math.min(1, Math.abs(err) / 1.6);
  const target = speedTarget * slow;
  const accel = (target > s.speed ? (s.mega ? 3 : 5) : 8) * dt;
  s.speed += clamp(target - s.speed, -accel, accel);
  s.x += Math.sin(s.heading) * s.speed * dt;
  s.z += Math.cos(s.heading) * s.speed * dt;
}

/**
 * The safety net: whatever happened, put the shark back outside every island and inside the lagoon, and
 * swing its nose along the shore so it slides away instead of pushing into it.
 */
export function enforceBounds(s: Shark, world: WorldQuery): void {
  const r = s.mega ? MEGA_HARD_R : HARD_R;
  const obstacles = world.obstacles;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const dx = s.x - o.x;
    const dz = s.z - o.z;
    const min = o.radius + r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2) || 1e-4;
    const nx = dx / d;
    const nz = dz / d;
    s.x = o.x + nx * min;
    s.z = o.z + nz * min;
    slideAlong(s, nx, nz);
  }
  const lim = world.arenaRadius - r - 1;
  const d2 = s.x * s.x + s.z * s.z;
  if (d2 > lim * lim) {
    const d = Math.sqrt(d2);
    s.x = (s.x / d) * lim;
    s.z = (s.z / d) * lim;
    slideAlong(s, -s.x / lim, -s.z / lim); // the inward direction acts like a wall normal pointing away from the edge
  }
}

/** If the shark points into a wall (normal nx, nz points away from it), turn its nose toward the wall's tangent. */
function slideAlong(s: Shark, nx: number, nz: number): void {
  const fx = Math.sin(s.heading);
  const fz = Math.cos(s.heading);
  if (fx * nx + fz * nz >= 0) return; // already pointing away or along
  // Two tangents; take the one closer to where the nose points.
  const cross = fx * nz - fz * nx; // > 0: the nose is closer to the tangent (nz, -nx)
  const tx = cross > 0 ? nz : -nz;
  const tz = cross > 0 ? -nx : nx;
  const want = Math.atan2(tx, tz);
  s.heading = wrapPi(s.heading + clamp(wrapPi(want - s.heading), -0.3, 0.3));
}
