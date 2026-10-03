/**
 * One match: its own Three.js scene, world, boats, darts and effects, plus the
 * fixed-step simulation that ties every module together.
 *
 * The app creates a Match when you press Start (and a quiet "attract" one behind the
 * title screen), steps it 60 times a second, and disposes it when you leave.
 *
 * Online (setup.online), this is the HOST's match. Every human is a boat 0..humanCount-1, but only the ones in
 * `localSlots` sit at this device (the host is slot 0); the others are driven by a RemoteController fed from the
 * network. Two kinds of "which human" therefore exist and must not be mixed up:
 *  - rules, stats, scoring, sounds that any human could hear: ALL humans (humanCount, slotOf, isHumanBoat, nearHuman);
 *  - screens, cameras drawn, touch, rumble, hints on THIS device: LOCAL slots (localSlots, viewportOf, nearLocal).
 * Everything the match says out loud (sounds, effects, announcements, feed lines, camera kicks, rumble, darts and
 * their hits) is also written down as NetEvents for the guests: see drainEvents() and netcapture.ts.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { NetEvent, NetHud as NetHudState, NetSnapshot } from '../net/protocol';
import { SHARK_ID_BASE } from '../types';
import type {
  AimTarget, Balloons, BotDifficulty, BalloonPop, Boat, BoatControls, BoatInit, BoatNetState, BumpEvent, Controller,
  ControllerContext, DartHit, DartSystem, DartSpawn, DartTarget, DartTargetHit, DartUpdateResult, Effects, Hud,
  InputManager, MapBoat, MapState, MatchResult, MatchSetup, ModeId, Obstacle, PickupEvent, Pickups, PlayerMatchStats,
  PowerUpKind, RaceHudInfo, Sfx, SharkBump, SharkNetState, Sharks, SharkTag, SpawnPoint, TrophyAward, World,
} from '../types';
import { ChaseCamera, RemoteCamera } from './cameras';
import { foam, reportError } from './debug';
import {
  ZERO_CONTROLS, fallbackBalloons, fallbackBoat, fallbackDarts, fallbackPickups, fallbackSharks, fallbackSpawns,
  fallbackTeamSpawns, fallbackWorld, idleController, quietFx,
} from './fallbacks';
import { V2_METHODS, buildOrFallback, guard } from './guard';
import {
  awardTrophies, createBalloons, createBoat, createBotController, createDartSystem, createEffects, createPickups,
  createSharks, createWorld, resolveBoatCollisions,
} from './modules';
import { BattleMode } from './modes/battle';
import type { GameMode, GateTargets, ModeHost } from './modes/mode';
import { EventTap, TapFx, TapHud, TapSfx, type TapSite } from './modes/netcapture';
import { PracticeMode } from './modes/practice';
import { RaceMode } from './modes/race';
import { SharksMode } from './modes/sharks';
import { TeamMode } from './modes/team';
import { HumanPlayer, RemoteController, type HintKind, type PlayerHost } from './players';
import { MAX_HELPERS, botLook, rosterOf, sanitizeLook } from './setup';
import { clamp } from './util';

/** The simulation always advances in slices of this many seconds. */
export const STEP = 1 / 60;

export interface MatchServices {
  hud: Hud;
  sfx: Sfx;
  input: InputManager;
}

const NO_POSITIONS: readonly THREE.Vector3[] = [];
const NO_BOATS: readonly Boat[] = [];
const NO_BUMPS: BumpEvent[] = [];
const NO_PICKUPS: PickupEvent[] = [];
const NO_DARTS: DartUpdateResult = { hits: [], targetHits: [], waterSplashes: [] };
const NO_AIM: readonly AimTarget[] = [];
const NO_SHARK_BUMPS: SharkBump[] = [];
const NO_SHARK_DOTS: Sharks['mapDots'] = [];
const NO_SLOTS: readonly number[] = [];
const NO_EVENTS: readonly NetEvent[] = [];

const GOLD = 0xffd23f;
/** How long the victory confetti keeps popping after the MEGA SHARK is beaten, and the gap between bursts. */
const CONFETTI_SEC = 6;
const CONFETTI_GAP = 0.28;

/** A random number with mean 0 and standard deviation 1, roughly bell-shaped (sum of three uniforms, range +-3). */
function nearlyNormal(): number {
  return (Math.random() + Math.random() + Math.random()) * 2 - 3;
}
/** Kid-friendly verbs for the event feed. We rotate through them. */
const TAG_VERBS = ['tagged', 'splatted', 'bonked', 'soaked'];
const POWER_NAMES: Record<PowerUpKind, string> = {
  triple: 'Triple Shot',
  rapid: 'Rapid Fire',
  shield: 'Shield',
  turbo: 'Turbo',
};

function makeMode(id: ModeId, host: ModeHost): GameMode {
  switch (id) {
    case 'race': return new RaceMode(host);
    case 'team': return new TeamMode(host);
    case 'practice': return new PracticeMode(host);
    case 'sharks': return new SharksMode(host);
    default: return new BattleMode(host);
  }
}

export class Match implements ModeHost, PlayerHost, TapSite {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly pickups: Pickups;
  readonly darts: DartSystem;
  /** What the match itself uses for splashes, sparkles and so on (online: also written down for the guests). */
  readonly fx: Effects;
  /** The HUD as the match talks to it. Online it is a wrapper that also sends events (see netcapture.ts). */
  readonly hud: Hud;
  /** Same for sound. Aim a sound at a place with sfxAt(). */
  readonly sfx: Sfx;
  readonly input: InputManager;
  readonly mode: GameMode;
  /** Balloon Pop's balloons; null in every other mode. */
  readonly balloons: Balloons | null;
  /** Every shark in the lagoon: ambient cruisers in every mode, the attack waves in Boats vs. Sharks. */
  readonly sharks: Sharks;
  /** Humans are boats 0..humanCount-1; computer boats follow. */
  readonly boats: Boat[] = [];
  /** How every boat was built (index = boat id): online guests build identical puppets from these. */
  readonly inits: BoatInit[] = [];
  /**
   * One chase camera per human (index = human slot = boat id). Only the ones in `localSlots` are drawn and
   * updated; a human at another device has a RemoteCamera whose kicks and shakes become events.
   */
  readonly cams: ChaseCamera[] = [];
  /** One per human (online: at other devices too): rescue, honk, hints and trophy stats. */
  readonly players: HumanPlayer[] = [];
  /** EVERY human in the match. Offline 1 or 2; online the whole roster (2..4), whatever device they are at. */
  readonly humanCount: number;
  /**
   * The boat ids played on THIS device, in viewport order (viewport k shows boat localSlots[k]).
   * Local play: [0] or [0, 1]. Online host: [0]. The attract lagoon: [].
   */
  readonly localSlots: readonly number[];
  /** The online host's match: other humans sit at other devices, and everything is also written down as events. */
  readonly isOnline: boolean;

  /** Match time in seconds. Runs during the countdown too (so the water moves); frozen while paused. */
  t = 0;
  /** Total dart hits that landed (not counting shield blocks). */
  hits = 0;

  private readonly obstacles: readonly Obstacle[];
  private cachedResult: MatchResult | null = null;
  private readonly ctrls: Controller[] = [];
  private readonly autopilots: (Controller | null)[] = [];
  private readonly ctxs: ControllerContext[] = [];
  private readonly others: Boat[][] = [];
  private readonly firing: boolean[] = [];
  private readonly gates: GateTargets = { next: null, following: null };
  private botFireGate = 0;
  /** Computer boats' aim error (radians, one standard deviation), from CONFIG.bots.aimErrorDeg. */
  private readonly botAimSigma: number;
  /** Skill for computer boats (differs from setup.botDifficulty in Boats vs. Sharks). */
  private readonly botSkill: BotDifficulty;
  private tagCount = 0;
  private disposed = false;
  /** Balloon Pop's dart targets: the balloons plus the sharks, rebuilt into this one list every step. */
  private readonly targetList: DartTarget[] = [];
  /** Which way a dart was travelling when it tagged a shark (scratch). */
  private readonly sharkDir = new THREE.Vector3();
  /** Seconds of victory confetti still to go, the gap to the next burst, and the boat it pops over. */
  private confetti = 0;
  private confettiGap = 0;
  private confettiBoat = 0;
  private readonly confettiAt = new THREE.Vector3();
  /** Online only: where everything the match says is written down for the guests (null for local play). */
  private readonly tap: EventTap | null;
  /** The aimable sound wrapper inside `sfx` (online only). */
  private readonly tapSfx: TapSfx | null;
  /** The effects without the event copy: wakes, particles, and what the darts and sharks make. */
  private readonly rawFx: Effects;
  /** Online: the controller of each human who sits at another device, else null (index = human slot). */
  private readonly remotes: (RemoteController | null)[] = [];
  /** The network ids of the darts of the volley being fired right now (scratch). */
  private readonly fireIds: number[] = [];

  /**
   * `attract` = the quiet demo lagoon behind the title screen: no humans, no rules,
   * and the hud/sfx passed in should be the silent ones.
   */
  constructor(readonly setup: MatchSetup, services: MatchServices, readonly attract = false) {
    const online = attract ? null : setup.online ?? null;
    const roster = rosterOf(setup);
    this.input = services.input;
    this.isOnline = online !== null;
    // Humans: all of them (online, the whole roster). Local slots: the ones playing at THIS device.
    this.humanCount = attract ? 0 : online ? clamp(roster.length, 1, CONFIG.match.maxBoats) : setup.humans;
    this.localSlots = attract
      ? NO_SLOTS
      : online ? [clamp(Math.round(Number(online.localSlot)) || 0, 0, this.humanCount - 1)]
        : setup.humans === 2 ? [0, 1] : [0];
    if (online) {
      // Same sounds, announcements and feed lines as ever on this device, and a copy of each for the guests.
      const tap = new EventTap();
      this.tap = tap;
      this.tapSfx = new TapSfx(services.sfx, tap, this);
      this.sfx = this.tapSfx;
      this.hud = new TapHud(services.hud, tap, this);
    } else {
      this.tap = null;
      this.tapSfx = null;
      this.sfx = services.sfx;
      this.hud = services.hud;
    }
    // In Boats vs. Sharks the skill buttons set the SHARKS' speed; the helper boats are always sharp shooters.
    this.botSkill = setup.mode === 'sharks' ? 'hard' : setup.botDifficulty;
    const errDeg = CONFIG.bots.aimErrorDeg[this.botSkill] ?? CONFIG.bots.aimErrorDeg.normal;
    this.botAimSigma = (errDeg * Math.PI) / 180;

    const scene = this.scene;
    const modeId = setup.mode;
    // Each module is built behind buildOrFallback so one broken builder cannot stop the match from starting.
    this.world = buildOrFallback('createWorld', () => createWorld(scene, modeId), () => fallbackWorld(scene, modeId));
    this.obstacles = this.world.obstacles;
    this.pickups = buildOrFallback('createPickups', () => createPickups(scene, this.world, modeId), fallbackPickups);
    // The darts and the sharks get the plain effects: the guests' own copies play their splashes and bursts, so
    // sending those as events too would play them twice. Only what THIS file and the players/modes make is sent.
    const rawFx = guard('fx', buildOrFallback('createEffects', () => createEffects(scene), quietFx), {}, V2_METHODS.fx);
    this.rawFx = rawFx;
    this.fx = this.tap ? new TapFx(rawFx, this.tap) : rawFx;
    this.darts = buildOrFallback('createDartSystem', () => createDartSystem(scene, rawFx), fallbackDarts);
    this.balloons = modeId === 'practice'
      ? buildOrFallback('createBalloons', () => createBalloons(scene, this.world), () => fallbackBalloons(scene, this.world))
      : null;
    this.sharks = buildOrFallback(
      'createSharks',
      () => createSharks(scene, this.world, modeId, rawFx, setup.botDifficulty),
      fallbackSharks,
    );

    this.createBoats();
    this.mode = makeMode(modeId, this);

    for (let i = 0; i < this.humanCount; i++) {
      const boat = this.boats[i];
      let cam: ChaseCamera;
      if (this.viewportOf(i) >= 0) {
        cam = new ChaseCamera(boat.easyDriving);
        cam.snap(boat, this.world, 0);
      } else {
        // Nobody here looks through it: its kicks and shakes go to that player's own device.
        cam = new RemoteCamera(boat.easyDriving, (op, amt) => this.tap?.push({ k: 'cam', op, amt, to: i }));
      }
      this.cams.push(cam);
      this.players.push(new HumanPlayer(i, boat, sanitizeLook(roster[i]?.look, i).horn, this));
    }
  }

  /** A human's slot (= its boat id, whichever device they are at), or -1 for a computer boat. */
  slotOf(boatId: number): number {
    return boatId >= 0 && boatId < this.humanCount ? boatId : -1;
  }

  isHumanBoat(boatId: number): boolean {
    return boatId >= 0 && boatId < this.humanCount;
  }

  /** Which viewport on THIS device shows human `slot`, or -1 (a computer boat, or a human at another device). */
  viewportOf(slot: number): number {
    return this.localSlots.indexOf(slot);
  }

  /** Is any boat played on THIS device within `range` meters of (x, z)? (Whether THIS device could hear it.) */
  nearLocal(x: number, z: number, range: number): boolean {
    const r2 = range * range;
    for (let k = 0; k < this.localSlots.length; k++) {
      const boat = this.boats[this.localSlots[k]];
      if (!boat) continue;
      const dx = boat.position.x - x;
      const dz = boat.position.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /**
   * The sound system aimed at a spot in the lagoon. Online, this device plays the sound only if a local boat is
   * within earshot, and each guest decides the same from the spot we send. Offline it is just `sfx`.
   */
  sfxAt(x: number, z: number): Sfx {
    return this.tapSfx ? this.tapSfx.from(x, z) : this.sfx;
  }

  /** A coaching hint for a human at another device: their device words it for its own controls. */
  netHint(slot: number, kind: HintKind): void {
    this.tap?.push({ k: 'hint', hint: kind, to: slot });
  }

  /** Online host: the controller of the human at slot `slot` if they sit at another device, else null. */
  remote(slot: number): RemoteController | null {
    return this.remotes[slot] ?? null;
  }

  // ───────────────────────────── setup ─────────────────────────────

  private createBoats(): void {
    const { setup } = this;
    const humans = this.humanCount;
    // Balloon Pop has no computer boats. Boats vs. Sharks has up to three helper boats (on the players' team).
    const sharksMode = setup.mode === 'sharks';
    const maxBots = Math.max(0, CONFIG.match.maxBoats - humans);
    const bots = setup.mode === 'practice' ? 0 : clamp(Math.round(setup.bots), 0, sharksMode ? Math.min(MAX_HELPERS, maxBots) : maxBots);
    const total = humans + bots;
    // Team Up: team 0 = the humans plus enough helper bots to even the sides; team 1 = the other bots.
    // Boats are numbered humans, then helpers, then opponents, so each side is one run of ids.
    const teamMode = setup.mode === 'team';
    const allies = teamMode ? Math.min(bots, Math.max(0, Math.ceil(total / 2) - humans)) : 0;
    const sideA = humans + allies;
    const spawns = teamMode ? this.pickTeamSpawns(sideA, total - sideA) : this.pickSpawns(total);

    // Computer boats get paint colors the humans did not pick.
    const roster = rosterOf(setup);
    const used = new Set<number>();
    for (let i = 0; i < humans; i++) used.add(roster[i]?.color ?? -1);
    const freeColors = CONFIG.colors.filter((c) => !used.has(c));

    for (let i = 0; i < total; i++) {
      const isHuman = i < humans;
      const botIndex = i - humans;
      const player = roster[i];
      // Boats vs. Sharks: everyone is on one team, so the helpers' darts pass through the humans.
      const team = teamMode ? (i < sideA ? 0 : 1) : sharksMode ? 0 : i;
      const init: BoatInit = {
        id: i,
        name: isHuman ? player?.name || `Player ${i + 1}` : CONFIG.botNames[botIndex % CONFIG.botNames.length],
        color: isHuman
          ? player?.color ?? CONFIG.colors[i % CONFIG.colors.length]
          : freeColors.length > 0 ? freeColors[botIndex % freeColors.length] : CONFIG.colors[i % CONFIG.colors.length],
        isHuman,
        spawn: spawns[i],
        look: isHuman ? sanitizeLook(player?.look, i) : botLook(i),
        team,
        marker: teamMode ? CONFIG.team.colors[team] : null,
        // Easy Driving is for the kids at the controls; computer boats always drive normally.
        easyDriving: isHuman && (player?.easyDriving ?? true),
      };
      const boat = buildOrFallback('createBoat', () => createBoat(init), () => fallbackBoat(init));
      this.scene.add(boat.object);
      this.boats.push(boat);
      this.inits.push(init);

      const controller = isHuman
        ? this.humanDriver(i)
        : buildOrFallback('createBotController', () => createBotController(this.botSkill, i), () => idleController('bot'));
      this.ctrls.push(controller);
      this.autopilots.push(null);
      this.firing.push(false);
      this.ctxs.push({
        self: boat,
        boats: this.boats,
        world: this.world,
        mode: setup.mode,
        t: 0,
        nextCheckpoint: null,
        followingCheckpoint: null,
        pickups: NO_POSITIONS,
        sharks: NO_AIM,
      });
    }
    // Each boat gets a list of everyone EXCEPT itself (for aim assist), built once.
    for (let i = 0; i < total; i++) this.others.push(this.boats.filter((b) => b !== this.boats[i]));
  }

  /**
   * Who drives human `i`: this device's own controls (the input manager numbers the players here 0 and 1), or, for a
   * human at another device, a RemoteController that the net code feeds.
   */
  private humanDriver(i: number): Controller {
    const vp = this.viewportOf(i);
    if (vp < 0) {
      const remote = new RemoteController();
      this.remotes[i] = remote;
      return remote;
    }
    this.remotes[i] = null;
    const count = this.localSlots.length as 1 | 2;
    return buildOrFallback('humanController', () => this.input.humanController(vp as 0 | 1, count), () => idleController('human'));
  }

  /** Ask the world for spawn points; if it hands back nonsense, lay them out ourselves. */
  private pickSpawns(count: number): SpawnPoint[] {
    try {
      const pts = this.world.spawnPoints(count, this.setup.mode);
      if (pts.length >= count && pts.every((p) => Number.isFinite(p.x + p.z + p.heading))) return pts;
      reportError('world.spawnPoints', `gave ${pts.length} usable points, needed ${count}`);
    } catch (e) {
      reportError('world.spawnPoints', e);
    }
    return fallbackSpawns(count, this.setup.mode, this.world.checkpoints);
  }

  /** Team Up spawns: side A's points first, then side B's. Same safety net as pickSpawns. */
  private pickTeamSpawns(countA: number, countB: number): SpawnPoint[] {
    const usable = (pts: readonly SpawnPoint[] | undefined, n: number): boolean =>
      !!pts && pts.length >= n && pts.slice(0, n).every((p) => Number.isFinite(p.x + p.z + p.heading));
    try {
      const [a, b] = this.world.teamSpawnPoints(countA, countB);
      if (usable(a, countA) && usable(b, countB)) return [...a.slice(0, countA), ...b.slice(0, countB)];
      reportError('world.teamSpawnPoints', `gave ${a?.length}+${b?.length} usable points, needed ${countA}+${countB}`);
    } catch (e) {
      reportError('world.teamSpawnPoints', e);
    }
    const [a, b] = fallbackTeamSpawns(countA, countB);
    return [...a, ...b];
  }

  // ───────────────────────────── the simulation ─────────────────────────────

  /**
   * Advance the match by one fixed slice.
   *  controlsOn: boats obey their controllers (off during the countdown and on the results screen)
   *  rulesOn:    the mode counts scores, gates and the clock
   */
  step(dt: number, controlsOn: boolean, rulesOn: boolean): void {
    if (this.disposed) return;
    const t = (this.t += dt);
    const boats = this.boats;
    const n = boats.length;
    const mode = this.mode;
    if (this.botFireGate > 0) this.botFireGate -= dt;

    let crates: readonly THREE.Vector3[] = NO_POSITIONS;
    try {
      crates = this.pickups.positions;
    } catch (e) {
      reportError('pickups.positions', e);
    }
    // The sharks the blasters and the bots can see this step (re-read after the sharks have moved, below).
    let sharkTargets: readonly AimTarget[] = NO_AIM;
    try {
      sharkTargets = this.sharks.targets;
    } catch (e) {
      reportError('sharks.targets', e);
    }

    // Taps that came in from other devices while the boats could not be driven (the countdown) are forgotten.
    if (!controlsOn && this.isOnline) {
      for (let i = 0; i < this.humanCount; i++) this.remotes[i]?.discard();
    }

    // 1. Controllers decide, boats move.
    for (let i = 0; i < n; i++) {
      const boat = boats[i];
      let c: BoatControls = ZERO_CONTROLS;
      // A bot that has finished the race just coasts; humans keep control.
      const driven = controlsOn && (boat.isHuman || !mode.isFinished(i));
      if (driven) {
        const ctx = this.ctxs[i];
        ctx.t = t;
        ctx.pickups = crates;
        ctx.sharks = sharkTargets;
        mode.gates(i, this.gates);
        ctx.nextCheckpoint = this.gates.next;
        ctx.followingCheckpoint = this.gates.following;
        try {
          c = this.controllerFor(i).update(ctx, dt) ?? ZERO_CONTROLS;
        } catch (e) {
          reportError(`controller[${i}].update`, e);
        }
      }
      // Copy the fire flag right now: some controllers reuse one output object.
      // (Computer boats hold their own fire while a teammate is in the way: that lives in ai/bot.ts.)
      this.firing[i] = driven && c.fire === true;
      // Humans: rescue, honk and hints. (Before boat.update, so a rescued boat carries on from its new spot.)
      const human = i < this.humanCount ? this.players[i] : null;
      if (human && driven) {
        try {
          human.update(dt, t, c, mode.isFinished(i));
        } catch (e) {
          reportError(`player[${i}].update`, e);
        }
      }
      try {
        boat.update(c, dt, t, this.world, this.others[i], sharkTargets);
      } catch (e) {
        reportError(`boat[${i}].update`, e);
      }
      if (human && driven && boat.boosting) human.boostSeconds += dt;
    }

    // 2. Boats bump into each other.
    let bumps: BumpEvent[] = NO_BUMPS;
    try {
      bumps = resolveBoatCollisions(boats);
    } catch (e) {
      reportError('resolveBoatCollisions', e);
    }
    for (let k = 0; k < bumps.length; k++) this.onBump(bumps[k]);

    // 2b. Sharks swim, chase and bump (after the boats have moved, before the darts fly).
    let sharkBumps: SharkBump[] = NO_SHARK_BUMPS;
    try {
      sharkBumps = this.sharks.update(t, dt, boats);
      sharkTargets = this.sharks.targets;
    } catch (e) {
      reportError('sharks.update', e);
    }
    for (let k = 0; k < sharkBumps.length; k++) this.onSharkBump(sharkBumps[k], rulesOn);

    // 3. Anyone holding fire shoots (if their blaster is ready).
    for (let i = 0; i < n; i++) {
      if (!this.firing[i]) continue;
      try {
        const spawns = boats[i].tryFire(t, this.others[i], sharkTargets);
        if (spawns.length > 0) {
          // Players keep full aim assist; computer boats get a small random aim error.
          if (!boats[i].isHuman) this.wobbleBotAim(spawns);
          const ids = this.fireIds;
          for (let k = 0; k < spawns.length; k++) {
            const id = this.darts.spawn(spawns[k]);
            ids[k] = typeof id === 'number' ? id : -1;
          }
          this.onFired(boats[i], spawns, ids);
        }
      } catch (e) {
        reportError(`boat[${i}].tryFire`, e);
      }
    }

    // 4. Darts fly; apply what they hit (boats, sharks, and in Balloon Pop the balloons).
    let flight = NO_DARTS;
    try {
      flight = this.darts.update(dt, t, boats, this.world, mode.stunSeconds, this.dartTargets(sharkTargets));
    } catch (e) {
      reportError('darts.update', e);
    }
    // A dart that popped a balloon or scared a shark is used up: the guests' copy of it goes away too.
    if (this.tap) {
      for (let k = 0; k < flight.targetHits.length; k++) this.tap.push({ k: 'kill', id: flight.targetHits[k].dartId });
    }
    this.onHits(flight.hits, rulesOn);
    this.onSharkHits(flight.targetHits, rulesOn);
    if (this.balloons) this.updateBalloons(flight.targetHits, t, dt, rulesOn);
    let splashSounds = 0;
    for (let k = 0; k < flight.waterSplashes.length && splashSounds < 2; k++) {
      const p = flight.waterSplashes[k];
      if (this.nearHuman(p.x, p.z, 70)) {
        this.sfxAt(p.x, p.z).splash(0.35);
        splashSounds++;
      }
    }

    // 5. Crates.
    let grabbed: PickupEvent[] = NO_PICKUPS;
    try {
      grabbed = this.pickups.update(t, dt, boats);
    } catch (e) {
      reportError('pickups.update', e);
    }
    this.onPickups(grabbed, rulesOn);

    // 6. Rules: clock, gates, announcements.
    if (rulesOn) {
      try {
        mode.update(dt);
      } catch (e) {
        reportError(`${mode.id}.update`, e);
      }
    }

    // 7. Visuals: victory confetti, wakes, particles, water and sky.
    if (this.confetti > 0) this.sprinkleConfetti(dt);
    for (let i = 0; i < n; i++) this.rawFx.wake(boats[i]);
    this.rawFx.update(dt, t, this.world);
    try {
      this.world.update(t, dt);
    } catch (e) {
      reportError('world.update', e);
    }
  }

  /**
   * Knock a computer boat's volley slightly off target. Yaw and pitch errors are roughly
   * normal (sum of three uniforms); the whole volley shares one error so a Triple Shot
   * keeps its fan shape. Edits the directions in place: no allocation.
   */
  private wobbleBotAim(spawns: readonly DartSpawn[]): void {
    const sigma = this.botAimSigma;
    if (!(sigma > 0)) return;
    const yaw = nearlyNormal() * sigma;
    const pitch = nearlyNormal() * sigma * 0.5;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    for (let k = 0; k < spawns.length; k++) {
      const d = spawns[k].direction;
      // Yaw: turn the dart sideways about the Y axis.
      const x = d.x * cy + d.z * sy;
      const z = -d.x * sy + d.z * cy;
      // Pitch: tilt the dart's elevation angle (the horizontal part keeps its heading).
      const h = Math.hypot(x, z);
      if (h < 1e-6) continue;
      const elev = Math.atan2(d.y, h) + pitch;
      const ch = Math.cos(elev) / h;
      d.set(x * ch, Math.sin(elev), z * ch);
    }
  }

  /** Move the chase cameras of the players at THIS device. Runs once per rendered frame with real frame time. */
  updateCameras(dt: number): void {
    for (let k = 0; k < this.localSlots.length; k++) {
      const i = this.localSlots[k];
      try {
        this.cams[i].update(dt, this.boats[i], this.world, this.t);
      } catch (e) {
        reportError(`camera[${i}]`, e);
      }
    }
  }

  // ───────────────────────────── event handlers ─────────────────────────────

  private controllerFor(i: number): Controller {
    // Autopilot (a test hook): the human boats at THIS device are driven by an ordinary bot brain.
    if (foam.autopilot && this.viewportOf(i) >= 0) {
      let pilot = this.autopilots[i];
      if (!pilot) {
        pilot = buildOrFallback('createBotController', () => createBotController('normal', 100 + i), () => idleController('bot'));
        this.autopilots[i] = pilot;
      }
      return pilot;
    }
    return this.ctrls[i];
  }

  /**
   * Is any human boat (at any device) within `range` meters of this spot? Used so we only make sounds somebody could
   * hear; online, each device then keeps only the ones near ITS boat (see nearLocal).
   */
  private nearHuman(x: number, z: number, range: number): boolean {
    const r2 = range * range;
    for (let i = 0; i < this.humanCount; i++) {
      const p = this.boats[i].position;
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /** Buzz the gamepad of human `slot`: here if they play at this device, otherwise on theirs (as an event). */
  private rumble(slot: number, strength: number, ms: number): void {
    const vp = this.viewportOf(slot);
    if (vp >= 0) this.input.rumble(vp as 0 | 1, this.localSlots.length as 1 | 2, strength, ms);
    else if (this.tap && this.isHumanBoat(slot)) this.tap.push({ k: 'rumble', strength, ms, to: slot });
  }

  private onBump(b: BumpEvent): void {
    const a = this.boats[b.aId];
    const c = this.boats[b.bId];
    const slotA = a ? this.slotOf(a.id) : -1;
    const slotC = c ? this.slotOf(c.id) : -1;
    if (slotA >= 0 || slotC >= 0 || this.nearHuman(b.point.x, b.point.z, 40)) this.sfxAt(b.point.x, b.point.z).bump(b.strength);
    this.fx.splash(b.point, clamp(0.5 + b.strength * 0.06, 0.5, 1.6));
    const shake = clamp(b.strength / 16, 0.1, 0.4);
    if (slotA >= 0) {
      this.cams[slotA].shake(shake);
      this.rumble(slotA, shake, 120);
    }
    if (slotC >= 0) {
      this.cams[slotC].shake(shake);
      this.rumble(slotC, shake, 120);
    }
  }

  private onFired(boat: Boat, spawns: readonly DartSpawn[], ids: readonly number[]): void {
    const dartCount = spawns.length;
    const slot = this.slotOf(boat.id);
    if (slot >= 0) {
      this.sfxAt(boat.position.x, boat.position.z).fire();
      this.cams[slot].kick(dartCount > 1 ? 0.4 : 0.25);
    } else if (this.botFireGate <= 0 && this.nearHuman(boat.position.x, boat.position.z, 45)) {
      this.sfxAt(boat.position.x, boat.position.z).fire();
      this.botFireGate = 0.08; // keep a crowd of bots from turning into one long buzz
    }
    if (this.tap) {
      // Guests fly their own copies of the darts: each with its network id, where it starts and how it goes.
      const darts: number[][] = [];
      for (let k = 0; k < dartCount; k++) {
        const o = spawns[k].origin;
        const d = spawns[k].direction;
        darts.push([ids[k], o.x, o.y, o.z, d.x, d.y, d.z, spawns[k].speed]);
      }
      this.tap.push({ k: 'fire', boat: boat.id, darts });
    }
  }

  private onHits(hits: readonly DartHit[], rulesOn: boolean): void {
    const mode = this.mode;
    for (let k = 0; k < hits.length; k++) {
      const h = hits[k];
      if (this.tap) this.recordHit(h);
      const shooter = this.boats[h.ownerId];
      const target = this.boats[h.targetId];
      if (!shooter || !target) continue;
      if (shooter.team === target.team) continue; // teammates never tag each other (the darts skip them already)
      const shooterSlot = this.slotOf(shooter.id);
      const targetSlot = this.slotOf(target.id);
      const audible = shooterSlot >= 0 || targetSlot >= 0 || this.nearHuman(h.point.x, h.point.z, 45);

      if (h.blocked) {
        if (audible) this.sfxAt(h.point.x, h.point.z).shieldBlock();
        if (targetSlot >= 0) {
          this.cams[targetSlot].shake(0.2);
          if (rulesOn) this.hud.feed(`${target.name}'s shield blocked it!`, target.color);
        }
        continue;
      }

      if (!this.attract) this.hits++;
      if (audible) this.sfxAt(h.point.x, h.point.z).hit();
      if (targetSlot >= 0) {
        this.cams[targetSlot].shake(0.55);
        this.rumble(targetSlot, 0.9, 240);
      }
      if (shooterSlot >= 0) this.cams[shooterSlot].kick(0.3);
      if (!rulesOn) continue;

      mode.onTag(shooter, target);
      if (shooterSlot >= 0) {
        const p = this.players[shooterSlot];
        p.hits++;
        if (targetSlot >= 0 && targetSlot !== shooterSlot) p.tagsOnOtherHuman++;
      }
      if (targetSlot >= 0) this.players[targetSlot].timesTagged++;
      const verb = TAG_VERBS[this.tagCount++ % TAG_VERBS.length];
      this.hud.feed(`${shooter.name} ${verb} ${target.name}!`, shooter.color);
      if (shooterSlot >= 0 && (mode.id === 'battle' || mode.id === 'team')) {
        this.hud.announce('SPLAT!', { sub: `+${CONFIG.battle.pointsPerHit}`, ms: 700, viewport: shooterSlot });
      }
    }
  }

  private onPickups(events: readonly PickupEvent[], rulesOn: boolean): void {
    for (let k = 0; k < events.length; k++) {
      const e = events[k];
      const boat = this.boats[e.boatId];
      if (!boat) continue;
      try {
        boat.applyPowerUp(e.kind);
      } catch (err) {
        reportError(`boat[${e.boatId}].applyPowerUp`, err);
      }
      this.fx.sparkle(e.position, GOLD);
      const slot = this.slotOf(boat.id);
      if (slot >= 0 || this.nearHuman(e.position.x, e.position.z, 40)) this.sfxAt(e.position.x, e.position.z).pickup();
      if (slot >= 0 && rulesOn) {
        this.players[slot].pickups++;
        const label = POWER_NAMES[e.kind] ?? String(e.kind);
        this.hud.feed(`${boat.name} grabbed ${label}!`, boat.color);
        this.hud.announce(`${label.toUpperCase()}!`, { ms: 900, viewport: slot });
      }
    }
  }

  // ───────────────────────────── sharks ─────────────────────────────

  /** What a dart can hit besides boats: the sharks, plus the balloons in Balloon Pop (one reused list). */
  private dartTargets(sharkTargets: readonly AimTarget[]): readonly DartTarget[] {
    const balloons = this.balloons;
    if (!balloons) return sharkTargets;
    const list = this.targetList;
    list.length = 0;
    const b = balloons.targets;
    for (let k = 0; k < b.length; k++) list.push(b[k]);
    for (let k = 0; k < sharkTargets.length; k++) list.push(sharkTargets[k]);
    return list;
  }

  /** The reticle label for a locked target: a boat's name, or "Shark" / "MEGA SHARK". */
  targetName(id: number): string | null {
    if (id < SHARK_ID_BASE) return this.boats[id]?.name ?? null;
    const list = this.sharks.targets;
    for (let k = 0; k < list.length; k++) {
      if (list[k].id === id) return list[k].name;
    }
    return null;
  }

  /** A shark bumped a boat. The Sharks module already wobbled the boat; here are the sounds, the splash and the rules. */
  private onSharkBump(b: SharkBump, rulesOn: boolean): void {
    // Sharks.update already called boat.onHit on this side (whatever the rules say): the guests' copy of the boat
    // needs the same paint flash and wobble, or the shield pop, which only a `hit` event gives it.
    if (this.tap) this.tap.push({ k: 'hit', boat: b.boatId, blocked: b.blocked, stun: b.blocked ? 0 : CONFIG.sharks.bumpStun });
    if (!rulesOn) return;
    const boat = this.boats[b.boatId];
    if (!boat) return;
    const slot = this.slotOf(boat.id);
    const audible = slot >= 0 || this.nearHuman(b.point.x, b.point.z, 45);
    if (audible) this.sfxAt(b.point.x, b.point.z).sharkBump();
    this.fx.splash(b.point, b.mega ? 2.4 : 1.3);
    if (b.blocked) {
      // A shield soaked it up: boing, and nobody loses anything.
      if (audible) this.sfxAt(b.point.x, b.point.z).shieldBlock();
      if (slot >= 0) this.cams[slot].shake(0.2);
      this.hud.feed(`${boat.name}'s shield bounced a shark!`, boat.color);
      return;
    }
    if (slot >= 0) {
      this.cams[slot].shake(b.mega ? 0.8 : 0.5);
      this.rumble(slot, b.mega ? 1 : 0.7, b.mega ? 360 : 220);
      this.players[slot].sharkBumps++;
    }
    this.mode.onSharkBump(b);
    const who = b.mega ? 'The MEGA SHARK' : 'A shark';
    this.hud.feed(this.mode.id === 'sharks' ? `Splash! ${who} bumped ${boat.name}!` : `${who} bumped ${boat.name}!`, boat.color);
  }

  /** Darts that hit a shark (ids from SHARK_ID_BASE up) go to the Sharks module; the rest are balloons. */
  private onSharkHits(hits: readonly DartTargetHit[], rulesOn: boolean): void {
    for (let k = 0; k < hits.length; k++) {
      const h = hits[k];
      if (h.targetId < SHARK_ID_BASE) continue;
      // The dart's direction: from the shooter to where it landed.
      const shooter = this.boats[h.ownerId];
      const dir = this.sharkDir.set(0, 0, 1);
      if (shooter) {
        dir.copy(h.point).sub(shooter.position);
        if (dir.lengthSq() < 1e-6) dir.set(Math.sin(shooter.heading), 0, Math.cos(shooter.heading));
      }
      dir.normalize();
      let tag: SharkTag | null = null;
      try {
        tag = this.sharks.hit(h.targetId, h.ownerId, dir);
      } catch (e) {
        reportError('sharks.hit', e);
      }
      if (tag) this.onSharkTag(tag, rulesOn);
    }
  }

  /**
   * A dart scared a shark off (or bonked the MEGA SHARK). Sounds and kick always; points and stats only with the
   * rules on, and only Boats vs. Sharks turns a tag into score (the mode decides: elsewhere it is just for fun).
   */
  private onSharkTag(tag: SharkTag, rulesOn: boolean): void {
    const shooter = this.boats[tag.boatId];
    const slot = shooter ? this.slotOf(shooter.id) : -1;
    const finalBlow = tag.mega && tag.defeated;
    if (slot >= 0 || this.nearHuman(tag.point.x, tag.point.z, 60)) {
      // A normal shark (and the MEGA SHARK's last hit) dives away; the MEGA SHARK shrugs off the others with a bonk.
      if (!tag.mega || finalBlow) this.sfxAt(tag.point.x, tag.point.z).sharkDive();
      else this.sfxAt(tag.point.x, tag.point.z).hit();
    }
    if (slot >= 0) {
      this.cams[slot].kick(0.3);
      this.rumble(slot, 0.35, 100);
    }
    if (!rulesOn || !shooter) return;
    if (slot >= 0 && !tag.mega) this.players[slot].sharkTags++;
    this.mode.onSharkTag(shooter, tag);
    if (finalBlow) {
      this.hud.feed(`${shooter.name} beat the MEGA SHARK!`, shooter.color);
      this.confetti = CONFETTI_SEC;
    } else if (!tag.mega) {
      this.hud.feed(`${shooter.name} scared off a shark!`, shooter.color);
    }
  }

  /** Victory confetti: colorful bursts popping over the boats, one every CONFETTI_GAP seconds. */
  private sprinkleConfetti(dt: number): void {
    this.confetti -= dt;
    this.confettiGap -= dt;
    if (this.confettiGap > 0 || this.boats.length === 0) return;
    this.confettiGap = CONFETTI_GAP;
    const boat = this.boats[this.confettiBoat++ % this.boats.length];
    const at = this.confettiAt.set(
      boat.position.x + (Math.random() - 0.5) * 8,
      boat.position.y + 3 + Math.random() * 3,
      boat.position.z + (Math.random() - 0.5) * 8,
    );
    this.fx.hitBurst(at, CONFIG.colors[Math.floor(Math.random() * CONFIG.colors.length)]);
    if (this.confettiBoat % 2 === 0) this.fx.sparkle(at, GOLD);
  }

  // ───────────────────────────── balloons ─────────────────────────────

  /** Balloon Pop: pop what the darts hit, then whatever a boat drove through. Nothing pops outside the rules. */
  private updateBalloons(dartHits: readonly DartTargetHit[], t: number, dt: number, rulesOn: boolean): void {
    const balloons = this.balloons;
    if (!balloons) return;
    try {
      if (rulesOn) {
        for (let k = 0; k < dartHits.length; k++) {
          if (dartHits[k].targetId >= SHARK_ID_BASE) continue; // a shark: handled in onSharkHits
          const pop = balloons.pop(dartHits[k].targetId, dartHits[k].ownerId);
          if (pop) this.onBalloonPop(pop);
        }
      }
      // With the rules off (countdown, results) the balloons still bob, but no boat can pop them.
      const rams = balloons.update(t, dt, rulesOn ? this.boats : NO_BOATS);
      for (let k = 0; k < rams.length; k++) this.onBalloonPop(rams[k]);
    } catch (e) {
      reportError('balloons.update', e);
    }
  }

  private onBalloonPop(pop: BalloonPop): void {
    const boat = this.boats[pop.boatId];
    const slot = boat ? this.slotOf(boat.id) : -1;
    this.fx.pop(pop.position, pop.color);
    if (slot >= 0 || this.nearHuman(pop.position.x, pop.position.z, 60)) this.sfxAt(pop.position.x, pop.position.z).pop();
    if (slot >= 0) {
      this.players[slot].balloons += pop.value;
      this.cams[slot].kick(0.15);
      this.rumble(slot, 0.25, 80);
    }
    this.mode.onBalloon(pop);
    if (pop.value > 1 && boat) {
      this.hud.feed(`${boat.name} popped a GOLD balloon! +${pop.value}`, GOLD);
      if (slot >= 0) this.hud.announce('GOLD!', { sub: `+${pop.value}`, ms: 800, viewport: slot });
    }
  }

  // ───────────────────────────── results and HUD data ─────────────────────────────

  /**
   * The full results: the mode's table and headline, plus each human's stats and any trophies they earned
   * for the first time. Built once (awarding a trophy saves it, so asking twice would hand out nothing).
   *
   * Online, `stats` holds EVERY human's numbers (see statsFor), but trophies go only to the humans at THIS device:
   * each guest awards its own player's trophies on its own device.
   */
  result(): MatchResult {
    if (this.cachedResult) return this.cachedResult;
    const base = this.mode.result();
    const stats = this.buildStats();
    const mine = this.isOnline ? this.localSlots.map((slot) => stats[slot]).filter((st) => st !== undefined) : stats;
    let awards: TrophyAward[] = [];
    try {
      awards = awardTrophies(mine);
    } catch (e) {
      reportError('awardTrophies', e);
    }
    this.cachedResult = { ...base, stats, awards };
    return this.cachedResult;
  }

  /** What human `slot` did this match (the numbers behind their trophies), or null if there is no such human. */
  statsFor(slot: number): PlayerMatchStats | null {
    return this.result().stats[slot] ?? null;
  }

  private buildStats(): PlayerMatchStats[] {
    const stats: PlayerMatchStats[] = [];
    for (let i = 0; i < this.humanCount; i++) {
      const p = this.players[i];
      const boat = p.boat;
      const outcome = this.mode.outcome(boat.id);
      stats.push({
        name: boat.name,
        color: boat.color,
        slot: i,
        mode: this.mode.id,
        place: this.mode.rankOf(boat.id),
        won: outcome.won,
        finished: outcome.finished,
        hits: p.hits,
        tagsOnOtherHuman: p.tagsOnOtherHuman,
        timesTagged: p.timesTagged,
        balloons: p.balloons,
        boostSeconds: Math.round(p.boostSeconds * 10) / 10,
        pickups: p.pickups,
        honks: p.honks,
        rescues: p.rescues,
        finishTime: outcome.finishTime,
        easyDriving: boat.easyDriving,
        sharkTags: p.sharkTags,
        sharkBumps: p.sharkBumps,
        megaDefeated: outcome.megaDefeated === true,
        hull: sanitizeLook(rosterOf(this.setup)[i]?.look, i).hull,
      });
    }
    return stats;
  }

  /** Everything the mini-map draws, fresh every call (the obstacle list keeps its identity all match). */
  mapState(): MapState {
    const boats: MapBoat[] = [];
    for (let i = 0; i < this.boats.length; i++) {
      const b = this.boats[i];
      boats.push({ id: b.id, x: b.position.x, z: b.position.z, heading: b.heading, color: b.color, isHuman: b.isHuman, team: b.team });
    }
    const balloons: { x: number; z: number; gold: boolean }[] = [];
    const bl = this.balloons;
    if (bl) {
      // Same rule as the balloons themselves: every goldEvery-th one (counting from 1) is gold.
      const goldEvery = Math.floor(CONFIG.practice.goldEvery);
      const targets = bl.targets;
      for (let k = 0; k < targets.length; k++) {
        const target = targets[k];
        if (target.alive) balloons.push({ x: target.position.x, z: target.position.z, gold: goldEvery > 0 && (k + 1) % goldEvery === 0 });
      }
    }
    let pickups: readonly THREE.Vector3[] = NO_POSITIONS;
    try {
      pickups = this.pickups.positions;
    } catch (e) {
      reportError('pickups.positions', e);
    }
    let sharkDots: Sharks['mapDots'] = NO_SHARK_DOTS;
    try {
      sharkDots = this.sharks.mapDots;
    } catch (e) {
      reportError('sharks.mapDots', e);
    }
    return {
      arenaRadius: this.world.arenaRadius,
      obstacles: this.obstacles,
      boats,
      pickups,
      balloons,
      sharks: sharkDots,
      gates: this.mode.gateList,
    };
  }

  // ───────────────────────────── online host ─────────────────────────────

  /**
   * Everything the match said out loud since the last call, oldest first (see NetEvent): sounds, effects,
   * announcements, feed lines, camera kicks, rumble, hints, darts leaving and landing. Call it after every step and
   * send the events to the guests (`to` says which one an event is for; no `to` = everybody). Empty for local
   * play. Do not change the returned array.
   */
  drainEvents(): readonly NetEvent[] {
    return this.tap ? this.tap.take() : NO_EVENTS;
  }

  /** A dart landed: the guests' copy sticks to the boat, bounces off the shield, or (no pose to show) just ends. */
  private recordHit(h: DartHit): void {
    const tap = this.tap;
    if (!tap) return;
    if (h.blocked) {
      tap.push({ k: 'deflect', id: h.dartId, p: [h.point.x, h.point.y, h.point.z] });
      tap.push({ k: 'hit', boat: h.targetId, blocked: true, stun: 0 });
      return;
    }
    if (h.tip && h.quat) {
      tap.push({
        k: 'stick', id: h.dartId, boat: h.targetId,
        tip: [h.tip[0], h.tip[1], h.tip[2]], quat: [h.quat[0], h.quat[1], h.quat[2], h.quat[3]],
      });
    } else {
      tap.push({ k: 'kill', id: h.dartId });
    }
    tap.push({ k: 'hit', boat: h.targetId, blocked: false, stun: this.mode.stunSeconds });
  }

  /**
   * Everything a guest needs to draw the match right now: every boat, the sharks, the crates, the balloons and the
   * mode's numbers (scores, clock, race progress, teams, shark rules). Plain data, built fresh each call.
   */
  netSnapshot(seq: number): NetSnapshot {
    const boats: BoatNetState[] = [];
    for (let i = 0; i < this.boats.length; i++) boats.push(this.boatNet(this.boats[i]));
    let sharks: SharkNetState = [];
    try {
      sharks = this.sharks.netState();
    } catch (e) {
      reportError('sharks.netState', e);
    }
    let crates = 0;
    try {
      crates = this.pickups.netState();
    } catch (e) {
      reportError('pickups.netState', e);
    }
    let balloons: number[] | null = null;
    if (this.balloons) {
      try {
        balloons = this.balloons.netState();
      } catch (e) {
        reportError('balloons.netState', e);
      }
    }
    return { seq, t: this.t, boats, sharks, crates, balloons, hud: this.netHud() };
  }

  /** One boat's state for the snapshot (if the boat cannot say, a stand-in made from what every boat shows). */
  private boatNet(b: Boat): BoatNetState {
    try {
      return b.netState();
    } catch (e) {
      reportError(`boat[${b.id}].netState`, e);
    }
    return {
      x: b.position.x, z: b.position.z, heading: b.heading, vx: b.velocity.x, vz: b.velocity.z, steer: 0,
      boosting: b.boosting, shielded: b.shielded, stunned: b.stunned,
      powerUp: b.powerUp ? b.powerUp.kind : null, powerUpLeft: b.powerUp ? b.powerUp.timeLeft : 0,
      ammo: b.ammo, reloading: b.reloading, reloadProgress: b.reloadProgress, boost: b.boost,
      aimTargetId: b.aimTargetId, epoch: 0,
    };
  }

  /** What the mode shows on every HUD: scores, ranking, clocks, race progress, teams, balloons, shark rules. */
  private netHud(): NetHudState {
    const mode = this.mode;
    const scores: number[] = [];
    const nextGate: (number | null)[] = [];
    const race: (RaceHudInfo | null)[] | null = mode.id === 'race' ? [] : null;
    const ranking: number[] = [];
    const hud: NetHudState = {
      timeLeft: null, raceTime: null, ranking, scores, race, nextGate, teams: null, balloons: null, sharks: null,
    };
    try {
      for (let i = 0; i < this.boats.length; i++) {
        scores.push(mode.scoreOf(i));
        nextGate.push(mode.nextGate(i));
        if (race) race.push(mode.raceInfo(i));
      }
      for (let k = 0; k < mode.ranking.length; k++) ranking.push(mode.ranking[k].id);
      hud.timeLeft = mode.timeLeft();
      hud.raceTime = mode.raceTime();
      hud.teams = mode.teams();
      hud.balloons = mode.balloonCount();
      hud.sharks = mode.sharkHud();
    } catch (e) {
      reportError('netHud', e);
    }
    return hud;
  }

  // ───────────────────────────── cleanup ─────────────────────────────

  /** Release everything this match created. Safe to call twice. */
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
    safely('fx', () => this.rawFx.dispose());
    safely('world', () => this.world.dispose());
    safely('scene', () => disposeSceneResources(this.scene));
    this.boats.length = 0;
    this.cams.length = 0;
    this.players.length = 0;
    this.remotes.length = 0;
  }
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
