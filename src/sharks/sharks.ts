import * as THREE from 'three';
import { CONFIG } from '../config';
import { probeSolid } from '../ai/steering';
import { SHARK_ID_BASE } from '../types';
import type { AimTarget, BotDifficulty, Boat, Effects, ModeId, SharkBump, SharkNetState, SharkTag, Sharks, World } from '../types';
import { MEGA_SCALE, NOSE_Z } from './sharkModel';
import { createSharkRig } from './sharkRig';
import type { SharkPose, SharkRig } from './sharkRig';
import {
  HIT_Y,
  MEGA_SLOT,
  MODE_CHASE,
  MODE_CRUISE,
  MODE_FLEE,
  NORMAL_SLOTS,
  PHASE_DIVE,
  PHASE_FLIP,
  PHASE_LUNGE,
  PHASE_OFF,
  PHASE_SWIM,
  SLOTS,
  Shark,
} from './sharkState';
import { HARD_R, MEGA_HARD_R, clamp, enforceBounds, smoothstep, steerAround, swimStep, wrapPi } from './sharkSteer';

/**
 * Every shark in the lagoon: ambient cruisers in every game, attack waves and the MEGA SHARK in Boats vs. Sharks.
 *
 * Sharks are pooled (16 normal slots plus one MEGA slot), drawn with a few instanced meshes (sharkRig.ts),
 * and nothing is allocated per frame. Each shark is a tiny state machine:
 *   swim  -> cruising lazily, chasing a boat, or swimming away from a spot
 *   lunge -> the bump: a quick hop at the boat with the jaw open, then a splash
 *   flip  -> darted: a comic flip
 *   dive  -> darted: sinking out of sight (an ambient shark comes back `returnSec` after it was tagged)
 */

const TAU = Math.PI * 2;
/** The longest step simulated at once: a lag spike slows the sharks down a little instead of teleporting them. */
const MAX_STEP = 0.05;

// How high the middle of the body rides above the waves (meters). The water is solid, so below zero hides it.
const RIDE_CRUISE = -0.72; // only the fin and a hint of the back show
const RIDE_CHASE = 0.02; // back, eyes and fin all out
const RIDE_FLEE = -0.3;
const MEGA_RIDE_CRUISE = -0.9;
const MEGA_RIDE_CHASE = -0.45;
const MEGA_RIDE_FLEE = -0.7;
const REST_JAW = 0.28;
/** While chasing, the nose tips up a little so the grin shows. */
const CHASE_PITCH = 0.2;
/** Seconds to rise up from the depths when sent in. */
const APPEAR_SEC = 1.3;

// Timing.
const BUMP_COOLDOWN = 4;
const FLEE_SEC = 2.4;
const LUNGE_SEC = 0.6;
const MEGA_LUNGE_SEC = 0.8;
const FLIP_SEC = 0.9;
const MEGA_FLIP_SEC = 1.5;
const DIVE_SEC = 1.05;
const MEGA_DIVE_SEC = 1.8;
const RETARGET_SEC = 3;

// Reach and range.
const BUMP_REACH = 1.2;
const MEGA_BUMP_REACH = 3;
const CHASE_RANGE = 45;
const GIVE_UP_DISTANCE = 75;
const MEGA_SPEED = 0.8;
/** Cruising sharks swerve around boats this close (plus the boat's own radius). */
const BOAT_AVOID = 11;
/** Ambient sharks do not start closer than this to a boat's starting spot. */
const SPAWN_KEEP_OUT = 38;
const GATE_KEEP_OUT = 16;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

// ───────────────────────────── The network snapshot (private format) ─────────────────────────────
// A flat number array:  [mega health (-1 = not out), mega max health, waves left, entry count, ...entries]
// One entry per shark that is in the lagoon (STRIDE numbers, whole numbers so they pack small on the wire):
//   slot, phase, mode + 4 * wave, x (cm), z (cm), heading (mrad), speed (cm/s), turn rate (mrad/s),
//   appear (1/1000), progress through the lunge/flip/dive (1/1000)
const NET_HEAD = 4;
const NET_STRIDE = 10;

interface KeepOut {
  x: number;
  z: number;
  r: number;
}

class SharkSystem implements Sharks {
  readonly targets: AimTarget[] = [];
  readonly mapDots: { x: number; z: number; heading: number; mega: boolean }[] = [];

  private readonly root = new THREE.Group();
  private readonly rig: SharkRig;
  private readonly sharks: Shark[] = [];
  private readonly dots: { x: number; z: number; heading: number; mega: boolean }[] = [];
  private readonly bumps: SharkBump[] = [];
  private readonly keepOut: KeepOut[] = [];
  private readonly canChase: boolean;
  /** Boats vs. Sharks: how much the skill setting speeds the wave sharks up or slows them down. */
  private readonly waveSpeed: number;
  private readonly megaInfo = { health: 0, maxHealth: CONFIG.sharks.megaHealth };
  private megaOut = false;
  private boats: readonly Boat[] = [];
  private clock = 0;
  private t = 0;
  private disposed = false;

  // Online guest: set by the first applyNetState. From then on the sharks are puppets of the host's snapshots.
  private netMode = false;
  private netWaveLeft = 0;
  private netNearNext = false;
  /** Where each slot's entry starts in the previous / next snapshot (-1 = that shark is not in it). */
  private readonly netPrevAt = new Int32Array(SLOTS);
  private readonly netNextAt = new Int32Array(SLOTS);

  // Scratch space, reused every frame.
  private readonly nrm = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly surf = new THREE.Vector3();
  private spotX = 0;
  private spotZ = 0;
  /** What the shark that is thinking right now wants (filled in by the plan* methods). */
  private readonly plan = { want: 0, speed: 0, turn: 1, look: 12, goal: 1e9, dodge: true };
  private readonly pose: SharkPose = {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, wag1: 0, wag2: 0, jaw: 0, flash: 0, spray: 0, waterY: 0, waterPitch: 0, waterRoll: 0,
  };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    private readonly mode: ModeId,
    private readonly fx: Effects,
    skill: BotDifficulty,
  ) {
    this.root.name = 'sharks';
    scene.add(this.root);
    this.rig = createSharkRig(this.root);
    for (let i = 0; i < SLOTS; i++) {
      this.sharks.push(new Shark(i, i === MEGA_SLOT));
      this.dots.push({ x: 0, z: 0, heading: 0, mega: i === MEGA_SLOT });
    }
    this.canChase = mode !== 'practice';
    this.waveSpeed = mode === 'sharks' ? (CONFIG.sharks.speedBySkill[skill] ?? 1) : 1;

    // Ambient cruisers (Boats vs. Sharks brings its own waves instead).
    const count = mode === 'sharks' ? 0 : Math.min(NORMAL_SLOTS, (CONFIG.sharks.ambient as Record<string, number>)[mode] ?? 0);
    if (count > 0) {
      this.collectKeepOut();
      for (let i = 0; i < count; i++) {
        const s = this.sharks[i];
        this.launch(s, false);
        this.findOpenWater(s);
        s.heading = Math.random() * TAU - Math.PI;
      }
    }
    this.refreshTargets();
  }

  // ───────────────────────────── The public face ─────────────────────────────

  get waveLeft(): number {
    if (this.netMode) return this.netWaveLeft;
    let n = 0;
    for (let i = 0; i < SLOTS; i++) {
      const s = this.sharks[i];
      if (s.wave && (s.phase === PHASE_SWIM || s.phase === PHASE_LUNGE)) n++;
    }
    return n;
  }

  get mega(): { health: number; maxHealth: number } | null {
    return this.megaOut ? this.megaInfo : null;
  }

  update(t: number, dt: number, boats: readonly Boat[]): SharkBump[] {
    const bumps = this.bumps;
    bumps.length = 0;
    if (this.disposed) return bumps;
    this.boats = boats;
    this.t = t;
    const step = dt > 0 ? Math.min(dt, MAX_STEP) : 0;
    this.clock += step;

    for (let i = 0; i < SLOTS; i++) {
      const s = this.sharks[i];
      if (s.phase === PHASE_OFF) {
        if (s.returnAt > 0 && this.clock >= s.returnAt) this.comeBack(s);
        else continue;
      }
      s.flash = Math.max(0, s.flash - step * 6);
      s.shake = Math.max(0, s.shake - step * 2.6);
      if (s.bumpCooldown > 0) s.bumpCooldown -= step;
      switch (s.phase) {
        case PHASE_SWIM:
          this.swim(s, step);
          break;
        case PHASE_LUNGE:
          this.lunge(s, step);
          break;
        case PHASE_FLIP:
          this.flip(s, step);
          break;
        default:
          this.dive(s, step);
      }
    }
    this.separate(step);
    this.checkBumps();

    this.draw(step);
    return bumps;
  }

  /** Draw everyone, and refresh the hit spheres and the mini-map dots (the half of update() a guest runs too). */
  private draw(step: number): void {
    this.rig.begin();
    const dots = this.mapDots;
    dots.length = 0;
    for (let i = 0; i < SLOTS; i++) {
      const s = this.sharks[i];
      if (s.phase === PHASE_OFF) continue;
      this.writePose(s, step);
      this.updateTarget(s);
      if (s.phase !== PHASE_DIVE && (s.phase !== PHASE_SWIM || s.appear > 0.35)) {
        const d = this.dots[i];
        d.x = s.x;
        d.z = s.z;
        d.heading = s.heading;
        dots.push(d);
      }
    }
    this.rig.end();
    this.refreshTargets();
  }

  hit(sharkId: number, boatId: number, direction: THREE.Vector3): SharkTag | null {
    if (this.disposed) return null;
    const s = this.sharks[sharkId - SHARK_ID_BASE];
    if (!s || !this.hittable(s)) return null;
    const point = new THREE.Vector3(s.x, HIT_Y, s.z);
    this.surfacePoint(s.x, s.z, 0);
    s.flash = 1;

    if (s.mega) {
      this.megaInfo.health = Math.max(0, this.megaInfo.health - 1);
      if (this.megaInfo.health > 0) {
        s.shake = 1; // a flash and a short shake: it is not beaten yet
        s.jaw = Math.max(s.jaw, 0.7);
        this.fx.splash(this.surf, 1.4);
        return { sharkId, boatId, point, mega: true, defeated: false };
      }
      // Beaten: a big flip and a giant splash.
      this.megaOut = false;
      this.startFlip(s, direction);
      this.fx.splash(this.surf, 3);
      this.fx.bubbles(this.surf);
      this.refreshTargets();
      return { sharkId, boatId, point, mega: true, defeated: true };
    }

    this.startFlip(s, direction);
    if (!s.wave) s.returnAt = this.clock + CONFIG.sharks.returnSec;
    this.fx.splash(this.surf, 1.1);
    this.refreshTargets();
    return { sharkId, boatId, point, mega: false, defeated: true };
  }

  spawnWave(count: number, mega: boolean): void {
    if (this.disposed) return;
    if (mega) {
      const s = this.sharks[MEGA_SLOT];
      this.launch(s, true);
      this.edgeSpot(s, Math.random() * TAU);
      this.megaInfo.maxHealth = CONFIG.sharks.megaHealth;
      this.megaInfo.health = CONFIG.sharks.megaHealth;
      this.megaOut = true;
      this.refreshTargets();
      return;
    }
    // Free normal slots (a slot waiting to bring an ambient shark back is not free).
    const free: Shark[] = [];
    for (let i = 0; i < NORMAL_SLOTS && free.length < count; i++) {
      const s = this.sharks[i];
      if (s.phase === PHASE_OFF && s.returnAt === 0) free.push(s);
    }
    const base = Math.random() * TAU;
    for (let k = 0; k < free.length; k++) {
      const s = free[k];
      this.launch(s, true);
      // Evenly spread around the edge, with a little wobble so it does not look like a clock face.
      this.edgeSpot(s, base + (TAU * k) / free.length + rand(-0.06, 0.06));
    }
    this.refreshTargets();
  }

  // ───────────────────────────── Online ─────────────────────────────

  /** Host: every shark in the lagoon as a flat list of whole numbers (the format is described at the top of the file). */
  netState(): SharkNetState {
    const out: number[] = [this.megaOut ? this.megaInfo.health : -1, this.megaInfo.maxHealth, this.waveLeft, 0];
    let n = 0;
    for (let i = 0; i < SLOTS; i++) {
      const s = this.sharks[i];
      if (s.phase === PHASE_OFF) continue;
      n++;
      out.push(
        i,
        s.phase,
        s.mode + (s.wave ? 4 : 0),
        Math.round(s.x * 100),
        Math.round(s.z * 100),
        Math.round(wrapPi(s.heading) * 1000),
        Math.round(s.speed * 100),
        Math.round(s.turnVel * 1000),
        Math.round(clamp(s.appear, 0, 1) * 1000),
        Math.round(clamp(s.seqDur > 0 ? s.seqT / s.seqDur : 0, 0, 1) * 1000),
      );
    }
    out[3] = n;
    return out;
  }

  /**
   * Guest: show the sharks between two host snapshots. Only the render half of update() runs (no brains, no bumps).
   * Where a shark is comes from blending the two snapshots; what it is doing (swimming, lunging, flipping...) comes
   * from the nearer one, and when that changes the captured start values are set up here and the splashes play.
   */
  applyNetState(prev: SharkNetState, next: SharkNetState, alpha: number, t: number, dt: number): void {
    if (this.disposed) return;
    this.netMode = true;
    this.t = t;
    const step = dt > 0 ? Math.min(dt, MAX_STEP) : 0;
    this.clock += step;
    const k = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    // Switch to the next snapshot's view of things at the halfway point, and back only well before it, so a wobble
    // in the caller's clock never makes a shark flip back and forth (and replay its splash).
    if (k >= 0.5) this.netNearNext = true;
    else if (k < 0.3) this.netNearNext = false;
    const near = this.netNearNext ? next : prev;
    const prevAt = this.netPrevAt;
    const nextAt = this.netNextAt;
    this.indexNet(prev, prevAt);
    this.indexNet(next, nextAt);
    const nearAt = this.netNearNext ? nextAt : prevAt;

    // The MEGA SHARK's health, the wave count.
    if (near.length >= NET_HEAD) {
      const health = near[0];
      if (this.megaOut && health >= 0 && health < this.megaInfo.health) this.netMegaHit();
      if (health >= 0) this.megaInfo.health = this.megaOut ? Math.min(this.megaInfo.health, health) : health; // only ever goes down
      this.megaOut = health >= 0;
      this.megaInfo.maxHealth = near[1];
      this.netWaveLeft = near[2];
    }

    for (let i = 0; i < SLOTS; i++) {
      const s = this.sharks[i];
      const at = nearAt[i];
      if (at < 0) {
        // Not in the lagoon (any more).
        if (s.phase !== PHASE_OFF) {
          s.phase = PHASE_OFF;
          s.target.alive = false;
          s.spray = 0;
        }
        continue;
      }
      s.flash = Math.max(0, s.flash - step * 6);
      s.shake = Math.max(0, s.shake - step * 2.6);

      // Where it is: a blend of both snapshots when it is in both, else just the nearer one.
      const a = prevAt[i];
      const b = nextAt[i];
      let seq = near[at + 9] / 1000;
      if (a >= 0 && b >= 0) {
        s.x = lerp(prev[a + 3], next[b + 3], k) / 100;
        s.z = lerp(prev[a + 4], next[b + 4], k) / 100;
        const h0 = prev[a + 5] / 1000;
        s.heading = h0 + wrapPi(next[b + 5] / 1000 - h0) * k;
        s.speed = lerp(prev[a + 6], next[b + 6], k) / 100;
        s.turnVel = lerp(prev[a + 7], next[b + 7], k) / 1000;
        s.appear = lerp(prev[a + 8], next[b + 8], k) / 1000;
        // Progress only blends inside one and the same lunge/flip/dive.
        if (prev[a + 1] === next[b + 1] && next[b + 9] >= prev[a + 9]) seq = lerp(prev[a + 9], next[b + 9], k) / 1000;
      } else {
        s.x = near[at + 3] / 100;
        s.z = near[at + 4] / 100;
        s.heading = near[at + 5] / 1000;
        s.speed = near[at + 6] / 100;
        s.turnVel = near[at + 7] / 1000;
        s.appear = near[at + 8] / 1000;
      }
      const flags = near[at + 2];
      s.mode = flags & 3;
      s.wave = (flags & 4) !== 0;
      if (near[at + 1] !== s.phase) this.netPhase(s, near[at + 1]);
      s.seqT = seq * s.seqDur;
    }
    this.draw(step);
  }

  /** Where each shark's entry starts in a snapshot, by slot (-1 = not in it). */
  private indexNet(state: SharkNetState, out: Int32Array): void {
    out.fill(-1);
    const n = state.length >= NET_HEAD ? state[3] : 0;
    for (let k = 0; k < n; k++) {
      const at = NET_HEAD + k * NET_STRIDE;
      if (at + NET_STRIDE > state.length) break;
      const slot = state[at];
      if (slot >= 0 && slot < SLOTS) out[slot] = at;
    }
  }

  /**
   * A shark changed what it is doing (as seen in the snapshots): capture the start values update() would have
   * (the flip remembers where it took off from), and play the splashes and bubbles the host's sharks play.
   */
  private netPhase(s: Shark, to: number): void {
    const from = s.phase;
    const mega = s.mega;
    if (from === PHASE_OFF) {
      // Sent in (or back from a dive): start the way launch() does.
      s.yRide = this.rideFor(s);
      s.exY = s.yRide;
      s.exPitch = 0;
      s.pitchBase = s.mode === MODE_CHASE ? CHASE_PITCH : 0;
      s.bank = 0;
      s.jaw = REST_JAW;
      s.spray = 0;
      s.flash = 0;
      s.shake = 0;
      s.vx = 0;
      s.vz = 0;
    }
    switch (to) {
      case PHASE_LUNGE:
        s.seqDur = mega ? MEGA_LUNGE_SEC : LUNGE_SEC;
        s.jawStart = s.jaw;
        break;
      case PHASE_FLIP:
        // Darted: the same splash hit() makes, then a flip from wherever it was.
        s.seqDur = mega ? MEGA_FLIP_SEC : FLIP_SEC;
        s.flipH = mega ? 3.4 : 1.9;
        s.flipY0 = s.exY;
        s.flipPitch0 = s.exPitch;
        s.jawStart = s.jaw;
        s.flash = 1;
        this.surfacePoint(s.x, s.z, 0);
        this.fx.splash(this.surf, mega ? 3 : 1.1);
        if (mega) this.fx.bubbles(this.surf);
        break;
      case PHASE_DIVE:
        s.seqDur = mega ? MEGA_DIVE_SEC : DIVE_SEC;
        this.splashDown(s);
        break;
      case PHASE_SWIM:
        if (from === PHASE_LUNGE) this.splashAtNose(s); // the pounce is over: the nose lands
        break;
      default:
        break;
    }
    s.phase = to;
  }

  /** The MEGA SHARK took a dart and is still going (what hit() does on the host): a flash, a shake, a wide jaw, a splash. */
  private netMegaHit(): void {
    const s = this.sharks[MEGA_SLOT];
    if (s.phase === PHASE_OFF) return;
    s.flash = 1;
    s.shake = 1;
    s.jaw = Math.max(s.jaw, 0.7);
    this.surfacePoint(s.x, s.z, 0);
    this.fx.splash(this.surf, 1.4);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.sharks) {
      s.phase = PHASE_OFF;
      s.target.alive = false;
      s.chaseBoat = null;
    }
    this.targets.length = 0;
    this.mapDots.length = 0;
    this.bumps.length = 0;
    this.megaOut = false;
    this.boats = [];
    this.scene.remove(this.root);
    this.rig.dispose();
  }

  // ───────────────────────────── Sending sharks in ─────────────────────────────

  /** Get a slot ready to swim. The caller then puts it somewhere. */
  private launch(s: Shark, wave: boolean): void {
    const cfg = CONFIG.sharks;
    s.phase = PHASE_SWIM;
    s.wave = wave;
    s.returnAt = 0;
    s.speed = cfg.cruiseSpeed * 0.8;
    s.turnVel = 0;
    s.vx = 0;
    s.vz = 0;
    s.appear = 0;
    s.flash = 0;
    s.shake = 0;
    s.spray = 0;
    s.bank = 0;
    s.pitchBase = 0;
    s.jaw = REST_JAW;
    s.yRide = s.mega ? MEGA_RIDE_CRUISE : RIDE_CRUISE;
    s.exY = s.yRide;
    s.exPitch = 0;
    s.avoidOff = 0;
    s.avoidSide = Math.random() < 0.5 ? -1 : 1;
    s.bumpCooldown = 1; // a moment of peace after arriving
    s.chaseBoat = null;
    s.chaseT = 0;
    s.fleeT = 0;
    s.stuckN = 0;
    s.progT = 1.5;
    s.progDist = 0;
    s.wpT = 0;
    // No two sharks swim quite alike.
    s.speedMul = s.mega ? 1 : wave ? rand(0.93, 1.07) : rand(0.85, 1.15);
    s.turnMul = s.mega ? 0.55 : rand(0.9, 1.15);
    s.weaveAmp = s.mega ? 0.04 : rand(0.05, 0.22);
    s.weaveFreq = rand(0.6, 1.4);
    s.weavePhase = Math.random() * TAU;
    if (wave) {
      s.mode = MODE_CHASE;
      s.retargetT = 0;
    } else {
      s.mode = MODE_CRUISE;
      s.chaseTimer = 8 + CONFIG.sharks.chaseEverySec * rand(0.3, 1.2);
    }
  }

  /** An ambient shark that was darted returns near the edge. */
  private comeBack(s: Shark): void {
    this.launch(s, false);
    this.edgeSpot(s, Math.random() * TAU);
    s.chaseTimer = CONFIG.sharks.chaseEverySec * rand(0.5, 1.1);
  }

  /** Put a shark in the water just inside the edge at angle `ang`, facing in, clear of islands. */
  private edgeSpot(s: Shark, ang: number): void {
    const hard = s.mega ? MEGA_HARD_R : HARD_R;
    const radius = this.world.arenaRadius - (s.mega ? 14 : 7);
    let a = ang;
    for (let k = 0; k < 14; k++) {
      // Try the angle itself, then wider and wider to either side.
      a = ang + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 0.13;
      this.spotX = Math.sin(a) * radius;
      this.spotZ = Math.cos(a) * radius;
      if (this.waterIsOpen(this.spotX, this.spotZ, hard + 6, true)) break;
    }
    s.x = this.spotX;
    s.z = this.spotZ;
    s.heading = Math.atan2(-s.x, -s.z) + rand(-0.25, 0.25);
    s.wpT = 0;
  }

  /** Put an ambient shark at a random open spot, away from boat starting spots and other sharks. */
  private findOpenWater(s: Shark): void {
    const R = this.world.arenaRadius;
    const hard = s.mega ? MEGA_HARD_R : HARD_R;
    for (let k = 0; k < 40; k++) {
      const ang = Math.random() * TAU;
      const rad = Math.sqrt(0.04 + Math.random() * 0.7) * R; // 0.2 R .. 0.86 R, evenly over the area
      const x = Math.sin(ang) * rad;
      const z = Math.cos(ang) * rad;
      if (!this.waterIsOpen(x, z, hard + 8, false)) continue;
      if (this.nearKeepOut(x, z)) continue;
      if (this.nearShark(s, x, z, 25)) continue;
      s.x = x;
      s.z = z;
      return;
    }
    this.edgeSpot(s, Math.random() * TAU);
  }

  /** Places an ambient shark should not start: where boats begin, and the race gates. */
  private collectKeepOut(): void {
    try {
      const points = this.world.spawnPoints(CONFIG.match.maxBoats, this.mode);
      for (const p of points) this.keepOut.push({ x: p.x, z: p.z, r: SPAWN_KEEP_OUT });
    } catch {
      // No spawn information: sharks may start anywhere open. That is fine.
    }
    if (this.mode === 'race') {
      for (const c of this.world.checkpoints) this.keepOut.push({ x: c.position.x, z: c.position.z, r: GATE_KEEP_OUT });
    }
  }

  /** Is (x, z) open water, `clear` meters from every island and inside the lagoon (a bit more inside unless `edge`)? */
  private waterIsOpen(x: number, z: number, clear: number, edge: boolean): boolean {
    const limit = this.world.arenaRadius - (edge ? 4 : 14);
    if (x * x + z * z > limit * limit) return false;
    const obstacles = this.world.obstacles;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const dx = x - o.x;
      const dz = z - o.z;
      const r = o.radius + clear;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }

  private nearKeepOut(x: number, z: number): boolean {
    for (let i = 0; i < this.keepOut.length; i++) {
      const k = this.keepOut[i];
      const dx = x - k.x;
      const dz = z - k.z;
      if (dx * dx + dz * dz < k.r * k.r) return true;
    }
    return false;
  }

  private nearShark(self: Shark, x: number, z: number, dist: number): boolean {
    for (let i = 0; i < SLOTS; i++) {
      const o = this.sharks[i];
      if (o === self || o.phase === PHASE_OFF) continue;
      const dx = x - o.x;
      const dz = z - o.z;
      if (dx * dx + dz * dz < dist * dist) return true;
    }
    return false;
  }

  // ───────────────────────────── Swimming ─────────────────────────────

  private swim(s: Shark, dt: number): void {
    if (s.appear < 1) s.appear = Math.min(1, s.appear + dt / APPEAR_SEC);
    if (s.mode === MODE_CHASE) this.planChase(s, dt);
    else if (s.mode === MODE_FLEE) this.planFlee(s, dt);
    else this.planCruise(s, dt);

    const p = this.plan;
    let want = p.want;
    if (p.dodge) want = this.dodgeBoats(s, want);
    want = steerAround(s, want, p.look, p.goal, this.world, dt);
    swimStep(s, want, p.turn, p.speed, dt);
  }

  /** Lazy loops: wander from one open-water spot to the next. */
  private planCruise(s: Shark, dt: number): void {
    const p = this.plan;
    s.wpT -= dt;
    let dx = s.wpX - s.x;
    let dz = s.wpZ - s.z;
    let d = Math.sqrt(dx * dx + dz * dz);
    if (d < 9 || s.wpT <= 0) {
      this.pickWaypoint(s);
      dx = s.wpX - s.x;
      dz = s.wpZ - s.z;
      d = Math.sqrt(dx * dx + dz * dz);
    }
    p.want = Math.atan2(dx, dz);
    p.goal = d + 2;
    p.speed = CONFIG.sharks.cruiseSpeed * s.speedMul * (1 + 0.08 * Math.sin(this.clock * 0.6 + s.weavePhase)) * (s.mega ? MEGA_SPEED : 1);
    p.turn = 0.95 * s.turnMul;
    p.look = 12 + p.speed + (s.mega ? 8 : 0);
    p.dodge = true;
    // Now and then an ambient shark gets curious about a boat (never in Balloon Pop).
    if (!s.wave && this.canChase) {
      s.chaseTimer -= dt;
      if (s.chaseTimer <= 0) this.tryChase(s);
    }
  }

  private planChase(s: Shark, dt: number): void {
    const cfg = CONFIG.sharks;
    const p = this.plan;
    if (s.wave) {
      s.retargetT -= dt;
      if (s.retargetT <= 0 || !s.chaseBoat) this.pickTarget(s);
    } else {
      s.chaseT -= dt;
    }
    const b = s.chaseBoat;
    if (!b) {
      // Nobody to go after: drift toward the middle of the lagoon.
      p.want = Math.atan2(-s.x, -s.z);
      p.speed = cfg.cruiseSpeed * s.speedMul;
      p.turn = 0.95 * s.turnMul;
      p.look = 14;
      p.goal = 1e9;
      p.dodge = true;
      return;
    }
    const bx = b.position.x;
    const bz = b.position.z;
    const dx = bx - s.x;
    const dz = bz - s.z;
    const d = Math.sqrt(dx * dx + dz * dz);

    if (!s.wave && (s.chaseT <= 0 || d > GIVE_UP_DISTANCE)) {
      this.giveUp(s, bx, bz);
      this.planFlee(s, dt);
      return;
    }
    // Is it getting anywhere? (Stuck behind an island, or the boat is simply too quick.)
    s.progT -= dt;
    if (s.progT <= 0) {
      s.progT = 1.5;
      s.stuckN = d > 12 && d > s.progDist - 1 ? s.stuckN + 1 : 0;
      s.progDist = d;
      if (s.stuckN >= 2) {
        s.stuckN = 0;
        if (s.wave) s.retargetT = 0; // try another boat
        else {
          this.giveUp(s, bx, bz);
          this.planFlee(s, dt);
          return;
        }
      }
    }

    // Aim a little ahead of a moving boat, with a personal weave that fades as it closes in.
    const lead = clamp(d / 24, 0, 0.5);
    const tx = bx + b.velocity.x * lead;
    const tz = bz + b.velocity.z * lead;
    p.want = Math.atan2(tx - s.x, tz - s.z) + s.weaveAmp * Math.sin(this.clock * s.weaveFreq + s.weavePhase) * smoothstep(8, 22, d);
    let speed = cfg.chaseSpeed * s.speedMul * (s.wave ? this.waveSpeed : 1) * (s.mega ? MEGA_SPEED : 1);
    if (s.bumpCooldown > 0.2 && d < 10) speed *= 0.5; // hang back until it may bump again
    p.speed = speed;
    p.turn = 1.9 * s.turnMul;
    p.look = 9 + speed + (s.mega ? 8 : 0);
    p.goal = d + 2;
    p.dodge = false;
  }

  private planFlee(s: Shark, dt: number): void {
    const cfg = CONFIG.sharks;
    const p = this.plan;
    s.fleeT -= dt;
    p.want = Math.atan2(s.x - s.fleeX, s.z - s.fleeZ) + s.fleeBias;
    p.speed = (s.wave ? cfg.chaseSpeed * 0.55 * this.waveSpeed : cfg.cruiseSpeed * 1.5) * s.speedMul * (s.mega ? MEGA_SPEED : 1);
    p.turn = 1.5 * s.turnMul;
    p.look = 14 + (s.mega ? 8 : 0);
    p.goal = 1e9;
    p.dodge = true;
    if (s.fleeT <= 0) {
      if (s.wave) {
        s.mode = MODE_CHASE;
        s.retargetT = 0;
      } else {
        s.mode = MODE_CRUISE;
        s.wpT = 0;
        s.chaseTimer = cfg.chaseEverySec * rand(0.6, 1.4);
      }
    }
  }

  /** Swerve gently around boats that are close, so cruising sharks do not swim through them. */
  private dodgeBoats(s: Shark, want: number): number {
    const boats = this.boats;
    let ax = Math.sin(want);
    let az = Math.cos(want);
    let pushed = false;
    const reach = BOAT_AVOID + (s.mega ? 6 : 0);
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      const dx = s.x - b.position.x;
      const dz = s.z - b.position.z;
      const r = reach + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const w = 1 - d / r;
      const k = (w * w * 2.4) / d;
      ax += dx * k;
      az += dz * k;
      pushed = true;
    }
    return pushed ? Math.atan2(ax, az) : want;
  }

  /** Choose the next spot to swim to: mostly a lazy arc ahead, sometimes a big turn so they loop back. */
  private pickWaypoint(s: Shark): void {
    const hard = s.mega ? MEGA_HARD_R : HARD_R;
    for (let k = 0; k < 6; k++) {
      const turn = Math.random() < 0.2 ? (Math.random() < 0.5 ? -1 : 1) * rand(1.8, 3) : rand(-1.1, 1.1);
      const a = s.heading + turn;
      const dist = rand(28, 60);
      const x = s.x + Math.sin(a) * dist;
      const z = s.z + Math.cos(a) * dist;
      if (!this.waterIsOpen(x, z, hard + 7, false)) continue;
      if (probeSolid(s.x, s.z, Math.sin(a), Math.cos(a), hard, this.world, 2, hard + 2, dist) < dist - 1) continue;
      s.wpX = x;
      s.wpZ = z;
      s.wpT = rand(14, 20);
      return;
    }
    // Nothing nearby is open (a shark wedged in a corner): pick any open spot in the lagoon.
    const R = this.world.arenaRadius;
    for (let k = 0; k < 30; k++) {
      const ang = Math.random() * TAU;
      const rad = Math.sqrt(rand(0.04, 0.7)) * R;
      const x = Math.sin(ang) * rad;
      const z = Math.cos(ang) * rad;
      if (this.waterIsOpen(x, z, hard + 7, false)) {
        s.wpX = x;
        s.wpZ = z;
        s.wpT = rand(14, 20);
        return;
      }
    }
    s.wpX = 0;
    s.wpZ = 0;
    s.wpT = 10;
  }

  /** Ambient: pick the nearest boat within range that no other shark is already chasing. */
  private tryChase(s: Shark): void {
    const boats = this.boats;
    let best: Boat | null = null;
    let bestD = CHASE_RANGE;
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      const dx = b.position.x - s.x;
      const dz = b.position.z - s.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= bestD || this.isChased(b, s)) continue;
      best = b;
      bestD = d;
    }
    if (!best) {
      s.chaseTimer = rand(1.5, 3.5); // nobody close: look again soon
      return;
    }
    s.mode = MODE_CHASE;
    s.chaseBoat = best;
    s.chaseT = CONFIG.sharks.chaseSec * rand(0.8, 1.15);
    s.progT = 1.5;
    s.progDist = bestD;
    s.stuckN = 0;
  }

  private isChased(b: Boat, except: Shark): boolean {
    for (let i = 0; i < SLOTS; i++) {
      const o = this.sharks[i];
      if (o !== except && o.mode === MODE_CHASE && o.chaseBoat === b && (o.phase === PHASE_SWIM || o.phase === PHASE_LUNGE)) return true;
    }
    return false;
  }

  /** Ambient: it gives up, and swims off away from where the boat is. */
  private giveUp(s: Shark, bx: number, bz: number): void {
    s.mode = MODE_FLEE;
    s.fleeX = bx;
    s.fleeZ = bz;
    s.fleeT = rand(2.5, 3.5);
    s.fleeBias = (Math.random() < 0.5 ? -1 : 1) * rand(0.3, 0.7);
    s.chaseBoat = null;
    s.chaseTimer = CONFIG.sharks.chaseEverySec * rand(0.6, 1.4);
  }

  /**
   * Boats vs. Sharks: pick the nearest boat, spreading out (at most 2 sharks per boat while there is room;
   * when every boat is busy, the least busy one).
   */
  private pickTarget(s: Shark): void {
    s.retargetT = RETARGET_SEC * rand(0.85, 1.15);
    const boats = this.boats;
    let best: Boat | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      let load = 0;
      for (let j = 0; j < SLOTS; j++) {
        const o = this.sharks[j];
        if (o !== s && o.wave && o.mode === MODE_CHASE && o.chaseBoat === b && o.phase !== PHASE_OFF) load++;
      }
      const dx = b.position.x - s.x;
      const dz = b.position.z - s.z;
      const score = Math.sqrt(dx * dx + dz * dz) + (load >= 2 ? 500 * (load - 1) : 0);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    s.chaseBoat = best;
    s.progDist = Infinity;
    s.stuckN = 0;
  }

  // ───────────────────────────── The bump ─────────────────────────────

  /** A shark's nose (or body) touching a boat: bump it. Never in Balloon Pop. */
  private checkBumps(): void {
    if (this.mode === 'practice') return;
    const boats = this.boats;
    for (let i = 0; i < SLOTS; i++) {
      const s = this.sharks[i];
      if (s.phase !== PHASE_SWIM || s.bumpCooldown > 0 || s.appear < 0.7) continue;
      const scale = s.mega ? MEGA_SCALE : 1;
      const noseX = s.x + Math.sin(s.heading) * NOSE_Z * scale;
      const noseZ = s.z + Math.cos(s.heading) * NOSE_Z * scale;
      const reach = s.mega ? MEGA_BUMP_REACH : BUMP_REACH;
      for (let j = 0; j < boats.length; j++) {
        const b = boats[j];
        const bx = b.position.x;
        const bz = b.position.z;
        let dx = bx - noseX;
        let dz = bz - noseZ;
        let r = b.radius + reach;
        let touching = dx * dx + dz * dz < r * r;
        if (!touching) {
          // A boat that drives into the side of the body counts too.
          dx = bx - s.x;
          dz = bz - s.z;
          r = b.radius + 0.9 * scale;
          touching = dx * dx + dz * dz < r * r;
        }
        if (!touching) continue;
        this.bump(s, b, noseX, noseZ);
        break;
      }
    }
  }

  private bump(s: Shark, b: Boat, noseX: number, noseZ: number): void {
    const bx = b.position.x;
    const bz = b.position.z;
    const dx = bx - s.x;
    const dz = bz - s.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    this.dir.set(dx / len, 0, dz / len);
    const blocked = !b.onHit(this.dir, CONFIG.sharks.bumpStun);
    const px = (noseX + bx) * 0.5;
    const pz = (noseZ + bz) * 0.5;
    this.bumps.push({
      sharkId: s.target.id,
      boatId: b.id,
      point: new THREE.Vector3(px, this.world.waveHeight(px, pz, this.t) + 0.3, pz),
      blocked,
      mega: s.mega,
    });

    // The lunge: the nose carries on toward the boat, then it splashes down and turns away.
    const noseDist = Math.sqrt((bx - noseX) * (bx - noseX) + (bz - noseZ) * (bz - noseZ));
    s.phase = PHASE_LUNGE;
    s.seqT = 0;
    s.seqDur = s.mega ? MEGA_LUNGE_SEC : LUNGE_SEC;
    s.lungeTravel = clamp(noseDist - b.radius * 0.6, 0.8, 5);
    s.lungeAim = Math.atan2(dx, dz);
    s.jawStart = s.jaw;
    s.bumpCooldown = BUMP_COOLDOWN;
    s.fleeX = bx;
    s.fleeZ = bz;
    s.chaseBoat = null;
    s.chaseT = 0;
  }

  private lunge(s: Shark, dt: number): void {
    s.seqT += dt;
    const tau = Math.min(1, s.seqT / s.seqDur);
    s.heading = wrapPi(s.heading + clamp(wrapPi(s.lungeAim - s.heading), -2.5 * dt, 2.5 * dt));
    s.turnVel *= Math.max(0, 1 - 8 * dt);
    // A pounce: starts fast and settles quickly. The distances add up to lungeTravel (the area under 3(1-t)^2 is 1).
    s.speed = ((3 * s.lungeTravel) / s.seqDur) * (1 - tau) * (1 - tau);
    s.x += Math.sin(s.heading) * s.speed * dt;
    s.z += Math.cos(s.heading) * s.speed * dt;
    if (tau < 1) return;

    // Splash down at the nose, then turn away.
    this.splashAtNose(s);
    s.phase = PHASE_SWIM;
    s.mode = MODE_FLEE;
    s.fleeT = FLEE_SEC * (s.mega ? 1.1 : 1);
    s.fleeBias = (Math.random() < 0.5 ? -1 : 1) * rand(0.3, 0.7);
    s.speed = Math.max(s.speed, 2);
    s.chaseTimer = CONFIG.sharks.chaseEverySec * rand(0.8, 1.4);
  }

  // ───────────────────────────── Darted ─────────────────────────────

  private startFlip(s: Shark, dir: THREE.Vector3): void {
    s.phase = PHASE_FLIP;
    s.seqT = 0;
    s.seqDur = s.mega ? MEGA_FLIP_SEC : FLIP_SEC;
    s.flipH = s.mega ? 3.4 : 1.9;
    s.flipY0 = s.exY;
    s.flipPitch0 = s.exPitch;
    s.jawStart = s.jaw;
    // Knocked along the dart's way, carrying a bit of its swim.
    const hl = Math.sqrt(dir.x * dir.x + dir.z * dir.z) || 1;
    const push = s.mega ? 1.5 : 2.5;
    s.vx = (dir.x / hl) * push + Math.sin(s.heading) * s.speed * 0.35;
    s.vz = (dir.z / hl) * push + Math.cos(s.heading) * s.speed * 0.35;
    s.speed = 0;
    s.turnVel = 0;
    s.chaseBoat = null;
    s.mode = MODE_FLEE;
  }

  private flip(s: Shark, dt: number): void {
    s.seqT += dt;
    this.drift(s, dt);
    if (s.seqT < s.seqDur) return;
    // Back down with a splash, and off it goes.
    this.splashDown(s);
    s.phase = PHASE_DIVE;
    s.seqT = 0;
    s.seqDur = s.mega ? MEGA_DIVE_SEC : DIVE_SEC;
  }

  /** The splash where a lunging shark's nose lands. */
  private splashAtNose(s: Shark): void {
    const scale = s.mega ? MEGA_SCALE : 1;
    this.surfacePoint(s.x + Math.sin(s.heading) * NOSE_Z * scale, s.z + Math.cos(s.heading) * NOSE_Z * scale, 0);
    this.fx.splash(this.surf, s.mega ? 3 : 1.1);
  }

  /** The splash and bubbles where a flipping shark comes back down, just before it dives. */
  private splashDown(s: Shark): void {
    this.surfacePoint(s.x, s.z, 0);
    if (s.mega) {
      this.fx.splash(this.surf, 3.6);
      this.fx.bubbles(this.surf);
      this.surfacePoint(s.x + 3, s.z + 2, 0);
      this.fx.splash(this.surf, 2.6);
      this.surfacePoint(s.x - 3, s.z - 2, 0);
      this.fx.splash(this.surf, 2.6);
      this.fx.bubbles(this.surf);
    } else {
      this.fx.splash(this.surf, 1.4);
      this.surfacePoint(s.x, s.z, -0.2);
      this.fx.bubbles(this.surf);
    }
  }

  private dive(s: Shark, dt: number): void {
    s.seqT += dt;
    this.drift(s, dt);
    if (s.seqT < s.seqDur) return;
    s.phase = PHASE_OFF;
    s.target.alive = false;
    s.spray = 0;
  }

  private drift(s: Shark, dt: number): void {
    s.x += s.vx * dt;
    s.z += s.vz * dt;
    const k = Math.exp(-1.8 * dt);
    s.vx *= k;
    s.vz *= k;
  }

  // ───────────────────────────── Housekeeping ─────────────────────────────

  /** Keep sharks from piling onto each other (the MEGA SHARK shoulders the little ones aside), then make them safe. */
  private separate(dt: number): void {
    const list = this.sharks;
    const k = Math.min(1, dt * 6);
    for (let i = 0; i < SLOTS; i++) {
      const a = list[i];
      if (a.phase !== PHASE_SWIM && a.phase !== PHASE_LUNGE) continue;
      for (let j = i + 1; j < SLOTS; j++) {
        const b = list[j];
        if (b.phase !== PHASE_SWIM && b.phase !== PHASE_LUNGE) continue;
        const min = (a.mega ? 4.5 : 1.9) + (b.mega ? 4.5 : 1.9);
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-3) {
          dx = 1;
          dz = 0;
          d = 1;
        }
        const push = Math.min(0.3, (min - d) * k);
        const wa = a.mega ? 0.1 : b.mega ? 0.9 : 0.5;
        const nx = dx / d;
        const nz = dz / d;
        a.x -= nx * push * 2 * wa;
        a.z -= nz * push * 2 * wa;
        b.x += nx * push * 2 * (1 - wa);
        b.z += nz * push * 2 * (1 - wa);
      }
    }
    for (let i = 0; i < SLOTS; i++) {
      const s = list[i];
      if (s.phase !== PHASE_OFF) enforceBounds(s, this.world);
    }
  }

  private hittable(s: Shark): boolean {
    return (s.phase === PHASE_SWIM || s.phase === PHASE_LUNGE) && s.appear > 0.5;
  }

  /** Rebuild the list of hittable sharks (same array, same objects every time). */
  private refreshTargets(): void {
    const list = this.targets;
    list.length = 0;
    for (let i = 0; i < SLOTS; i++) {
      const s = this.sharks[i];
      const live = this.hittable(s);
      s.target.alive = live;
      if (live) list.push(s.target);
    }
  }

  private updateTarget(s: Shark): void {
    const tg = s.target;
    tg.position.set(s.x, HIT_Y, s.z);
    if (s.phase === PHASE_SWIM || s.phase === PHASE_LUNGE) tg.velocity.set(Math.sin(s.heading) * s.speed, 0, Math.cos(s.heading) * s.speed);
    else tg.velocity.set(s.vx, 0, s.vz);
  }

  /** Scratch point on the water surface at (x, z), `below` meters under it (negative = above). */
  private surfacePoint(x: number, z: number, below: number): void {
    this.surf.set(x, this.world.waveHeight(x, z, this.t) - below, z);
  }

  // ───────────────────────────── How it looks ─────────────────────────────

  private rideFor(s: Shark): number {
    if (s.mode === MODE_CHASE) return s.mega ? MEGA_RIDE_CHASE : RIDE_CHASE;
    if (s.mode === MODE_FLEE) return s.mega ? MEGA_RIDE_FLEE : RIDE_FLEE;
    return s.mega ? MEGA_RIDE_CRUISE : RIDE_CRUISE;
  }

  /** Work out one shark's whole pose for this frame and hand it to the rig. */
  private writePose(s: Shark, dt: number): void {
    const P = this.pose;
    const world = this.world;
    const wy = world.waveHeight(s.x, s.z, this.t);
    world.waveNormal(s.x, s.z, this.t, this.nrm);
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const ny = Math.max(this.nrm.y, 0.3);
    // The shark lies along the swell: nose up on the way up a wave, leaning with the slope to its side.
    const wavePitch = Math.atan(-(this.nrm.x * fx + this.nrm.z * fz) / ny) * 0.6;
    const waveRoll = Math.atan((this.nrm.z * fx - this.nrm.x * fz) / ny) * 0.6;

    let exY: number;
    let exPitch: number;
    let jaw: number;
    let rate: number;
    let a1: number;
    let a2: number;
    let rollExtra = 0;
    let sprayTarget = 0;
    let tilt = 1; // how much of the wave tilt it follows
    const sp = Math.min(s.speed, 14);
    const mega = s.mega;

    switch (s.phase) {
      case PHASE_SWIM: {
        s.yRide += (this.rideFor(s) - s.yRide) * (1 - Math.exp(-2.4 * dt));
        const rise = smoothstep(0, 1, s.appear);
        exY = s.yRide - (mega ? 9 : 3) * (1 - rise);
        s.pitchBase += ((s.mode === MODE_CHASE ? CHASE_PITCH : 0) - s.pitchBase) * (1 - Math.exp(-3 * dt));
        exPitch = s.pitchBase;
        // A happy half-open grin; while chasing the jaw goes chomp-chomp.
        let jt = REST_JAW + 0.04 * Math.sin(this.clock * 1.7 + s.weavePhase);
        if (s.mode === MODE_CHASE) jt = 0.3 + 0.3 * (0.5 + 0.5 * Math.sin(this.clock * 14 + s.weavePhase));
        else if (s.mode === MODE_FLEE) jt = 0.2;
        s.jaw += (jt - s.jaw) * (1 - Math.exp(-12 * dt));
        jaw = s.jaw;
        rate = TAU * (0.9 + 0.22 * sp) * (mega ? 0.55 : 1);
        a1 = 0.09 + 0.012 * sp;
        a2 = 0.3 + 0.015 * sp;
        sprayTarget = smoothstep(0.35, 0.8, s.appear);
        break;
      }
      case PHASE_LUNGE: {
        const tau = clamp(s.seqT / s.seqDur, 0, 1);
        // A hop: up and over in an arc, nose up first and then nose down.
        exY = s.yRide + (mega ? 1.3 : 0.7) * 4 * tau * (1 - tau);
        exPitch = s.pitchBase * (1 - tau) + 0.55 * (1 - 2 * tau);
        // Jaw wide open, then CHOMP.
        if (tau < 0.18) jaw = lerp(s.jawStart, 1.05, smoothstep(0, 0.18, tau));
        else if (tau < 0.55) jaw = 1.05;
        else if (tau < 0.66) jaw = lerp(1.05, 0.12, smoothstep(0.55, 0.66, tau));
        else jaw = lerp(0.12, 0.3, smoothstep(0.66, 1, tau));
        s.jaw = jaw;
        rate = TAU * 3.2;
        a1 = 0.07;
        a2 = 0.25;
        break;
      }
      case PHASE_FLIP: {
        const tau = clamp(s.seqT / s.seqDur, 0, 1);
        const rest = mega ? -0.6 : -0.15;
        // Up in an arc and a full backflip, landing back at the water.
        exY = s.flipY0 * (1 - tau) + rest * tau + s.flipH * 4 * tau * (1 - tau);
        exPitch = s.flipPitch0 * (1 - tau) + TAU * smoothstep(0, 1, tau);
        rollExtra = 0.5 * Math.sin(tau * Math.PI * 3);
        jaw = lerp(s.jawStart, 1, smoothstep(0, 0.25, tau)); // "whoa!"
        s.jaw = jaw;
        rate = TAU * 4.2;
        a1 = 0.2;
        a2 = 0.7;
        tilt = 0.25;
        break;
      }
      default: {
        const tau = clamp(s.seqT / s.seqDur, 0, 1);
        // Nose first, tail wiggling in the air, and gone.
        exY = (mega ? -0.6 : -0.15) - (mega ? 12 : 4.2) * tau * tau;
        exPitch = -(mega ? 1 : 1.15) * smoothstep(0, 0.5, tau);
        jaw = 0.15;
        s.jaw = jaw;
        rate = TAU * 3.5;
        a1 = 0.15;
        a2 = 0.55;
        tilt = 0.25;
      }
    }

    s.exY = exY;
    s.exPitch = exPitch;
    s.wagPhase += rate * dt;
    s.spray += (sprayTarget - s.spray) * (1 - Math.exp(-6 * dt));
    s.bank += (clamp(-s.turnVel * 0.16, -0.45, 0.45) - s.bank) * (1 - Math.exp(-6 * dt));

    // The MEGA SHARK shakes when a dart lands.
    const shake = s.shake;
    const shakeYaw = shake > 0 ? Math.sin(this.clock * 50) * 0.08 * shake : 0;
    const shakeRoll = shake > 0 ? Math.sin(this.clock * 43 + 1) * 0.07 * shake : 0;

    P.x = s.x;
    P.z = s.z;
    P.y = wy + exY;
    P.yaw = s.heading - 0.3 * a1 * Math.sin(s.wagPhase) + shakeYaw; // the head sways a little against the tail
    P.pitch = exPitch + wavePitch * tilt;
    P.roll = s.bank + waveRoll * tilt + rollExtra + shakeRoll;
    P.wag1 = a1 * Math.sin(s.wagPhase);
    P.wag2 = a2 * Math.sin(s.wagPhase - 1.1);
    P.jaw = jaw;
    P.flash = s.flash;
    P.spray = s.spray * clamp(0.55 + s.speed / 10, 0.55, 1.5);
    P.waterY = wy;
    P.waterPitch = wavePitch;
    P.waterRoll = waveRoll;
    this.rig.add(mega, P);
  }
}

/**
 * Every shark in the lagoon. `skill` scales shark speed in Boats vs. Sharks.
 * Ambient cruisers in every other mode (CONFIG.sharks.ambient); attack waves via spawnWave() in 'sharks'.
 */
export function createSharks(scene: THREE.Scene, world: World, mode: ModeId, fx: Effects, skill: BotDifficulty): Sharks {
  return new SharkSystem(scene, world, mode, fx, skill);
}
