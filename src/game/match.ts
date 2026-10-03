/**
 * One match: its own Three.js scene, world, boats, darts and effects, plus the
 * fixed-step simulation that ties every module together.
 *
 * The app creates a Match when you press Start (and a quiet "attract" one behind the
 * title screen), steps it 60 times a second, and disposes it when you leave.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type {
  Balloons, BalloonPop, Boat, BoatControls, BoatInit, BumpEvent, Controller, ControllerContext, DartHit,
  DartSystem, DartSpawn, DartTargetHit, DartUpdateResult, Effects, Hud, InputManager, MapBoat, MapState,
  MatchResult, MatchSetup, ModeId, Obstacle, PickupEvent, Pickups, PlayerMatchStats, PowerUpKind, Sfx, SpawnPoint,
  TrophyAward, World,
} from '../types';
import { ChaseCamera } from './cameras';
import { foam, reportError } from './debug';
import {
  ZERO_CONTROLS, fallbackBalloons, fallbackBoat, fallbackDarts, fallbackPickups, fallbackSpawns,
  fallbackTeamSpawns, fallbackWorld, idleController, quietFx,
} from './fallbacks';
import { V2_METHODS, buildOrFallback, guard } from './guard';
import {
  awardTrophies, createBalloons, createBoat, createBotController, createDartSystem, createEffects, createPickups,
  createWorld, resolveBoatCollisions,
} from './modules';
import { BattleMode } from './modes/battle';
import type { GameMode, GateTargets, ModeHost } from './modes/mode';
import { PracticeMode } from './modes/practice';
import { RaceMode } from './modes/race';
import { TeamMode } from './modes/team';
import { HumanPlayer, type PlayerHost } from './players';
import { botLook, sanitizeLook } from './setup';
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

const GOLD = 0xffd23f;

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
    default: return new BattleMode(host);
  }
}

export class Match implements ModeHost, PlayerHost {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly pickups: Pickups;
  readonly darts: DartSystem;
  readonly fx: Effects;
  readonly hud: Hud;
  readonly sfx: Sfx;
  readonly input: InputManager;
  readonly mode: GameMode;
  /** Balloon Pop's balloons; null in every other mode. */
  readonly balloons: Balloons | null;
  /** Humans are boats 0..humanCount-1; computer boats follow. */
  readonly boats: Boat[] = [];
  /** One chase camera per human, same order as the boats. */
  readonly cams: ChaseCamera[] = [];
  /** One per human: rescue, honk, hints and trophy stats. */
  readonly players: HumanPlayer[] = [];
  readonly humanCount: number;

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
  private tagCount = 0;
  private disposed = false;

  /**
   * `attract` = the quiet demo lagoon behind the title screen: no humans, no rules,
   * and the hud/sfx passed in should be the silent ones.
   */
  constructor(readonly setup: MatchSetup, services: MatchServices, readonly attract = false) {
    this.hud = services.hud;
    this.sfx = services.sfx;
    this.input = services.input;
    this.humanCount = attract ? 0 : setup.humans;
    const errDeg = CONFIG.bots.aimErrorDeg[setup.botDifficulty] ?? CONFIG.bots.aimErrorDeg.normal;
    this.botAimSigma = (errDeg * Math.PI) / 180;

    const scene = this.scene;
    const modeId = setup.mode;
    // Each module is built behind buildOrFallback so one broken builder cannot stop the match from starting.
    this.world = buildOrFallback('createWorld', () => createWorld(scene, modeId), () => fallbackWorld(scene, modeId));
    this.obstacles = this.world.obstacles;
    this.pickups = buildOrFallback('createPickups', () => createPickups(scene, this.world, modeId), fallbackPickups);
    this.fx = guard('fx', buildOrFallback('createEffects', () => createEffects(scene), quietFx), {}, V2_METHODS.fx);
    this.darts = buildOrFallback('createDartSystem', () => createDartSystem(scene, this.fx), fallbackDarts);
    this.balloons = modeId === 'practice'
      ? buildOrFallback('createBalloons', () => createBalloons(scene, this.world), () => fallbackBalloons(scene, this.world))
      : null;

    this.createBoats();
    this.mode = makeMode(modeId, this);

    for (let i = 0; i < this.humanCount; i++) {
      const boat = this.boats[i];
      const cam = new ChaseCamera(boat.easyDriving);
      cam.snap(boat, this.world, 0);
      this.cams.push(cam);
      this.players.push(new HumanPlayer(i, boat, sanitizeLook(setup.players[i]?.look, i).horn, this));
    }
  }

  slotOf(boatId: number): number {
    return boatId < this.humanCount ? boatId : -1;
  }

  // ───────────────────────────── setup ─────────────────────────────

  private createBoats(): void {
    const { setup } = this;
    const humans = this.humanCount;
    // Balloon Pop has no computer boats.
    const bots = setup.mode === 'practice' ? 0 : clamp(Math.round(setup.bots), 0, Math.max(0, CONFIG.match.maxBoats - humans));
    const total = humans + bots;
    // Team Up: team 0 = the humans plus enough helper bots to even the sides; team 1 = the other bots.
    // Boats are numbered humans, then helpers, then opponents, so each side is one run of ids.
    const teamMode = setup.mode === 'team';
    const allies = teamMode ? Math.min(bots, Math.max(0, Math.ceil(total / 2) - humans)) : 0;
    const sideA = humans + allies;
    const spawns = teamMode ? this.pickTeamSpawns(sideA, total - sideA) : this.pickSpawns(total);

    // Computer boats get paint colors the humans did not pick.
    const used = new Set<number>();
    for (let i = 0; i < humans; i++) used.add(setup.players[i]?.color ?? -1);
    const freeColors = CONFIG.colors.filter((c) => !used.has(c));

    for (let i = 0; i < total; i++) {
      const isHuman = i < humans;
      const botIndex = i - humans;
      const player = setup.players[i];
      const team = teamMode ? (i < sideA ? 0 : 1) : i;
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

      const controller = isHuman
        ? buildOrFallback('humanController', () => this.input.humanController(i as 0 | 1, setup.humans), () => idleController('human'))
        : buildOrFallback('createBotController', () => createBotController(setup.botDifficulty, i), () => idleController('bot'));
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
      });
    }
    // Each boat gets a list of everyone EXCEPT itself (for aim assist), built once.
    for (let i = 0; i < total; i++) this.others.push(this.boats.filter((b) => b !== this.boats[i]));
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
        boat.update(c, dt, t, this.world, this.others[i]);
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

    // 3. Anyone holding fire shoots (if their blaster is ready).
    for (let i = 0; i < n; i++) {
      if (!this.firing[i]) continue;
      try {
        const spawns = boats[i].tryFire(t, this.others[i]);
        if (spawns.length > 0) {
          // Players keep full aim assist; computer boats get a small random aim error.
          if (!boats[i].isHuman) this.wobbleBotAim(spawns);
          for (let k = 0; k < spawns.length; k++) this.darts.spawn(spawns[k]);
          this.onFired(boats[i], spawns.length);
        }
      } catch (e) {
        reportError(`boat[${i}].tryFire`, e);
      }
    }

    // 4. Darts fly; apply what they hit (boats, and in Balloon Pop the balloons).
    let flight = NO_DARTS;
    try {
      flight = this.darts.update(dt, t, boats, this.world, mode.stunSeconds, this.balloons?.targets);
    } catch (e) {
      reportError('darts.update', e);
    }
    this.onHits(flight.hits, rulesOn);
    if (this.balloons) this.updateBalloons(flight.targetHits, t, dt, rulesOn);
    let splashSounds = 0;
    for (let k = 0; k < flight.waterSplashes.length && splashSounds < 2; k++) {
      const p = flight.waterSplashes[k];
      if (this.nearHuman(p.x, p.z, 70)) {
        this.sfx.splash(0.35);
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

    // 7. Visuals: wakes, particles, water and sky.
    for (let i = 0; i < n; i++) this.fx.wake(boats[i]);
    this.fx.update(dt, t, this.world);
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

  /** Move the chase cameras. Runs once per rendered frame with real frame time. */
  updateCameras(dt: number): void {
    for (let i = 0; i < this.cams.length; i++) {
      try {
        this.cams[i].update(dt, this.boats[i], this.world, this.t);
      } catch (e) {
        reportError(`camera[${i}]`, e);
      }
    }
  }

  // ───────────────────────────── event handlers ─────────────────────────────

  private controllerFor(i: number): Controller {
    // Autopilot (a test hook): human boats are driven by an ordinary bot brain.
    if (foam.autopilot && this.boats[i].isHuman) {
      let pilot = this.autopilots[i];
      if (!pilot) {
        pilot = buildOrFallback('createBotController', () => createBotController('normal', 100 + i), () => idleController('bot'));
        this.autopilots[i] = pilot;
      }
      return pilot;
    }
    return this.ctrls[i];
  }

  /** Is any human boat within `range` meters of this spot? (Used so we only play sounds you could hear.) */
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

  private rumble(slot: number, strength: number, ms: number): void {
    this.input.rumble(slot as 0 | 1, this.setup.humans, strength, ms);
  }

  private onBump(b: BumpEvent): void {
    const a = this.boats[b.aId];
    const c = this.boats[b.bId];
    const slotA = a ? this.slotOf(a.id) : -1;
    const slotC = c ? this.slotOf(c.id) : -1;
    if (slotA >= 0 || slotC >= 0 || this.nearHuman(b.point.x, b.point.z, 40)) this.sfx.bump(b.strength);
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

  private onFired(boat: Boat, dartCount: number): void {
    const slot = this.slotOf(boat.id);
    if (slot >= 0) {
      this.sfx.fire();
      this.cams[slot].kick(dartCount > 1 ? 0.4 : 0.25);
    } else if (this.botFireGate <= 0 && this.nearHuman(boat.position.x, boat.position.z, 45)) {
      this.sfx.fire();
      this.botFireGate = 0.08; // keep a crowd of bots from turning into one long buzz
    }
  }

  private onHits(hits: readonly DartHit[], rulesOn: boolean): void {
    const mode = this.mode;
    for (let k = 0; k < hits.length; k++) {
      const h = hits[k];
      const shooter = this.boats[h.ownerId];
      const target = this.boats[h.targetId];
      if (!shooter || !target) continue;
      if (shooter.team === target.team) continue; // teammates never tag each other (the darts skip them already)
      const shooterSlot = this.slotOf(shooter.id);
      const targetSlot = this.slotOf(target.id);
      const audible = shooterSlot >= 0 || targetSlot >= 0 || this.nearHuman(h.point.x, h.point.z, 45);

      if (h.blocked) {
        if (audible) this.sfx.shieldBlock();
        if (targetSlot >= 0) {
          this.cams[targetSlot].shake(0.2);
          if (rulesOn) this.hud.feed(`${target.name}'s shield blocked it!`, target.color);
        }
        continue;
      }

      if (!this.attract) this.hits++;
      if (audible) this.sfx.hit();
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
      if (slot >= 0 || this.nearHuman(e.position.x, e.position.z, 40)) this.sfx.pickup();
      if (slot >= 0 && rulesOn) {
        this.players[slot].pickups++;
        const label = POWER_NAMES[e.kind] ?? String(e.kind);
        this.hud.feed(`${boat.name} grabbed ${label}!`, boat.color);
        this.hud.announce(`${label.toUpperCase()}!`, { ms: 900, viewport: slot });
      }
    }
  }

  // ───────────────────────────── balloons ─────────────────────────────

  /** Balloon Pop: pop what the darts hit, then whatever a boat drove through. Nothing pops outside the rules. */
  private updateBalloons(dartHits: readonly DartTargetHit[], t: number, dt: number, rulesOn: boolean): void {
    const balloons = this.balloons;
    if (!balloons) return;
    try {
      if (rulesOn) {
        for (let k = 0; k < dartHits.length; k++) {
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
    if (slot >= 0 || this.nearHuman(pop.position.x, pop.position.z, 60)) this.sfx.pop();
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
   */
  result(): MatchResult {
    if (this.cachedResult) return this.cachedResult;
    const base = this.mode.result();
    const stats = this.buildStats();
    let awards: TrophyAward[] = [];
    try {
      awards = awardTrophies(stats);
    } catch (e) {
      reportError('awardTrophies', e);
    }
    this.cachedResult = { ...base, stats, awards };
    return this.cachedResult;
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
    return {
      arenaRadius: this.world.arenaRadius,
      obstacles: this.obstacles,
      boats,
      pickups,
      balloons,
      gates: this.mode.gateList,
    };
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
    for (const boat of this.boats) safely('boat', () => boat.dispose());
    safely('fx', () => this.fx.dispose());
    safely('world', () => this.world.dispose());
    safely('scene', () => disposeSceneResources(this.scene));
    this.boats.length = 0;
    this.cams.length = 0;
    this.players.length = 0;
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
