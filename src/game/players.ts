/**
 * Everything a human player gets that a computer boat does not:
 *  - Rescue (the button, and automatically for Easy Driving when stuck),
 *  - Honk,
 *  - friendly coaching hints,
 *  - the numbers that feed the Trophy Shelf (PlayerMatchStats).
 *
 * One HumanPlayer per human (online, that includes the humans at other devices). The Match calls `update` every
 * step with that player's controls. A player at another device (driven by a RemoteController) gets the same
 * rescue, honk and stats; only the coaching hints differ, because their own device words them for its own controls.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { CONTROLS_TIMEOUT } from '../net/protocol';
import type { GuestControls } from '../net/protocol';
import type {
  Boat, BoatControls, Controller, Effects, Hud, HornId, InputManager, MatchSetup, Sfx, SpawnPoint, World,
} from '../types';
import type { ChaseCamera } from './cameras';
import { ZERO_CONTROLS, fallbackSafeSpot } from './fallbacks';

/** What a HumanPlayer needs from its match. */
export interface PlayerHost {
  readonly setup: MatchSetup;
  readonly world: World;
  readonly fx: Effects;
  /** `viewport` arguments are human slots: the match turns them into this device's viewports (or events). */
  readonly hud: Hud;
  readonly sfx: Sfx;
  readonly input: InputManager;
  readonly cams: readonly ChaseCamera[];
  /** Boat ids played on THIS device, in viewport order. */
  readonly localSlots: readonly number[];
  /** The viewport of human `slot` on this device, or -1 when that player sits at another device. */
  viewportOf(slot: number): number;
  /** The sound system, aimed at a spot in the lagoon (online it tells the guests where the sound comes from). */
  sfxAt(x: number, z: number): Sfx;
  /** Coaching hint for a player at another device: they word it for their own controls. */
  netHint(slot: number, kind: HintKind): void;
}

type Scheme = 'keysA' | 'keysB' | 'gamepad' | 'touch';
export type HintKind = 'start' | 'shoot' | 'go' | 'stuck';

/** Slower than this while the player wants to go = stuck. */
const STUCK_SPEED = 1.5;
/** Touching an island only counts as stuck below this speed (gliding along a shore is fine). */
const TOUCH_SPEED = 3.5;
/** Extra reach when checking whether a boat is touching an island (meters beyond the two radii). */
const TOUCH_MARGIN = 0.6;
/** How long a normal-driving player is stuck before the "Press R" hint. */
const STUCK_HINT_SEC = 2;
/** Seconds without firing before "Press SPACE to shoot!". */
const IDLE_SHOT_SEC = 12;
/** Seconds sitting still (normal driving) before "Hold W to go!". */
const PARKED_SEC = 3;
/** At most one hint per player in this many seconds, and each hint at most twice per match. */
const HINT_GAP_SEC = 8;
const HINT_MAX = 2;
const HINT_MS = 4500;
/** Minimum time between two honks from one boat. */
const HONK_GAP_SEC = 0.3;
const GOLD = 0xffd23f;

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

export class HumanPlayer {
  // What this player did (Trophy Shelf).
  hits = 0;
  tagsOnOtherHuman = 0;
  timesTagged = 0;
  /** Balloon points (a gold balloon is worth 3). */
  balloons = 0;
  boostSeconds = 0;
  pickups = 0;
  honks = 0;
  rescues = 0;
  /** Sharks scared off with darts (any mode; the MEGA SHARK's hits don't count, only normal sharks). */
  sharkTags = 0;
  /** Times a shark bumped this player's boat (a shield-blocked bump doesn't count). */
  sharkBumps = 0;

  private rescueHeld = false;
  private honkHeld = false;
  private rescueCooldown = 0;
  private honkCooldown = 0;
  private stuck = 0;
  private parked = 0;
  private sinceShot = 0;
  private lastHintAt = -Infinity;
  private readonly hintCount: Record<HintKind, number> = { start: 0, shoot: 0, go: 0, stuck: 0 };
  private readonly scratch = new THREE.Vector3();

  constructor(
    readonly slot: number,
    readonly boat: Boat,
    private readonly horn: HornId,
    private readonly host: PlayerHost,
  ) {}

  /**
   * One simulation step with this human's controls (only while they are in charge of the boat).
   * `finished` = a racer who has crossed the line: no stuck checks for them.
   */
  update(dt: number, t: number, c: BoatControls, finished: boolean): void {
    // Read the controller's output right now: it may reuse one object from frame to frame.
    const wantRescue = c.rescue === true;
    const wantHonk = c.honk === true;
    const throttle = c.throttle;
    const firing = c.fire === true;
    const boat = this.boat;

    // Buttons act on the press (not while held).
    this.rescueCooldown = Math.max(0, this.rescueCooldown - dt);
    this.honkCooldown = Math.max(0, this.honkCooldown - dt);
    const rescuePress = wantRescue && !this.rescueHeld;
    const honkPress = wantHonk && !this.honkHeld;
    this.rescueHeld = wantRescue;
    this.honkHeld = wantHonk;
    if (honkPress && this.honkCooldown <= 0) this.honk();
    if (rescuePress && this.rescueCooldown <= 0) {
      this.rescue(t, false);
      return; // everything below was about the old spot
    }

    // Stuck: wants to go but is barely moving, or pressed against an island.
    const speed = Math.abs(boat.speed);
    const isStuck = !finished && ((speed < STUCK_SPEED && throttle > 0.3) || (speed < TOUCH_SPEED && this.touchingIsland()));
    this.stuck = isStuck ? this.stuck + dt : Math.max(0, this.stuck - 2 * dt);
    if (boat.easyDriving) {
      if (this.stuck >= CONFIG.easyDriving.autoRescueSec) {
        this.rescue(t, true);
        return;
      }
    } else if (this.stuck >= STUCK_HINT_SEC && this.hint('stuck', t)) {
      this.stuck = 0;
    }

    // Coaching: say how to drive at GO, then nudge only when it looks like the player needs it.
    this.sinceShot = firing ? 0 : this.sinceShot + dt;
    const parkedNow = !boat.easyDriving && !finished && speed < 1 && throttle < 0.1;
    this.parked = parkedNow ? this.parked + dt : 0;
    if (this.hintCount.start === 0) {
      this.hint('start', t);
    } else if (this.parked >= PARKED_SEC) {
      if (this.hint('go', t)) this.parked = 0;
    } else if (this.sinceShot >= IDLE_SHOT_SEC && this.host.setup.mode !== 'race') {
      if (this.hint('shoot', t)) this.sinceShot = 0;
    }
  }

  // ───────────── rescue ─────────────

  private touchingIsland(): boolean {
    const p = this.boat.position;
    const obstacles = this.host.world.obstacles;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const reach = o.radius + this.boat.radius + TOUCH_MARGIN;
      if (dx * dx + dz * dz < reach * reach) return true;
    }
    return false;
  }

  /** Lift the boat to the nearest open water, facing a clear way, with a splash and a sparkle. */
  private rescue(t: number, automatic: boolean): void {
    const { boat, host, scratch } = this;
    const { world, fx } = host;
    const from = boat.position;
    let spot: SpawnPoint;
    try {
      spot = world.safeSpot(from.x, from.z, boat.heading);
      if (!Number.isFinite(spot.x + spot.z + spot.heading)) throw new Error('safeSpot gave a non-number');
    } catch {
      spot = fallbackSafeSpot(from.x, from.z, boat.heading, world.obstacles, world.arenaRadius);
    }
    fx.splash(scratch.copy(from), 2.2); // a big splash where the boat was...
    boat.teleport(spot);
    scratch.set(spot.x, boat.position.y, spot.z);
    fx.splash(scratch, 2.2); // ...and where it lands
    fx.sparkle(scratch, GOLD);
    host.sfxAt(spot.x, spot.z).rescue();
    host.hud.announce('RESCUED!', { sub: automatic ? 'Back on the water!' : undefined, ms: 900, viewport: this.slot });
    host.cams[this.slot]?.snap(boat, world, t); // the camera hops along instead of sliding across the lagoon

    this.rescues++;
    this.rescueCooldown = CONFIG.rescue.cooldownSec;
    this.stuck = 0;
    this.parked = 0;
  }

  // ───────────── honk ─────────────

  private honk(): void {
    const { boat, host } = this;
    this.honkCooldown = HONK_GAP_SEC;
    this.honks++;
    host.sfxAt(boat.position.x, boat.position.z).honk(this.horn);
    host.fx.notes(boat.position, boat.color); // the notes lift themselves above the waterline point
  }

  // ───────────── hints ─────────────

  /** Show a hint if the rules allow it (spacing, and at most twice per match). Returns true if it was shown. */
  private hint(kind: HintKind, t: number): boolean {
    if (t - this.lastHintAt < HINT_GAP_SEC || this.hintCount[kind] >= (kind === 'start' ? 1 : HINT_MAX)) return false;
    if (this.host.viewportOf(this.slot) < 0) {
      // Another device: it knows which controls that player uses, so it words the hint itself.
      this.lastHintAt = t;
      this.hintCount[kind]++;
      this.host.netHint(this.slot, kind);
      return true;
    }
    const scheme = this.scheme();
    let text: string;
    switch (kind) {
      case 'start': text = this.startText(scheme); break;
      case 'shoot': text = SHOOT_NOW_TEXT[scheme]; break;
      case 'go': text = GO_TEXT[scheme]; break;
      default: text = STUCK_TEXT[scheme]; break;
    }
    this.lastHintAt = t;
    this.hintCount[kind]++;
    this.host.hud.hint(text, this.slot, HINT_MS);
    return true;
  }

  private startText(scheme: Scheme): string {
    const steer = STEER_TEXT[scheme];
    switch (this.host.setup.mode) {
      case 'race': return joinHint(scheme, steer, 'drive through the gates!');
      case 'practice': return joinHint(scheme, steer, 'drive into balloons to pop them!');
      default: return joinHint(scheme, steer, SHOOT_TEXT[scheme]);
    }
  }

  private scheme(): Scheme {
    // The input manager numbers the players on THIS device (0 or 1), not the match's human slots.
    const s = this.host.input.schemeOf(this.host.viewportOf(this.slot) as 0 | 1, this.host.localSlots.length as 1 | 2);
    return s === 'keysB' || s === 'gamepad' || s === 'touch' ? s : 'keysA';
  }
}

/**
 * Drives the boat of an online player at another device from the controls it sends (GuestControls).
 *
 * Held things (throttle, steer, boost, fire) are copied as they arrive. Presses arrive as running counters, so a
 * quick tap is never lost to a dropped or late packet: each counter that went up becomes a press that is held for
 * exactly one simulation step (fire is also held while the button is). If nothing arrives for CONTROLS_TIMEOUT
 * seconds the boat lets go of everything, and `disconnect()` does that for good. (That time is the clock on the
 * wall, not match time: a fast-forwarded test match must not make a steady 30 Hz stream look like silence.)
 */
export class RemoteController implements Controller {
  readonly kind = 'human' as const;

  private readonly out: BoatControls = { throttle: 0, steer: 0, fire: false, boost: false, rescue: false, honk: false };
  private readonly held: BoatControls = { throttle: 0, steer: 0, fire: false, boost: false, rescue: false, honk: false };
  // Press counters as of the last packet (the first packet only sets the baseline), and presses not used yet.
  private seen = false;
  private lastFire = 0;
  private lastRescue = 0;
  private lastHonk = 0;
  private pressFire = false;
  private pressRescue = false;
  private pressHonk = false;
  /** When the last packet arrived (performance.now() ms). */
  private lastAt = -Infinity;
  private gone = false;

  /** A GuestControls packet arrived (newest wins; the caller drops out-of-order ones). */
  receive(msg: GuestControls): void {
    if (this.gone || !msg || !msg.c) return;
    const c = msg.c;
    const h = this.held;
    h.throttle = axis(c.throttle);
    h.steer = axis(c.steer);
    h.fire = c.fire === true;
    h.boost = c.boost === true;
    h.rescue = c.rescue === true;
    h.honk = c.honk === true;
    const p = msg.presses;
    if (p) {
      const fire = count(p.fire);
      const rescue = count(p.rescue);
      const honk = count(p.honk);
      if (this.seen) {
        // A counter that went DOWN means the other side started counting again: just take the new baseline.
        if (fire > this.lastFire) this.pressFire = true;
        if (rescue > this.lastRescue) this.pressRescue = true;
        if (honk > this.lastHonk) this.pressHonk = true;
      }
      this.lastFire = fire;
      this.lastRescue = rescue;
      this.lastHonk = honk;
      this.seen = true;
    }
    this.lastAt = performance.now();
  }

  /** Forget presses that came in while the boats could not be driven (the countdown, the results screen). */
  discard(): void {
    this.pressFire = false;
    this.pressRescue = false;
    this.pressHonk = false;
  }

  /** The player left: the boat sits still from now on. */
  disconnect(): void {
    this.gone = true;
    this.discard();
  }

  update(): BoatControls {
    if (this.gone || performance.now() - this.lastAt > CONTROLS_TIMEOUT * 1000) {
      this.discard();
      return ZERO_CONTROLS;
    }
    const o = this.out;
    const h = this.held;
    o.throttle = h.throttle;
    o.steer = h.steer;
    o.boost = h.boost;
    // Rescue and honk act on the press (the player's own update looks for the button going down), so a press
    // counter that went up shows as one step of "held"; a button that is simply still down shows as held too.
    o.fire = h.fire || this.pressFire;
    o.rescue = h.rescue || this.pressRescue;
    o.honk = h.honk || this.pressHonk;
    this.discard();
    return o;
  }
}

/** A stick or trigger value from the wire: a finite number in -1..1, else 0. */
function axis(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? (v < -1 ? -1 : v > 1 ? 1 : v) : 0;
}

/** A running press counter from the wire: a finite number, else 0. */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
