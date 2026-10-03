/**
 * The hand-placed map of the lagoon. Pure data and a little math (no Three.js),
 * so it is easy to read, tweak and test.
 *
 * Everything below was laid out for an arena of radius 160 m. If you change
 * CONFIG.arena.radius, positions and island sizes scale along with it.
 *
 * Handy picture (x to the right, z up, duck in the middle):
 *
 *            Delta
 *     Alpha        Bravo
 *          duck
 *     Charlie        Echo        <- sandy islands, rocks sprinkled around,
 *                                    lighthouse island far out west
 */
import type { Obstacle, SpawnPoint } from '../types';

const DESIGN_RADIUS = 160;
/** Race gates are this wide on each side of their center (meters). */
export const GATE_RADIUS = 9;
/** Spawn circles keep this far clear of an obstacle edge (a boat is ~1.7 m wide + wiggle room). */
const SPAWN_CLEARANCE = 4.5;

export interface IslandSpec {
  x: number;
  z: number;
  /** Beach waterline radius. This is also the obstacle circle. */
  r: number;
  palms: number;
  seed: number;
  /** A small hut with a red roof. */
  hut: boolean;
  /** A green patch on top. */
  grass: boolean;
  /** Gets the striped lighthouse. */
  lighthouse: boolean;
}

export interface RockClusterSpec {
  x: number;
  z: number;
  /** Obstacle circle radius (covers every rock in the cluster). */
  r: number;
  rocks: number;
  seed: number;
}

export interface DuckSpec {
  x: number;
  z: number;
  /** Obstacle circle radius. */
  r: number;
  /** Which way the beak points (heading convention). */
  heading: number;
}

export interface GateSpec {
  x: number;
  z: number;
  heading: number;
  radius: number;
}

export interface Layout {
  arenaRadius: number;
  /** Design units -> meters (arenaRadius / 160). */
  scale: number;
  islands: IslandSpec[];
  rocks: RockClusterSpec[];
  duck: DuckSpec;
  /** Island circles, rock circles, then the duck. Same order the World exposes. */
  obstacles: Obstacle[];
  /** Race gates in driving order. gates[0] is start/finish. */
  gates: GateSpec[];
  /** Spots for battle-mode crates (open water). */
  battleCrates: { x: number; z: number }[];
  /** Ring of buoys marking the edge of the arena. */
  edgeBuoys: { count: number; ringRadius: number };
}

// ───────────────────────────── The map (design units: meters at radius 160) ─────────────────────────────

const ISLANDS: IslandSpec[] = [
  { x: -34, z: 18, r: 22, palms: 6, seed: 11, hut: true, grass: true, lighthouse: false }, // Alpha: the big one
  { x: 36, z: 30, r: 17, palms: 4, seed: 23, hut: false, grass: true, lighthouse: false }, // Bravo
  { x: 10, z: -52, r: 18, palms: 5, seed: 37, hut: false, grass: true, lighthouse: false }, // Charlie
  { x: -12, z: 64, r: 9, palms: 2, seed: 41, hut: false, grass: false, lighthouse: false }, // Delta: a tiny one
  { x: 60, z: -18, r: 11, palms: 3, seed: 53, hut: false, grass: false, lighthouse: false }, // Echo
  { x: -122, z: -50, r: 12, palms: 2, seed: 67, hut: false, grass: false, lighthouse: true }, // Lighthouse island
];

const ROCKS: RockClusterSpec[] = [
  { x: -76, z: 8, r: 5, rocks: 4, seed: 5 },
  { x: 124, z: 34, r: 5, rocks: 3, seed: 6 },
  { x: 40, z: 112, r: 5, rocks: 4, seed: 7 },
  { x: -52, z: -118, r: 5, rocks: 3, seed: 8 },
  { x: 78, z: -96, r: 5, rocks: 4, seed: 9 },
];

const DUCK: DuckSpec = { x: 2, z: -8, r: 6.8, heading: 0.6 };

/**
 * Race course. Just positions: headings are worked out from the neighbours so
 * each gate faces the way the boats really travel.
 * A big sweeping loop, one tight S-bend chicane in the south west.
 */
const GATE_POINTS: [number, number][] = [
  [100, -48],
  [100, 34],
  [72, 88],
  [14, 106],
  [-40, 92],
  [-86, 52],
  [-92, 2],
  [-64, -36],
  [-88, -70],
  [50, -104],
];

/** Open-water spots for crates in battle mode (spread around the lagoon). */
const BATTLE_CRATES: [number, number][] = [
  [0, 40],
  [32, -18],
  [-38, -32],
  [96, 8],
  [-96, 20],
  [20, 98],
  [-20, -90],
  [74, -62],
];

// ───────────────────────────── Builders ─────────────────────────────

export function buildLayout(arenaRadius: number): Layout {
  const s = arenaRadius / DESIGN_RADIUS;

  const islands = ISLANDS.map((i) => ({ ...i, x: i.x * s, z: i.z * s, r: i.r * s }));
  const rocks = ROCKS.map((r) => ({ ...r, x: r.x * s, z: r.z * s, r: r.r * Math.max(0.8, s) }));
  const duck = { ...DUCK, x: DUCK.x * s, z: DUCK.z * s };

  const obstacles: Obstacle[] = [
    ...islands.map((i) => ({ x: i.x, z: i.z, radius: i.r })),
    ...rocks.map((r) => ({ x: r.x, z: r.z, radius: r.r })),
    { x: duck.x, z: duck.z, radius: duck.r },
  ];

  const pts = GATE_POINTS.map(([x, z]) => ({ x: x * s, z: z * s }));
  const gates: GateSpec[] = pts.map((p, i) => {
    const prev = pts[(i + pts.length - 1) % pts.length];
    const next = pts[(i + 1) % pts.length];
    // Face along the line from the previous gate to the next one: a smooth "through" direction.
    return { x: p.x, z: p.z, heading: Math.atan2(next.x - prev.x, next.z - prev.z), radius: GATE_RADIUS };
  });

  return {
    arenaRadius,
    scale: s,
    islands,
    rocks,
    duck,
    obstacles,
    gates,
    battleCrates: BATTLE_CRATES.map(([x, z]) => ({ x: x * s, z: z * s })),
    edgeBuoys: { count: 56, ringRadius: arenaRadius - 2.5 },
  };
}

/**
 * Where an island's beach meets the water, in direction `theta` (radians from +X toward +Z).
 * The coast is a little lumpy but never sticks out past the obstacle circle `r`,
 * so boats bumping the circle always stay in open water. The island mesh and the
 * water's shoreline foam both use this one function so they line up.
 */
export function shoreRadius(island: { r: number; seed: number }, theta: number): number {
  const a = island.seed * 1.7;
  const b = island.seed * 0.9 + 2;
  const lump = 0.06 * (0.5 + 0.5 * Math.sin(3 * theta + a)) + 0.04 * (0.5 + 0.5 * Math.sin(5 * theta + b));
  return island.r * (1 - lump);
}

function clearOfObstacles(x: number, z: number, obstacles: readonly Obstacle[], margin: number): boolean {
  for (const o of obstacles) {
    const d = Math.hypot(x - o.x, z - o.z);
    if (d < o.radius + margin) return false;
  }
  return true;
}

/**
 * Battle spawns: evenly spaced on a ring at 55% of the arena radius, facing the middle.
 * If a spot lands on an island it slides a little along the ring (or in/out) until it is clear.
 * The order is shuffled so spawn 0 and spawn 1 start far apart (good for two human players).
 */
export function battleSpawns(layout: Layout, count: number): SpawnPoint[] {
  const ringR = layout.arenaRadius * 0.55;
  const out: SpawnPoint[] = [];
  // Pick a step that is coprime with `count` and close to half-way round.
  let step = Math.max(1, Math.floor(count / 2));
  while (step > 1 && gcd(step, count) !== 1) step--;

  const phase = Math.PI * 0.25; // start a little off the axes so nobody faces a rock cluster dead on
  for (let i = 0; i < count; i++) {
    const slot = (i * step) % count;
    const baseAngle = phase + (slot / count) * Math.PI * 2;
    let best: SpawnPoint | null = null;
    // Try the exact spot first, then wiggle: angle +-4 deg per step, radius +-6 m.
    search: for (let a = 0; a <= 8; a++) {
      for (const sign of a === 0 ? [1] : [1, -1]) {
        for (const dr of [0, -6, 6, -12, 12]) {
          const ang = baseAngle + sign * a * 0.07;
          const r = ringR + dr;
          const x = Math.cos(ang) * r;
          const z = Math.sin(ang) * r;
          if (clearOfObstacles(x, z, layout.obstacles, SPAWN_CLEARANCE)) {
            best = { x, z, heading: Math.atan2(-x, -z) };
            break search;
          }
        }
      }
    }
    if (!best) {
      const x = Math.cos(baseAngle) * ringR;
      const z = Math.sin(baseAngle) * ringR;
      best = { x, z, heading: Math.atan2(-x, -z) };
    }
    out.push(best);
  }
  return out;
}

/** Race spawns: a 2-wide grid behind the start gate, 4 m side to side, 6 m back per row. */
export function raceSpawns(layout: Layout, count: number): SpawnPoint[] {
  const g = layout.gates[0];
  const fx = Math.sin(g.heading);
  const fz = Math.cos(g.heading);
  // Local +X after rotation.y = heading (the driver's left).
  const rx = Math.cos(g.heading);
  const rz = -Math.sin(g.heading);
  const FIRST_ROW_BACK = 10; // just outside the gate circle, so the first real pass starts lap 1
  const out: SpawnPoint[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const side = i % 2 === 0 ? -2 : 2;
    const back = FIRST_ROW_BACK + row * 6;
    out.push({
      x: g.x - fx * back + rx * side,
      z: g.z - fz * back + rz * side,
      heading: g.heading,
    });
  }
  return out;
}

/**
 * Team Up spawns. Each side lines up in a little "V" (the first boat at the point, the
 * rest alternating left and right behind it), all facing the middle of the lagoon.
 * Side A starts in the north east, side B on the exact opposite side (the same two
 * open spots the two-player battle spawns use), so the teams meet over the middle.
 */
const TEAM_TIP_RING = 0.58; // the point of each V sits at this fraction of the arena radius
const TEAM_ROW_SIDE = 6; // meters sideways per row of the V
const TEAM_ROW_BACK = 5; // meters back (away from the middle) per row of the V
const TEAM_MIN_APART = 5; // nudged boats never start closer than this
const TEAM_EDGE_MARGIN = 10; // and never closer to the arena edge than this

export function teamSpawns(layout: Layout, countA: number, countB: number): [SpawnPoint[], SpawnPoint[]] {
  const placed: SpawnPoint[] = []; // both sides, so side B never lands on side A
  const limit = layout.arenaRadius - TEAM_EDGE_MARGIN;

  const fits = (x: number, z: number): boolean => {
    if (Math.hypot(x, z) > limit) return false;
    if (!clearOfObstacles(x, z, layout.obstacles, SPAWN_CLEARANCE)) return false;
    return placed.every((p) => Math.hypot(p.x - x, p.z - z) >= TEAM_MIN_APART);
  };

  /** The exact spot if it fits, otherwise the closest spot that does (rings of 2 m steps). */
  const nudge = (x: number, z: number): { x: number; z: number } => {
    if (fits(x, z)) return { x, z };
    for (let r = 2; r <= 60; r += 2) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + r * 0.37;
        const nx = x + Math.cos(a) * r;
        const nz = z + Math.sin(a) * r;
        if (fits(nx, nz)) return { x: nx, z: nz };
      }
    }
    return { x, z };
  };

  const side = (count: number, angle: number): SpawnPoint[] => {
    const n = Math.max(0, Math.floor(count));
    const ox = Math.cos(angle); // outward from the middle
    const oz = Math.sin(angle);
    const tx = -oz; // sideways
    const tz = ox;
    const heading = Math.atan2(-ox, -oz); // facing the middle
    const tip = layout.arenaRadius * TEAM_TIP_RING;
    const out: SpawnPoint[] = [];
    for (let i = 0; i < n; i++) {
      const row = Math.ceil(i / 2); // 0, 1, 1, 2, 2, 3, ...
      const lateral = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * row * TEAM_ROW_SIDE;
      const dist = tip + row * TEAM_ROW_BACK; // distance from the middle of the lagoon
      const spot = nudge(ox * dist + tx * lateral, oz * dist + tz * lateral);
      const sp: SpawnPoint = { x: spot.x, z: spot.z, heading };
      placed.push(sp);
      out.push(sp);
    }
    return out;
  };

  const a = side(countA, Math.PI * 0.25);
  const b = side(countB, Math.PI * 1.25);
  return [a, b];
}

// ───────────────────────────── Rescue ─────────────────────────────

/** Rescue spots keep this far from every obstacle edge (the contract says at least 4 m) and ... */
const SAFE_SHORE = 4.5;
/** ... this far inside the arena edge (the contract says at least 8 m). */
const SAFE_EDGE = 8.5;
/** "Open water ahead" means this many meters straight ahead of the spot ... */
const AHEAD_LENGTH = 20;
/** ... staying this far from every obstacle edge ... */
const AHEAD_SHORE = 3.5;
/** ... and ending this far inside the arena edge. */
const AHEAD_EDGE = 4;
/** Tiny slack so a spot pushed to exactly the margin is not rejected by rounding. */
const SLACK = 0.001;

/**
 * Rescue: the nearest open-water spot to (x, z), at least 4 m clear of every obstacle and
 * inside the arena edge by 8 m. It faces `heading` when 20 m of open water lies straight
 * ahead; otherwise it faces away from the nearest obstacle (or, if that way is blocked
 * too, toward the middle of the lagoon, so a rescued boat never starts nose-to-wall).
 */
export function findSafeSpot(layout: Layout, x: number, z: number, heading: number): SpawnPoint {
  const obstacles = layout.obstacles;
  const limit = layout.arenaRadius - SAFE_EDGE;
  const h = Number.isFinite(heading) ? heading : 0;

  const isSafe = (px: number, pz: number): boolean =>
    Math.hypot(px, pz) <= limit + SLACK && clearOfObstacles(px, pz, obstacles, SAFE_SHORE - SLACK);

  // 1) Start from the boat's position, pulled inside the arena.
  let px = Number.isFinite(x) ? x : 0;
  let pz = Number.isFinite(z) ? z : 0;
  const toLimit = (): void => {
    const d = Math.hypot(px, pz);
    if (d > limit) {
      px *= limit / d;
      pz *= limit / d;
    }
  };
  toLimit();
  const startX = px;
  const startZ = pz;

  // 2) Slide straight out of any obstacle's margin (a few passes: leaving one island's margin
  //    can step into another's, and the arena edge can push back in).
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const o of obstacles) {
      let dx = px - o.x;
      let dz = pz - o.z;
      const d = Math.hypot(dx, dz);
      const need = o.radius + SAFE_SHORE;
      if (d >= need) continue;
      if (d < 1e-6) {
        dx = 1;
        dz = 0;
      } else {
        dx /= d;
        dz /= d;
      }
      px = o.x + dx * need;
      pz = o.z + dz * need;
      moved = true;
    }
    toLimit();
    if (!moved) break;
  }

  // 3) Squeezed between things (e.g. a margin against the arena edge)? Search outward in rings
  //    around the start point. Every spot on one ring is equally far, so the first hit wins.
  if (!isSafe(px, pz)) {
    px = startX;
    pz = startZ;
    search: for (let r = 1.5; r <= layout.arenaRadius * 2; r += 1.5) {
      const n = Math.max(12, Math.ceil((Math.PI * 2 * r) / 1.5));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r * 0.37;
        const cx = startX + Math.cos(a) * r;
        const cz = startZ + Math.sin(a) * r;
        if (isSafe(cx, cz)) {
          px = cx;
          pz = cz;
          break search;
        }
      }
    }
  }

  // 4) Which way to face. Is there open water for AHEAD_LENGTH meters along heading `hd`?
  const openAhead = (hd: number): boolean => {
    const dx = Math.sin(hd);
    const dz = Math.cos(hd);
    for (const o of obstacles) {
      // Closest point of the straight line (0..AHEAD_LENGTH) to the obstacle's center.
      const s = Math.max(0, Math.min(AHEAD_LENGTH, (o.x - px) * dx + (o.z - pz) * dz));
      const cx = px + dx * s - o.x;
      const cz = pz + dz * s - o.z;
      const keep = o.radius + AHEAD_SHORE;
      if (cx * cx + cz * cz < keep * keep) return false;
    }
    // The arena is convex and the spot is inside it, so checking the far end is enough.
    const ex = px + dx * AHEAD_LENGTH;
    const ez = pz + dz * AHEAD_LENGTH;
    const edge = layout.arenaRadius - AHEAD_EDGE;
    return ex * ex + ez * ez <= edge * edge;
  };

  let facing = h;
  if (!openAhead(h)) {
    let nearest: Obstacle | null = null;
    let nearestGap = Infinity;
    for (const o of obstacles) {
      const gap = Math.hypot(px - o.x, pz - o.z) - o.radius;
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = o;
      }
    }
    facing = nearest ? Math.atan2(px - nearest.x, pz - nearest.z) : Math.atan2(-px, -pz);
    if (!openAhead(facing)) {
      const inward = Math.atan2(-px, -pz);
      if (openAhead(inward)) facing = inward;
    }
  }

  return { x: px, z: pz, heading: facing };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
