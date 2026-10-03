/**
 * Foam Fleet bots: small math helpers and obstacle avoidance.
 *
 * The big idea of `Avoider` is "feeler rays". The bot knows where it WANTS to go (a heading).
 * We shoot a fan of imaginary rays out in front of the boat, each one turned a little
 * further left or right of that heading, and measure how far each ray can travel before it
 * would hit an island, the edge of the lagoon, or another boat. Then we pick the ray that
 * is closest to where we wanted to go but still has room. Open water means we go exactly
 * where we wanted; an island in the way means we curve around it.
 */
import type { AimTarget, Boat, WorldQuery } from '../types';

export const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** A shark with a hit radius bigger than this is the MEGA SHARK (normal sharks are 1.6, the MEGA is 4.5). */
export const MEGA_SHARK_RADIUS = 3;
/** A shark bumps when its nose is within this many meters of a boat's edge (the MEGA SHARK: this + 3). */
export const SHARK_BUMP_REACH = 1.2;
export const MEGA_BUMP_EXTRA = 3;

/**
 * Center-to-center distance at which a shark of this size can bump a boat of radius `boatRadius`
 * (the shark's nose sticks out about one hit radius from its center).
 */
export function sharkBumpGap(boatRadius: number, shark: AimTarget): number {
  return boatRadius + SHARK_BUMP_REACH + shark.radius + (shark.radius > MEGA_SHARK_RADIUS ? MEGA_BUMP_EXTRA : 0);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wrap an angle into -PI..PI so "350 degrees" becomes "-10 degrees". */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

/** 0 at edge0, 1 at edge1, smooth in between. The edges may be given in either order. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Step `current` toward `target` by at most `maxDelta` (never overshoots). */
export function moveToward(current: number, target: number, maxDelta: number): number {
  if (target > current) return Math.min(target, current + maxDelta);
  return Math.max(target, current - maxDelta);
}

/**
 * The heading that points from (0,0) toward the offset (dx, dz).
 * Note the argument order: it is atan2(X, Z), not atan2(Z, X), because heading 0 faces +Z
 * and forward = (sin heading, 0, cos heading).
 */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/**
 * How far (radians) the boat must turn to the RIGHT to face `wanted`.
 * Positive = turn right = steer +1. Negative = turn left = steer -1.
 *
 * Worked example. The boat faces +Z, so current heading = 0. The target is at (-10, +10).
 *   wanted  = headingOf(-10, 10) = atan2(-10, 10) = -45 degrees
 *   wrapPi(wanted - current) = -45 degrees   (heading has to DECREASE)
 *   steer +1 is defined to DECREASE heading (see types.ts), so we need a POSITIVE steer.
 *   turnRight = -(-45 degrees) = +45 degrees  -> steer = +45 degrees * gain > 0. Correct!
 * Sanity check: facing +Z, the driver's right hand points at -X, and the target is at -X,
 * so the target really is on the right.
 */
export function turnRightAngle(current: number, wanted: number): number {
  return -wrapPi(wanted - current);
}

/** True if (px, pz) is within `slack` meters of an island or the lagoon edge. */
export function nearSolid(px: number, pz: number, boatRadius: number, world: WorldQuery, slack: number): boolean {
  const obstacles = world.obstacles;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const dx = o.x - px;
    const dz = o.z - pz;
    const reach = o.radius + boatRadius + slack;
    if (dx * dx + dz * dz < reach * reach) return true;
  }
  const edge = world.arenaRadius - boatRadius - slack;
  return px * px + pz * pz > edge * edge;
}

/**
 * One straight probe for the player's "bumper rails" (Easy Driving). How many meters can a boat
 * at (px, pz) travel along the unit direction (ux, uz) before it gets within `margin` meters of
 * an island or rock (the boat's own radius counts too), or crosses the safety ring `edgeInset`
 * meters inside the lagoon edge? Gives back `maxMeters` when the way is clear.
 *
 * Only solid things count (not other boats). Standing inside a danger zone only blocks the
 * directions that point further into it, so a boat hugging a shore can still slide along it.
 * No allocations: it is called a handful of times per frame.
 */
export function probeSolid(
  px: number,
  pz: number,
  ux: number,
  uz: number,
  boatRadius: number,
  world: WorldQuery,
  margin: number,
  edgeInset: number,
  maxMeters: number,
): number {
  let best = maxMeters;
  const obstacles = world.obstacles;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const dx = o.x - px;
    const dz = o.z - pz;
    const proj = dx * ux + dz * uz; // how far along the probe the thing's center is
    if (proj <= 0) continue; // it is behind us
    const r = o.radius + boatRadius + margin;
    const d2 = dx * dx + dz * dz;
    let t: number;
    if (d2 <= r * r) {
      t = 0; // already inside the zone and heading deeper in
    } else {
      const perp2 = d2 - proj * proj; // squared sideways miss distance
      if (perp2 >= r * r) continue; // the probe passes by
      t = proj - Math.sqrt(r * r - perp2);
    }
    if (t < best) best = t;
  }

  // The lagoon edge is a big circle around the origin: find where the probe leaves the safe ring.
  const ring = world.arenaRadius - edgeInset;
  const along = px * ux + pz * uz; // positive = pointing outward
  const dist2 = px * px + pz * pz;
  let tEdge: number;
  if (dist2 >= ring * ring) tEdge = along > 0 ? 0 : Infinity;
  else tEdge = -along + Math.sqrt(along * along - dist2 + ring * ring);
  if (tEdge < best) best = tEdge;
  return best < 0 ? 0 : best;
}

// ───────────────────────────── Feeler-ray avoidance ─────────────────────────────

/**
 * Ray directions to try, in radians away from the wanted heading.
 * Positive = more to the left (heading increases), negative = more to the right.
 * 0 comes first so that when the way is clear we choose it.
 */
const OFFSETS = new Float64Array([0, 0.2, -0.2, 0.4, -0.4, 0.62, -0.62, 0.85, -0.85, 1.1, -1.1, 1.4, -1.4, 1.8, -1.8, 2.4, -2.4]);
const COS_OFFSET = OFFSETS.map((o) => Math.cos(o));
const SIN_OFFSET = OFFSETS.map((o) => Math.sin(o));

/**
 * A second, finer fan centered on the NOSE (where the boat points right now). A boat cannot
 * turn on the spot: to face a new heading it first sails along an arc, so we also check what
 * is in the way while it swings round. 6 rays each side, 0.2 rad apart (about 69 degrees).
 */
const NOSE_STEP = 0.2;
const NOSE_HALF = 6;
const NOSE_COUNT = NOSE_HALF * 2 + 1;

/** Most things we remember per frame (islands + boats that are close enough to matter). */
const MAX_ENTRIES = 80;
/** Extra room around a solid thing: HARD is "we would touch it", SOFT is "comfortable distance". */
const HARD_PAD = 0.5;
const SOFT_PAD = 1.8;
/** The lagoon edge feels this many meters inside the real edge, so bots turn before the soft push. */
const EDGE_MARGIN = 5;
/** Moving boats are only worth worrying about this far ahead. */
const BOAT_REACH = 20;
/** Sharks are only steered around when VERY close: this far ahead (the MEGA SHARK is bigger, so a bit farther). */
const SHARK_REACH = 8;
const MEGA_SHARK_REACH = 14;

// How the scoring weighs things. Bigger number = that factor matters more.
const SCORE_TURN_AWAY = 0.3; // per PI radians away from the wanted heading
const SCORE_TURN_FROM_NOSE = 0.12; // per PI radians away from where the nose points right now
const SCORE_CHANGE_OF_MIND = 0.06; // per radian different from last frame's choice (stops dithering)
/** How far ahead (as a fraction of the look-ahead) a turning boat worries about islands. */
const SWEEP_HORIZON = 0.5;
const SCORE_SWEEP = 1; // per radian of blocked water the boat would have to swing through to get there

export class Avoider {
  /** Heading to steer toward (absolute radians) after avoidance. */
  heading = 0;
  /** 0..1: how much open water is along the chosen heading (1 = plenty). */
  clearance = 1;
  /** 0..1: open water straight ahead of the nose right now. */
  noseClearance = 1;
  /** Like clearance and noseClearance, but only counting islands and the lagoon edge (not other boats). */
  staticClearance = 1;
  /** Which way we swerved last time (radians; + = left). Handy for picking an unstick direction. */
  lastOffset = 0;

  // Scratch space reused every call, so nothing is allocated per frame.
  private readonly relX = new Float64Array(MAX_ENTRIES);
  private readonly relZ = new Float64Array(MAX_ENTRIES);
  private readonly distSq = new Float64Array(MAX_ENTRIES);
  private readonly hardSq = new Float64Array(MAX_ENTRIES);
  private readonly softSq = new Float64Array(MAX_ENTRIES);
  private readonly reach = new Float64Array(MAX_ENTRIES);
  /** 1 for entries that are other boats (they move, so they matter less), 0 for islands. */
  private readonly isBoat = new Uint8Array(MAX_ENTRIES);
  /** Meters of open water along each nose ray (see pick()). */
  private readonly noseMeters = new Float64Array(NOSE_COUNT);

  // The picture of the world for the current call (see pick()).
  private count = 0;
  private px = 0;
  private pz = 0;
  private look = 1;
  private edgeSq = 0;
  /** rayFrac() also leaves here the same answer ignoring boats... */
  private rayStatic = 1;
  /** ...and the open distance in plain meters. */
  private rayMeters = 0;

  reset(): void {
    this.lastOffset = 0;
  }

  /**
   * Choose a heading near `desired` that does not run into anything within `look` meters.
   * `ignore` is a boat to treat as thin air (the one we are deliberately chasing).
   * `sharks` (optional) are steered around like moving obstacles, but only when very close.
   */
  pick(
    self: Boat,
    boats: readonly Boat[],
    ignore: Boat | null,
    world: WorldQuery,
    desired: number,
    look: number,
    sharks?: readonly AimTarget[],
  ): void {
    this.px = self.position.x;
    this.pz = self.position.z;
    this.look = look;
    const edge = world.arenaRadius - EDGE_MARGIN;
    this.edgeSq = edge * edge;
    this.gather(self, boats, ignore, world, look, sharks);

    // ---- What is in the way while we turn? (rays around the nose) ----
    let noseStatic = 1;
    for (let j = -NOSE_HALF; j <= NOSE_HALF; j++) {
      const h = self.heading + j * NOSE_STEP;
      const frac = this.rayFrac(Math.sin(h), Math.cos(h));
      this.noseMeters[j + NOSE_HALF] = this.rayMeters;
      if (j === 0) {
        noseStatic = this.rayStatic;
        this.noseClearance = frac;
      }
    }
    // Only water within a turn's worth of distance matters while swinging round.
    const horizon = Math.max(8, look * SWEEP_HORIZON);

    // ---- Try every ray around the wanted heading and score it. ----
    const sinD = Math.sin(desired);
    const cosD = Math.cos(desired);
    let bestScore = -Infinity;
    let bestIndex = 0;
    let bestFrac = 1;
    let bestStatic = 1;

    for (let c = 0; c < OFFSETS.length; c++) {
      // Rotate the wanted direction by this ray's offset (angle-addition formulas).
      // heading h -> direction (sin h, cos h)
      const ux = sinD * COS_OFFSET[c] + cosD * SIN_OFFSET[c];
      const uz = cosD * COS_OFFSET[c] - sinD * SIN_OFFSET[c];
      const frac = this.rayFrac(ux, uz);
      const offset = OFFSETS[c];

      // To face this ray the boat first swings from its nose toward it. Add up how much
      // blocked water lies in that swing (in "blocked radians"). A short swing through
      // open water costs nothing; a swing across an island costs a lot, so the bot turns
      // the other way round instead.
      const delta = wrapPi(desired + offset - self.heading);
      let sweep = 0;
      if (delta > 0.1 || delta < -0.1) {
        const steps = Math.min(NOSE_HALF, Math.floor(Math.abs(delta) / NOSE_STEP));
        const dir = delta > 0 ? 1 : -1;
        for (let j = 0; j <= steps; j++) sweep += 1 - Math.min(1, this.noseMeters[NOSE_HALF + dir * j] / horizon);
        sweep *= NOSE_STEP;
      }

      const score =
        frac -
        (SCORE_TURN_AWAY * Math.abs(offset)) / Math.PI -
        (SCORE_TURN_FROM_NOSE * Math.abs(delta)) / Math.PI -
        SCORE_CHANGE_OF_MIND * Math.abs(offset - this.lastOffset) -
        SCORE_SWEEP * sweep;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = c;
        bestFrac = frac;
        bestStatic = this.rayStatic;
      }
    }

    this.lastOffset = OFFSETS[bestIndex];
    this.heading = desired + this.lastOffset;
    this.clearance = bestFrac;
    this.staticClearance = Math.min(bestStatic, noseStatic);
  }

  /** Collect everything near enough to matter into the scratch arrays. */
  private gather(
    self: Boat,
    boats: readonly Boat[],
    ignore: Boat | null,
    world: WorldQuery,
    look: number,
    sharks?: readonly AimTarget[],
  ): void {
    const px = this.px;
    const pz = this.pz;
    const selfR = self.radius;
    let n = 0;
    const obstacles = world.obstacles;
    for (let i = 0; i < obstacles.length && n < MAX_ENTRIES; i++) {
      const o = obstacles[i];
      const dx = o.x - px;
      const dz = o.z - pz;
      const hard = o.radius + selfR + HARD_PAD;
      const soft = hard + SOFT_PAD;
      const d2 = dx * dx + dz * dz;
      const cull = look + soft;
      if (d2 > cull * cull) continue;
      this.relX[n] = dx;
      this.relZ[n] = dz;
      this.distSq[n] = d2;
      this.hardSq[n] = hard * hard;
      this.softSq[n] = soft * soft;
      this.reach[n] = look;
      this.isBoat[n] = 0;
      n++;
    }
    const boatReach = Math.min(look, BOAT_REACH);
    for (let i = 0; i < boats.length && n < MAX_ENTRIES; i++) {
      const b = boats[i];
      if (b.id === self.id || b === ignore) continue;
      const dx = b.position.x - px;
      const dz = b.position.z - pz;
      const hard = b.radius + selfR + HARD_PAD;
      const soft = hard + SOFT_PAD;
      const d2 = dx * dx + dz * dz;
      const cull = boatReach + soft;
      if (d2 > cull * cull) continue;
      this.relX[n] = dx;
      this.relZ[n] = dz;
      this.distSq[n] = d2;
      this.hardSq[n] = hard * hard;
      this.softSq[n] = soft * soft;
      this.reach[n] = boatReach;
      this.isBoat[n] = 1;
      n++;
    }
    // Sharks move like boats (so they count as "not solid"), but the zone around one is the whole bump reach.
    if (sharks) {
      for (let i = 0; i < sharks.length && n < MAX_ENTRIES; i++) {
        const s = sharks[i];
        const dx = s.position.x - px;
        const dz = s.position.z - pz;
        const hard = sharkBumpGap(selfR, s);
        const soft = hard + SOFT_PAD;
        const reach = Math.min(look, s.radius > MEGA_SHARK_RADIUS ? MEGA_SHARK_REACH : SHARK_REACH);
        const d2 = dx * dx + dz * dz;
        const cull = reach + soft;
        if (d2 > cull * cull) continue;
        this.relX[n] = dx;
        this.relZ[n] = dz;
        this.distSq[n] = d2;
        this.hardSq[n] = hard * hard;
        this.softSq[n] = soft * soft;
        this.reach[n] = reach;
        this.isBoat[n] = 1;
        n++;
      }
    }
    this.count = n;
  }

  /**
   * Shoot one feeler ray from the boat along the unit direction (ux, uz).
   * Returns 0..1: 1 = nothing in the way for `look` meters, 0 = blocked right now.
   */
  private rayFrac(ux: number, uz: number): number {
    let frac = 1;
    let fixed = 1; // the same answer, but ignoring boats (see rayStatic)
    let meters = Infinity; // the nearest hit, in meters
    for (let k = 0; k < this.count; k++) {
      const proj = this.relX[k] * ux + this.relZ[k] * uz; // how far along the ray the thing's center is
      const d2 = this.distSq[k];
      let t: number;
      if (d2 <= this.hardSq[k]) {
        // Already touching it: only rays that point INTO it are blocked.
        if (proj <= 0) continue;
        t = 0;
      } else {
        if (proj <= 0) continue; // it is behind this ray
        // If we are inside the comfort zone, judge by the touching distance instead.
        const r2 = d2 <= this.softSq[k] ? this.hardSq[k] : this.softSq[k];
        const perp2 = d2 - proj * proj; // squared sideways miss distance
        if (perp2 >= r2) continue; // the ray passes by
        t = proj - Math.sqrt(r2 - perp2);
      }
      if (t < meters) meters = t;
      const f = t / this.reach[k];
      if (f < frac) frac = f;
      if (this.isBoat[k] === 0 && f < fixed) fixed = f;
    }

    // The lagoon edge is a big circle around the origin: find where this ray leaves it.
    const along = this.px * ux + this.pz * uz; // positive = pointing outward
    const dist2 = this.px * this.px + this.pz * this.pz;
    let tEdge: number;
    if (dist2 >= this.edgeSq) tEdge = along > 0 ? 0 : Infinity;
    else tEdge = -along + Math.sqrt(along * along - dist2 + this.edgeSq);
    const fEdge = tEdge / this.look;
    if (fEdge < frac) frac = fEdge;
    if (fEdge < fixed) fixed = fEdge;
    if (tEdge < meters) meters = tEdge;
    this.rayMeters = meters;
    this.rayStatic = fixed < 0 ? 0 : fixed;
    return frac < 0 ? 0 : frac;
  }
}
