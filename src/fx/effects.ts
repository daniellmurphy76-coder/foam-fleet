import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Boat, Effects, WorldQuery } from '../types';
import { BillboardLayer, FoamLayer, F, P } from './particles';

/**
 * Splashes, hit bursts, sparkles, shark-dive bubbles, balloon pops, honk notes and boat wakes.
 *
 * Everything here is drawn by two pooled particle layers (see particles.ts), so the whole
 * effects system costs two draw calls however busy the lagoon gets.
 */

const TAU = Math.PI * 2;

// How many particles the pools hold. Hit bursts are ~40 particles, a busy 8-boat wake ~300 billboards + up to WAKE_CAP foam streaks.
const BILLBOARD_CAPACITY = 2600;
const FOAM_CAPACITY = 1200;

const WHITE = new THREE.Color(0xffffff);
const FOAM_BLUE = new THREE.Color(0xd9f4ff);
const GOLD = new THREE.Color(0xffd23f);
const SOFT_GOLD = new THREE.Color(0xfff2a8);
const DART_BLUE = new THREE.Color(0x2f7bff); // the colors of a foam dart, for the little puff when one is used up
const DART_ORANGE = new THREE.Color(0xff8a00);

// Honk notes: module-private numbers a kid would not normally touch.
/** How many notes one honk sends up. They leave a beat apart ("pa-pa-paaa"). */
const NOTE_COUNT = 5;
const NOTE_GAP = 0.1;
/** Notes start this far above the boat's waterline point, about at the captain's hat. */
const NOTE_LIFT = 2.3;
/** Notes still waiting for their turn. Mashing the horn can't queue more than this. */
const NOTE_QUEUE = 24;

// Shark-dive bubbles: module-private numbers a kid would not normally touch.
/** How many bubbles one dive sends up. They set off a beat apart, so the column lasts about a second. */
const BUBBLE_COUNT = 13;
const BUBBLE_STAGGER = 0.045;
/** Bubbles still waiting for their turn. Several sharks diving at once fit; mashing can't queue more than this. */
const BUBBLE_QUEUE = 120;
/** Bubbles are born this far under the water (and rise to it), so the deepest are only just hidden by the waves. */
const BUBBLE_DEPTH_MIN = 0.15;
const BUBBLE_DEPTH_MAX = 0.5;
const BUBBLE_COLOR = new THREE.Color(0xd2f2ff);

// Wake tuning: module-private numbers a kid would not normally touch.
/** Distance from the boat's waterline point back to the end of its hull. */
const HULL_END = 2.0;
/** Below this speed (m/s) a boat leaves no wake at all. */
const WAKE_MIN_SPEED = 2.0;
/** The wake fades in over this many m/s above the minimum, so it never pops on or off. */
const WAKE_RAMP = 4.0;
/** Meters of travel between foam streaks (smaller = denser trail). Each step lays one streak. */
const FOAM_SPACING = 0.6;
const FOAM_SPACING_BOOST = 0.5;
/** Steps alternate between the two arms of the V; every this-many steps one more streak goes down the middle. */
const CENTER_EVERY = 4;
/** Sideways drift as a fraction of boat speed. 0.2 = a narrow V, about 11 degrees either side of the boat's track. */
const ARM_SPREAD = 0.2;
/** Each arm starts this far out from the boat's center line (about the stern's half-width). */
const ARM_START = 0.55;
/** Most live wake streaks across ALL boats. Past ~60% of this the emitters thin out, so 8 boats can't carpet the lagoon. */
const WAKE_CAP = 600;

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Per-boat bookkeeping so spray and foam come out at a steady rate whatever the frame rate. */
interface WakeState {
  dist: number; // meters travelled since the last foam blob
  spray: number; // fractional droplets owed
  bow: number; // fractional bow droplets owed
  mist: number; // fractional mist puffs owed
  puff: number; // fractional boost puffs owed
  lane: number; // foam step counter, 0..2*CENTER_EVERY-1 (even = left arm, odd = right arm)
}

/** A honk note waiting for its turn to float up. */
interface QueuedNote {
  wait: number; // seconds until it launches
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  pair: boolean; // two beamed notes instead of one
}

/** A dive bubble waiting for its turn to rise. */
interface QueuedBubble {
  wait: number; // seconds until it is born
  x: number;
  z: number;
  big: boolean;
}

export function createEffects(scene: THREE.Scene): Effects {
  const sparks = new BillboardLayer(BILLBOARD_CAPACITY);
  const foam = new FoamLayer(FOAM_CAPACITY, WAKE_CAP);
  scene.add(foam.mesh);
  scene.add(sparks.mesh);

  const wakeStates = new Map<number, WakeState>();
  // wake(boat) has no dt argument, so we reuse the dt from the latest update().
  let lastDt = 1 / 60;

  // Scratch colors (reused so nothing is allocated per effect).
  const target = new THREE.Color();
  const light = new THREE.Color();
  const pick = new THREE.Color();
  const dir = { x: 0, y: 0, z: 0 };

  // Honk notes waiting to launch (pooled, so a honk allocates nothing).
  const notesIdle: QueuedNote[] = [];
  const notesWaiting: QueuedNote[] = [];
  for (let i = 0; i < NOTE_QUEUE; i++) {
    notesIdle.push({ wait: 0, x: 0, y: 0, z: 0, color: new THREE.Color(), pair: false });
  }

  // Dive bubbles waiting to rise (pooled the same way). The surface height comes from the latest update().
  const bubblesIdle: QueuedBubble[] = [];
  const bubblesWaiting: QueuedBubble[] = [];
  for (let i = 0; i < BUBBLE_QUEUE; i++) bubblesIdle.push({ wait: 0, x: 0, z: 0, big: false });
  let lastWorld: WorldQuery | null = null;
  let lastT = 0;

  /** Random direction on a sphere, pushed upward a bit so bursts pop up and out. */
  function randomDir(upBias: number): void {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * TAU;
    const r = Math.sqrt(1 - u * u);
    dir.x = r * Math.cos(a);
    dir.y = u + upBias;
    dir.z = r * Math.sin(a);
  }

  // ───────────────────────────── splash ─────────────────────────────

  /** White droplets arcing up and falling, a few soft puffs, and a ripple on the water. `size` ~1 = a normal splash. */
  function splash(p: THREE.Vector3, size: number): void {
    const s = clamp(size, 0.15, 3.5);
    const root = Math.sqrt(s);

    const drops = Math.min(40, Math.round(7 + 9 * s));
    for (let i = 0; i < drops; i++) {
      const a = Math.random() * TAU;
      const speed = rand(0.8, 3.0) * root; // sideways
      const up = rand(2.8, 6.4) * (0.55 + 0.45 * root);
      const d = rand(0.12, 0.24) * (0.7 + 0.3 * root);
      sparks.emit(
        P.DROPLET,
        p.x + Math.cos(a) * 0.12 * s, p.y + 0.05, p.z + Math.sin(a) * 0.12 * s,
        Math.cos(a) * speed, up, Math.sin(a) * speed,
        rand(0.9, 1.4), d, d * 0.45,
        Math.random() < 0.3 ? FOAM_BLUE : WHITE,
      );
    }

    // A few soft puffs give the splash some body.
    const puffs = 2 + Math.floor(2 * s);
    for (let i = 0; i < puffs; i++) {
      const a = Math.random() * TAU;
      sparks.emit(
        P.PUFF,
        p.x + Math.cos(a) * 0.2 * s, p.y + 0.1, p.z + Math.sin(a) * 0.2 * s,
        Math.cos(a) * 0.6 * s, rand(1.0, 2.4) * root, Math.sin(a) * 0.6 * s,
        rand(0.4, 0.6), 0.35 * s, rand(0.8, 1.2) * s,
        WHITE,
      );
    }

    // Flat on the water: an expanding ripple ring and a patch of foam.
    foam.emit(F.RIPPLE, p.x, p.z, 0, 0, 0.9, 0.4 * s, 2.8 * s, 0.8, 1.0, 0);
    foam.emit(F.BLOB, p.x, p.z, 0, 0, rand(1.0, 1.3), 0.5 * s, 1.5 * s, 0.85, 0.7, 1.5);
  }

  // ───────────────────────────── hitBurst ─────────────────────────────

  /**
   * The "you got tagged!" pop: a bright flash, a shock ring, confetti in the target's color,
   * a handful of stars, and some foam puffs. About 0.6 seconds, impossible to miss.
   */
  function hitBurst(p: THREE.Vector3, color: number): void {
    target.setHex(color);
    light.copy(target).lerp(WHITE, 0.5);

    // 1. Flash and ring (the instant "something happened here" cue).
    sparks.emit(P.FLASH, p.x, p.y, p.z, 0, 0, 0, 0.16, 1.0, 2.8, WHITE);
    sparks.emit(P.RING, p.x, p.y, p.z, 0, 0, 0, 0.34, 0.6, 4.4, WHITE);

    // 2. Foam puffs that billow outward.
    for (let i = 0; i < 4; i++) {
      randomDir(0.2);
      const v = rand(1.5, 3.5);
      sparks.emit(
        P.PUFF, p.x, p.y, p.z,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.4, 0.55), 0.5, rand(1.1, 1.5),
        i & 1 ? WHITE : light,
      );
    }

    // 3. Confetti: mostly the target's color so everyone sees WHO got hit.
    for (let i = 0; i < 26; i++) {
      randomDir(0.35);
      const v = rand(4, 11);
      const r = Math.random();
      if (r < 0.5) pick.copy(target);
      else if (r < 0.72) pick.copy(light);
      else if (r < 0.9) pick.copy(WHITE);
      else pick.copy(GOLD);
      sparks.emit(
        i & 1 ? P.CONFETTI : P.BIT,
        p.x, p.y, p.z,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.5, 0.75), rand(0.16, 0.32), 0,
        pick,
      );
    }

    // 4. Stars: bigger, slower, spinning, the "POW!" in the middle.
    for (let i = 0; i < 7; i++) {
      randomDir(0.25);
      const v = rand(4, 8);
      const k = i % 4;
      sparks.emit(
        P.STAR, p.x, p.y, p.z,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.55, 0.7), rand(0.55, 0.95), 0,
        k === 0 || k === 3 ? GOLD : k === 1 ? WHITE : target,
      );
    }
  }

  // ───────────────────────────── sparkle ─────────────────────────────

  /** Gold twinkles drifting upward: pickups collected, shields popping. `color` adds a few twinkles in its own hue. */
  function sparkle(p: THREE.Vector3, color: number): void {
    target.setHex(color);
    sparks.emit(P.RING, p.x, p.y, p.z, 0, 0, 0, 0.45, 0.5, 3.2, SOFT_GOLD);
    for (let i = 0; i < 16; i++) {
      randomDir(0.6);
      const v = rand(0.8, 3.0);
      const a = Math.random();
      pick.copy(a < 0.5 ? GOLD : a < 0.75 ? SOFT_GOLD : target);
      const shape = i % 4 === 3 ? P.GLINT : P.SPARKLE;
      sparks.emit(
        shape,
        p.x + dir.x * 0.4, p.y + dir.y * 0.3, p.z + dir.z * 0.4,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.7, 1.2), shape === P.GLINT ? rand(0.12, 0.2) : rand(0.4, 0.8), 0,
        pick,
      );
    }
  }

  // ───────────────────────────── pop ─────────────────────────────

  /**
   * A balloon bursts: a quick flash and ring, big rubbery shreds in the balloon's color flying off
   * its skin and fluttering down, round confetti, a few stars and a puff of let-out air.
   * `p` is the balloon's center (a balloon is about 1.8 m across).
   */
  function pop(p: THREE.Vector3, color: number): void {
    target.setHex(color);
    light.copy(target).lerp(WHITE, 0.45);

    // 1. Flash and ring.
    sparks.emit(P.FLASH, p.x, p.y, p.z, 0, 0, 0, 0.14, 1.8, 3.8, WHITE);
    sparks.emit(P.RING, p.x, p.y, p.z, 0, 0, 0, 0.34, 1.2, 5.6, light);

    // 2. Shreds of rubber: they start out on the balloon's skin and linger, so it reads as "the balloon burst".
    for (let i = 0; i < 16; i++) {
      randomDir(0.3);
      const v = rand(3, 8);
      sparks.emit(
        P.CONFETTI,
        p.x + dir.x * 0.45, p.y + dir.y * 0.45, p.z + dir.z * 0.45,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.8, 1.15), rand(0.3, 0.5), 0,
        i % 4 === 3 ? light : target,
      );
    }

    // 3. Small round confetti, mostly in the balloon's color.
    for (let i = 0; i < 14; i++) {
      randomDir(0.35);
      const v = rand(4, 10);
      const r = Math.random();
      pick.copy(r < 0.45 ? target : r < 0.7 ? light : r < 0.9 ? WHITE : GOLD);
      sparks.emit(
        P.BIT,
        p.x, p.y, p.z,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.55, 0.85), rand(0.14, 0.26), 0,
        pick,
      );
    }

    // 4. A few stars for the "POP!".
    for (let i = 0; i < 4; i++) {
      randomDir(0.3);
      const v = rand(3, 6);
      const k = i % 3;
      sparks.emit(
        P.STAR, p.x, p.y, p.z,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.6, 0.8), rand(0.5, 0.8), 0,
        k === 0 ? GOLD : k === 1 ? WHITE : light,
      );
    }

    // 5. The air whooshing out.
    for (let i = 0; i < 3; i++) {
      randomDir(0);
      const v = rand(1.2, 2.6);
      sparks.emit(
        P.PUFF, p.x, p.y, p.z,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.4, 0.5), 0.9, rand(1.8, 2.4),
        i & 1 ? WHITE : light,
      );
    }
  }

  // ───────────────────────────── puff ─────────────────────────────

  /**
   * A tiny poof where a foam dart is used up (it popped something and is gone): three soft puffs and a
   * few blue and orange foam bits. Not part of the shared Effects contract; the dart system looks for it.
   */
  function puff(p: THREE.Vector3): void {
    for (let i = 0; i < 3; i++) {
      randomDir(0.1);
      const v = rand(0.8, 1.8);
      sparks.emit(
        P.PUFF, p.x, p.y, p.z,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.22, 0.32), 0.22, rand(0.6, 0.8),
        WHITE,
      );
    }
    for (let i = 0; i < 4; i++) {
      randomDir(0.3);
      const v = rand(2, 4.5);
      sparks.emit(
        P.BIT, p.x, p.y, p.z,
        dir.x * v, dir.y * v, dir.z * v,
        rand(0.3, 0.45), rand(0.08, 0.13), 0,
        i & 1 ? DART_ORANGE : DART_BLUE,
      );
    }
  }

  // ───────────────────────────── notes ─────────────────────────────

  /**
   * Honk! A few cartoon music notes pop out above the boat one after another, then drift up and fade.
   * `p` is the boat's waterline point; the notes start NOTE_LIFT above it, in `color` with a dark outline.
   */
  function notes(p: THREE.Vector3, color: number): void {
    for (let k = 0; k < NOTE_COUNT; k++) {
      const n = notesIdle.pop();
      if (!n) return; // the horn is being mashed and the queue is full: skip the extras
      n.wait = k * NOTE_GAP;
      n.x = p.x + rand(-0.9, 0.9);
      n.y = p.y + NOTE_LIFT + rand(-0.1, 0.3);
      n.z = p.z + rand(-0.9, 0.9);
      n.color.setHex(color);
      n.pair = k % 2 === 1; // single, pair, single, pair, single
      notesWaiting.push(n);
    }
  }

  /** Launch every queued note whose turn has come. */
  function launchNotes(dt: number): void {
    for (let i = notesWaiting.length - 1; i >= 0; i--) {
      const n = notesWaiting[i];
      n.wait -= dt;
      if (n.wait > 0) continue;
      // Pop up, drift a little sideways and keep floating up while fading; tilted a touch so they look hand-drawn.
      sparks.emit(
        n.pair ? P.NOTE2 : P.NOTE,
        n.x, n.y, n.z,
        rand(-1.2, 1.2), rand(2.2, 3.4), rand(-1.2, 1.2),
        rand(1.3, 1.7), rand(1.0, 1.4), 0,
        n.color,
        rand(-0.3, 0.3),
      );
      // Swap-remove: the last one was already handled this pass (we walk backwards).
      notesWaiting[i] = notesWaiting[notesWaiting.length - 1];
      notesWaiting.pop();
      notesIdle.push(n);
    }
  }

  // ───────────────────────────── bubbles ─────────────────────────────

  /**
   * A shark dives: a column of bubbles rises where it went down and pops at the surface, over about a second.
   * The bubbles set off one after another (a few of them big), scattered around `p` the way a shark's body
   * is long. Only p.x and p.z matter: the bubbles start just under the waves and climb to the water.
   */
  function bubbles(p: THREE.Vector3): void {
    for (let k = 0; k < BUBBLE_COUNT; k++) {
      const b = bubblesIdle.pop();
      if (!b) return; // too many dives at once: skip the extras
      b.wait = k * BUBBLE_STAGGER + rand(0, 0.03);
      b.x = p.x + rand(-1.0, 1.0);
      b.z = p.z + rand(-1.0, 1.0);
      b.big = k % 5 === 2;
      bubblesWaiting.push(b);
    }
  }

  /** Send up every queued bubble whose turn has come (born a little under the water, rising to it). */
  function launchBubbles(dt: number): void {
    for (let i = bubblesWaiting.length - 1; i >= 0; i--) {
      const b = bubblesWaiting[i];
      b.wait -= dt;
      if (b.wait > 0) continue;
      const surface = lastWorld ? lastWorld.waveHeight(b.x, b.z, lastT) : 0;
      const size = b.big ? rand(0.5, 0.66) : rand(0.2, 0.4);
      sparks.emit(
        P.BUBBLE,
        b.x, surface - rand(BUBBLE_DEPTH_MIN, BUBBLE_DEPTH_MAX), b.z,
        rand(-0.1, 0.1), rand(0.7, 1.05), rand(-0.1, 0.1),
        2.0, size, size * 1.25, // the long life is only a safety net: it pops at the surface long before that
        BUBBLE_COLOR,
      );
      bubblesWaiting[i] = bubblesWaiting[bubblesWaiting.length - 1];
      bubblesWaiting.pop();
      bubblesIdle.push(b);
    }
  }

  /** A bubble reached the surface: a pinch of droplets and a tiny ripple. */
  function bubblePop(x: number, y: number, z: number): void {
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * TAU;
      const sp = rand(0.3, 0.9);
      const d = rand(0.06, 0.11);
      sparks.emit(
        P.DROPLET,
        x, y + 0.03, z,
        Math.cos(a) * sp, rand(1.4, 2.4), Math.sin(a) * sp,
        rand(0.5, 0.7), d, d * 0.5,
        WHITE,
      );
    }
    foam.emit(F.RIPPLE, x, z, 0, 0, 0.55, 0.12, 0.7, 0.6, 1.0, 0);
  }
  sparks.onSurfacePop = bubblePop;

  // ───────────────────────────── wake ─────────────────────────────

  /**
   * A crisp, narrow V of foam left on the water plus a little spray off the stern, all scaled by
   * how fast the boat goes. Nothing at all when the boat is (nearly) stopped.
   */
  function wake(boat: Boat): void {
    const speed = boat.speed;
    const a = Math.abs(speed);
    if (a < WAKE_MIN_SPEED) return;

    let st = wakeStates.get(boat.id);
    if (!st) {
      st = { dist: 0, spray: 0, bow: 0, mist: 0, puff: 0, lane: 0 };
      wakeStates.set(boat.id, st);
    }
    const dt = lastDt;
    const boosting = boat.boosting;
    const speedN = Math.min(1.3, a / CONFIG.boat.maxSpeed); // ~1 at top speed, more while boosting
    const ramp = clamp((a - WAKE_MIN_SPEED) / WAKE_RAMP, 0, 1); // 0 -> 1 as the boat gets going

    // Direction the boat is travelling (flips when reversing) and its sideways axis.
    const sinH = Math.sin(boat.heading);
    const cosH = Math.cos(boat.heading);
    const sign = speed >= 0 ? 1 : -1;
    const tx = sinH * sign, tz = cosH * sign; // travel direction
    const lx = cosH, lz = -sinH; // sideways
    const bx = boat.position.x, by = boat.position.y, bz = boat.position.z;
    const sx = bx - tx * HULL_END, sz = bz - tz * HULL_END; // the trailing end of the hull

    // 1. Foam streaks left on the water: one every FOAM_SPACING meters of travel (so a faster boat
    //    lays more), alternating left arm / right arm, with a thin center line every few steps.
    //    Each streak is small, soft-edged and half see-through, drifts outward in proportion to the
    //    boat's speed (that is what opens the V) and is gone in under two seconds, so the water
    //    underneath always shows through.
    const crowd = 1 + 2 * clamp((foam.wakeAlive / WAKE_CAP - 0.6) / 0.4, 0, 1); // busy lagoon: thin out before the hard cap
    const spacing = (boosting ? FOAM_SPACING_BOOST : FOAM_SPACING) * crowd;
    const hot = boosting ? 1.15 : 1; // boosting: a touch wider, a touch bigger
    st.dist += a * dt;
    let guard = 8;
    while (st.dist >= spacing && guard-- > 0) {
      st.dist -= spacing;
      // We overshot the spawn point by st.dist meters, so place the streak that far back along the path.
      const px = sx - tx * st.dist, pz = sz - tz * st.dist;
      const step = st.lane;
      st.lane = (st.lane + 1) % (2 * CENTER_EVERY);
      if (ramp < 0.05) continue; // creeping: nothing worth drawing yet
      const size = rand(0.6, 0.9) * (0.85 + 0.2 * Math.min(1, speedN)) * hot; // starting width in meters
      const alpha = (0.5 + 0.1 * Math.min(1, speedN)) * ramp; // peak opacity 0.5 - 0.6

      const side = step % 2 === 0 ? -1 : 1; // left arm, right arm, left arm...
      const out = side * ARM_SPREAD * hot * rand(0.85, 1.15) * a; // sideways drift speed
      // Lay the streak along the arm it is part of: one step back along the track and ARM_SPREAD out to the side.
      const rot = Math.atan2(tz - side * ARM_SPREAD * lz, tx - side * ARM_SPREAD * lx);
      foam.emit(
        F.WAKE,
        px + lx * side * ARM_START, pz + lz * side * ARM_START,
        lx * out, lz * out,
        rand(1.4, 1.8), size, size * 1.6, alpha, 0.9, 0, rot,
      );

      if (step % CENTER_EVERY === CENTER_EVERY - 1) {
        // The thin propeller-wash line down the middle: smaller and fainter than the arms.
        foam.emit(F.WAKE, px, pz, 0, 0, rand(1.2, 1.5), size * 0.7, size * 1.1, alpha * 0.7, 0.9, 0, Math.atan2(tz, tx));
      }
    }
    if (st.dist > spacing) st.dist = 0; // never let a big pause build up a burst of streaks

    // 2. A little spray off the stern; a lot more when boosting (a taller, denser rooster tail).
    st.spray += (a * 0.9 + (boosting ? 18 : 0)) * dt;
    while (st.spray >= 1) {
      st.spray -= 1;
      const back = (2.6 + a * 0.1 + Math.random() * 1.2) * (boosting ? 1.3 : 1);
      const side = rand(-1.2, 1.2);
      const up = rand(2.0, 4.0) + (boosting ? 1.5 : 0);
      const d = boosting ? rand(0.22, 0.4) : rand(0.14, 0.26);
      const o = rand(-0.5, 0.5);
      sparks.emit(
        P.SPRAY,
        sx + lx * o, by + 0.2, sz + lz * o,
        boat.velocity.x * 0.1 - tx * back + lx * side, up, boat.velocity.z * 0.1 - tz * back + lz * side,
        rand(0.45, 0.75), d, d * 0.4,
        WHITE,
      );
    }

    // 2b. Just a wisp of mist behind the stern (the foam streaks do the trail work now).
    st.mist += a * 0.08 * dt;
    while (st.mist >= 1) {
      st.mist -= 1;
      sparks.emit(
        P.MIST,
        sx + lx * rand(-0.5, 0.5), by + 0.3, sz + lz * rand(-0.5, 0.5),
        -tx * rand(1.0, 2.5) + lx * rand(-0.8, 0.8), rand(0.5, 1.5), -tz * rand(1.0, 2.5) + lz * rand(-0.8, 0.8),
        rand(0.3, 0.45), 0.3, rand(0.6, 0.9),
        WHITE,
      );
    }

    // 3. Boost puffs: small soft clouds blasting out of the back.
    if (boosting) {
      st.puff += 9 * dt;
      while (st.puff >= 1) {
        st.puff -= 1;
        sparks.emit(
          P.PUFF,
          sx + lx * rand(-0.4, 0.4), by + 0.35, sz + lz * rand(-0.4, 0.4),
          -tx * rand(3, 6), rand(0.8, 2.0), -tz * rand(3, 6),
          rand(0.3, 0.45), 0.4, rand(0.9, 1.3),
          WHITE,
        );
      }
    } else {
      st.puff = 0;
    }

    // 4. A little bow spray at speed so fast boats feel fast from the chase camera.
    if (a > 7) {
      st.bow += a * 0.3 * dt;
      while (st.bow >= 1) {
        st.bow -= 1;
        const sideSign = Math.random() < 0.5 ? -1 : 1;
        const out = sideSign * rand(1.8, 3.2);
        sparks.emit(
          P.SPRAY,
          bx + tx * 1.5 + lx * sideSign * 0.7, by + 0.1, bz + tz * 1.5 + lz * sideSign * 0.7,
          boat.velocity.x * 0.5 + lx * out, rand(1.6, 3.2), boat.velocity.z * 0.5 + lz * out,
          rand(0.35, 0.55), rand(0.12, 0.22), 0.05,
          WHITE,
        );
      }
    }
  }

  // ───────────────────────────── update / clear / dispose ─────────────────────────────

  function update(dt: number, t: number, world: WorldQuery): void {
    lastDt = clamp(dt, 0, 0.05);
    lastWorld = world;
    lastT = t;
    launchNotes(lastDt);
    launchBubbles(lastDt);
    sparks.update(lastDt, t, world);
    foam.update(lastDt, t, world);
  }

  function clear(): void {
    sparks.clear();
    foam.clear();
    wakeStates.clear();
    while (notesWaiting.length > 0) notesIdle.push(notesWaiting.pop() as QueuedNote);
    while (bubblesWaiting.length > 0) bubblesIdle.push(bubblesWaiting.pop() as QueuedBubble);
  }

  function dispose(): void {
    clear();
    sparks.onSurfacePop = null;
    lastWorld = null;
    sparks.dispose();
    foam.dispose();
  }

  // `puff` is an extra beyond the Effects contract (see its comment); typed as Effects on the way out.
  const effects = { splash, hitBurst, sparkle, bubbles, pop, notes, puff, wake, update, clear, dispose };
  return effects;
}
