/**
 * The guest's render-only copy of the host's match (DESIGN.md "v5: Online multiplayer" > Guest).
 *
 * A guest never simulates. It builds the same world, puppet boats (from the host's exact BoatInits), sharks,
 * crates, balloons, effects and darts, then every frame:
 *  - reads this device's controls and sends them to the host,
 *  - replays the host's one-shot events,
 *  - places everything from the host's snapshots (other boats and sharks a little in the past, interpolated;
 *    this player's own boat from the newest snapshot, carried forward by its velocity),
 *  - and follows the own boat with the ordinary chase camera.
 *
 * src/net/guest.ts owns the connection and feeds this view through pushSnapshot / pushEvents / noteState.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { SHARK_ID_BASE } from '../types';
import type {
  Balloons, Boat, BoatControls, BoatInit, BoatNetState, Controller, ControllerContext, DartSpawn, DartSystem, DartTarget,
  Effects, Hud, HudState, InputManager, MapBoat, MapState, MatchSetup, ModeId, Pickups, PlayerHud, ScoreRow, Sfx, Sharks,
  Viewport, World,
} from '../types';
import { ChaseCamera } from '../game/cameras';
import { reportError } from '../game/debug';
import {
  idleController, fallbackBalloons, fallbackBoat, fallbackDarts, fallbackPickups, fallbackSharks, fallbackWorld, quietFx,
} from '../game/fallbacks';
import { V2_METHODS, buildOrFallback, guard } from '../game/guard';
import type { MatchServices } from '../game/match';
import {
  createBalloons, createBoat, createDartSystem, createEffects, createPickups, createSharks, createWorld,
} from '../game/modules';
import { clamp, damp, topSpeedOf, wrapPi } from '../game/util';
import { CONTROLS_HZ, INTERP_DELAY, MAX_EXTRAPOLATE } from './protocol';
import type { GuestControls, NetAppState, NetEvent, NetSnapshot } from './protocol';
import type { GuestView } from './session';

/** What src/net/guest.ts needs from the view beyond the GuestView contract. */
export interface NetGuestView extends GuestView {
  /** The newest host snapshot (any order; late and duplicate ones are dropped). */
  pushSnapshot(s: NetSnapshot): void;
  /** One `ev` message from the host: `t` is the host match time the events happened at. */
  pushEvents(t: number, events: readonly NetEvent[]): void;
  /** The host's app state changed (countdown, playing, paused, results...). */
  noteState(state: NetAppState): void;
}

export interface GuestViewInit {
  setup: MatchSetup;
  /** Exactly how the host built every boat (index = boat id). */
  inits: readonly BoatInit[];
  /** This device's player slot = its boat id. */
  slot: number;
  services: MatchServices;
  /** Hand this device's controls to the host (the fast channel). */
  sendControls(msg: GuestControls): void;
}

const NO_BOATS: readonly Boat[] = [];
const NO_TARGETS: readonly DartTarget[] = [];

/** Snapshots kept for interpolation (10 at 20 Hz = half a second). */
const SNAP_KEEP = 10;
/** Arrival times remembered for the host-clock estimate (24 at 20 Hz = just over a second). */
const CLOCK_WINDOW = 24;
/** How fast the host-clock estimate eases toward its target (per second), and the gap that makes it jump instead. */
const CLOCK_SLEW = 4;
const CLOCK_JUMP = 0.4;
/** If the host clock goes back by more than this between snapshots, a new match (or a long pause) began. */
const RESTART_GAP = 1;
/** When snapshots arrive late, the view draws a little further in the past (at most this much extra, seconds). */
const MAX_EXTRA_DELAY = 0.15;
const EXTRA_DECAY = 0.03;
/** Starved of snapshots for this long: forget the clock estimate and find the host's clock again. */
const RESYNC_AFTER = 0.35;
/** The own boat's small jumps (a new snapshot landing) melt away at this rate (per second). */
const OWN_SETTLE = 10;
/** A bigger jump than this (meters) is a real teleport, not a correction. */
const OWN_SNAP_DIST = 5;
/** The own boat's turn rate is estimated from two snapshots; never trust more than this (rad/s). */
const MAX_TURN_RATE = 4;
/** A sound with a position is skipped when the own boat is farther than this (meters). */
const HEARABLE = 70;
/** Events this old (seconds) are not worth replaying as sounds, sparks or shakes. */
const STALE_SEC = 1.5;
/** A dart's leftover flight time beyond which its event is ignored. */
const DART_STALE_SEC = 3;
/** Most events waiting to be replayed (a tab that was in the background piles them up). */
const MAX_QUEUED = 600;
const HINT_MS = 4500;
const WHITE = 0xffffff;
const CONTROL_GAP = 1 / CONTROLS_HZ;

/** The only Sfx methods the host may ask for (everything that is a sound, nothing that changes settings). */
const SFX_OK: ReadonlySet<string> = new Set([
  'fire', 'hit', 'shieldBlock', 'splash', 'bump', 'pickup', 'boost', 'checkpoint', 'lap', 'countdown', 'go', 'victory',
  'pop', 'honk', 'rescue', 'trophy', 'sharkBump', 'sharkDive', 'waveStart', 'megaRoar', 'defeat', 'uiMove', 'uiSelect',
]);

// ───────────────────────────── hint wording (same as the host's coaching) ─────────────────────────────

type Scheme = 'keysA' | 'keysB' | 'gamepad' | 'touch';

const STEER_TEXT: Record<Scheme, string> = {
  keysA: 'Steer with A and D',
  keysB: 'Steer with the arrow keys',
  gamepad: 'Left stick to steer',
  touch: 'Drag the stick to steer',
};
const SHOOT_TEXT: Record<Scheme, string> = {
  keysA: 'Space to shoot!',
  keysB: 'Enter to shoot!',
  gamepad: 'A to shoot!',
  touch: 'Tap FIRE to shoot!',
};
const SHOOT_NOW_TEXT: Record<Scheme, string> = {
  keysA: 'Press SPACE to shoot!',
  keysB: 'Press ENTER to shoot!',
  gamepad: 'Press A to shoot!',
  touch: 'Tap FIRE to shoot!',
};
const GO_TEXT: Record<Scheme, string> = {
  keysA: 'Hold W to go!',
  keysB: 'Hold the UP arrow to go!',
  gamepad: 'Hold the right trigger to go!',
  touch: 'Push the stick up to go!',
};
const STUCK_TEXT: Record<Scheme, string> = {
  keysA: 'Stuck? Press R!',
  keysB: 'Stuck? Press the / key!',
  gamepad: 'Stuck? Press Y!',
  touch: 'Stuck? Tap RESCUE!',
};

/** "Steer with A and D, Space to shoot!" is one line; on touch the two halves read better as two sentences. */
function joinHint(scheme: Scheme, steer: string, rest: string): string {
  return scheme === 'touch' ? `${steer}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : `${steer}, ${rest}`;
}

function hintText(kind: 'start' | 'shoot' | 'go' | 'stuck', scheme: Scheme, mode: ModeId): string {
  switch (kind) {
    case 'shoot': return SHOOT_NOW_TEXT[scheme];
    case 'go': return GO_TEXT[scheme];
    case 'stuck': return STUCK_TEXT[scheme];
    default: {
      const steer = STEER_TEXT[scheme];
      if (mode === 'race') return joinHint(scheme, steer, 'drive through the gates!');
      if (mode === 'practice') return joinHint(scheme, steer, 'drive into balloons to pop them!');
      return joinHint(scheme, steer, SHOOT_TEXT[scheme]);
    }
  }
}

// ───────────────────────────── small helpers ─────────────────────────────

function nowSec(): number {
  return performance.now() * 0.001;
}

function copyBoat(out: BoatNetState, s: BoatNetState): void {
  out.x = s.x;
  out.z = s.z;
  out.heading = s.heading;
  out.vx = s.vx;
  out.vz = s.vz;
  out.steer = s.steer;
  out.boosting = s.boosting;
  out.shielded = s.shielded;
  out.stunned = s.stunned;
  out.powerUp = s.powerUp;
  out.powerUpLeft = s.powerUpLeft;
  out.ammo = s.ammo;
  out.reloading = s.reloading;
  out.reloadProgress = s.reloadProgress;
  out.boost = s.boost;
  out.aimTargetId = s.aimTargetId;
  out.epoch = s.epoch;
}

function blankBoatState(): BoatNetState {
  return {
    x: 0, z: 0, heading: 0, vx: 0, vz: 0, steer: 0, boosting: false, shielded: false, stunned: false, powerUp: null,
    powerUpLeft: 0, ammo: 0, reloading: false, reloadProgress: 1, boost: 1, aimTargetId: null, epoch: 0,
  };
}

/** Another boat between two snapshots: smooth numbers blend, on/off things switch halfway. */
function lerpBoat(out: BoatNetState, a: BoatNetState, b: BoatNetState, alpha: number): void {
  const pick = alpha < 0.5 ? a : b;
  // A respawn or rescue happened between the two: jump, never slide across the lagoon.
  if (a.epoch !== b.epoch) {
    copyBoat(out, pick);
    return;
  }
  out.x = a.x + (b.x - a.x) * alpha;
  out.z = a.z + (b.z - a.z) * alpha;
  out.heading = a.heading + wrapPi(b.heading - a.heading) * alpha;
  out.vx = a.vx + (b.vx - a.vx) * alpha;
  out.vz = a.vz + (b.vz - a.vz) * alpha;
  out.steer = a.steer + (b.steer - a.steer) * alpha;
  out.boosting = pick.boosting;
  out.shielded = pick.shielded;
  out.stunned = pick.stunned;
  out.powerUp = pick.powerUp;
  out.powerUpLeft = a.powerUp === b.powerUp ? a.powerUpLeft + (b.powerUpLeft - a.powerUpLeft) * alpha : pick.powerUpLeft;
  out.ammo = pick.ammo;
  out.reloading = pick.reloading;
  out.reloadProgress = a.reloading && b.reloading ? a.reloadProgress + (b.reloadProgress - a.reloadProgress) * alpha : pick.reloadProgress;
  out.boost = a.boost + (b.boost - a.boost) * alpha;
  out.aimTargetId = pick.aimTargetId;
  out.epoch = b.epoch;
}

/** Events waiting for their moment, in the order they arrived. */
class Lane {
  readonly times: number[] = [];
  readonly events: NetEvent[] = [];
  head = 0;

  push(t: number, ev: NetEvent): void {
    this.times.push(t);
    this.events.push(ev);
    if (this.events.length - this.head > MAX_QUEUED) {
      // Far too many (a long stall): drop the oldest half.
      const drop = this.head + (MAX_QUEUED >> 1);
      this.times.splice(0, drop);
      this.events.splice(0, drop);
      this.head = 0;
    }
  }
}

class GuestViewImpl implements NetGuestView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly slot: number;
  private readonly mode: ModeId;
  private readonly inits: readonly BoatInit[];
  private readonly hud: Hud;
  private readonly sfx: Sfx;
  private readonly input: InputManager;
  private readonly sendOut: (msg: GuestControls) => void;

  private readonly world: World;
  private readonly pickups: Pickups;
  private readonly darts: DartSystem;
  private readonly fx: Effects;
  private readonly sharks: Sharks;
  private readonly balloons: Balloons | null;
  private readonly boats: Boat[] = [];
  private readonly own: Boat;
  private readonly chase: ChaseCamera;
  private disposed = false;

  // ── controls ──
  private readonly controller: Controller;
  private readonly ctx: ControllerContext;
  private ctlAcc = 0;
  private ctlSeq = 0;
  private heldFire = false;
  private heldRescue = false;
  private heldHonk = false;
  private pressFire = 0;
  private pressRescue = 0;
  private pressHonk = 0;

  // ── the host's clock ──
  private appState: NetAppState = 'countdown';
  private readonly snaps: NetSnapshot[] = [];
  private readonly arrivals = new Float64Array(CLOCK_WINDOW);
  private arrivalCount = 0;
  private arrivalNext = 0;
  private synced = false;
  private resyncNext = false;
  /** hostNow = local clock + off; `target` is where `off` is heading. */
  private off = 0;
  private target = 0;
  private extra = 0;
  /** Host match time right now (as far as we can tell), and the moment other boats are drawn at. */
  private hostNow = 0;
  private renderT = 0;
  /** The time handed to the water, the fx and the boats' wave sampling. */
  private t = 0;

  // ── events ──
  private readonly ownLane = new Lane();
  private readonly worldLane = new Lane();
  private readonly ownDarts = new Set<number>();
  private readonly spawn: DartSpawn = { origin: new THREE.Vector3(), direction: new THREE.Vector3(), speed: 0, ownerId: 0 };
  private readonly tmp = new THREE.Vector3();
  private snapCamera = true;

  // ── puppets ──
  private readonly states: BoatNetState[] = [];
  /** The own boat: newest snapshot + what it was last frame, so a new snapshot never makes it jump. */
  private ownFrom: NetSnapshot | null = null;
  private ownRate = 0;
  private errX = 0;
  private errZ = 0;
  private errH = 0;
  private ownVx = 0;
  private ownVz = 0;

  // ── HUD scratch (reused every frame) ──
  private readonly hp: PlayerHud;
  private readonly hudPlayers: PlayerHud[];
  private readonly hudViewports: Viewport[] = [];
  private readonly rows: ScoreRow[] = [];
  private readonly mapBoats: MapBoat[] = [];
  private readonly mapBalloons: { x: number; z: number; gold: boolean }[] = [];
  private readonly mapState: MapState;
  private readonly hudOut: HudState;
  private readonly defaultOrder: number[] = [];

  constructor(init: GuestViewInit) {
    const { setup, inits, slot, services } = init;
    if (!inits[slot]) throw new Error('The host sent a game we could not read');
    this.slot = slot;
    this.mode = setup.mode;
    this.inits = inits;
    this.hud = services.hud;
    this.sfx = services.sfx;
    this.input = services.input;
    this.sendOut = init.sendControls;

    const scene = this.scene;
    const modeId = setup.mode;
    // Every module is built behind buildOrFallback, like in a Match: one broken builder must not blank the screen.
    this.world = buildOrFallback('createWorld', () => createWorld(scene, modeId), () => fallbackWorld(scene, modeId));
    this.pickups = buildOrFallback('createPickups', () => createPickups(scene, this.world, modeId), fallbackPickups);
    this.fx = guard('fx', buildOrFallback('createEffects', () => createEffects(scene), quietFx), {}, V2_METHODS.fx);
    this.darts = buildOrFallback('createDartSystem', () => createDartSystem(scene, this.fx), fallbackDarts);
    this.balloons = modeId === 'practice'
      ? buildOrFallback('createBalloons', () => createBalloons(scene, this.world), () => fallbackBalloons(scene, this.world))
      : null;
    this.sharks = buildOrFallback(
      'createSharks',
      () => createSharks(scene, this.world, modeId, this.fx, setup.botDifficulty),
      fallbackSharks,
    );

    // Puppet boats, built exactly like the host built them.
    for (let i = 0; i < inits.length; i++) {
      const bi = inits[i];
      const boat = buildOrFallback('createBoat', () => createBoat(bi), () => fallbackBoat(bi));
      scene.add(boat.object);
      this.boats.push(boat);
      this.states.push(blankBoatState());
      this.defaultOrder.push(bi.id);
    }
    this.own = this.boats[slot];

    this.chase = new ChaseCamera(this.own.easyDriving);
    this.chase.snap(this.own, this.world, 0);
    this.camera = this.chase.camera;
    if (typeof window !== 'undefined' && window.innerHeight > 0) this.chase.setAspect(window.innerWidth / window.innerHeight);

    // This device's controls drive the own puppet: Easy Driving's assist reads its position and the real world.
    this.controller = buildOrFallback('humanController', () => this.input.humanController(0, 1), () => idleController('human'));
    this.ctx = {
      self: this.own,
      boats: this.boats,
      world: this.world,
      mode: modeId,
      t: 0,
      nextCheckpoint: null,
      followingCheckpoint: null,
      pickups: this.pickups.positions,
      sharks: this.sharks.targets,
    };

    const oi = inits[slot];
    this.hp = {
      name: oi.name, color: oi.color, score: 0, ammo: 0, maxAmmo: 0, reloading: false, reloadProgress: 1, boost: 1,
      powerUp: null, shielded: false, rank: 1, race: null, arrow: null, lockedTarget: null, boatId: slot, team: oi.team,
      viewHeading: 0, nextGate: null, easyDriving: oi.easyDriving,
    };
    this.hudPlayers = [this.hp];
    this.mapState = {
      arenaRadius: this.world.arenaRadius,
      obstacles: this.world.obstacles,
      boats: this.mapBoats,
      pickups: this.pickups.positions,
      balloons: this.mapBalloons,
      sharks: this.sharks.mapDots,
      gates: modeId === 'race' ? this.world.checkpoints : [],
    };
    for (let i = 0; i < inits.length; i++) {
      const bi = inits[i];
      this.mapBoats.push({ id: bi.id, x: bi.spawn.x, z: bi.spawn.z, heading: bi.spawn.heading, color: bi.color, isHuman: bi.isHuman, team: bi.team });
    }
    this.hudOut = {
      mode: modeId,
      timeLeft: null,
      raceTime: null,
      players: this.hudPlayers,
      viewports: this.hudViewports,
      scoreboard: this.rows,
      teams: null,
      balloons: null,
      sharks: null,
      map: this.mapState,
    };
  }

  // ───────────────────────────── feeds from guest.ts ─────────────────────────────

  pushSnapshot(s: NetSnapshot): void {
    if (this.disposed || !s || !Array.isArray(s.boats) || !Number.isFinite(s.t)) return;
    const snaps = this.snaps;
    const last = snaps.length > 0 ? snaps[snaps.length - 1] : null;
    if (last && s.t <= last.t) {
      // The fast channel can reorder and duplicate: a slightly older snapshot is just dropped.
      if (last.t - s.t < RESTART_GAP) return;
      this.restart(); // the host's clock went back a long way: a new match began
    }
    const sample = s.t - nowSec();
    if (!this.synced || this.resyncNext) {
      this.arrivalCount = 0;
      this.arrivalNext = 0;
      this.off = sample;
      this.synced = true;
      this.resyncNext = false;
    }
    // The freshest packet (the one with the least delay) says how far the host clock is ahead of ours.
    this.arrivals[this.arrivalNext] = sample;
    this.arrivalNext = (this.arrivalNext + 1) % CLOCK_WINDOW;
    if (this.arrivalCount < CLOCK_WINDOW) this.arrivalCount++;
    let best = sample;
    for (let i = 0; i < this.arrivalCount; i++) if (this.arrivals[i] > best) best = this.arrivals[i];
    this.target = best;

    snaps.push(s);
    if (snaps.length > SNAP_KEEP) snaps.shift();
  }

  pushEvents(t: number, events: readonly NetEvent[]): void {
    if (this.disposed || !Array.isArray(events) || !Number.isFinite(t)) return;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const lane = this.laneFor(ev);
      if (lane) lane.push(t, ev);
    }
  }

  noteState(state: NetAppState): void {
    // The host's clock stood still while it was paused: when it resumes, find it again.
    if (this.appState === 'paused' && state !== 'paused') {
      this.resyncNext = true;
      this.extra = 0;
    }
    this.appState = state;
  }

  /** Forget every snapshot and the clock estimate (a new match, or a long gap). */
  private restart(): void {
    this.snaps.length = 0;
    this.synced = false;
    this.resyncNext = false;
    this.arrivalCount = 0;
    this.arrivalNext = 0;
    this.extra = 0;
    this.ownFrom = null;
    this.ownRate = 0;
    this.errX = this.errZ = this.errH = 0;
  }

  /**
   * Which queue an event waits in (or null: not for this device). Things that happen to or because of this
   * player run on the host clock (the own boat is drawn there); everything else waits for the slightly older
   * moment the other boats are drawn at, so a dart leaves a boat where that boat is actually drawn.
   */
  private laneFor(ev: NetEvent): Lane | null {
    switch (ev.k) {
      case 'cam':
      case 'rumble':
      case 'hint':
        return ev.to === this.slot ? this.ownLane : null;
      case 'announce':
        if (ev.to === undefined) return this.worldLane;
        return ev.to === this.slot ? this.ownLane : null;
      case 'hit':
        return ev.boat === this.slot ? this.ownLane : this.worldLane;
      case 'fire':
        if (ev.boat !== this.slot) return this.worldLane;
        if (this.ownDarts.size > 128) this.ownDarts.clear();
        for (let i = 0; i < ev.darts.length; i++) this.ownDarts.add(ev.darts[i][0]);
        return this.ownLane;
      case 'stick':
      case 'deflect':
      case 'kill':
        // The end of one of this player's own darts follows the dart (which flew on the host clock).
        if (this.ownDarts.delete(ev.id)) return this.ownLane;
        return this.worldLane;
      default:
        return this.worldLane;
    }
  }

  // ───────────────────────────── the frame ─────────────────────────────

  update(dt: number): void {
    if (this.disposed) return;
    if (!(dt > 0)) dt = 0;
    else if (dt > 0.25) dt = 0.25;

    this.advanceClock(dt);
    const snaps = this.snaps;
    const newest = snaps.length > 0 ? snaps[snaps.length - 1] : null;

    // 1. This device's controls.
    try {
      this.readControls(dt, newest);
    } catch (e) {
      reportError('guest.controls', e);
    }

    // 2. The host's one-shot events.
    if (this.synced) {
      this.drain(this.ownLane, this.hostNow);
      this.drain(this.worldLane, this.renderT);
    }

    // 3. Put everything where the snapshots say.
    if (newest) {
      try {
        this.applySnapshots(dt, newest);
      } catch (e) {
        reportError('guest.apply', e);
      }
    }

    // 4. Darts fly (islands and water only: the host decides every hit), then the pretty stuff.
    const t = this.t;
    try {
      this.darts.update(dt, t, NO_BOATS, this.world, 0, NO_TARGETS);
    } catch (e) {
      reportError('guest.darts', e);
    }
    try {
      for (let i = 0; i < this.boats.length; i++) this.fx.wake(this.boats[i]);
      this.fx.update(dt, t, this.world);
    } catch (e) {
      reportError('guest.fx', e);
    }
    try {
      this.world.update(t, dt);
    } catch (e) {
      reportError('guest.world', e);
    }
    try {
      if (this.snapCamera && newest) {
        this.snapCamera = false;
        this.chase.snap(this.own, this.world, t);
      } else {
        this.chase.update(dt, this.own, this.world, t);
      }
    } catch (e) {
      reportError('guest.camera', e);
    }
  }

  /** Advance the estimate of the host's match clock and work out where "now" and "a little ago" are on it. */
  private advanceClock(dt: number): void {
    if (!this.synced) {
      this.t += dt;
      return;
    }
    const gap = this.target - this.off;
    if (gap > CLOCK_JUMP || gap < -CLOCK_JUMP) this.off = this.target;
    else this.off += gap * (1 - Math.exp(-CLOCK_SLEW * dt));
    this.hostNow = nowSec() + this.off;
    this.t = this.hostNow;

    // Draw other boats this far behind the newest snapshot; when snapshots run late, sit a little further back.
    const snaps = this.snaps;
    this.renderT = this.hostNow - INTERP_DELAY - this.extra;
    if (snaps.length > 0) {
      const short = this.renderT - snaps[snaps.length - 1].t;
      if (short > RESYNC_AFTER) {
        this.resyncNext = true;
        this.extra = 0;
      } else if (short > 0) {
        this.extra = Math.min(MAX_EXTRA_DELAY, this.extra + short * 0.5);
      } else {
        this.extra = Math.max(0, this.extra - EXTRA_DECAY * dt);
      }
    }
  }

  // ───────────────────────────── controls ─────────────────────────────

  private readControls(dt: number, newest: NetSnapshot | null): void {
    const ctx = this.ctx;
    ctx.t = this.t;
    ctx.pickups = this.pickups.positions;
    ctx.sharks = this.sharks.targets;
    const gate = newest ? newest.hud.nextGate?.[this.slot] ?? null : null;
    const cps = this.world.checkpoints;
    ctx.nextCheckpoint = gate !== null && cps.length > 0 ? cps[gate] ?? null : null;
    ctx.followingCheckpoint = gate !== null && cps.length > 0 ? cps[(gate + 1) % cps.length] ?? null : null;

    const c: BoatControls = this.controller.update(ctx, dt);
    // Count the presses (rising edges) every rendered frame, so a quick tap between two sends is never lost.
    const fire = c.fire === true;
    const rescue = c.rescue === true;
    const honk = c.honk === true;
    if (fire && !this.heldFire) this.pressFire++;
    if (rescue && !this.heldRescue) this.pressRescue++;
    if (honk && !this.heldHonk) this.pressHonk++;
    this.heldFire = fire;
    this.heldRescue = rescue;
    this.heldHonk = honk;

    // The host stands still while paused, and there is nobody to drive for in the lobby.
    if (this.appState === 'paused' || this.appState === 'lobby') return;
    this.ctlAcc += dt;
    if (this.ctlAcc < CONTROL_GAP) return;
    this.ctlAcc = Math.min(this.ctlAcc - CONTROL_GAP, CONTROL_GAP);
    const throttle = Number.isFinite(c.throttle) ? clamp(c.throttle, -1, 1) : 0;
    const steer = Number.isFinite(c.steer) ? clamp(c.steer, -1, 1) : 0;
    // A fresh message every time (30 a second): the transport may hold on to it.
    this.sendOut({
      k: 'ctl',
      seq: ++this.ctlSeq,
      c: { throttle, steer, fire, boost: c.boost === true, rescue, honk },
      presses: { fire: this.pressFire, rescue: this.pressRescue, honk: this.pressHonk },
    });
  }

  // ───────────────────────────── placing things from snapshots ─────────────────────────────

  private applySnapshots(dt: number, newest: NetSnapshot): void {
    const snaps = this.snaps;
    const n = snaps.length;
    const rt = this.renderT;
    const t = this.t;

    // Find the two snapshots around the render time.
    let a = newest;
    let b = newest;
    let alpha = 0;
    const starved = rt >= newest.t;
    if (!starved) {
      if (rt <= snaps[0].t) {
        a = b = snaps[0];
      } else {
        let i = n - 2;
        while (i > 0 && snaps[i].t > rt) i--;
        a = snaps[i];
        b = snaps[i + 1];
        const span = b.t - a.t;
        alpha = span > 1e-4 ? clamp((rt - a.t) / span, 0, 1) : 1;
      }
    }
    const pick = alpha < 0.5 ? a : b;

    // Sharks first, so the boats' blasters can look at where they are.
    try {
      this.sharks.applyNetState(a.sharks, b.sharks, alpha, t, dt);
    } catch (e) {
      reportError('guest.sharks', e);
    }
    const aim = this.sharks.targets;

    const boats = this.boats;
    const states = this.states;
    const extrap = starved ? clamp(rt - newest.t, 0, MAX_EXTRAPOLATE) : 0;
    for (let i = 0; i < boats.length; i++) {
      const out = states[i];
      if (i === this.slot) {
        const s = newest.boats[i];
        if (!s || !this.ownState(out, s, newest, dt)) continue;
      } else {
        const sa = a.boats[i];
        const sb = b.boats[i];
        if (!sa || !sb || !Number.isFinite(sa.x + sa.z + sb.x + sb.z)) continue;
        if (starved) {
          // Nothing newer to blend toward: coast on the last velocity for a moment, then hold.
          copyBoat(out, sb);
          out.x += sb.vx * extrap;
          out.z += sb.vz * extrap;
        } else {
          lerpBoat(out, sa, sb, alpha);
        }
      }
      try {
        boats[i].applyNetState(out, dt, t, this.world, aim);
      } catch (e) {
        reportError(`guest.boat[${i}]`, e);
      }
    }
    try {
      this.pickups.applyNetState(pick.crates, t, dt);
    } catch (e) {
      reportError('guest.pickups', e);
    }
    try {
      if (this.balloons && pick.balloons) this.balloons.applyNetState(pick.balloons, t, dt);
    } catch (e) {
      reportError('guest.balloons', e);
    }
  }

  /**
   * This player's own boat: the newest snapshot carried forward by its velocity (never more than
   * MAX_EXTRAPOLATE). When a fresh snapshot lands, the gap between where we were drawing the boat and where
   * the new snapshot says it is fades away over a few frames instead of showing as a hop.
   * Returns false if the snapshot is unusable.
   */
  private ownState(out: BoatNetState, s: BoatNetState, newest: NetSnapshot, dt: number): boolean {
    if (!Number.isFinite(s.x + s.z + s.heading + s.vx + s.vz)) return false;
    copyBoat(out, s);
    const hostNow = this.hostNow;
    const el = clamp(hostNow - newest.t, 0, MAX_EXTRAPOLATE);
    const from = this.ownFrom;
    if (from !== newest) {
      const o = from ? from.boats[this.slot] : undefined;
      if (!o || o.epoch !== s.epoch) {
        // First snapshot, or a respawn / rescue: no sliding, and the camera hops along.
        this.errX = this.errZ = this.errH = 0;
        this.ownRate = 0;
        this.ownVx = s.vx;
        this.ownVz = s.vz;
        this.snapCamera = true;
      } else if (from) {
        const oel = clamp(hostNow - from.t, 0, MAX_EXTRAPOLATE);
        const span = newest.t - from.t;
        const rate = span > 0.01 ? clamp(wrapPi(s.heading - o.heading) / span, -MAX_TURN_RATE, MAX_TURN_RATE) : 0;
        this.errX += o.x + o.vx * oel - (s.x + s.vx * el);
        this.errZ += o.z + o.vz * oel - (s.z + s.vz * el);
        this.errH += wrapPi(o.heading + this.ownRate * oel - (s.heading + rate * el));
        this.ownRate = rate;
        if (Math.hypot(this.errX, this.errZ) > OWN_SNAP_DIST) this.errX = this.errZ = this.errH = 0;
      }
      this.ownFrom = newest;
    }
    const k = Math.exp(-OWN_SETTLE * dt);
    this.errX *= k;
    this.errZ *= k;
    this.errH *= k;
    this.ownVx = damp(this.ownVx, s.vx, 14, dt);
    this.ownVz = damp(this.ownVz, s.vz, 14, dt);
    out.x = s.x + s.vx * el + this.errX;
    out.z = s.z + s.vz * el + this.errZ;
    out.heading = s.heading + this.ownRate * el + this.errH;
    out.vx = this.ownVx;
    out.vz = this.ownVz;
    return true;
  }

  // ───────────────────────────── events ─────────────────────────────

  private drain(lane: Lane, limit: number): void {
    const times = lane.times;
    const events = lane.events;
    while (lane.head < events.length && times[lane.head] <= limit) {
      const i = lane.head++;
      try {
        this.play(events[i], Math.max(0, limit - times[i]));
      } catch (e) {
        reportError('guest.event', e);
      }
    }
    if (lane.head >= events.length) {
      lane.head = 0;
      times.length = 0;
      events.length = 0;
    }
  }

  /** Replay one event. `age` = how long ago (seconds) it happened on the clock it was waiting for. */
  private play(ev: NetEvent, age: number): void {
    const stale = age > STALE_SEC;
    switch (ev.k) {
      case 'sfx': {
        if (stale || !SFX_OK.has(ev.m)) return;
        if (ev.at) {
          const p = this.own.position;
          const dx = ev.at[0] - p.x;
          const dz = ev.at[1] - p.z;
          if (dx * dx + dz * dz > HEARABLE * HEARABLE) return;
        }
        const fn = (this.sfx as unknown as Record<string, unknown>)[ev.m];
        if (typeof fn === 'function') fn.apply(this.sfx, ev.a);
        return;
      }
      case 'fx': {
        if (stale) return;
        const v = this.tmp.set(ev.p[0], ev.p[1], ev.p[2]);
        const a = ev.a;
        const fx = this.fx;
        switch (ev.m) {
          case 'splash': fx.splash(v, a ?? 1); break;
          case 'hitBurst': fx.hitBurst(v, a ?? WHITE); break;
          case 'sparkle': fx.sparkle(v, a ?? WHITE); break;
          case 'bubbles': fx.bubbles(v); break;
          case 'pop': fx.pop(v, a ?? WHITE); break;
          case 'notes': fx.notes(v, a ?? WHITE); break;
        }
        return;
      }
      case 'announce':
        if (age > 3) return;
        this.hud.announce(ev.text, { sub: ev.sub, ms: ev.ms, viewport: ev.to === undefined ? undefined : 0 });
        return;
      case 'feed':
        if (age <= 6) this.hud.feed(ev.text, ev.color);
        return;
      case 'hint': {
        if (age > 3) return;
        const s =this.input.schemeOf(0, 1);
        const scheme: Scheme = s === 'keysB' || s === 'gamepad' || s === 'touch' ? s : 'keysA';
        this.hud.hint(hintText(ev.hint, scheme, this.mode), 0, HINT_MS);
        return;
      }
      case 'cam':
        if (stale) return;
        if (ev.op === 'shake') this.chase.shake(ev.amt);
        else if (ev.op === 'kick') this.chase.kick(ev.amt);
        else this.snapCamera = true;
        return;
      case 'rumble':
        if (!stale) this.input.rumble(0, 1, ev.strength, ev.ms);
        return;
      case 'fire': {
        if (age > CONFIG.blaster.dartLife) return; // the dart is long gone
        const boat = this.boats[ev.boat];
        if (boat && !stale) boat.netFire();
        const spawn = this.spawn;
        spawn.ownerId = ev.boat;
        for (let i = 0; i < ev.darts.length; i++) {
          const d = ev.darts[i];
          spawn.origin.set(d[1], d[2], d[3]);
          spawn.direction.set(d[4], d[5], d[6]);
          spawn.speed = d[7];
          this.darts.spawnNet(d[0], spawn, age);
        }
        return;
      }
      case 'stick': {
        if (age > DART_STALE_SEC) return;
        const boat = this.boats[ev.boat];
        if (boat) this.darts.netStick(ev.id, boat, ev.tip, ev.quat);
        return;
      }
      case 'deflect':
        if (age <= DART_STALE_SEC) this.darts.netDeflect(ev.id, ev.p);
        return;
      case 'kill':
        if (age <= DART_STALE_SEC) this.darts.netKill(ev.id);
        return;
      case 'hit': {
        if (stale) return;
        const boat = this.boats[ev.boat];
        if (boat) boat.netHit(ev.blocked, ev.stun);
        return;
      }
    }
  }

  // ───────────────────────────── the rest of the GuestView contract ─────────────────────────────

  setViewport(vp: Viewport): void {
    this.chase.setAspect(vp.height > 0 ? vp.width / vp.height : 1);
  }

  /** The reticle label for a locked target: a boat's name, or "Shark" / "MEGA SHARK". */
  private targetName(id: number | null): string | null {
    if (id === null) return null;
    if (id < SHARK_ID_BASE) return this.boats[id]?.name ?? null;
    const list = this.sharks.targets;
    for (let k = 0; k < list.length; k++) {
      if (list[k].id === id) return list[k].name;
    }
    return null;
  }

  hudState(vp: Viewport): HudState {
    const snaps = this.snaps;
    const nh = snaps.length > 0 ? snaps[snaps.length - 1].hud : null;
    const slot = this.slot;
    const own = this.own;
    const out = this.hudOut;
    this.hudViewports[0] = vp;

    // This player.
    const hp = this.hp;
    hp.score = nh?.scores?.[slot] ?? 0;
    hp.ammo = own.ammo;
    hp.maxAmmo = own.maxAmmo;
    hp.reloading = own.reloading;
    hp.reloadProgress = own.reloadProgress;
    hp.boost = own.boost;
    hp.powerUp = own.powerUp;
    hp.shielded = own.shielded;
    const place = nh ? nh.ranking.indexOf(slot) : -1;
    hp.rank = place >= 0 ? place + 1 : 1;
    hp.race = nh?.race?.[slot] ?? null;
    const gate = nh?.nextGate?.[slot] ?? null;
    hp.nextGate = gate;
    // The arrow points from the camera's forward direction toward the next gate. Right = clockwise = positive.
    const gp = gate !== null ? this.world.checkpoints[gate]?.position : undefined;
    hp.arrow = gp ? wrapPi(this.chase.viewHeading - Math.atan2(gp.x - own.position.x, gp.z - own.position.z)) : null;
    hp.lockedTarget = this.targetName(own.aimTargetId);
    hp.team = own.team;
    hp.viewHeading = this.chase.viewHeading;
    hp.easyDriving = own.easyDriving;

    // Scoreboard: boat ids best first, from the host's ranking (before the first snapshot: boat order).
    const order = nh && nh.ranking.length > 0 ? nh.ranking : this.defaultOrder;
    const rows = this.rows;
    let n = 0;
    for (let k = 0; k < order.length; k++) {
      const id = order[k];
      const bi = this.inits[id];
      if (!bi) continue;
      let row = rows[n];
      if (!row) {
        row = { id: 0, name: '', color: 0, score: 0, isHuman: false, team: 0 };
        rows[n] = row;
      }
      row.id = id;
      row.name = bi.name;
      row.color = bi.color;
      row.score = nh?.scores?.[id] ?? 0;
      row.isHuman = bi.isHuman;
      row.team = bi.team;
      n++;
    }
    rows.length = n;

    out.timeLeft = nh ? nh.timeLeft : null;
    out.raceTime = nh ? nh.raceTime : null;
    out.teams = nh ? nh.teams : null;
    out.balloons = nh ? nh.balloons : null;
    out.sharks = nh ? nh.sharks : null;

    // Mini-map: every boat, the live balloons, and the same obstacle/crate/shark lists the match would use.
    const mb = this.mapBoats;
    for (let i = 0; i < mb.length; i++) {
      const b = this.boats[i];
      const m = mb[i];
      m.x = b.position.x;
      m.z = b.position.z;
      m.heading = b.heading;
    }
    const mapBalloons = this.mapBalloons;
    let nb = 0;
    const bl = this.balloons;
    if (bl) {
      // Same rule as the balloons themselves: every goldEvery-th one (counting from 1) is gold.
      const goldEvery = Math.floor(CONFIG.practice.goldEvery);
      const targets = bl.targets;
      for (let k = 0; k < targets.length; k++) {
        const target = targets[k];
        if (!target.alive) continue;
        let dot = mapBalloons[nb];
        if (!dot) {
          dot = { x: 0, z: 0, gold: false };
          mapBalloons[nb] = dot;
        }
        dot.x = target.position.x;
        dot.z = target.position.z;
        dot.gold = goldEvery > 0 && (k + 1) % goldEvery === 0;
        nb++;
      }
    }
    mapBalloons.length = nb;
    const ms = this.mapState;
    ms.pickups = this.pickups.positions;
    ms.sharks = this.sharks.mapDots;
    return out;
  }

  engineLevel(): number {
    if (this.appState === 'countdown') return 0.18 + 0.08 * Math.sin(this.t * 9);
    if (this.appState !== 'playing') return 0;
    const own = this.own;
    return clamp(Math.abs(own.speed) / topSpeedOf(own.easyDriving), 0, 1);
  }

  boatObject(id: number): THREE.Object3D | null {
    return this.boats[id]?.object ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const safely = (label: string, fn: () => void): void => {
      try {
        fn();
      } catch (e) {
        reportError(`${label}.dispose`, e);
      }
    };
    // Darts first: stuck darts are children of the boats.
    safely('darts', () => { this.darts.clear(); this.darts.dispose(); });
    safely('pickups', () => this.pickups.dispose());
    safely('balloons', () => this.balloons?.dispose());
    safely('sharks', () => this.sharks.dispose());
    for (const boat of this.boats) safely('boat', () => boat.dispose());
    safely('fx', () => this.fx.dispose());
    safely('world', () => this.world.dispose());
    safely('scene', () => disposeSceneResources(this.scene));
    this.boats.length = 0;
    this.snaps.length = 0;
    this.ownLane.events.length = 0;
    this.ownLane.times.length = 0;
    this.worldLane.events.length = 0;
    this.worldLane.times.length = 0;
  }
}

/** Build the guest's view of the match the host just started. */
export function createGuestView(init: GuestViewInit): NetGuestView {
  return new GuestViewImpl(init);
}

/**
 * Safety net after the modules have cleaned up after themselves: free any GPU
 * resources still hanging off the scene so rematches never leak.
 */
function disposeSceneResources(scene: THREE.Scene): void {
  const doneMaterials = new Set<THREE.Material>();
  const disposeTexture = (v: unknown): void => {
    if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
  };
  const disposeMaterial = (m: THREE.Material): void => {
    if (doneMaterials.has(m)) return;
    doneMaterials.add(m);
    for (const key of Object.keys(m)) disposeTexture((m as unknown as Record<string, unknown>)[key]);
    const uniforms = (m as THREE.ShaderMaterial).uniforms;
    if (uniforms) for (const key of Object.keys(uniforms)) disposeTexture(uniforms[key]?.value);
    m.dispose();
  };

  scene.traverse((obj) => {
    const drawable = obj as THREE.Mesh;
    drawable.geometry?.dispose();
    const mat = drawable.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat);
    if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
    if ((obj as THREE.Light).isLight) (obj as unknown as { dispose?: () => void }).dispose?.();
  });
  disposeTexture(scene.background);
  disposeTexture(scene.environment);
  scene.clear();
}
