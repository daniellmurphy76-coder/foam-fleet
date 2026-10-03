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
 * Teams (Team Up): a bot never chases or shoots a teammate, holds its fire while a teammate is
 * in the line of fire, and an ally prefers opponents that are close to its human buddy.
 *
 * Sharks: in Boats vs. Sharks the bots are HELPERS (`planSharks()`): they dart the shark closest to a
 * human, everybody piles onto the MEGA SHARK, they keep a safe distance and swerve away (boosting)
 * from a shark about to bump them. In the other games a bot mostly ignores sharks, steering round
 * one only when it is very close; a normal or hard bot may turn and dart a shark that is chasing it
 * (`planSharkDuel()`). Both use `engageShark()`.
 *
 * Difficulty and personality live in profile.ts. The math helpers are in steering.ts.
 *
 * Handy reminder (types.ts): steer +1 turns RIGHT, which DECREASES heading. All the sign
 * handling is in `turnRightAngle()` in steering.ts, with a worked example.
 */
import type { AimTarget, Boat, BotDifficulty, BoatControls, Controller, ControllerContext } from '../types';
import { CONFIG } from '../config';
import {
  Avoider,
  DEG,
  MEGA_SHARK_RADIUS,
  clamp,
  headingOf,
  lerp,
  moveToward,
  nearSolid,
  sharkBumpGap,
  smoothstep,
  turnRightAngle,
  wrapPi,
} from './steering';
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

// ---- teams (Team Up) ----
// `Boat.team` is the boat's own id in free-for-all modes, so "same team" never matches another
// boat there and the rules below only bite in Team Up.
/** Hold fire when a teammate is in the line of fire within this many meters. */
const HOLD_FIRE_M = 25;
/** A teammate is "in the way" if the darts would pass within its hit radius plus this much. */
const HOLD_FIRE_LANE_PAD = 0.8;
/** An ally weighs an opponent this much (x) when that opponent is right next to a human buddy... */
const GUARD_FACTOR = 0.45;
/** ...within GUARD_NEAR meters of the human; the pull fades out to nothing by GUARD_FAR meters. */
const GUARD_NEAR = 15;
const GUARD_FAR = 55;

// ---- sharks ----
const NO_SHARKS: readonly AimTarget[] = [];
/** A helper keeps this far (meters) from the shark it is darting: near enough to hit, far enough to dodge. */
const SHARK_RANGE_MIN = 15;
const SHARK_RANGE_MAX = 25;
/** Cruising sharks swim at about 5 m/s, chasing ones at 9 or more: faster than this means "chasing". */
const SHARK_CHASE_SPEED = 8;
/** A chasing shark this close and swimming our way is "chasing me" (games where sharks are only a nuisance). */
const SHARK_NOTICE_M = 20;
/** Helpers only go out to sharks within this many meters of a human; farther ones are left to come to us. */
const SHARK_LEASH_M = 70;
/** A shark this close to a human is a fight right now: no crate detours. */
const SHARK_URGENT_M = 45;
/** Holding the nose on a shark: throttle drops to this share as the gap closes, so we stay at range. */
const SHARK_STAND_THROTTLE = 0.45;
/** Swerving away from a bump: this far (degrees) from the line to the shark (125 = mostly sideways, a bit away). */
const DODGE_ANGLE = 125 * DEG;
/** After the danger passes the swerve (and the boost) lasts this long. */
const DODGE_TAIL_SEC = 0.4;
/**
 * How much room a boat wants before it swerves: the shark's bump gap plus a margin, plus how far the shark
 * (DODGE_SHARK_SEC of its speed toward us) and we (DODGE_SELF_SEC of ours toward it) travel while we swing round.
 * Small enough that a helper still gets its shots in as a shark comes at it, big enough that it mostly gets away.
 */
const DODGE_MARGIN = 1.5;
const DODGE_SHARK_SEC = 0.6;
const DODGE_SELF_SEC = 0.35;
/** Turning on a chasing shark (other games): give up after this long, or when it is this far away. */
const DUEL_MAX_SEC = 5;
const DUEL_GIVE_UP_M = 32;
const DUEL_COOLDOWN_SEC = 3;
/** Helpers wait between waves in a loose ring this far from the nearest human. */
const ESCORT_MIN = 14;
const ESCORT_MAX = 22;

/** Distance from (x, z) to the nearest human boat (any team, `self` included if it is one); Infinity if there are none. */
function distToAnyHuman(boats: readonly Boat[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < boats.length; i++) {
    if (!boats[i].isHuman) continue;
    const d = Math.hypot(boats[i].position.x - x, boats[i].position.z - z);
    if (d < best) best = d;
  }
  return best;
}

/** The live shark with this id, or null (sharks that dive leave the list). */
function findShark(sharks: readonly AimTarget[], id: number): AimTarget | null {
  for (let i = 0; i < sharks.length; i++) if (sharks[i].id === id) return sharks[i];
  return null;
}

/** Distance from (x, z) to the nearest HUMAN teammate of `self` (not counting itself); Infinity if it has none. */
function distToHumanBuddy(boats: readonly Boat[], self: Boat, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < boats.length; i++) {
    const h = boats[i];
    if (!h.isHuman || h.id === self.id || h.team !== self.team) continue;
    const d = Math.hypot(h.position.x - x, h.position.z - z);
    if (d < best) best = d;
  }
  return best;
}

/** Is the point (dx, dz), measured from the shooter, within `lane` meters of the ray (ux, uz) and 1..`reach` meters along it? */
function inLane(dx: number, dz: number, ux: number, uz: number, reach: number, lane: number): boolean {
  const ahead = dx * ux + dz * uz;
  if (ahead <= 1 || ahead > reach) return false;
  return Math.abs(dx * uz - dz * ux) <= lane;
}

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

  /** Bots never use the rescue or honk buttons (they get unstuck on their own). */
  private readonly out: BoatControls = { throttle: 0, steer: 0, fire: false, boost: false, rescue: false, honk: false };
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

  // ---- sharks: target, what the bot "sees" of it, and dodging ----
  /** Id of the shark we are darting (Boats vs. Sharks), or -1. */
  private sharkId = -1;
  private sharkRetargetIn = 0;
  private sPerceiveIn = 0;
  private sSeenAt = 0;
  private sSeenX = 0;
  private sSeenZ = 0;
  private sSeenVX = 0;
  private sSeenVZ = 0;
  private sPeelLeft = 0;
  private sStrafeMix = 0;
  private dodgeLeft = 0;
  private dodgeHeading = 0;
  private dodgeSide = 1;
  private threatFor = 0;
  /** Which way round the human we circle while waiting for sharks: -1 or +1. */
  private escortDir: number;
  private escortRadius: number;
  /** Other games: the chasing shark we decided to fight (-1 = none), for how long, and the one we decided to ignore. */
  private duelId = -1;
  private duelLeft = 0;
  private duelCool = 0;
  private declinedId = -1;

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

    // (Rolled last, so adding sharks did not change what the older rolls above give for a seed.)
    this.escortDir = this.rng() < 0.5 ? -1 : 1;
    this.escortRadius = lerp(ESCORT_MIN, ESCORT_MAX, this.rng());
  }

  update(ctx: ControllerContext, dt: number): BoatControls {
    const out = this.out;
    if (!(dt > 0)) return out;
    if (dt > MAX_DT) dt = MAX_DT;
    this.clock += dt;

    const self = ctx.self;
    const sk = this.skill;

    // Notice being tagged (the boat becomes "stunned"). Battles and Team Up care; in a race a hit is only a stun.
    // In Boats vs. Sharks a bump is what stuns a helper: it swerves away like it was tagged.
    const stunned = self.stunned;
    if (stunned && !this.wasStunned && (ctx.mode === 'battle' || ctx.mode === 'team' || ctx.mode === 'sharks')) {
      this.onTagged(self.heading);
    }
    this.wasStunned = stunned;
    const sharks = ctx.sharks ?? NO_SHARKS;

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
    else if (ctx.mode === 'sharks') this.planSharks(ctx, dt);
    else this.planBattle(ctx, dt);
    // Sharks only bother the other games when one chases us, and then only a bot that is up to it turns on it.
    if (ctx.mode !== 'sharks') this.planSharkDuel(ctx, dt);

    // ---- 2. AVOID ----
    // Look farther ahead the faster we go (a boat at 22 m/s needs about 30 m to swing around a rock).
    // Sharks count too, but only when they are very close.
    const look = clamp(Math.abs(self.speed) * 1.3 + 8, 12, 42) * sk.lookScale;
    this.avoid.pick(self, ctx.boats, this.planIgnore, ctx.world, this.planDesired, look, sharks);

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
      if (b.team === self.team) continue; // never chase a teammate
      // Nearest boat wins, with some randomness. Human boats are a slightly tastier target.
      // (ControllerContext has no scores, so "chase the leader" is not possible here.)
      let score = Math.hypot(b.position.x - px, b.position.z - pz) * (0.85 + 0.3 * this.rng());
      if (b.isHuman) score *= 0.88;
      if (b === this.target) score *= 0.8; // stick with the current target unless something is clearly better
      // Team Up allies look after their human buddy: opponents hovering near the human look closer.
      // (Always 1 for a bot with no human teammate.)
      const guard = smoothstep(GUARD_NEAR, GUARD_FAR, distToHumanBuddy(boats, self, b.position.x, b.position.z));
      score *= lerp(GUARD_FACTOR, 1, guard);
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
    let eagerness = this.me.greed;
    if (best && Math.hypot(best.position.x - px, best.position.z - pz) < this.me.preferredRange * 1.1) eagerness *= 0.35;
    this.considerCrate(ctx, px, pz, eagerness);
  }

  /** Maybe start a detour to the nearest reachable crate within this bot's pickup range (`eagerness` = the chance, 0..1). */
  private considerCrate(ctx: ControllerContext, px: number, pz: number, eagerness: number): void {
    if (this.hasGoal || ctx.pickups.length === 0) return;
    let bestD2 = this.skill.pickupRange * this.skill.pickupRange;
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
    if (found && this.rng() < eagerness) this.startCrateDetour(bx, bz, 8);
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

  // ───────────────────────────── Sharks ─────────────────────────────

  /**
   * Boats vs. Sharks: this bot is a helper. In order: swerve away from a shark about to bump us; dart the
   * shark closest to a human (the MEGA SHARK first, for everybody); with no shark to deal with, grab a
   * crate or wait near a human.
   */
  private planSharks(ctx: ControllerContext, dt: number): void {
    const self = ctx.self;
    const sharks = ctx.sharks ?? NO_SHARKS;
    const px = self.position.x;
    const pz = self.position.z;

    // After being bumped: swerve away for a moment, boosting if we feel like it.
    if (this.escapeLeft > 0 && this.escapeBoost) this.planBoost = true;
    if (this.evadeLeft > 0) {
      this.planDesired = this.evadeHeading;
      return;
    }
    // A shark about to bump us beats everything else.
    if (this.dodgeSharks(ctx, dt, sharks)) return;

    // Re-think which shark to go after every second or two (or right away if it dove).
    this.sharkRetargetIn -= dt;
    let shark = this.sharkId >= 0 ? findShark(sharks, this.sharkId) : null;
    if (this.sharkRetargetIn <= 0 || (this.sharkId >= 0 && !shark)) {
      this.chooseShark(ctx, px, pz, sharks);
      shark = this.sharkId >= 0 ? findShark(sharks, this.sharkId) : null;
    }

    // A crate is fine while no shark is near a human.
    const urgent = shark !== null && distToAnyHuman(ctx.boats, shark.position.x, shark.position.z) < SHARK_URGENT_M;
    if (!urgent && this.followCrate(ctx, dt, px, pz)) return;

    if (shark) this.engageShark(ctx, dt, shark);
    else this.planEscort(ctx, dt, px, pz);
  }

  /** The shark to dart: the MEGA SHARK if it is out, else the one closest to a human (protect the players). */
  private chooseShark(ctx: ControllerContext, px: number, pz: number, sharks: readonly AimTarget[]): void {
    let best = -1;
    let bestScore = Infinity;
    let bestGuard = Infinity;
    for (let i = 0; i < sharks.length; i++) {
      const s = sharks[i];
      const mine = Math.hypot(s.position.x - px, s.position.z - pz);
      // How far it is from the people we protect (from us, when no human is around).
      let guard = distToAnyHuman(ctx.boats, s.position.x, s.position.z);
      if (!Number.isFinite(guard)) guard = mine;
      if (guard > SHARK_LEASH_M) continue; // too far away: let it come to us
      let score = (guard + 0.15 * mine) * (0.9 + 0.2 * this.rng());
      if (s.radius > MEGA_SHARK_RADIUS) score *= 0.05; // everybody piles onto the MEGA SHARK
      if (s.id === this.sharkId) score *= 0.8; // stick with this one unless another is clearly closer
      if (score < bestScore) {
        bestScore = score;
        best = s.id;
        bestGuard = guard;
      }
    }
    if (best !== this.sharkId) {
      this.sharkId = best;
      this.sPerceiveIn = 0; // take a fresh look at the new shark
      this.sPeelLeft = 0;
    }
    this.sharkRetargetIn = 1 + 1.5 * this.rng();
    this.boostPermit = this.rng() < clamp(this.skill.boostChance * (0.6 + 0.8 * this.me.aggression), 0, 1);

    // With no shark near a human, a crate close by is worth a detour.
    if (bestGuard >= SHARK_URGENT_M) this.considerCrate(ctx, px, pz, this.me.greed);
  }

  /**
   * Fight one shark: close in until we are at a safe range (15-25 m, never inside its bump reach), keep the nose
   * on it and shoot, curve round it while the blaster reloads, and break away if it gets too close. A shark only
   * counts as an obstacle for avoidance when very close (see Avoider), so steering straight at it is fine.
   */
  private engageShark(ctx: ControllerContext, dt: number, shark: AimTarget): void {
    const self = ctx.self;
    const sk = this.skill;
    const me = this.me;
    const px = self.position.x;
    const pz = self.position.z;

    // Steer by a snapshot of the shark that refreshes every `reaction` seconds (stale news = slower bot).
    this.sPerceiveIn -= dt;
    if (this.sPerceiveIn <= 0 || this.clock - this.sSeenAt > 1) {
      this.sSeenX = shark.position.x;
      this.sSeenZ = shark.position.z;
      this.sSeenVX = shark.velocity.x;
      this.sSeenVZ = shark.velocity.z;
      this.sSeenAt = this.clock;
      this.sPerceiveIn = sk.reaction * (0.7 + 0.6 * this.rng());
    }
    const age = this.clock - this.sSeenAt;
    const tx = this.sSeenX + this.sSeenVX * age * sk.predict;
    const tz = this.sSeenZ + this.sSeenVZ * age * sk.predict;
    const dist = Math.hypot(tx - px, tz - pz);
    const leadTime = sk.predict * clamp(dist / Math.max(Math.abs(self.speed) + 12, 14), 0, 1.2);
    const bearing = headingOf(tx - px, tz - pz);
    const bearingLead = headingOf(tx + this.sSeenVX * leadTime - px, tz + this.sSeenVZ * leadTime - pz);

    // The MEGA SHARK bumps from farther away, so stay a bit farther from it.
    const gap = sharkBumpGap(self.radius, shark);
    const base = clamp(me.preferredRange, SHARK_RANGE_MIN, SHARK_RANGE_MAX);
    const range = shark.radius > MEGA_SHARK_RADIUS ? Math.max(base, gap + 8) : base;
    const peelEnter = Math.max(gap + 4, range * 0.55);

    if (this.sPeelLeft > 0) {
      // Too close: break away to the side, then come back round for another run.
      this.sPeelLeft -= dt;
      this.planDesired = bearing + this.strafe * PEEL_ANGLE;
      if (this.sPeelLeft <= 0 || (PEEL_SEC_MAX - this.sPeelLeft > PEEL_SEC_MIN && dist > range * PEEL_EXIT)) {
        this.sPeelLeft = 0;
        if (this.rng() < 0.5) this.strafe = -this.strafe;
      }
    } else if (dist < peelEnter) {
      this.sPeelLeft = PEEL_SEC_MAX;
      this.planDesired = bearing + this.strafe * PEEL_ANGLE;
    } else {
      // Same idea as the battle circle-strafe: nose on the shark while the blaster is loaded, curving
      // round it while reloading.
      const closeness = smoothstep(range * 1.25, range * 0.8, dist); // 0 far .. 1 close
      const reloading = self.ammo <= 0 || self.reloading;
      this.sStrafeMix += ((reloading ? 1 : STRAFE_ARMED) - this.sStrafeMix) * (1 - Math.exp(-dt / 0.25));
      const sideways = this.strafe * me.engageOffsetDeg * DEG * closeness * this.sStrafeMix;
      this.planDesired = bearingLead + sideways + this.aimErr + this.weave();
      // Do not charge in: ease off as we come into range so we stay out of bump reach.
      this.planThrottle = lerp(1, SHARK_STAND_THROTTLE, smoothstep(range * 2, range * 1.1, dist));
      if (dist > range * CHASE_FACTOR && this.boostPermit) this.planBoost = true;
    }
  }

  /**
   * Is a shark about to bump us? If so (after a short "notice" delay, longer for easier bots) swerve away from
   * it and boost; the swerve outlasts the danger a little. Returns true while swerving.
   */
  private dodgeSharks(ctx: ControllerContext, dt: number, sharks: readonly AimTarget[]): boolean {
    const self = ctx.self;
    this.dodgeLeft = Math.max(0, this.dodgeLeft - dt);
    const threat = this.findThreat(self, sharks);
    if (threat) {
      this.threatFor += dt;
      if (this.threatFor >= this.skill.reaction * 0.3) {
        const toShark = headingOf(threat.position.x - self.position.x, threat.position.z - self.position.z);
        // Swing out to the side that is the shorter turn from the nose (and keep that side while dodging).
        if (this.dodgeLeft <= 0) this.dodgeSide = wrapPi(toShark - self.heading) > 0 ? -1 : 1;
        this.dodgeHeading = toShark + this.dodgeSide * DODGE_ANGLE;
        this.dodgeLeft = DODGE_TAIL_SEC;
      }
    } else {
      this.threatFor = 0;
    }
    if (this.dodgeLeft <= 0) return false;
    this.planDesired = this.dodgeHeading;
    this.planBoost = true;
    this.sPeelLeft = 0;
    return true;
  }

  /**
   * The shark closest to bumping us, or null. A shark is a danger when it is swimming and we are closing on each
   * other, and it is nearer than the room we need to turn away: its bump gap, plus the distance both of us
   * travel while the boat swings round (so a fast head-on approach counts from farther away).
   */
  private findThreat(self: Boat, sharks: readonly AimTarget[]): AimTarget | null {
    const px = self.position.x;
    const pz = self.position.z;
    let worst: AimTarget | null = null;
    let worstMargin = 0;
    for (let i = 0; i < sharks.length; i++) {
      const s = sharks[i];
      if (Math.hypot(s.velocity.x, s.velocity.z) < 2) continue; // not swimming at anybody
      const dx = s.position.x - px;
      const dz = s.position.z - pz;
      const dist = Math.hypot(dx, dz) || 0.01;
      const ux = dx / dist;
      const uz = dz / dist;
      const sharkIn = Math.max(0, -(s.velocity.x * ux + s.velocity.z * uz)); // how fast it comes at us
      const meIn = Math.max(0, self.velocity.x * ux + self.velocity.z * uz); // how fast we go at it
      if (sharkIn + meIn < 1) continue; // just passing by
      const room = sharkBumpGap(self.radius, s) + DODGE_MARGIN + sharkIn * DODGE_SHARK_SEC + meIn * DODGE_SELF_SEC;
      if (room - dist > worstMargin) {
        worstMargin = room - dist;
        worst = s;
      }
    }
    return worst;
  }

  /** No shark to fight: loop slowly round the nearest human, so the helpers are close when the sharks arrive. */
  private planEscort(ctx: ControllerContext, dt: number, px: number, pz: number): void {
    const self = ctx.self;
    let buddy: Boat | null = null;
    let buddyDist = Infinity;
    for (let i = 0; i < ctx.boats.length; i++) {
      const b = ctx.boats[i];
      if (!b.isHuman || b.id === self.id) continue;
      const d = Math.hypot(b.position.x - px, b.position.z - pz);
      if (d < buddyDist) {
        buddyDist = d;
        buddy = b;
      }
    }
    if (!buddy) {
      this.planWander(ctx, dt, px, pz);
      return;
    }
    const hx = buddy.position.x;
    const hz = buddy.position.z;
    const r = this.escortRadius;
    if (buddyDist > r * 2.5) {
      // Fell behind: catch up.
      this.planDesired = headingOf(hx - px, hz - pz);
      if (buddyDist > r * 4 && this.boostPermit) this.planBoost = true;
      return;
    }
    // Aim for a spot a little further round the ring from where we are.
    const here = Math.atan2(px - hx, pz - hz);
    const ahead = here + this.escortDir * 0.7;
    const limit = ctx.world.arenaRadius * 0.85;
    let gx = hx + Math.sin(ahead) * r;
    let gz = hz + Math.cos(ahead) * r;
    const gr = Math.hypot(gx, gz);
    if (gr > limit) {
      gx *= limit / gr;
      gz *= limit / gr;
    }
    if (!crateIsReachable(ctx, gx, gz)) this.escortDir = -this.escortDir; // that spot is on an island: go round the other way
    this.planDesired = headingOf(gx - px, gz - pz);
    this.planThrottle = 0.75;
  }

  /**
   * Games where sharks are only a nuisance: a shark swimming at us may be worth turning round for. Bots that are up
   * to it (normal and hard) roll the dice when a chase starts, then face the shark and shoot (swerving away if it
   * gets about to bump us). After the chase, or after a few seconds, the bot goes back to its game. A racer never
   * leaves the course: it only takes pot-shots at the chaser (see decideFire).
   */
  private planSharkDuel(ctx: ControllerContext, dt: number): void {
    const self = ctx.self;
    const sharks = ctx.sharks ?? NO_SHARKS;
    this.duelCool = Math.max(0, this.duelCool - dt);
    if (this.skill.sharkFight <= 0 || sharks.length === 0) {
      if (this.duelId >= 0) this.endDuel();
      this.declinedId = -1;
      return;
    }

    if (this.duelId >= 0) {
      this.duelLeft -= dt;
      const s = findShark(sharks, this.duelId);
      if (!s || this.duelLeft <= 0 || Math.hypot(s.position.x - self.position.x, s.position.z - self.position.z) > DUEL_GIVE_UP_M) {
        this.endDuel(); // it left, it gave up, or we did
      } else {
        if (ctx.mode !== 'race') {
          this.planBoost = false;
          this.planThrottle = 1;
          this.planIgnore = null;
          if (!this.dodgeSharks(ctx, dt, sharks)) this.engageShark(ctx, dt, s);
        }
        return;
      }
    }

    if (this.duelCool > 0) return;
    const chaser = this.chaserOf(self, sharks);
    if (!chaser) {
      this.declinedId = -1;
      return;
    }
    if (chaser.id === this.declinedId) return;
    if (this.rng() < this.skill.sharkFight) {
      this.duelId = chaser.id;
      this.duelLeft = DUEL_MAX_SEC;
      this.sPerceiveIn = 0;
      this.sPeelLeft = 0;
    } else {
      this.declinedId = chaser.id; // not this time: ignore this chase
    }
  }

  private endDuel(): void {
    this.duelId = -1;
    this.duelCool = DUEL_COOLDOWN_SEC;
    this.dodgeLeft = 0;
    this.threatFor = 0;
    this.sPeelLeft = 0;
  }

  /** A shark swimming at us (at chasing speed, pointed our way) within SHARK_NOTICE_M, or null. */
  private chaserOf(self: Boat, sharks: readonly AimTarget[]): AimTarget | null {
    let best: AimTarget | null = null;
    let bestDist = SHARK_NOTICE_M;
    for (let i = 0; i < sharks.length; i++) {
      const s = sharks[i];
      const dx = self.position.x - s.position.x; // from the shark to us
      const dz = self.position.z - s.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= bestDist) continue;
      const speed = Math.hypot(s.velocity.x, s.velocity.z);
      if (speed < SHARK_CHASE_SPEED) continue; // just cruising
      if ((s.velocity.x * dx + s.velocity.z * dz) / (speed * (dist || 1)) < 0.5) continue; // not pointed at us
      best = s;
      bestDist = dist;
    }
    return best;
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
      // Running from a tag or a shark bump, any boost in the tank will do.
      const needed = this.escapeLeft > 0 || this.dodgeLeft > 0 ? Math.min(sk.boostOn, 0.2) : sk.boostOn;
      if (meter >= needed) {
        this.boosting = true;
        this.boostHold = 0.5;
      }
    }
  }

  // ───────────────────────────── Shooting ─────────────────────────────

  /**
   * Fire when any other boat (or a shark we are after) is lined up with the nose and in range. The
   * blaster's own aim assist does the precise aiming; the bot just has to point roughly the right way.
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
      if (b.id === self.id || b.team === self.team) continue; // teammates are friends, not targets
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
    if (!aligned) aligned = this.sharkInCone(ctx, px, pz, fx, fz, tanCone, range2);

    // The bot only reacts after it has had the boat lined up for a moment.
    this.alignedFor = aligned ? this.alignedFor + dt : 0;
    let fire = aligned && this.alignedFor >= sk.reaction * 0.3;

    // No darts left (and no Rapid Fire): do not hold the button down.
    if (fire && self.ammo <= 0 && !(self.powerUp !== null && self.powerUp.kind === 'rapid')) fire = false;

    // A teammate right in the way? Hold your fire until they are clear.
    if (fire && this.teammateInLine(ctx)) fire = false;

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

  /**
   * Is a shark we are allowed to shoot at lined up with the nose? In Boats vs. Sharks every shark is fair game;
   * elsewhere only the one chasing us that we decided to fight (so a bot never wastes darts on the cruisers).
   * The shark's own size widens the cone a little (the dart only has to hit its hit-sphere).
   */
  private sharkInCone(ctx: ControllerContext, px: number, pz: number, fx: number, fz: number, tanCone: number, range2: number): boolean {
    const all = ctx.mode === 'sharks';
    if (!all && this.duelId < 0) return false;
    const sharks = ctx.sharks ?? NO_SHARKS;
    for (let i = 0; i < sharks.length; i++) {
      const s = sharks[i];
      if (!all && s.id !== this.duelId) continue;
      const dx = s.position.x - px;
      const dz = s.position.z - pz;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 1 || dx * dx + dz * dz > range2) continue;
      const sideways = Math.abs(dx * fz - dz * fx);
      if (sideways <= ahead * tanCone + s.radius * 0.5) return true;
    }
    return false;
  }

  /**
   * Is a teammate on the path the darts would take, within HOLD_FIRE_M? The darts fly toward the
   * boat or shark the blaster is locked onto, or straight ahead when nothing is locked. (Darts pass
   * through teammates anyway; holding fire just looks and feels friendlier.) A teammate beyond the
   * locked target is not in the way, so the check only reaches as far as that target.
   */
  private teammateInLine(ctx: ControllerContext): boolean {
    const self = ctx.self;
    const boats = ctx.boats;
    const px = self.position.x;
    const pz = self.position.z;
    let ux = Math.sin(self.heading);
    let uz = Math.cos(self.heading);
    let reach = HOLD_FIRE_M;
    if (self.aimTargetId !== null) {
      // The locked thing is a boat, or (id >= SHARK_ID_BASE) a shark.
      let lockX = 0;
      let lockZ = 0;
      let locked = false;
      for (let i = 0; i < boats.length && !locked; i++) {
        const b = boats[i];
        if (b.id !== self.aimTargetId) continue;
        lockX = b.position.x;
        lockZ = b.position.z;
        locked = true;
      }
      const sharks = ctx.sharks ?? NO_SHARKS;
      for (let i = 0; i < sharks.length && !locked; i++) {
        if (sharks[i].id !== self.aimTargetId) continue;
        lockX = sharks[i].position.x;
        lockZ = sharks[i].position.z;
        locked = true;
      }
      if (locked) {
        const dx = lockX - px;
        const dz = lockZ - pz;
        const d = Math.hypot(dx, dz);
        if (d > 1) {
          ux = dx / d;
          uz = dz / d;
          reach = Math.min(reach, d);
        }
      }
    }
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      if (b.id === self.id || b.team !== self.team) continue;
      if (inLane(b.position.x - px, b.position.z - pz, ux, uz, reach, b.hitRadius + HOLD_FIRE_LANE_PAD)) return true;
    }
    return false;
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
