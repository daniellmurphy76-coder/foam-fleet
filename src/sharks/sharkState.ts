import * as THREE from 'three';
import type { AimTarget, Boat } from '../types';
import { SHARK_ID_BASE } from '../types';

/**
 * Everything one shark remembers. Sharks are pooled: a slot is built once and reused for the whole match.
 * Slots 0..15 are the normal sharks, slot 16 is the MEGA SHARK.
 */

/** What a shark is doing with its body. */
export const PHASE_OFF = 0; // not in the lagoon (waiting to come back, or never sent in)
export const PHASE_SWIM = 1; // swimming: cruising, chasing or swimming away (see the modes)
export const PHASE_LUNGE = 2; // the bump: a quick hop at a boat with the jaw open
export const PHASE_FLIP = 3; // darted: a comic flip
export const PHASE_DIVE = 4; // darted: sinking out of sight

/** What a swimming shark wants. */
export const MODE_CRUISE = 0; // lazy loops through open water
export const MODE_CHASE = 1; // after a boat
export const MODE_FLEE = 2; // swimming away from a spot (after a bump, or after giving up)

/** The hit sphere sits at the body, about at the waterline. */
export const HIT_Y = 0.3;
export const HIT_RADIUS = 2.0; // generous: sharks twist and turn
export const MEGA_HIT_RADIUS = 4.5;

/** The slot of the MEGA SHARK, and how many slots there are. */
export const NORMAL_SLOTS = 16;
export const MEGA_SLOT = NORMAL_SLOTS;
export const SLOTS = NORMAL_SLOTS + 1;

/** What darts and the aim assist see: one sphere per shark, reused for the whole match. */
export class SharkTarget implements AimTarget {
  readonly position = new THREE.Vector3(0, HIT_Y, 0);
  readonly velocity = new THREE.Vector3();
  /** Hittable right now (swimming or lunging, and up out of the depths). */
  alive = false;
  constructor(
    readonly id: number,
    readonly radius: number,
    readonly name: string,
  ) {}
}

export class Shark {
  readonly index: number;
  readonly mega: boolean;
  readonly target: SharkTarget;

  phase = PHASE_OFF;
  mode = MODE_CRUISE;
  /** Sent in by spawnWave() (Boats vs. Sharks), as opposed to an ambient cruiser. */
  wave = false;

  // ---- where it is and how it moves ----
  x = 0;
  z = 0;
  heading = 0;
  speed = 0;
  /** Current turning speed (radians per second, positive = turning left). Smoothed so turns never jitter. */
  turnVel = 0;
  /** Sideways drift while flipping and diving. */
  vx = 0;
  vz = 0;

  // ---- how it looks (all smoothed) ----
  /** Height of the body's middle above the wave, easing toward what the mode wants. */
  yRide = -0.72;
  /** The last full height above the wave and the last pitch shown (so a dart hit can flip from where it is). */
  exY = -0.72;
  exPitch = 0;
  pitchBase = 0;
  bank = 0;
  wagPhase = Math.random() * Math.PI * 2;
  jaw = 0.28;
  /** 0..1: rising up from the depths after being sent in. */
  appear = 0;
  flash = 0;
  shake = 0;
  /** 0..1: how much of the V of spray shows. */
  spray = 0;

  // ---- a lunge, flip or dive in progress ----
  seqT = 0;
  seqDur = 1;
  lungeTravel = 0;
  /** The heading that points at the boat being bumped. */
  lungeAim = 0;
  flipH = 0;
  flipY0 = 0;
  flipPitch0 = 0;
  jawStart = 0;

  // ---- the brain ----
  chaseBoat: Boat | null = null;
  /** Ambient: seconds this chase may still last. */
  chaseT = 0;
  /** Ambient: seconds until it gets curious about a boat. */
  chaseTimer = 0;
  /** Boats vs. Sharks: seconds until it picks its target boat again. */
  retargetT = 0;
  /** Seconds until it may bump again. */
  bumpCooldown = 0;
  fleeT = 0;
  fleeX = 0;
  fleeZ = 0;
  fleeBias = 0;
  wpX = 0;
  wpZ = 0;
  wpT = 0;
  /** Smoothed sidestep around islands (radians), and which side it last went (+1 left, -1 right). */
  avoidOff = 0;
  avoidSide = 1;
  /** Chase progress check: if it is not getting closer, it gives up. */
  progT = 0;
  progDist = 0;
  stuckN = 0;
  /** Clock time when an ambient shark that got darted comes back (0 = not waiting). */
  returnAt = 0;

  // ---- personality: no two sharks swim quite alike ----
  speedMul = 1;
  turnMul = 1;
  weaveAmp = 0.1;
  weaveFreq = 1;
  weavePhase = 0;

  constructor(index: number, mega: boolean) {
    this.index = index;
    this.mega = mega;
    this.target = new SharkTarget(SHARK_ID_BASE + index, mega ? MEGA_HIT_RADIUS : HIT_RADIUS, mega ? 'MEGA SHARK' : 'Shark');
  }
}
