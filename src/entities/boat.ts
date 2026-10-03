/**
 * Foam Fleet: the boat.
 *
 * This file is the "brain" of a boat: driving, bobbing on the waves, the foam-dart blaster,
 * power-ups and getting hit. The 3D model lives in boatModel.ts.
 *
 * Quick map of the driving model (read this first, it makes the code easy):
 *   1. Steering turns the HEADING (which way the nose points).
 *   2. We split the boat's velocity into "forward" and "sideways" parts, relative to the nose.
 *   3. Throttle changes the forward part. A little grip squeezes the sideways part toward zero
 *      (that squeeze is the fun drifty feel: the boat keeps sliding for a moment after a turn).
 *   4. We put the parts back together and move the boat, then bounce it off the lagoon edge and islands.
 *
 * Easy Driving (kid-friendly handling, on when `init.easyDriving`) changes that recipe in a few places:
 * slower top speed, gentler and smoother turning, no drift (the grip step is almost instant), softer hits,
 * and "shore sliding": touching an island or the lagoon edge never bounces the boat backward, it just
 * glides along the coast. Normal handling is untouched.
 *
 * Steering sign (see types.ts): steer +1 = right = heading DECREASES.
 * forward = (sin heading, 0, cos heading), right = (-cos heading, 0, sin heading).
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { SHARK_ID_BASE } from '../types';
import type {
  ActivePowerUp, AimTarget, Boat, BoatControls, BoatInit, BoatNetState, BumpEvent, DartSpawn, PowerUpKind, SpawnPoint, WorldQuery,
} from '../types';
import { buildBoatRig, FLAG_YAW, MARKER_HEIGHT, SHIELD_SIZE, type BoatRig } from './boatModel';

// ───────────────────────────── feel knobs (module-private) ─────────────────────────────
// The ones a kid would tweak (top speed, accel, turn rate...) are in CONFIG.boat / CONFIG.blaster.

const SUBSTEP = 1 / 60; // physics never takes a bigger step than this, even if a frame is slow or fast-forwarded
const MAX_SUBSTEPS = 15;
/** Online puppets: no real boat goes faster than this (boost is 34 m/s), so anything faster is a glitch. */
const PUPPET_MAX_SPEED = 60;
const MAX_FRAME_DT = SUBSTEP * MAX_SUBSTEPS;

// Throttle and speed
const STUN_THRUST = 0.35; // a stunned boat only has this much engine
const BOOST_ACCEL = 2.2; // boost accelerates this many times harder (the "rocket" feel)
const BOOST_KICK = 3; // instant shove (m/s) the moment boost starts
const BOOST_MIN_START = 0.05; // meter needed to start a boost (stops flicker at an empty tank)
const BRAKE_MUL = 1.4; // pressing reverse while moving forward brakes harder than normal accel
const REVERSAL_MUL = 1.5; // going from reverse to forward is extra snappy
const COAST_FRICTION = 0.8; // m/s^2 of extra drag so a coasting boat really stops
const EASE_DOWN = 1.6; // how quickly speed settles to a lower target (per second): boost fade-out, stun slow-down

// Turning
const PIVOT_TURN = 0.4; // share of turnRate you still get when sitting still (slow pivot)
const FULL_TURN_AT = 0.35; // ...reached at this fraction of max speed
const YAW_RESPONSE = 12; // how quickly the turn rate follows the steering input (per second)
const SPIN_DECAY = 4.5; // how quickly a hit-spin dies away (per second)

// Drift: the sideways velocity decays at this rate (per second). Lower = drifts more.
const GRIP_SLOW = 2.5; // when barely moving (so a sideways shove actually slides you)
const GRIP_FAST = 8; // at speed (about 15 degrees of slip at full turn: "a little drift")
const SLIP_KEEP = 0.8; // how much of the squeezed-out sideways speed turns into forward speed

// Easy Driving (the knobs a kid would tweak -- speed, turning, knockback -- are in CONFIG.easyDriving)
const EASY_ACCEL = 0.85; // acceleration compared to normal handling
const EASY_YAW_RESPONSE = 4; // turn rate eases toward its target with a 0.25 s time constant (no twitch)
const EASY_GRIP = 40; // sideways speed is squeezed away almost instantly: no drift
const EASY_STUN_THRUST = 0.6; // a stunned Easy Driving boat keeps more engine than a normal one
const EASY_STUN_SHAKE = 0.3; // stun wobble and hit-spin are this much of normal
const EASY_EDGE_PUSH = 0.35; // the lagoon edge nudges an Easy Driving boat back only this hard
const SLIDE_KEEP = 0.85; // a full-speed shore hit keeps this much of the sideways (along-the-shore) speed
const SLIDE_FULL_HIT = 6; // m/s of impact that counts as a "full" hit for the line above
const SLIDE_TURN = 7; // how eagerly the nose swings toward the shore tangent (per second)
const SLIDE_TURN_MAX = 2.2; // ...but never faster than this (rad/s): gentle
const SLIDE_MEMORY = 0.4; // seconds a head-on shore hit remembers which way it chose to slide

// Lagoon edge: a soft cushion, then a hard wall
const EDGE_MARGIN = 14;
const EDGE_BRAKE = 1.5;
const EDGE_BRAKE_MAX = 12;
const EDGE_PUSH = 25; // m/s^2 nudge back toward the middle at the very edge
const EDGE_BOUNCE = 0.35;

// Bonking into things
const ISLAND_BOUNCE = 0.45; // speed kept when bouncing off an island (damping)
const SCRAPE = 0.8; // per second, while grinding along a shore
const BOAT_BOUNCE = 0.6; // restitution for boat-vs-boat
const BUMP_MIN_SPEED = 1.5; // closing speed that counts as a "bump" event
const JOLT_GAIN = 0.12; // rad/s of tilt kick per m/s of impact

// Blaster
const TRICKLE_DELAY = 1; // seconds without firing before darts start to trickle back
const AIM_UP = 0.035; // radians of upward angle when nothing is locked
const AIM_MAX_ELEV = 0.35; // never aim steeper than this
const TURRET_MAX_YAW = 0.52; // the turret can swing this far either side (radians)

// Look and feel of the tilting
const WAVE_FOLLOW = 0.9; // how much of the wave slope the hull follows
const PITCH_K = 70; // spring stiffness / damping for pitch and roll (slightly bouncy)
const PITCH_C = 11;
const ROLL_K = 60;
const ROLL_C = 9;
const FLASH_TIME = 0.28; // seconds the white hit flash lasts
const SHIELD_POP_TIME = 0.3;
const NET_STUN_GUESS = 0.6; // online puppets: wobble this long if a stun shows up in a snapshot before its hit event

// ───────────────────────────── small helpers ─────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Shortest signed angle from b to a, in (-PI, PI]. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

// Scratch objects: reused every frame so the hot paths never allocate.
const _n = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tc = new THREE.Vector3(); // the locked target's center...
const _tv = new THREE.Vector3(); // ...and its velocity (see lockedTarget)
const _aim = new THREE.Vector3();
const _approx = new THREE.Vector3();

/** What tryFire returns when the blaster isn't ready (shared, never modified). */
const NO_SHOTS: DartSpawn[] = [];
const NO_BUMPS: BumpEvent[] = [];

function findBoat(list: readonly Boat[], id: number): Boat | null {
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** How much of the full turn rate a boat gets (speedRatio = speed / top speed): a slow pivot, full turn, a touch wider when flying. */
function turnShapeFor(speedRatio: number): number {
  return lerp(PIVOT_TURN, 1, smoothstep(0, FULL_TURN_AT, speedRatio)) * (1 - 0.22 * clamp01((speedRatio - 0.7) / 0.8));
}

/**
 * Online guests: the puppet boats that share one world, so a puppet's turret can find the boat it is locked onto
 * (applyNetState gets no `others` list). Keyed by the world object, so a host Match or a Garage boat never mixes in.
 */
const PUPPET_GROUPS = new WeakMap<object, Boat[]>();

// ───────────────────────────── the boat ─────────────────────────────

class FoamBoat implements Boat {
  readonly id: number;
  readonly name: string;
  readonly color: number;
  readonly isHuman: boolean;
  readonly team: number;
  readonly easyDriving: boolean;
  readonly object: THREE.Object3D;
  /** The very same vector as object.position, so moving one moves the other. */
  readonly position: THREE.Vector3;
  readonly velocity = new THREE.Vector3();
  heading = 0;
  readonly radius = CONFIG.boat.radius;
  readonly hitRadius = CONFIG.boat.hitRadius;
  readonly maxAmmo = CONFIG.blaster.magazine;

  private readonly rig: BoatRig;
  private disposed = false;

  // cached sin/cos of the heading (recomputed only when the heading changes)
  private sinH = 0;
  private cosH = 1;
  private axesHeading = Number.NaN;

  // cleaned-up copy of this frame's controls
  private inThrottle = 0;
  private inSteer = 0;

  // blaster / boost / power-up state
  private _ammo = CONFIG.blaster.magazine;
  private _reloading = false;
  private reloadElapsed = 0;
  private _boost = 1;
  private _boosting = false;
  private boostLocked = false;
  private _powerUp: ActivePowerUp | null = null;
  private _shielded = false;
  private stunTimer = 0;
  private stunDuration = 0;
  private flash = 0;
  private _aimTargetId: number | null = null;
  private nextFireT = 0;
  private sinceShot = 99;
  private trickleAcc = 0;

  // motion
  private yawRate = 0; // current turn rate (rad/s, negative = turning right)
  private spin = 0; // extra turn rate from being hit or bonking something
  private slideSign = 0; // Easy Driving: which way a head-on shore hit chose to slide (0 = not chosen)
  private slideT = 0; // ...and how long that choice is remembered
  private prevForward = 0;
  private accel = 0; // smoothed forward acceleration, drives nose-up and head tilt

  // hull tilt (springs) -- pitch: + = nose down, roll: + = leaning right
  private pitch = 0;
  private pitchVel = 0;
  private pitchTarget = 0;
  private roll = 0;
  private rollVel = 0;
  private rollTarget = 0;
  private wobblePhase = 0;

  // blaster / extras visuals
  private turretYawA = 0;
  private turretPitchA = AIM_UP;
  private recoil = 0;
  private muzzleFlashT = 0;
  private headYaw = 0;
  private flameLevel = 0;
  private shieldAppear = 0;
  private shieldPop = 0;

  // online: the host bumps `epoch` on every respawn/teleport; a puppet remembers the one it last showed
  private epoch = 0;
  private netSeenEpoch = -1;
  private netStunned = false;
  private readonly netPowerUp: ActivePowerUp = { kind: 'triple', timeLeft: 0 };
  /** Set by the first applyNetState: the puppets of this world (this boat included). null = a real, simulated boat. */
  private peers: Boat[] | null = null;

  constructor(init: BoatInit) {
    this.id = init.id;
    this.name = init.name;
    this.color = init.color;
    this.isHuman = init.isHuman;
    this.team = init.team;
    this.easyDriving = init.easyDriving;
    this.rig = buildBoatRig(init.look, init.color, init.id, init.marker);
    this.object = this.rig.root;
    this.position = this.rig.root.position;
    this.respawn(init.spawn);
  }

  // ── read-only views the rest of the game uses ──
  get speed(): number {
    this.refreshAxes();
    return this.velocity.x * this.sinH + this.velocity.z * this.cosH;
  }
  get ammo(): number { return this._ammo; }
  get reloading(): boolean { return this._reloading; }
  get reloadProgress(): number {
    return this._reloading ? clamp01(this.reloadElapsed / Math.max(0.01, CONFIG.blaster.reloadTime)) : 1;
  }
  get boost(): number { return this._boost; }
  get boosting(): boolean { return this._boosting; }
  get powerUp(): ActivePowerUp | null { return this._powerUp; }
  get shielded(): boolean { return this._shielded; }
  get stunned(): boolean { return this.peers !== null ? this.netStunned : this.stunTimer > 0; }
  get aimTargetId(): number | null { return this._aimTargetId; }

  // Handling numbers, scaled for Easy Driving (read from CONFIG each time so live tweaks work).
  private get topSpeed(): number {
    return CONFIG.boat.maxSpeed * (this.easyDriving ? CONFIG.easyDriving.speedScale : 1);
  }
  private get boostTop(): number {
    return CONFIG.boat.boostSpeed * (this.easyDriving ? CONFIG.easyDriving.speedScale : 1);
  }
  private get accelBase(): number {
    return CONFIG.boat.accel * (this.easyDriving ? EASY_ACCEL : 1);
  }
  private get turnBase(): number {
    return CONFIG.boat.turnRate * (this.easyDriving ? CONFIG.easyDriving.turnScale : 1);
  }
  private get stunThrust(): number {
    return this.easyDriving ? EASY_STUN_THRUST : STUN_THRUST;
  }

  private refreshAxes(): void {
    if (this.heading !== this.axesHeading) {
      this.axesHeading = this.heading;
      this.sinH = Math.sin(this.heading);
      this.cosH = Math.cos(this.heading);
    }
  }

  // ───────────────────────────── per-frame update ─────────────────────────────

  update(
    c: BoatControls, dt: number, t: number, world: WorldQuery, others: readonly Boat[], aimTargets?: readonly AimTarget[],
  ): void {
    if (!(dt > 0) || this.disposed) return; // paused (dt = 0) or garbage: stand still
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

    this.inThrottle = Number.isFinite(c.throttle) ? clamp(c.throttle, -1, 1) : 0;
    this.inSteer = Number.isFinite(c.steer) ? clamp(c.steer, -1, 1) : 0;

    this.updateTimers(c, dt);

    // Physics in small fixed steps so fast-forward and slow frames behave the same.
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.stepPhysics(h, world);

    this.sampleWaves(dt, t, world);
    this.pickAimTarget(others, aimTargets);
    this.animate(dt, t, others, aimTargets);
  }

  /** Countdowns: stun, flash, power-ups, boost meter, reloading. */
  private updateTimers(c: BoatControls, dt: number): void {
    if (this.stunTimer > 0) this.stunTimer = Math.max(0, this.stunTimer - dt);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt / FLASH_TIME);
    if (this.shieldPop > 0) this.shieldPop = Math.max(0, this.shieldPop - dt);
    if (this._powerUp) {
      this._powerUp.timeLeft -= dt;
      if (this._powerUp.timeLeft <= 0) this._powerUp = null;
    }

    // Boost: hold the button while the meter has juice. Turbo boosts by itself and never drains.
    const turbo = this._powerUp !== null && this._powerUp.kind === 'turbo';
    if (!c.boost && !turbo) this.boostLocked = false; // let go of the button = armed again
    const wantsBoost = (c.boost || turbo) && this.inThrottle > -0.3 && !this.boostLocked;
    // Starting needs a little juice in the tank; once going we run until it hits zero.
    if (wantsBoost && (turbo || this._boosting || this._boost > BOOST_MIN_START)) {
      if (!this._boosting) {
        // Rocket kick! A small instant shove forward (never past boost top speed, so tapping can't cheat).
        this._boosting = true;
        this.refreshAxes();
        const vf = this.velocity.x * this.sinH + this.velocity.z * this.cosH;
        const kick = clamp(this.boostTop - vf, 0, BOOST_KICK);
        this.velocity.x += this.sinH * kick;
        this.velocity.z += this.cosH * kick;
      }
      if (!turbo) {
        this._boost -= CONFIG.boat.boostDrain * dt;
        if (this._boost <= 0) {
          // Ran dry: coast out, and make the player let go before boosting again (no flicker at zero).
          this._boost = 0;
          this._boosting = false;
          this.boostLocked = true;
        }
      }
    } else {
      this._boosting = false;
      this._boost = Math.min(1, this._boost + CONFIG.boat.boostRecharge * dt);
    }

    // Blaster ammo
    this.sinceShot += dt;
    if (this._reloading) {
      this.reloadElapsed += dt;
      if (this.reloadElapsed >= CONFIG.blaster.reloadTime) {
        this._ammo = this.maxAmmo;
        this._reloading = false;
      }
    } else if (this._ammo < this.maxAmmo && this.sinceShot > TRICKLE_DELAY) {
      // Not shooting for a moment: darts slowly trickle back in.
      this.trickleAcc += dt;
      const every = Math.max(0.05, CONFIG.blaster.trickleReload);
      while (this.trickleAcc >= every && this._ammo < this.maxAmmo) {
        this._ammo++;
        this.trickleAcc -= every;
      }
      if (this._ammo >= this.maxAmmo) this.trickleAcc = 0;
    }
  }

  /** One small slice of driving physics. See the map at the top of the file. */
  private stepPhysics(h: number, world: WorldQuery): void {
    const cfg = CONFIG.boat;
    const easy = this.easyDriving;
    const vel = this.velocity;
    const pos = this.position;
    const stunned = this.stunTimer > 0;
    const maxSpeed = this.topSpeed;
    const accel = this.accelBase;
    const stunThrust = this.stunThrust;

    if (this.slideT > 0) {
      this.slideT -= h;
      if (this.slideT <= 0) this.slideSign = 0; // been clear of the shore a while: forget the choice
    }

    // 1. Steering: turn rate grows with speed (but you can still pivot slowly when stopped).
    this.refreshAxes();
    let vf = vel.x * this.sinH + vel.z * this.cosH;
    const speedRatio = Math.abs(vf) / maxSpeed;
    const turnShape = turnShapeFor(speedRatio);
    const targetYaw = -this.inSteer * this.turnBase * turnShape; // steer +1 = right = heading goes DOWN
    // Easy Driving eases into the turn more slowly, so a jab at the key never makes the boat twitch.
    this.yawRate += (targetYaw - this.yawRate) * (1 - Math.exp(-(easy ? EASY_YAW_RESPONSE : YAW_RESPONSE) * h));
    this.spin *= Math.exp(-SPIN_DECAY * h);
    this.heading += (this.yawRate + this.spin) * h;
    this.refreshAxes();
    const sinH = this.sinH;
    const cosH = this.cosH;

    // 2. Split the velocity into forward / sideways parts of the (new) heading.
    //    The nose just turned but the boat is still moving the old way: that gap IS the drift.
    vf = vel.x * sinH + vel.z * cosH;
    let vl = -vel.x * cosH + vel.z * sinH; // + = sliding toward the boat's right

    // 3. Grip: squeeze the sideways speed away; give some of it back as forward speed.
    const absF = Math.abs(vf);
    // Easy Driving has near-perfect grip, so the boat goes where the nose points (no drift).
    const grip = easy ? EASY_GRIP : lerp(GRIP_SLOW, GRIP_FAST, smoothstep(1, 9, absF)) * (this._boosting ? 0.8 : 1);
    const vlGripped = vl * Math.exp(-grip * h);
    if (absF > 0.01) {
      const share = SLIP_KEEP * clamp01(absF / 6);
      vf += Math.sign(vf) * share * (Math.hypot(vf, vl) - Math.hypot(vf, vlGripped));
    }
    vl = vlGripped;

    // 4. Throttle moves the forward speed toward a target.
    let thr = this.inThrottle;
    if (this._boosting) thr = Math.max(thr, 1);
    if (stunned) thr *= stunThrust;
    const topSpeed = this._boosting ? this.boostTop : maxSpeed;
    const target = thr >= 0 ? thr * topSpeed : thr * cfg.reverseSpeed;
    const push = accel * (this._boosting ? BOOST_ACCEL : 1) * (stunned ? stunThrust : 1);
    if (Math.abs(thr) < 0.04) {
      // Letting go: water drag plus a little friction so we really stop.
      vf *= Math.exp(-cfg.drag * h);
      const f = COAST_FRICTION * h;
      vf = Math.abs(vf) <= f ? 0 : vf - Math.sign(vf) * f;
    } else if (vf < target) {
      // Speeding up (or slowing a reversing boat).
      const rate = vf < 0 ? push * REVERSAL_MUL : push * (1 - 0.45 * clamp01(vf / target) ** 2); // eases in near top speed
      vf = Math.min(vf + rate * h, target);
    } else if (vf > target) {
      if (thr < -0.04) {
        // Pressing reverse: brake hard while still going forward, then back up.
        const rate = vf > 0 ? accel * BRAKE_MUL : push;
        vf = Math.max(vf - rate * h, target);
      } else {
        // Target is lower than our speed (boost ended, half throttle, stun): settle smoothly.
        vf = target + (vf - target) * Math.exp(-EASE_DOWN * h);
      }
    }

    // 5. Back to world coordinates and move.
    vel.x = sinH * vf - cosH * vl;
    vel.z = cosH * vf + sinH * vl;
    vel.y = 0;
    const v2 = vel.x * vel.x + vel.z * vel.z;
    if (v2 > 3600) {
      const k = 60 / Math.sqrt(v2); // safety net: nothing should ever exceed 60 m/s
      vel.x *= k;
      vel.z *= k;
    }
    pos.x += vel.x * h;
    pos.z += vel.z * h;

    this.keepInArena(h, world);
    this.bounceOffObstacles(h, world);
  }

  /** Soft cushion near the edge of the lagoon, hard wall just past it. */
  private keepInArena(h: number, world: WorldQuery): void {
    const pos = this.position;
    const vel = this.velocity;
    const R = world.arenaRadius;
    const start = R - EDGE_MARGIN;
    const d2 = pos.x * pos.x + pos.z * pos.z;
    if (d2 <= start * start) return;
    const d = Math.sqrt(d2);
    const nx = pos.x / d; // outward direction
    const nz = pos.z / d;
    const k = clamp01((d - start) / EDGE_MARGIN); // 0 at the start of the cushion, 1 at the edge
    const vr = vel.x * nx + vel.z * nz;
    if (vr > 0) {
      const f = Math.min(1, h * (EDGE_BRAKE + EDGE_BRAKE_MAX * k * k)); // brake outward motion harder and harder
      vel.x -= nx * vr * f;
      vel.z -= nz * vr * f;
    }
    const nudge = EDGE_PUSH * (this.easyDriving ? EASY_EDGE_PUSH : 1) * k * k * h;
    vel.x -= nx * nudge;
    vel.z -= nz * nudge;
    const maxD = R - this.radius;
    if (d > maxD) {
      pos.x = nx * maxD;
      pos.z = nz * maxD;
      if (this.easyDriving) {
        // The edge is a shore too: glide along it (the water is toward the middle, so the normal points inward).
        this.shoreSlide(-nx, -nz, h);
        return;
      }
      const vr2 = vel.x * nx + vel.z * nz;
      if (vr2 > 0) {
        vel.x -= nx * vr2 * (1 + EDGE_BOUNCE);
        vel.z -= nz * vr2 * (1 + EDGE_BOUNCE);
      }
    }
  }

  /**
   * Easy Driving shore contact. (nx, nz) is the unit normal pointing from the shore out into the water
   * and the boat has already been moved back onto the shore line. Instead of bouncing:
   *  - the part of the velocity going into the shore is removed (never backward),
   *  - the along-the-shore part is kept (about 85% after a hard hit, more after a glancing one),
   *  - and if the nose points into the shore it swings toward whichever shore tangent is closest to the
   *    current heading, so the boat glides along the coast and never ends up wedged nose-in.
   */
  private shoreSlide(nx: number, nz: number, h: number): void {
    const vel = this.velocity;
    const vn = vel.x * nx + vel.z * nz;
    if (vn < 0) {
      const impact = -vn;
      vel.x -= nx * vn;
      vel.z -= nz * vn;
      const keep = 1 - (1 - SLIDE_KEEP) * clamp01(impact / SLIDE_FULL_HIT);
      vel.x *= keep;
      vel.z *= keep;
      if (impact > 2) this.jolt(nx, nz, impact * 0.5); // a small shiver, no spin
    }
    this.slideT = SLIDE_MEMORY;

    // Backing into the shore: just stop there, no nose swinging.
    this.refreshAxes();
    if (this.velocity.x * this.sinH + this.velocity.z * this.cosH < -0.5) return;
    const fn = this.sinH * nx + this.cosH * nz; // < 0: the nose points into the shore
    if (fn > -0.02) return;

    // The two shore tangents are +-(-nz, nx). Pick the one the nose is closest to.
    const tx = -nz;
    const tz = nx;
    const alongHeading = Math.atan2(tx, tz); // the heading that runs along +tangent
    const dotF = this.sinH * tx + this.cosH * tz;
    let sgn: number;
    if (Math.abs(dotF) > 0.2) {
      sgn = dotF > 0 ? 1 : -1;
      this.slideSign = sgn;
    } else {
      // Nearly head-on: both tangents are equally close. Choose by the way the player is steering (else by
      // boat id) and stick with it, so the nose does not flip-flop between the two.
      if (this.slideSign === 0) {
        const want = this.inSteer > 0.1 ? -1 : this.inSteer < -0.1 ? 1 : this.id % 2 === 0 ? 1 : -1; // wanted sign of the turn (steer right = heading goes down)
        this.slideSign = (angleDiff(alongHeading, this.heading) > 0 ? 1 : -1) * want;
      }
      sgn = this.slideSign;
    }
    const targetHeading = sgn > 0 ? alongHeading : alongHeading + Math.PI;
    const d = angleDiff(targetHeading, this.heading);
    this.heading += clamp(d * SLIDE_TURN, -SLIDE_TURN_MAX, SLIDE_TURN_MAX) * h;
  }

  /** Islands, rocks and landmarks are circles: push out, bounce with damping, never stick. */
  private bounceOffObstacles(h: number, world: WorldQuery): void {
    const obstacles = world.obstacles;
    const pos = this.position;
    const vel = this.velocity;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const dx = pos.x - o.x;
      const dz = pos.z - o.z;
      const minD = o.radius + this.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;
      const d = Math.sqrt(d2);
      let nx: number;
      let nz: number;
      if (d > 1e-4) {
        nx = dx / d;
        nz = dz / d;
      } else {
        nx = -this.sinH; // exactly on the center (rare): back out the way we came
        nz = -this.cosH;
      }
      pos.x = o.x + nx * minD; // snap to the shore
      pos.z = o.z + nz * minD;
      if (this.easyDriving) {
        this.shoreSlide(nx, nz, h); // glide along the island instead of bouncing off it
        continue;
      }
      const vn = vel.x * nx + vel.z * nz;
      if (vn >= 0) continue; // already moving away
      const impact = -vn;
      // Reflect the part going into the island, keeping only some of it...
      vel.x -= nx * vn * (1 + ISLAND_BOUNCE);
      vel.z -= nz * vn * (1 + ISLAND_BOUNCE);
      // ...and scrape a little speed off the sliding part.
      const outV = vel.x * nx + vel.z * nz;
      const keep = Math.exp(-SCRAPE * h);
      vel.x = nx * outV + (vel.x - nx * outV) * keep;
      vel.z = nz * outV + (vel.z - nz * outV) * keep;
      if (impact > 2) {
        this.jolt(nx, nz, impact);
        // Glancing blows swing the nose along the shore, which helps you slip free.
        if (impact > 3) {
          const cross = this.sinH * nz - this.cosH * nx;
          const sign = Math.abs(cross) > 0.05 ? -Math.sign(cross) : this.id % 2 === 0 ? 1 : -1;
          this.spin += sign * Math.min(1.2, impact * 0.08);
        }
      }
    }
  }

  /** Bobbing and the targets the hull tilts toward. */
  private sampleWaves(dt: number, t: number, world: WorldQuery): void {
    const pos = this.position;
    pos.y = world.waveHeight(pos.x, pos.z, t);
    world.waveNormal(pos.x, pos.z, t, _n);
    this.refreshAxes();
    const nf = _n.x * this.sinH + _n.z * this.cosH; // slope along the boat
    const nr = -_n.x * this.cosH + _n.z * this.sinH; // slope across the boat
    const ny = Math.max(0.2, _n.y);
    const wavePitch = Math.atan2(nf, ny) * WAVE_FOLLOW; // + = nose down
    const waveRoll = Math.atan2(nr, ny) * WAVE_FOLLOW; // + = leaning right

    const vf = this.velocity.x * this.sinH + this.velocity.z * this.cosH;
    const rawAcc = clamp((vf - this.prevForward) / dt, -40, 40);
    this.prevForward = vf;
    this.accel += (rawAcc - this.accel) * (1 - Math.exp(-dt * 8));

    const maxSpeed = this.topSpeed;
    const spd = clamp(Math.abs(vf) / maxSpeed, 0, 1.3);
    // Nose up when speeding up (and a bit when planing fast), nose down when braking.
    this.pitchTarget =
      wavePitch -
      clamp(this.accel / this.accelBase, -1.2, 1.2) * 0.11 -
      clamp01(vf / maxSpeed) * 0.05 -
      (this._boosting ? 0.05 : 0);
    // Bank into the turn: lean right when turning right (the faster, the more).
    this.rollTarget = waveRoll + (-this.yawRate / this.turnBase) * (0.1 + 0.26 * spd);
  }

  /**
   * Aim assist. Lock rule: the nearest BOAT (other team) roughly in front of us wins. Only if there is none, the nearest
   * aim target (a shark) in the cone is locked instead, so `aimTargetId` can be a shark id (>= SHARK_ID_BASE).
   * Generous at close range. Teammates are never targets.
   */
  private pickAimTarget(others: readonly Boat[], aimTargets?: readonly AimTarget[]): void {
    const range = CONFIG.blaster.aimAssistRange;
    const cone = (CONFIG.blaster.aimAssistDeg * Math.PI) / 180;
    let bestId: number | null = null;
    let best = Infinity;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o === this || o.id === this.id || o.team === this.team) continue;
      const dx = o.position.x - this.position.x;
      const dz = o.position.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 0.01) continue;
      const current = o.id === this._aimTargetId; // stick to the current target a little (no flicker)
      // A big boat close up covers a wide angle, so widen the cone by the target's own size.
      const limit = cone * (current ? 1.25 : 1) + Math.asin(Math.min(1, o.hitRadius / d));
      const off = Math.abs(angleDiff(Math.atan2(dx, dz), this.heading));
      if (off > limit) continue;
      const score = current ? d * 0.8 : d;
      if (score < best) {
        best = score;
        bestId = o.id;
      }
    }
    if (bestId === null && aimTargets) {
      // No boat to lock: the nearest shark in the cone (same rules, same stickiness).
      for (let i = 0; i < aimTargets.length; i++) {
        const a = aimTargets[i];
        if (!a.alive) continue;
        const dx = a.position.x - this.position.x;
        const dz = a.position.z - this.position.z;
        const d = Math.hypot(dx, dz);
        if (d > range || d < 0.01) continue;
        const current = a.id === this._aimTargetId;
        const limit = cone * (current ? 1.25 : 1) + Math.asin(Math.min(1, a.radius / d)); // the MEGA SHARK is huge up close
        const off = Math.abs(angleDiff(Math.atan2(dx, dz), this.heading));
        if (off > limit) continue;
        const score = current ? d * 0.8 : d;
        if (score < best) {
          best = score;
          bestId = a.id;
        }
      }
    }
    this._aimTargetId = bestId;
  }

  /**
   * Find the thing we are locked onto (a boat, or a shark if the id is >= SHARK_ID_BASE) and write its center into _tc
   * and its velocity into _tv. False if the lock is empty or the target is gone (a shark that dived since last frame).
   */
  private lockedTarget(others: readonly Boat[], aimTargets?: readonly AimTarget[]): boolean {
    const id = this._aimTargetId;
    if (id === null) return false;
    if (id >= SHARK_ID_BASE) {
      if (!aimTargets) return false;
      for (let i = 0; i < aimTargets.length; i++) {
        const a = aimTargets[i];
        if (a.id !== id || !a.alive) continue;
        _tc.copy(a.position);
        _tv.copy(a.velocity);
        return true;
      }
      return false;
    }
    const b = findBoat(others, id);
    if (!b) return false;
    b.hitCenter(_tc);
    _tv.copy(b.velocity);
    return true;
  }

  /**
   * Work out which way a dart should fly (a unit vector written into `out`).
   * Locked on (see lockedTarget): lead the target (aim where it WILL be) and aim a bit high so gravity drops the dart onto it.
   * Not locked: straight ahead with a small upward angle.
   */
  private solveAim(origin: THREE.Vector3, out: THREE.Vector3, locked: boolean): void {
    this.refreshAxes();
    if (!locked) {
      const ce = Math.cos(AIM_UP);
      out.set(this.sinH * ce, Math.sin(AIM_UP), this.cosH * ce);
      return;
    }
    const g = CONFIG.blaster.dartGravity;
    const speed = CONFIG.blaster.dartSpeed + Math.max(0, this.speed);
    const tv = _tv;
    let tof = _tc.distanceTo(origin) / speed; // time of flight, refined a few times
    for (let i = 0; i < 3; i++) {
      _aim.set(_tc.x + tv.x * tof, _tc.y + 0.5 * g * tof * tof, _tc.z + tv.z * tof);
      tof = _aim.distanceTo(origin) / speed;
    }
    out.subVectors(_aim, origin).normalize();
    const horiz = Math.hypot(out.x, out.z);
    const maxY = horiz * Math.tan(AIM_MAX_ELEV);
    if (out.y > maxY) {
      out.y = maxY;
      out.normalize();
    }
  }

  /** Springs, turret, captain, flame, shield: everything that is just for looks. */
  private animate(dt: number, t: number, others: readonly Boat[], aimTargets?: readonly AimTarget[]): void {
    const rig = this.rig;
    const maxSpeed = this.topSpeed;

    // Hull tilt springs (a few small steps keep the springs stable).
    const n = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.pitchVel += (PITCH_K * (this.pitchTarget - this.pitch) - PITCH_C * this.pitchVel) * h;
      this.pitch += this.pitchVel * h;
      this.rollVel += (ROLL_K * (this.rollTarget - this.roll) - ROLL_C * this.rollVel) * h;
      this.roll += this.rollVel * h;
    }

    // Stun wobble: a shaky shimmy that fades as the stun runs out.
    let wobPitch = 0;
    let wobRoll = 0;
    let wobYaw = 0;
    if (this.stunTimer > 0) {
      this.wobblePhase += dt * 32;
      const w = clamp01(this.stunTimer / Math.max(0.05, this.stunDuration)) * (this.easyDriving ? EASY_STUN_SHAKE : 1);
      wobRoll = Math.sin(this.wobblePhase) * 0.16 * w;
      wobPitch = Math.cos(this.wobblePhase * 0.8) * 0.06 * w;
      wobYaw = Math.sin(this.wobblePhase * 0.6) * 0.14 * w;
    }
    rig.root.rotation.set(this.pitch + wobPitch, this.heading + wobYaw, this.roll + wobRoll);

    // White flash on the paint (hull, painted deck and pattern decals) when hit.
    this.setFlash(this.flash * 0.9);

    // Turret: swing toward the aim target (clamped), match the dart's elevation.
    let yawT = 0;
    let pitchT = AIM_UP;
    if (this.lockedTarget(others, aimTargets)) {
      // a boat or a shark: the turret tracks either one the same way
      this.refreshAxes();
      _approx.set(this.position.x + this.sinH * 1.4, this.position.y + 1.2, this.position.z + this.cosH * 1.4);
      this.solveAim(_approx, _dir, true);
      yawT = clamp(angleDiff(Math.atan2(_dir.x, _dir.z), this.heading), -TURRET_MAX_YAW, TURRET_MAX_YAW);
      pitchT = Math.atan2(_dir.y, Math.hypot(_dir.x, _dir.z));
    }
    const kTurret = 1 - Math.exp(-dt * 14);
    this.turretYawA += (yawT - this.turretYawA) * kTurret;
    this.turretPitchA += (pitchT - this.turretPitchA) * kTurret;
    this.recoil *= Math.exp(-dt * 15);
    rig.turretYaw.rotation.y = this.turretYawA;
    // negative x-rotation = muzzle up; counter most of the hull's own pitch so the barrel stays on target
    rig.turretPitch.rotation.x = -this.turretPitchA - this.pitch * 0.8 - this.recoil * 0.1;
    rig.turretRecoil.position.z = -this.recoil * 0.25;

    // Muzzle puff
    if (this.muzzleFlashT > 0) {
      this.muzzleFlashT = Math.max(0, this.muzzleFlashT - dt / 0.08);
      rig.muzzleFlash.visible = this.muzzleFlashT > 0;
      rig.muzzleFlash.scale.setScalar(0.5 + 0.9 * this.muzzleFlashT);
    }

    // Power-up looks
    const kind = this._powerUp ? this._powerUp.kind : null;
    rig.sideBarrels.visible = kind === 'triple';
    rig.blasterGlowMat.emissiveIntensity = kind === 'rapid' ? 0.35 + 0.25 * Math.sin(t * 28) : 0;

    // Captain looks into the turn and tips his head back when you floor it.
    this.headYaw += (-this.inSteer * 0.5 - this.headYaw) * (1 - Math.exp(-dt * 9));
    rig.head.rotation.set(-clamp(this.accel / this.accelBase, -1, 1) * 0.12, this.headYaw, this.inSteer * 0.08);

    // Flag flutters harder the faster we go; the propeller beanie spins faster too; the team diamond bobs and turns.
    const spd = clamp01(Math.abs(this.velocity.x * this.sinH + this.velocity.z * this.cosH) / maxSpeed);
    if (rig.hasFlag) {
      rig.flag.rotation.y = FLAG_YAW + Math.sin(t * 11 + this.id) * 0.22 * (0.3 + spd) - this.yawRate * 0.12;
      rig.flag.rotation.z = Math.sin(t * 8.3 + this.id * 1.7) * 0.06 * (0.3 + spd);
    }
    if (rig.propeller) rig.propeller.rotation.y += dt * (9 + 26 * spd);
    if (rig.eyeHalo) rig.eyeHalo.opacity = 0.4 + 0.14 * Math.sin(t * 3.2 + this.id * 1.3); // the BoneBoat's eyes glow slowly in and out
    if (rig.marker) {
      rig.marker.position.y = MARKER_HEIGHT + Math.sin(t * 3 + this.id) * 0.1;
      rig.marker.rotation.y = t * 1.8;
    }

    // Engine flame (boost)
    const flameTarget = this._boosting ? 1 : 0;
    this.flameLevel += (flameTarget - this.flameLevel) * (1 - Math.exp(-dt * (flameTarget > this.flameLevel ? 25 : 10)));
    rig.flame.visible = this.flameLevel > 0.02;
    if (rig.flame.visible) {
      const flicker = 1 + 0.18 * Math.sin(t * 70 + this.id * 3);
      const wide = 0.55 + 0.5 * this.flameLevel;
      rig.flame.scale.set(wide, wide, 0.15 + this.flameLevel * flicker);
    }

    // Shield bubble: pops in, pulses, and bursts outward when it takes a hit.
    if (this._shielded) {
      this.shieldAppear = Math.min(1, this.shieldAppear + dt * 5);
      const e = this.shieldAppear;
      const grow = e < 1 ? 1 + 0.15 * Math.sin(e * Math.PI) - (1 - e) * 0.9 : 1 + 0.03 * Math.sin(t * 6);
      rig.shield.visible = true;
      rig.shield.scale.set(SHIELD_SIZE.x * grow, SHIELD_SIZE.y * grow, SHIELD_SIZE.z * grow);
      rig.shieldMat.opacity = 0.28 + 0.06 * Math.sin(t * 5);
      rig.shieldSpin.rotation.y += dt * 0.8; // spin the bubble inside its holder so it keeps its shape
    } else if (this.shieldPop > 0) {
      const p = 1 - this.shieldPop / SHIELD_POP_TIME; // 0 -> 1
      const grow = 1 + p * 0.6;
      rig.shield.visible = true;
      rig.shield.scale.set(SHIELD_SIZE.x * grow, SHIELD_SIZE.y * grow, SHIELD_SIZE.z * grow);
      rig.shieldMat.opacity = 0.28 * (1 - p);
    } else {
      rig.shield.visible = false;
    }
  }

  /** Set the white hit-flash glow on every paint material (hull, painted deck, pattern decals). */
  private setFlash(v: number): void {
    const mats = this.rig.paintMats;
    for (let i = 0; i < mats.length; i++) mats[i].emissiveIntensity = v;
  }

  /** A quick tilt kick from a bump or hit. (push = the direction the boat is being pushed.) */
  jolt(pushX: number, pushZ: number, strength: number): void {
    this.refreshAxes();
    const k = Math.min(strength, 14) * JOLT_GAIN;
    const along = pushX * this.sinH + pushZ * this.cosH; // push toward the bow
    const across = -pushX * this.cosH + pushZ * this.sinH; // push toward the right
    // The top of the boat lags behind the push: shoved backward = nose dips, shoved right = leans left.
    this.pitchVel += -along * k;
    this.rollVel += -across * k;
  }

  // ───────────────────────────── blaster ─────────────────────────────

  tryFire(t: number, others: readonly Boat[], aimTargets?: readonly AimTarget[]): DartSpawn[] {
    if (this.disposed || t < this.nextFireT) return NO_SHOTS;
    const kind = this._powerUp ? this._powerUp.kind : null;
    const rapid = kind === 'rapid';
    if (!rapid && (this._reloading || this._ammo <= 0)) return NO_SHOTS;

    this.nextFireT = t + CONFIG.blaster.cooldown * (rapid ? 0.5 : 1);
    if (!rapid) {
      this._ammo--;
      if (this._ammo <= 0) {
        this._ammo = 0;
        this._reloading = true; // empty: reload automatically
        this.reloadElapsed = 0;
      }
    }
    this.sinceShot = 0;
    this.trickleAcc = 0;

    // Where the dart starts: the very tip of the barrel, in world space.
    this.rig.muzzle.getWorldPosition(_origin);

    // Aim at the locked boat or shark (leading it with its velocity); if it has just gone, shoot straight ahead.
    this.solveAim(_origin, _dir, this.lockedTarget(others, aimTargets));
    const speed = CONFIG.blaster.dartSpeed + Math.max(0, this.speed);

    const spawns: DartSpawn[] = [this.makeSpawn(_dir.x, _dir.y, _dir.z, speed)];
    if (kind === 'triple') {
      // Two more darts, fanned out left and right (rotating the direction around the Y axis).
      const a = (CONFIG.blaster.tripleSpreadDeg * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      spawns.push(
        this.makeSpawn(_dir.x * ca + _dir.z * sa, _dir.y, -_dir.x * sa + _dir.z * ca, speed),
        this.makeSpawn(_dir.x * ca - _dir.z * sa, _dir.y, _dir.x * sa + _dir.z * ca, speed),
      );
    }

    this.recoil = 1;
    this.muzzleFlashT = 1;
    return spawns;
  }

  private makeSpawn(dx: number, dy: number, dz: number, speed: number): DartSpawn {
    return {
      origin: _origin.clone(),
      direction: new THREE.Vector3(dx, dy, dz).normalize(),
      speed,
      ownerId: this.id,
    };
  }

  hitCenter(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + this.rig.centerY, this.position.z);
  }

  onHit(direction: THREE.Vector3, stunSeconds: number): boolean {
    if (this._shielded) {
      // The shield takes the hit and pops.
      this._shielded = false;
      this.shieldPop = SHIELD_POP_TIME;
      return false;
    }
    // Shove along the dart's direction (sideways on the water only). Easy Driving boats get a gentler shove.
    const easy = this.easyDriving;
    const knock = CONFIG.boat.knockback * (easy ? CONFIG.easyDriving.knockbackScale : 1);
    const hl = Math.hypot(direction.x, direction.z);
    if (hl > 1e-4) {
      const dx = direction.x / hl;
      const dz = direction.z / hl;
      this.velocity.x += dx * knock;
      this.velocity.z += dz * knock;
      this.jolt(dx, dz, knock * 2.5);
      // Spin a little, depending on which side got hit.
      this.refreshAxes();
      const side = -dx * this.cosH + dz * this.sinH; // dart pushing the boat to the right?
      this.spin += (Math.abs(side) > 0.05 ? -Math.sign(side) : this.id % 2 === 0 ? 1 : -1) * 1.8 * (easy ? EASY_STUN_SHAKE : 1);
    }
    this.stunTimer = Math.max(this.stunTimer, stunSeconds);
    this.stunDuration = this.stunTimer;
    this.flash = 1;
    return true;
  }

  applyPowerUp(kind: PowerUpKind): void {
    switch (kind) {
      case 'shield':
        // The shield is its own thing (see `shielded`); it lasts until it takes a hit.
        this._shielded = true;
        this.shieldAppear = 0;
        this.shieldPop = 0;
        break;
      case 'turbo':
        this._powerUp = { kind, timeLeft: CONFIG.powerUps.durationSec };
        this._boost = 1;
        this.boostLocked = false;
        break;
      case 'triple':
      case 'rapid':
        this._powerUp = { kind, timeLeft: CONFIG.powerUps.durationSec };
        break;
    }
  }

  respawn(spawn: SpawnPoint): void {
    this.epoch++;
    this.position.set(spawn.x, 0, spawn.z);
    this.heading = spawn.heading;
    this.axesHeading = Number.NaN;
    this.refreshAxes();
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    this.spin = 0;
    this.slideSign = 0;
    this.slideT = 0;
    this.prevForward = 0;
    this.accel = 0;

    this.stunTimer = 0;
    this.stunDuration = 0;
    this.flash = 0;
    this._powerUp = null;
    this._shielded = false;
    this.shieldAppear = 0;
    this.shieldPop = 0;
    this._ammo = this.maxAmmo;
    this._reloading = false;
    this.reloadElapsed = 0;
    this._boost = 1;
    this._boosting = false;
    this.boostLocked = false;
    this._aimTargetId = null;
    this.nextFireT = 0;
    this.sinceShot = 99;
    this.trickleAcc = 0;

    this.pitch = this.pitchVel = this.pitchTarget = 0;
    this.roll = this.rollVel = this.rollTarget = 0;
    this.wobblePhase = 0;
    this.turretYawA = 0;
    this.turretPitchA = AIM_UP;
    this.recoil = 0;
    this.muzzleFlashT = 0;
    this.headYaw = 0;
    this.flameLevel = 0;
    this.inThrottle = 0;
    this.inSteer = 0;

    // A nice resting pose, so a boat that is shown without ever being updated (the Garage) still looks right.
    const rig = this.rig;
    rig.root.rotation.set(0, this.heading, 0);
    this.setFlash(0);
    rig.blasterGlowMat.emissiveIntensity = 0;
    rig.sideBarrels.visible = false;
    rig.muzzleFlash.visible = false;
    rig.flame.visible = false;
    rig.shield.visible = false;
    rig.turretYaw.rotation.y = 0;
    rig.turretPitch.rotation.x = -AIM_UP;
    rig.turretRecoil.position.z = 0;
    rig.head.rotation.set(0, 0, 0);
    rig.flag.rotation.set(0, FLAG_YAW, 0);
    if (rig.marker) rig.marker.position.y = MARKER_HEIGHT;
  }

  teleport(spot: SpawnPoint): void {
    // Rescue: new spot, standing still, calm. Ammo, boost, shield and power-ups stay exactly as they were.
    this.epoch++;
    this.position.set(spot.x, this.position.y, spot.z); // y follows the waves on the next update
    this.heading = spot.heading;
    this.axesHeading = Number.NaN;
    this.refreshAxes();
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    this.spin = 0;
    this.slideSign = 0;
    this.slideT = 0;
    this.prevForward = 0;
    this.accel = 0;
    this.stunTimer = 0;
    this.stunDuration = 0;
    this.flash = 0;
    this.wobblePhase = 0;
    this.pitchVel = 0;
    this.rollVel = 0;
    this._aimTargetId = null;
    this.setFlash(0);
    this.rig.root.rotation.set(this.pitch, this.heading, this.roll);
  }

  // ───────────────────────────── online ─────────────────────────────

  /** Host: everything a guest needs to draw this boat (and the owner's HUD). Read straight off the real state. */
  netState(): BoatNetState {
    const p = this._powerUp;
    return {
      x: this.position.x,
      z: this.position.z,
      heading: this.heading,
      vx: this.velocity.x,
      vz: this.velocity.z,
      steer: this.inSteer,
      boosting: this._boosting,
      shielded: this._shielded,
      stunned: this.stunTimer > 0,
      powerUp: p ? p.kind : null,
      powerUpLeft: p ? Math.max(0, p.timeLeft) : 0,
      ammo: this._ammo,
      reloading: this._reloading,
      reloadProgress: this.reloadProgress,
      boost: this._boost,
      aimTargetId: this._aimTargetId,
      epoch: this.epoch,
    };
  }

  /**
   * Guest: be a puppet. The pose and flags come from the host's snapshot (already interpolated by the caller);
   * then ONLY the looks run (wave bob and tilt, flames, shield, turret, flag, propeller, wobble): no physics,
   * no aim picking, no ammo or timers of our own. The same sampleWaves/animate as a real boat, so it looks identical.
   */
  applyNetState(s: BoatNetState, dt: number, t: number, world: WorldQuery, aimTargets?: readonly AimTarget[]): void {
    if (this.disposed) return;
    if (!(dt > 0)) dt = 1e-4; // paused or garbage: nothing moves, but the pose is still placed
    else if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    if (this.peers === null) {
      let group = PUPPET_GROUPS.get(world);
      if (!group) PUPPET_GROUPS.set(world, (group = []));
      group.push(this);
      this.peers = group;
    }

    // A garbled network value must never reach the physics-free animation below (or the wake effects).
    if (!Number.isFinite(s.x + s.z + s.heading + s.vx + s.vz)) return;

    // Pose and velocity (the caller supplies the velocity every frame, so the nose pitch below stays smooth).
    this.position.x = s.x;
    this.position.z = s.z;
    this.heading = s.heading;
    this.velocity.set(s.vx, 0, s.vz);
    const vMag = Math.hypot(s.vx, s.vz);
    if (vMag > PUPPET_MAX_SPEED) this.velocity.multiplyScalar(PUPPET_MAX_SPEED / vMag);
    this.inSteer = clamp(s.steer, -1, 1);
    this.refreshAxes();
    const vf = this.velocity.x * this.sinH + this.velocity.z * this.cosH;

    // A respawn or rescue on the host: snap, never glide. (The first snapshot counts too.)
    if (s.epoch !== this.netSeenEpoch) {
      this.netSeenEpoch = s.epoch;
      this.yawRate = 0;
      this.prevForward = vf;
      this.accel = 0;
      this.pitchVel = 0;
      this.rollVel = 0;
      this.stunTimer = 0;
      this.flash = 0;
      this.wobblePhase = 0;
      this.turretYawA = 0;
      this.turretPitchA = AIM_UP;
      this.recoil = 0;
      this.muzzleFlashT = 0;
      this.setFlash(0);
    }

    // Flags and meters, exactly as the host has them.
    this._boosting = s.boosting;
    this._boost = s.boost;
    this._ammo = s.ammo;
    this._reloading = s.reloading;
    this.reloadElapsed = s.reloadProgress * Math.max(0.01, CONFIG.blaster.reloadTime);
    this._aimTargetId = s.aimTargetId;
    if (s.powerUp !== null) {
      const p = this.netPowerUp; // one object, reused: the HUD reads kind/timeLeft each frame
      p.kind = s.powerUp;
      p.timeLeft = s.powerUpLeft;
      this._powerUp = p;
    } else {
      this._powerUp = null;
    }

    // Shield: pops in on a fresh pickup. (A hit's own pop animation, started by netHit, is never cut short.)
    if (!s.shielded) {
      this._shielded = false;
    } else if (!this._shielded && this.shieldPop <= 0) {
      this._shielded = true;
      this.shieldAppear = 0;
    }

    // Stun: the wobble runs on a local timer (started by netHit); the flag itself follows the host.
    if (s.stunned && !this.netStunned && this.stunTimer <= 0) {
      this.stunTimer = this.stunDuration = NET_STUN_GUESS; // the hit event is late or was lost
    } else if (!s.stunned && this.netStunned) {
      this.stunTimer = 0; // the host says it is over
    }
    this.netStunned = s.stunned;
    if (this.stunTimer > 0) this.stunTimer = Math.max(0, this.stunTimer - dt);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt / FLASH_TIME);
    if (this.shieldPop > 0) this.shieldPop = Math.max(0, this.shieldPop - dt);

    // The turn rate the host's boat would have (same recipe as stepPhysics), so banking and the flag look right.
    const targetYaw = -this.inSteer * this.turnBase * turnShapeFor(Math.abs(vf) / this.topSpeed);
    this.yawRate += (targetYaw - this.yawRate) * (1 - Math.exp(-(this.easyDriving ? EASY_YAW_RESPONSE : YAW_RESPONSE) * dt));

    this.sampleWaves(dt, t, world);
    this.animate(dt, t, this.peers, aimTargets);
  }

  /** Guest: a shot was fired (the darts come from their own event). Recoil and a muzzle puff. */
  netFire(): void {
    if (this.disposed) return;
    this.recoil = 1;
    this.muzzleFlashT = 1;
  }

  /** Guest: this boat was hit. A shield pops, or the paint flashes and the boat wobbles. Looks only. */
  netHit(blocked: boolean, stunSeconds: number): void {
    if (this.disposed) return;
    if (blocked) {
      this._shielded = false;
      this.shieldPop = SHIELD_POP_TIME;
      return;
    }
    this.flash = 1;
    if (stunSeconds > 0) {
      this.stunTimer = Math.max(this.stunTimer, stunSeconds);
      this.stunDuration = this.stunTimer;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.peers) {
      const i = this.peers.indexOf(this);
      if (i >= 0) this.peers.splice(i, 1);
      this.peers = null;
    }
    this.rig.dispose();
    IMPLEMENTATIONS.delete(this);
  }
}

/** Lets resolveBoatCollisions reach a boat's wobble without widening the public Boat type. */
const IMPLEMENTATIONS = new WeakMap<Boat, FoamBoat>();

/** A toy speedboat with a foam-dart blaster. */
export function createBoat(init: BoatInit): Boat {
  const boat = new FoamBoat(init);
  IMPLEMENTATIONS.set(boat, boat);
  return boat;
}

/** Push overlapping boats apart and bounce them. Returns bumps for sound/FX. */
export function resolveBoatCollisions(boats: readonly Boat[]): BumpEvent[] {
  let events: BumpEvent[] | null = null;
  for (let i = 0; i < boats.length; i++) {
    const a = boats[i];
    for (let j = i + 1; j < boats.length; j++) {
      const b = boats[j];
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const minD = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;

      // Contact normal: from a toward b.
      const d = Math.sqrt(d2);
      let nx: number;
      let nz: number;
      if (d > 1e-4) {
        nx = dx / d;
        nz = dz / d;
      } else {
        nx = Math.sin(a.heading); // stacked exactly on top of each other: pick a direction
        nz = Math.cos(a.heading);
      }

      // Separate equally.
      const half = (minD - d) / 2;
      a.position.x -= nx * half;
      a.position.z -= nz * half;
      b.position.x += nx * half;
      b.position.z += nz * half;

      // Exchange velocity along the normal (equal masses), only if they are closing in.
      const closing = -((b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz);
      if (closing <= 0) continue;
      const jx = nx * ((closing * (1 + BOAT_BOUNCE)) / 2);
      const jz = nz * ((closing * (1 + BOAT_BOUNCE)) / 2);
      a.velocity.x -= jx;
      a.velocity.z -= jz;
      b.velocity.x += jx;
      b.velocity.z += jz;

      IMPLEMENTATIONS.get(a)?.jolt(nx, nz, closing);
      IMPLEMENTATIONS.get(b)?.jolt(-nx, -nz, closing);

      if (closing > BUMP_MIN_SPEED) {
        if (!events) events = [];
        events.push({
          aId: a.id,
          bId: b.id,
          strength: closing,
          point: new THREE.Vector3(
            a.position.x + nx * a.radius,
            (a.position.y + b.position.y) / 2 + 0.5,
            a.position.z + nz * a.radius,
          ),
        });
      }
    }
  }
  return events ?? NO_BUMPS;
}
