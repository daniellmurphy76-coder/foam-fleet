/**
 * Everything a human player gets that a computer boat does not:
 *  - Rescue (the button, and automatically for Easy Driving when stuck),
 *  - Honk,
 *  - friendly coaching hints,
 *  - the numbers that feed the Trophy Shelf (PlayerMatchStats).
 *
 * One HumanPlayer per human. The Match calls `update` every step with that player's controls.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type {
  Boat, BoatControls, Effects, Hud, HornId, InputManager, MatchSetup, Sfx, SpawnPoint, World,
} from '../types';
import type { ChaseCamera } from './cameras';
import { fallbackSafeSpot } from './fallbacks';

/** What a HumanPlayer needs from its match. */
export interface PlayerHost {
  readonly setup: MatchSetup;
  readonly world: World;
  readonly fx: Effects;
  readonly hud: Hud;
  readonly sfx: Sfx;
  readonly input: InputManager;
  readonly cams: readonly ChaseCamera[];
}

type Scheme = 'keysA' | 'keysB' | 'gamepad' | 'touch';
type HintKind = 'start' | 'shoot' | 'go' | 'stuck';

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
    host.sfx.rescue();
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
    host.sfx.honk(this.horn);
    host.fx.notes(boat.position, boat.color); // the notes lift themselves above the waterline point
  }

  // ───────────── hints ─────────────

  /** Show a hint if the rules allow it (spacing, and at most twice per match). Returns true if it was shown. */
  private hint(kind: HintKind, t: number): boolean {
    if (t - this.lastHintAt < HINT_GAP_SEC || this.hintCount[kind] >= (kind === 'start' ? 1 : HINT_MAX)) return false;
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
    const s = this.host.input.schemeOf(this.slot as 0 | 1, this.host.setup.humans);
    return s === 'keysB' || s === 'gamepad' || s === 'touch' ? s : 'keysA';
  }
}
