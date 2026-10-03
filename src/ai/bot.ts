/**
 * Foam Fleet: computer-controlled captains.
 *
 * Every frame a bot does the same five things, in order (read `update()` first):
 *   1. PLAN     - decide where it WANTS to point (battle: at a target or a power-up crate;
 *                 race: at the next gate). This is `planBattle()` / `planRace()`.
 *   2. AVOID    - bend that heading around islands, the lagoon edge and other boats.
 *   3. STEER    - turn the heading error into a steering value, with a speed limit on how
 *                 fast the "wheel" may move so the boat never jitters.
 *   4. GO       - pick throttle (ease off in corners) and boost.
 *   5. SHOOT    - fire when a boat is lined up with the nose.
 *
 * Difficulty and personality live in profile.ts. The math helpers are in steering.ts.
 *
 * Handy reminder (types.ts): steer +1 turns RIGHT, which DECREASES heading. All the sign
 * handling is in `turnRightAngle()` in steering.ts, with a worked example.
 */
import type { Boat, BotDifficulty, BoatControls, Controller, ControllerContext } from '../types';
import { CONFIG } from '../config';
import { Avoider, DEG, clamp, headingOf, lerp, moveToward, nearSolid, smoothstep, turnRightAngle, wrapPi } from './steering';
import { SKILLS, makePersonality, makeRng } from './profile';
import type { Personality, Skill } from './profile';

const TWO_PI = Math.PI * 2;
/** Never simulate more than this much time in one step (a long hiccup must not fling the bot around). */
const MAX_DT = 0.1;

// ---- unstick ----
/** Slower than this (m/s) while trying to drive counts as "not moving". */
const STUCK_SPEED = 2;
/** Seconds of not moving before we reverse: quick when hugging an island, patient in open water. */
const STUCK_NEAR_SEC = 1.5;
const STUCK_FAR_SEC = 4;

// ---- battle ----
/**
 * After a close pass the bot "peels off": it heads this many degrees away from the direction
 * of the target (180 = straight away). Mostly away, a little sideways, so the distance opens
 * up quickly and there is room to swing round for the next run.
 */
const PEEL_ANGLE = 150 * DEG;
/** Break off when closer than (PEEL_ENTER - PEEL_BOLDNESS * aggression) times the preferred range. */
const PEEL_ENTER = 0.5;
const PEEL_BOLDNESS = 0.15;
/** A break-away lasts at least this long, until the gap is PEEL_EXIT x the preferred range, and never more than PEEL_SEC_MAX. */
const PEEL_SEC_MIN = 0.5;
const PEEL_SEC_MAX = 2.5;
const PEEL_EXIT = 1.1;
/** Share of the sideways curve still used while the blaster is loaded (1 = full curve, 0 = none). */
const STRAFE_ARMED = 0.15;
/** Farther than this times the preferred range counts as "far away": close the gap. */
const CHASE_FACTOR = 1.8;
/** Crates are collected within about 3 m, so we stop steering at them there. */
const PICKUP_ARRIVE = 3;
/** Race: a crate must be this close, and nearly on the way to the gate, to tempt a bot. */
const RACE_PICKUP_RANGE = 26;
const RACE_PICKUP_CONE = 0.5; // radians either side of the line to the gate
/** Race: if a bot spends this long within GATE_NEAR meters of a gate without passing it, it is circling. */
const GATE_NEAR = 45;
const GATE_LOST_SEC = 5;

/** A crate sitting on an island or rock can never be collected, so do not chase it. */
function crateIsReachable(ctx: ControllerContext, x: number, z: number): boolean {
  const obstacles = ctx.world.obstacles;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const reach = o.radius + ctx.self.radius + 0.5;
    if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) < reach * reach) return false;
  }
  return true;
}

function contains(boats: readonly Boat[], boat: Boat): boolean {
  for (let i = 0; i < boats.length; i++) if (boats[i] === boat) return true;
  return false;
}

// ---- battle: bots spreading out instead of ganging up ----
/**
 * Who each computer boat is chasing right now: botBoatId -> targetBoatId. One small map per match
 * (looked up by that match's boat list), so a new match never inherits an old one's entries and
 * the map is freed along with the match.
 */
const chasing = new WeakMap<readonly Boat[], Map<number, number>>();

/** This match's chase registry, with entries whose bot or target is no longer on the water removed. */
function chaseRegistry(boats: readonly Boat[]): Map<number, number> {
  let reg = chasing.get(boats);
  if (!reg) {
    reg = new Map<number, number>();
    chasing.set(boats, reg);
  }
  for (const [botId, targetId] of reg) {
    if (!hasBoatId(boats, botId) || !hasBoatId(boats, targetId)) reg.delete(botId);
  }
  return reg;
}

function hasBoatId(boats: readonly Boat[], id: number): boolean {
  for (let i = 0; i < boats.length; i++) if (boats[i].id === id) return true;
  return false;
}

/** How many bots other than `selfId` are currently chasing `targetId`. */
function countChasers(reg: ReadonlyMap<number, number>, selfId: number, targetId: number): number {
  let n = 0;
  for (const [botId, chased] of reg) if (botId !== selfId && chased === targetId) n++;
  return n;
}

/**
 * Score multiplier (bigger = less tempting) for a boat that `others` other bots already chase.
 * One chaser is only a nudge (x1.5); two or more swamp the usual distance and "tasty human"
 * differences (x3.5, x7), so the third bot picks somebody else unless it has no other choice.
 */
function crowdPenalty(others: number): number {
  return 1 + 0.5 * others + 0.75 * others * (others - 1);
}

class Bot implements Controller {
  readonly kind = 'bot' as const;

  private readonly skill: Skill;
  private readonly me: Personality;
  private readonly rng: () => number;
  /** Makes each bot like a different set of crates. */
  private readonly crateTaste: number;
  /** Shooting limits, kept inside what the blaster's aim assist can actually lock onto. */
  private readonly fireStart: number;
  private readonly fireStop: number;
  private readonly fireRange: number;

  private readonly out: BoatControls = { throttle: 0, steer: 0, fire: false, boost: false };
  private readonly avoid = new Avoider();

  private clock = 0;

  // ---- smoothed outputs ----
  private steer = 0;
  private throttle = 0;
  private boosting = false;
  private boostHold = 0;

  // ---- this frame's plan (written by planBattle/planRace, read by update) ----
  private planDesired = 0;
  private planThrottle = 1;
  /** 0..1: how sharp a bend is coming (race). */
  private planBrake = 0;
  private planBoost = false;
  /** A boat the avoidance rays should ignore (the one we are chasing). */
  private planIgnore: Boat | null = null;
  /** Finished racing: just cruise. */
  private cruising = false;

  // ---- unstick ----
  private stuckFor = 0;
  private reverseLeft = 0;
  private reverseSteer = 1;
  private lastUnstickAt = -100;
  private unstickGrace = 0;
  private hasMoved = false;

  // ---- hit reaction ----
  private wasStunned = false;
  private escapeLeft = 0;
  private escapeBoost = false;
  private evadeLeft = 0;
  private evadeHeading = 0;

  // ---- battle: target and what the bot "sees" of it ----
  private target: Boat | null = null;
  private retargetIn = 0;
  private perceiveIn = 0;
  private seenAt = 0;
  private seenX = 0;
  private seenZ = 0;
  private seenVX = 0;
  private seenVZ = 0;
  private strafe: number;
  private peelLeft = 0;
  /** 0..1: how much of the sideways strafe curve we use right now (see planBattle). */
  private strafeMix = 0;
  private boostPermit = false;
  private aimErr = 0;
  private aimErrGoal = 0;
  private aimErrIn = 0;

  // ---- race: noticing that we keep missing a gate ----
  private gateX = 0;
  private gateZ = 0;
  private gateTime = 0;

  // ---- power-up crate detour ----
  private hasGoal = false;
  private goalX = 0;
  private goalZ = 0;
  private goalLeft = 0;
  private goalScanIn = 0;

  // ---- wandering (no target) ----
  private wanderX = 0;
  private wanderZ = 0;
  private wanderLeft = 0;

  // ---- shooting ----
  private firing = false;
  private alignedFor = 0;
  private burstOpen = true;
  private burstLeft = 0;

  constructor(difficulty: BotDifficulty, seed: number) {
    this.skill = SKILLS[difficulty] ?? SKILLS.normal;
    this.rng = makeRng(seed);
    this.me = makePersonality(this.rng, this.skill);
    this.crateTaste = this.rng() * 100;
    this.strafe = this.me.strafe;

    // Never ask for a cone or range wider than the blaster's aim assist can lock onto.
    this.fireStop = Math.min(this.skill.fireStopDeg, CONFIG.blaster.aimAssistDeg - 1) * DEG;
    this.fireStart = Math.min(this.skill.fireStartDeg * DEG, this.fireStop - 2 * DEG);
    this.fireRange = Math.min(this.skill.fireRange, CONFIG.blaster.aimAssistRange - 4);

    this.boostPermit = this.rng() < this.skill.boostChance;
    this.burstLeft = this.skill.burstOnMin;
    this.wanderLeft = 0;
  }

  update(ctx: ControllerContext, dt: number): BoatControls {
    const out = this.out;
    if (!(dt > 0)) return out;
    if (dt > MAX_DT) dt = MAX_DT;
    this.clock += dt;

    const self = ctx.self;
    const sk = this.skill;

    // Notice being tagged (the boat becomes "stunned"). Only battles care.
    const stunned = self.stunned;
    if (stunned && !this.wasStunned && ctx.mode === 'battle') this.onTagged(self.heading);
    this.wasStunned = stunned;

    // Stuck on something? Reversing takes over everything until we are free.
    if (this.runUnstick(ctx, dt)) return out;

    this.escapeLeft = Math.max(0, this.escapeLeft - dt);
    this.evadeLeft = Math.max(0, this.evadeLeft - dt);
    this.updateAimWobble(dt);

    // ---- 1. PLAN ----
    this.planDesired = self.heading;
    this.planThrottle = 1;
    this.planBrake = 0;
    this.planBoost = false;
    this.planIgnore = null;
    this.cruising = false;
    if (ctx.mode === 'race') this.planRace(ctx, dt);
    else this.planBattle(ctx, dt);

    // ---- 2. AVOID ----
    // Look farther ahead the faster we go (a boat at 22 m/s needs about 30 m to swing around a rock).
    const look = clamp(Math.abs(self.speed) * 1.3 + 8, 12, 42) * sk.lookScale;
    this.avoid.pick(self, ctx.boats, this.planIgnore, ctx.world, this.planDesired, look);

    // ---- 3. STEER ----
    // turnRight > 0 means "the wanted heading is to my right", so steer positive.
    const turnRight = turnRightAngle(self.heading, this.avoid.heading);
    const wantSteer = clamp(turnRight * sk.steerGain, -1, 1);
    // The wheel can only swing so fast. This is what keeps the steering smooth, never twitchy.
    this.steer = moveToward(this.steer, wantSteer, sk.steerSlew * dt);

    // ---- 4. GO ----
    const turnAmount = Math.abs(turnRight);
    let wantThrottle: number;
    if (this.cruising) {
      wantThrottle = 0.4;
    } else {
      // Ease off for a sharp turn ahead, a hard turn right now, or cramped water. Take the
      // strictest of the three (not all three multiplied together).
      const forBend = lerp(1, sk.turnSlowFloor, this.planBrake);
      // (Count the heading we WANT as well as the one avoidance picked: a bot that needs to
      // turn right around should slow down so its turning circle gets tight.)
      const wantedTurn = Math.abs(turnRightAngle(self.heading, this.planDesired));
      const forTurn = lerp(1, sk.turnSlowFloor, smoothstep(0.7, 1.9, Math.max(turnAmount, wantedTurn)));
      // Islands and the lagoon edge are solid, so cramped water beside them slows us a lot.
      // Other boats move and the avoidance already steers round them: they only slow us a bit.
      const solidRoom = this.avoid.staticClearance;
      const crowdedRoom = Math.min(this.avoid.clearance, this.avoid.noseClearance);
      const forRoom = Math.min(lerp(0.45, 1, smoothstep(0.1, 0.6, solidRoom)), lerp(0.8, 1, smoothstep(0.1, 0.6, crowdedRoom)));
      wantThrottle = this.planThrottle * sk.throttleCap * Math.min(forBend, forTurn, forRoom);
    }
    this.updateBoost(self, turnAmount, dt);
    if (this.boosting) wantThrottle = 1;
    this.throttle = moveToward(this.throttle, wantThrottle, 3 * dt);

    // ---- 5. SHOOT ----
    const fire = this.cruising ? false : this.decideFire(ctx, dt);

    out.steer = this.steer;
    out.throttle = this.throttle;
    out.boost = this.boosting;
    out.fire = fire;
    return out;
  }

  // ───────────────────────────── Battle planning ─────────────────────────────

  private planBattle(ctx: ControllerContext, dt: number): void {
    const self = ctx.self;
    const sk = this.skill;
    const me = this.me;
    const px = self.position.x;
    const pz = self.position.z;

    // Re-think who to chase every 2-4 seconds (or right away if the target vanished).
    this.retargetIn -= dt;
    if (this.retargetIn <= 0 || (this.target !== null && !contains(ctx.boats, this.target))) {
      this.chooseTarget(ctx, px, pz);
    }

    // After being tagged: swerve away for a moment, boosting if we feel like it.
    if (this.escapeLeft > 0 && this.escapeBoost) this.planBoost = true;
    if (this.evadeLeft > 0) {
      this.planDesired = this.evadeHeading;
      return;
    }

    // A power-up crate worth a detour?
    if (this.followCrate(ctx, dt, px, pz)) return;

    const target = this.target;
    if (!target) {
      this.planWander(ctx, dt, px, pz);
      return;
    }

    // What the bot thinks it sees: a snapshot of the target that refreshes every
    // `reaction` seconds. Easy bots (0.5 s) react to old news, hard bots (0.1 s) barely lag.
    this.perceiveIn -= dt;
    if (this.perceiveIn <= 0) {
      this.seenX = target.position.x;
      this.seenZ = target.position.z;
      this.seenVX = target.velocity.x;
      this.seenVZ = target.velocity.z;
      this.seenAt = this.clock;
      this.perceiveIn = sk.reaction * (0.7 + 0.6 * this.rng());
    }
    const age = this.clock - this.seenAt;
    const tx = this.seenX + this.seenVX * age * sk.predict;
    const tz = this.seenZ + this.seenVZ * age * sk.predict;
    const dist = Math.hypot(tx - px, tz - pz);

    // Lead the target a little: aim where it is going, not where it is.
    const leadTime = sk.predict * clamp(dist / Math.max(Math.abs(self.speed) + 12, 14), 0, 1.2);
    const bearing = headingOf(tx - px, tz - pz); // straight at the target
    const bearingLead = headingOf(tx + this.seenVX * leadTime - px, tz + this.seenVZ * leadTime - pz);

    const range = me.preferredRange;
    const peelEnter = range * (PEEL_ENTER - PEEL_BOLDNESS * me.aggression);

    if (this.peelLeft > 0) {
      // Break away to the side after a close pass, so we do not ram the target.
      this.peelLeft -= dt;
      this.planDesired = bearing + this.strafe * PEEL_ANGLE;
      if (this.peelLeft <= 0 || (PEEL_SEC_MAX - this.peelLeft > PEEL_SEC_MIN && dist > range * PEEL_EXIT)) {
        this.peelLeft = 0;
        if (this.rng() < 0.5) this.strafe = -this.strafe; // sometimes come back from the other side
      }
    } else if (dist < peelEnter) {
      this.peelLeft = PEEL_SEC_MAX;
      this.planDesired = bearing + this.strafe * PEEL_ANGLE;
    } else {
      // Close in on the target. Inside the fighting range we curve to one side (the
      // "circle-strafe") instead of charging straight at it. The weave and aim error keep
      // the bot from being perfectly predictable.
      // The blaster only fires forward, so the sideways curve is mostly saved for while the
      // blaster is reloading; with darts in hand the bot keeps its nose near the target.
      const closeness = smoothstep(range * 1.25, range * 0.8, dist); // 0 far .. 1 close
      const reloading = self.ammo <= 0 || self.reloading;
      this.strafeMix += ((reloading ? 1 : STRAFE_ARMED) - this.strafeMix) * (1 - Math.exp(-dt / 0.25));
      const sideways = this.strafe * me.engageOffsetDeg * DEG * closeness * this.strafeMix;
      this.planDesired = bearingLead + sideways + this.aimErr + this.weave();
      if (dist > range * CHASE_FACTOR && this.boostPermit) this.planBoost = true;
    }
    if (dist > 10) this.planIgnore = target;
  }

  private chooseTarget(ctx: ControllerContext, px: number, pz: number): void {
    const self = ctx.self;
    const sk = this.skill;
    let best: Boat | null = null;
    let bestScore = Infinity;
    const boats = ctx.boats;
    const chasers = chaseRegistry(boats);
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      if (b.id === self.id) continue;
      // Nearest boat wins, with some randomness. Human boats are a slightly tastier target.
      // (ControllerContext has no scores, so "chase the leader" is not possible here.)
      let score = Math.hypot(b.position.x - px, b.position.z - pz) * (0.85 + 0.3 * this.rng());
      if (b.isHuman) score *= 0.88;
      if (b === this.target) score *= 0.8; // stick with the current target unless something is clearly better
      // Spread out: every OTHER bot already chasing this boat makes it a less tempting target.
      score *= crowdPenalty(countChasers(chasers, self.id, b.id));
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    // Tell the other bots who we picked (this overwrites our own previous pick).
    if (best) chasers.set(self.id, best.id);
    else chasers.delete(self.id);
    if (best !== this.target) {
      this.target = best;
      this.perceiveIn = 0; // take a fresh look at the new target
      this.peelLeft = 0;
    }
    this.retargetIn = 2 + 2 * this.rng();
    this.boostPermit = this.rng() < clamp(sk.boostChance * (0.6 + 0.8 * this.me.aggression), 0, 1);

    // Sometimes go for a power-up crate that is close by (less often while a fight is on).
    if (!this.hasGoal && ctx.pickups.length > 0) {
      let bestD2 = sk.pickupRange * sk.pickupRange;
      let bx = 0;
      let bz = 0;
      let found = false;
      for (let i = 0; i < ctx.pickups.length; i++) {
        const p = ctx.pickups[i];
        const d2 = (p.x - px) * (p.x - px) + (p.z - pz) * (p.z - pz);
        if (d2 < bestD2 && crateIsReachable(ctx, p.x, p.z)) {
          bestD2 = d2;
          bx = p.x;
          bz = p.z;
          found = true;
        }
      }
      if (found) {
        let eagerness = this.me.greed;
        if (best && Math.hypot(best.position.x - px, best.position.z - pz) < this.me.preferredRange * 1.1) eagerness *= 0.35;
        if (this.rng() < eagerness) this.startCrateDetour(bx, bz, 8);
      }
    }
  }

  /** Nobody to chase: cruise between random spots in the middle of the lagoon. */
  private planWander(ctx: ControllerContext, dt: number, px: number, pz: number): void {
    this.wanderLeft -= dt;
    const dx = this.wanderX - px;
    const dz = this.wanderZ - pz;
    if (this.wanderLeft <= 0 || dx * dx + dz * dz < 14 * 14) {
      const world = ctx.world;
      for (let attempt = 0; attempt < 4; attempt++) {
        const a = this.rng() * TWO_PI;
        const r = world.arenaRadius * (0.2 + 0.4 * this.rng());
        this.wanderX = Math.sin(a) * r;
        this.wanderZ = Math.cos(a) * r;
        let free = true;
        for (let i = 0; i < world.obstacles.length; i++) {
          const o = world.obstacles[i];
          const ox = o.x - this.wanderX;
          const oz = o.z - this.wanderZ;
          const clear = o.radius + 8;
          if (ox * ox + oz * oz < clear * clear) {
            free = false;
            break;
          }
        }
        if (free) break;
      }
      this.wanderLeft = 6 + 4 * this.rng();
    }
    this.planDesired = headingOf(this.wanderX - px, this.wanderZ - pz);
    this.planThrottle = 0.8;
  }

  // ───────────────────────────── Race planning ─────────────────────────────

  private planRace(ctx: ControllerContext, dt: number): void {
    const next = ctx.nextCheckpoint;
    const self = ctx.self;
    const px = self.position.x;
    const pz = self.position.z;

    if (!next) {
      this.planCruise(self, ctx);
      return;
    }

    // Circling a gate without ever passing it (too fast to turn in, or crowded out)? After a
    // few seconds, calm down: aim dead center, no boost, and slow right down until it is passed.
    if (next.position.x !== this.gateX || next.position.z !== this.gateZ) {
      this.gateX = next.position.x;
      this.gateZ = next.position.z;
      this.gateTime = 0;
    }
    const gateDist = Math.hypot(next.position.x - px, next.position.z - pz);
    if (gateDist < GATE_NEAR) this.gateTime += dt;
    const lost = this.gateTime > GATE_LOST_SEC;

    // Aim a bit to one side of the gate's middle (each bot has its own lane) so the pack
    // spreads out instead of everyone piling into the same spot.
    const lane = lost ? 0 : this.me.lane * next.radius * 0.4;
    const nx = next.position.x - Math.cos(next.heading) * lane; // (-cos h, sin h) is the gate's right-hand side
    const nz = next.position.z + Math.sin(next.heading) * lane;
    const vx = nx - px;
    const vz = nz - pz;
    const distNext = Math.hypot(vx, vz);

    // The racing line: as we near this gate, start leaning toward the one after it so the
    // turn is wide and smooth. The lean is capped so the line still passes through the gate.
    let ax = nx;
    let az = nz;
    let bend = 0; // how sharply the course turns at the next gate, radians
    const follow = ctx.followingCheckpoint;
    if (follow) {
      const ux = follow.position.x - nx;
      const uz = follow.position.z - nz;
      bend = Math.abs(wrapPi(headingOf(ux, uz) - headingOf(vx, vz)));
      let lean = lost ? 0 : 0.5 * smoothstep(60, 20, distNext);
      const maxMiss = next.radius * 0.5; // the line may miss the gate's center by at most this
      for (let i = 0; i < 3; i++) {
        const awx = vx + lean * ux;
        const awz = vz + lean * uz;
        const len = Math.hypot(awx, awz) || 1;
        const miss = Math.abs(vx * awz - vz * awx) / len; // sideways distance from the gate's center to our line
        if (miss <= maxMiss) break;
        lean *= (maxMiss / miss) * 0.9;
      }
      ax = nx + lean * ux;
      az = nz + lean * uz;
    }
    const aimBearing = headingOf(ax - px, az - pz);
    this.planDesired = aimBearing + (lost ? 0 : this.weave() * 0.4);
    if (lost) this.planThrottle = 0.55;

    // Slow down for a sharp bend that is close.
    this.planBrake = smoothstep(1.0, 2.4, bend) * smoothstep(55, 18, distNext);

    // Boost on long, fairly straight stretches. Easy bots mostly skip it.
    const sk = this.skill;
    const straightish = bend < 0.7 || distNext > 55;
    const willing = sk.boostChance >= 0.5 || this.me.boostLove > 0.85;
    if (willing && straightish && distNext > sk.raceBoostMinDist && !lost) this.planBoost = true;

    // Grab a crate if one is right on the way.
    this.goalScanIn -= dt;
    if (!this.hasGoal && this.goalScanIn <= 0) {
      this.goalScanIn = 0.4;
      this.scanRaceCrates(ctx, px, pz, aimBearing);
    }
    if (this.hasGoal) {
      const off = Math.abs(wrapPi(headingOf(this.goalX - px, this.goalZ - pz) - aimBearing));
      if (off > 1) this.hasGoal = false; // it is no longer on the way
      else if (this.followCrate(ctx, dt, px, pz)) this.planBoost = false;
    }
  }

  private scanRaceCrates(ctx: ControllerContext, px: number, pz: number, aimBearing: number): void {
    let bestD2 = RACE_PICKUP_RANGE * RACE_PICKUP_RANGE;
    for (let i = 0; i < ctx.pickups.length; i++) {
      const p = ctx.pickups[i];
      const dx = p.x - px;
      const dz = p.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD2) continue;
      if (Math.abs(wrapPi(headingOf(dx, dz) - aimBearing)) > RACE_PICKUP_CONE) continue;
      if (this.crateAppeal(p.x, p.z) >= this.me.greed) continue;
      if (!crateIsReachable(ctx, p.x, p.z)) continue;
      bestD2 = d2;
      this.startCrateDetour(p.x, p.z, 5);
    }
  }

  /** The race is over for this boat: potter about gently in the middle of the lagoon. */
  private planCruise(self: Boat, ctx: ControllerContext): void {
    const px = self.position.x;
    const pz = self.position.z;
    const limit = ctx.world.arenaRadius * 0.6;
    if (px * px + pz * pz > limit * limit) this.planDesired = headingOf(-px, -pz);
    else this.planDesired = self.heading + Math.sin(this.clock * 0.5) * 0.4;
    this.cruising = true;
  }

  // ───────────────────────────── Power-up crates ─────────────────────────────

  private startCrateDetour(x: number, z: number, seconds: number): void {
    this.hasGoal = true;
    this.goalX = x;
    this.goalZ = z;
    this.goalLeft = seconds;
  }

  /** Steer at the crate we picked. Returns false once it is collected, gone, or took too long. */
  private followCrate(ctx: ControllerContext, dt: number, px: number, pz: number): boolean {
    if (!this.hasGoal) return false;
    this.goalLeft -= dt;
    const dx = this.goalX - px;
    const dz = this.goalZ - pz;
    if (this.goalLeft <= 0 || dx * dx + dz * dz < PICKUP_ARRIVE * PICKUP_ARRIVE || !this.crateStillThere(ctx)) {
      this.hasGoal = false;
      return false;
    }
    this.planDesired = headingOf(dx, dz);
    return true;
  }

  private crateStillThere(ctx: ControllerContext): boolean {
    const list = ctx.pickups;
    for (let i = 0; i < list.length; i++) {
      if (Math.abs(list[i].x - this.goalX) < 1 && Math.abs(list[i].z - this.goalZ) < 1) return true;
    }
    return false;
  }

  /** A steady 0..1 number for each crate position, so a bot always likes or dislikes the same crate. */
  private crateAppeal(x: number, z: number): number {
    const h = Math.sin(x * 12.9898 + z * 78.233 + this.crateTaste) * 43758.5453;
    return h - Math.floor(h);
  }

  // ───────────────────────────── Reactions and wobble ─────────────────────────────

  private onTagged(heading: number): void {
    const sk = this.skill;
    this.escapeLeft = 1.8;
    this.escapeBoost = this.rng() < Math.min(1, sk.boostChance * 1.5);
    if (this.rng() < sk.evadeChance) {
      const side = this.rng() < 0.5 ? -1 : 1;
      this.evadeHeading = heading + side * (60 + 35 * this.rng()) * DEG;
      this.evadeLeft = 0.7 + 0.4 * this.rng();
      if (this.rng() < 0.5) this.strafe = -this.strafe;
    }
  }

  /** A gentle left-right sway so the bot does not drive like it is on rails. */
  private weave(): number {
    return Math.sin(this.clock * TWO_PI * this.me.wobbleHz + this.me.wobblePhase) * this.me.wobbleDeg * DEG;
  }

  /** The bot's aiming error drifts to a new random value now and then (never jumps). */
  private updateAimWobble(dt: number): void {
    this.aimErrIn -= dt;
    if (this.aimErrIn <= 0) {
      this.aimErrGoal = (this.rng() * 2 - 1) * this.skill.aimErrorDeg * DEG;
      this.aimErrIn = 0.6 + 0.6 * this.rng();
    }
    this.aimErr += (this.aimErrGoal - this.aimErr) * (1 - Math.exp(-dt / 0.3));
  }

  // ───────────────────────────── Boost ─────────────────────────────

  private updateBoost(self: Boat, turnAmount: number, dt: number): void {
    const sk = this.skill;
    const turbo = self.powerUp !== null && self.powerUp.kind === 'turbo';
    // Only boost when pointing nearly straight at open water: boosting through a turn is a crash.
    const straight = turnAmount < 0.18 && this.avoid.clearance > 0.85 && this.avoid.noseClearance > 0.85;
    const want = !this.cruising && (this.planBoost || turbo) && straight;
    const meter = turbo ? 1 : self.boost;

    if (this.boosting) {
      this.boostHold -= dt;
      // Keep going for at least half a second, but stop at once if the meter is nearly empty
      // or something is suddenly close ahead.
      if (meter < sk.boostOff || this.avoid.clearance < 0.4 || (!want && this.boostHold <= 0)) this.boosting = false;
    } else if (want) {
      const needed = this.escapeLeft > 0 ? Math.min(sk.boostOn, 0.2) : sk.boostOn;
      if (meter >= needed) {
        this.boosting = true;
        this.boostHold = 0.5;
      }
    }
  }

  // ───────────────────────────── Shooting ─────────────────────────────

  /**
   * Fire when any other boat is lined up with the nose and in range. The blaster's own aim
   * assist does the precise aiming; the bot just has to point roughly the right way.
   */
  private decideFire(ctx: ControllerContext, dt: number): boolean {
    const self = ctx.self;
    const sk = this.skill;
    const px = self.position.x;
    const pz = self.position.z;
    const fx = Math.sin(self.heading); // forward = (sin h, 0, cos h)
    const fz = Math.cos(self.heading);
    // Once we are shooting, allow a slightly wider cone so the stream does not flicker.
    const tanCone = Math.tan(this.firing ? this.fireStop : this.fireStart);
    const range2 = this.fireRange * this.fireRange;

    let aligned = false;
    const boats = ctx.boats;
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      if (b.id === self.id) continue;
      const dx = b.position.x - px;
      const dz = b.position.z - pz;
      const ahead = dx * fx + dz * fz; // distance along the nose
      if (ahead <= 1 || dx * dx + dz * dz > range2) continue;
      const sideways = Math.abs(dx * fz - dz * fx); // distance off to the side of the nose line
      if (sideways <= ahead * tanCone) {
        aligned = true;
        break;
      }
    }

    // The bot only reacts after it has had the boat lined up for a moment.
    this.alignedFor = aligned ? this.alignedFor + dt : 0;
    let fire = aligned && this.alignedFor >= sk.reaction * 0.3;

    // No darts left (and no Rapid Fire): do not hold the button down.
    if (fire && self.ammo <= 0 && !(self.powerUp !== null && self.powerUp.kind === 'rapid')) fire = false;

    // Easier bots shoot in short bursts with pauses in between.
    if (sk.burstOffMax > 0) {
      this.burstLeft -= dt;
      if (this.burstLeft <= 0) {
        this.burstOpen = !this.burstOpen;
        this.burstLeft = this.burstOpen
          ? lerp(sk.burstOnMin, sk.burstOnMax, this.rng())
          : lerp(sk.burstOffMin, sk.burstOffMax, this.rng());
      }
      if (!this.burstOpen) fire = false;
    }

    this.firing = fire;
    return fire;
  }

  // ───────────────────────────── Unstick ─────────────────────────────

  /** Returns true while the bot is busy backing out of trouble (the outputs are already set). */
  private runUnstick(ctx: ControllerContext, dt: number): boolean {
    const out = this.out;
    const self = ctx.self;

    if (this.reverseLeft > 0) {
      this.reverseLeft -= dt;
      out.throttle = -1;
      out.steer = this.reverseSteer;
      out.boost = false;
      out.fire = false;
      if (this.reverseLeft <= 0) {
        // Free again: start from a calm state and give the new heading a moment to work.
        this.steer = 0;
        this.throttle = 0;
        this.boosting = false;
        this.stuckFor = 0;
        this.unstickGrace = 1;
        this.avoid.reset();
      }
      return true;
    }

    this.unstickGrace = Math.max(0, this.unstickGrace - dt);
    if (Math.abs(self.speed) >= STUCK_SPEED) {
      this.hasMoved = true;
      this.stuckFor = 0;
      return false;
    }
    // Do not count time spent waiting at the start line (the countdown) as being stuck.
    if (!this.hasMoved && this.clock < 5) return false;
    if (this.unstickGrace > 0 || self.stunned) return false;
    // Only "stuck" if we were actually trying to drive forward.
    if (out.throttle < 0.3) return false;

    this.stuckFor += dt;
    const touching = nearSolid(self.position.x, self.position.z, self.radius, ctx.world, 3.5);
    if (this.stuckFor < (touching ? STUCK_NEAR_SEC : STUCK_FAR_SEC)) return false;

    // Back up while turning. Which way? Away from the side we were swerving to avoid, and
    // alternate if we keep getting stuck. (After the reverse, normal avoidance steers us out.)
    const swerved = this.avoid.lastOffset;
    let side = swerved > 0.05 ? -1 : swerved < -0.05 ? 1 : this.rng() < 0.5 ? -1 : 1;
    if (this.clock - this.lastUnstickAt < 6) side = -this.reverseSteer;
    this.reverseSteer = side;
    this.lastUnstickAt = this.clock;
    this.reverseLeft = 0.9 + 0.5 * this.rng();
    this.stuckFor = 0;
    out.throttle = -1;
    out.steer = side;
    out.boost = false;
    out.fire = false;
    return true;
  }
}

/** A computer-controlled captain. `seed` varies personality between bots. */
export function createBotController(difficulty: BotDifficulty, seed: number): Controller {
  return new Bot(difficulty, seed);
}
