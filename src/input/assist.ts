/**
 * Foam Fleet: the Easy Driving helper for human drivers.
 *
 * Two small jobs, both of which keep the boat easy to steer for a young captain:
 *   1. AUTO-CRUISE  - let go of everything and the boat keeps rolling at a gentle speed.
 *                     Go = full speed. Back = brake first, then reverse.
 *   2. BUMPER RAILS - look ahead along the way the boat is travelling. If an island or the
 *                     lagoon edge is coming up, nudge the steering toward the side with more
 *                     room (and ease off the gas when it is really close) so the boat
 *                     curves round the shore instead of crashing into it. The player is
 *                     always still in charge: their own steering is only turned down, never
 *                     taken away.
 *
 * The look-ahead ray is `probeSolid()` in ai/steering.ts (the same maths the bots use).
 * Steering convention (types.ts): steer +1 = turn RIGHT, which DECREASES heading, so the ray
 * at `heading + angle` is on the LEFT.
 */
import type { Boat, WorldQuery } from '../types';
import { CONFIG } from '../config';
import { clamp, headingOf, probeSolid } from '../ai/steering';

/** Look ahead for at least this many meters, or this many seconds of travel, whichever is more. */
const LOOK_MIN_M = 12;
const LOOK_SECONDS = 1.2;
/** The rails keep this far from an island (on top of its size and the boat's), and this far inside the edge. */
const OBSTACLE_MARGIN_M = 3;
const EDGE_INSET_M = 6;
/** Closer than this (and very urgent) and the gas is capped. */
const CAP_URGENCY = 0.8;
const CAP_DISTANCE_M = 6;
const CAP_THROTTLE = 0.4;
/**
 * Holding a hard turn this long eases off the gas so the boat turns tighter (like a kart game).
 * Without it a young driver holding "go" circles a balloon or buoy forever without reaching it.
 */
const CORNER_STEER = 0.7;
const CORNER_HOLD_SEC = 0.35;
const CORNER_THROTTLE = 0.5;
/** At full urgency the player's own steering counts this much less. */
const PLAYER_GIVE = 0.5;
/** Side probes: how far either side of the way ahead we peek, to find where the room is. */
const SIDE_NEAR_RAD = 0.45;
const SIDE_FAR_RAD = 0.9;
/** One side must have this much more room (0..1) before the nudge changes direction. */
const SIDE_TIE = 0.05;
/** The player is already turning toward a side with at least this much room: help them, don't fight them. */
const PLAYER_SIDE_OK = 0.85;
/** The player counts as "steering" past this much stick/key. */
const PLAYER_STEER_MIN = 0.25;
/** Going slower than this (m/s) we probe along the nose; faster, along the actual travel direction. */
const TRAVEL_DIR_SPEED = 3;
/** The nudge reacts fast, and lets go a little slower so the boat finishes its turn. */
const ATTACK_SEC = 0.06;
const RELEASE_SEC = 0.15;

/** Move `current` toward `target` with a time constant (fast when growing, slower when shrinking). */
function follow(current: number, target: number, dt: number): number {
  const tau = Math.abs(target) > Math.abs(current) ? ATTACK_SEC : RELEASE_SEC;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export class EasyAssist {
  /** The finished steering, throttle and brake flag. Valid until the next update(). */
  steer = 0;
  throttle = 0;
  /** True while the gas is capped for a close obstacle; the controller also lets go of boost. */
  braking = false;

  /** Smoothed 0..1: how soon the boat expects to hit something. */
  private urgency = 0;
  /** Smoothed sideways nudge (+ = right) before it is scaled into the final steering. */
  private nudge = 0;
  /** Which way we are nudging: +1 right, -1 left, 0 = not decided yet. Kept so it does not flip-flop. */
  private side = 0;
  /** How long the player has been holding a hard turn. */
  private cornerT = 0;

  reset(): void {
    this.cornerT = 0;
    this.steer = 0;
    this.throttle = 0;
    this.braking = false;
    this.urgency = 0;
    this.nudge = 0;
    this.side = 0;
  }

  /**
   * `playerSteer` -1..1 and `playerThrottle` -1..1 are what the player is asking for
   * (already merged from keyboard and pad). Results land in `steer`, `throttle`, `braking`.
   */
  update(self: Boat, world: WorldQuery, playerSteer: number, playerThrottle: number, dt: number): void {
    const cfg = CONFIG.easyDriving;

    // ---- auto-cruise ----
    // Nothing pressed = cruise. Pressing go slides smoothly from cruise up to full speed.
    // Pressing back is passed straight through: the boat brakes, then reverses.
    let throttle = playerThrottle >= 0 ? cfg.cruiseThrottle + (1 - cfg.cruiseThrottle) * playerThrottle : playerThrottle;

    // ---- corner slow-down ----
    this.cornerT = Math.abs(playerSteer) > CORNER_STEER ? this.cornerT + dt : 0;
    if (this.cornerT > CORNER_HOLD_SEC && throttle > CORNER_THROTTLE) throttle = CORNER_THROTTLE;

    // ---- bumper rails ----
    // Holding back (or already reversing) means the player is backing out: hands off.
    const backing = playerThrottle < -0.1 || self.speed < -0.5;
    let wantUrgency = 0;
    let wantSide = 0;
    let closest = Infinity;
    if (!backing) {
      const vx = self.velocity.x;
      const vz = self.velocity.z;
      const speed = Math.hypot(vx, vz);
      const h = speed > TRAVEL_DIR_SPEED ? headingOf(vx, vz) : self.heading;
      const look = Math.max(LOOK_MIN_M, speed * LOOK_SECONDS);
      closest = this.ray(self, world, h, look);
      if (closest < look) {
        wantUrgency = clamp(1 - closest / look, 0, 1);
        // Where is the room? Two probes each side, scored 0..1 (1 = clear all the way).
        const left = (this.ray(self, world, h + SIDE_NEAR_RAD, look) + this.ray(self, world, h + SIDE_FAR_RAD, look)) / (2 * look);
        const right = (this.ray(self, world, h - SIDE_NEAR_RAD, look) + this.ray(self, world, h - SIDE_FAR_RAD, look)) / (2 * look);
        const playerSide = playerSteer > PLAYER_STEER_MIN ? 1 : playerSteer < -PLAYER_STEER_MIN ? -1 : 0;
        let side = this.side;
        if (playerSide !== 0 && (playerSide > 0 ? right : left) > PLAYER_SIDE_OK) side = playerSide;
        else if (right > left + SIDE_TIE) side = 1;
        else if (left > right + SIDE_TIE) side = -1;
        else if (side === 0) side = playerSide !== 0 ? playerSide : 1;
        this.side = side;
        wantSide = side;
      }
    }
    if (wantUrgency === 0 && this.urgency < 0.05) this.side = 0; // all clear for a while: forget the old direction

    this.urgency = follow(this.urgency, wantUrgency, dt);
    this.nudge = follow(this.nudge, cfg.bumperStrength * wantUrgency * wantSide, dt);
    this.steer = clamp(playerSteer * (1 - PLAYER_GIVE * this.urgency) + this.nudge, -1, 1);

    // ---- throttle cap: really close and still coming in fast ----
    this.braking = false;
    if (wantUrgency > CAP_URGENCY && closest < CAP_DISTANCE_M && throttle > CAP_THROTTLE) {
      throttle = CAP_THROTTLE;
      this.braking = true;
    }
    this.throttle = throttle;
  }

  /** One look-ahead ray from the boat along `heading`; meters of open water, at most `look`. */
  private ray(self: Boat, world: WorldQuery, heading: number, look: number): number {
    return probeSolid(
      self.position.x,
      self.position.z,
      Math.sin(heading),
      Math.cos(heading),
      self.radius,
      world,
      OBSTACLE_MARGIN_M,
      EDGE_INSET_M,
      look,
    );
  }
}
