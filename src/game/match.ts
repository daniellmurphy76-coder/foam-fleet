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
  Boat, BoatControls, BoatInit, BumpEvent, Controller, ControllerContext, DartHit, DartSystem,
  DartSpawn, DartUpdateResult, Effects, Hud, InputManager, MatchSetup, PickupEvent, Pickups, PowerUpKind, Sfx,
  SpawnPoint, World,
} from '../types';
import { ChaseCamera } from './cameras';
import { foam, reportError } from './debug';
import {
  ZERO_CONTROLS, fallbackBoat, fallbackDarts, fallbackPickups, fallbackSpawns, fallbackWorld, idleController, quietFx,
} from './fallbacks';
import { buildOrFallback, guard } from './guard';
import {
  createBoat, createBotController, createDartSystem, createEffects, createPickups, createWorld, resolveBoatCollisions,
} from './modules';
import { BattleMode } from './modes/battle';
import type { GameMode, GateTargets, ModeHost } from './modes/mode';
import { RaceMode } from './modes/race';
import { clamp } from './util';

/** The simulation always advances in slices of this many seconds. */
export const STEP = 1 / 60;

export interface MatchServices {
  hud: Hud;
  sfx: Sfx;
  input: InputManager;
}

const NO_POSITIONS: readonly THREE.Vector3[] = [];
const NO_BUMPS: BumpEvent[] = [];
const NO_PICKUPS: PickupEvent[] = [];
const NO_DARTS: DartUpdateResult = { hits: [], waterSplashes: [] };

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

export class Match implements ModeHost {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly pickups: Pickups;
  readonly darts: DartSystem;
  readonly fx: Effects;
  readonly hud: Hud;
  readonly sfx: Sfx;
  readonly mode: GameMode;
  /** Humans are boats 0..humanCount-1; computer boats follow. */
  readonly boats: Boat[] = [];
  /** One chase camera per human, same order as the boats. */
  readonly cams: ChaseCamera[] = [];
  readonly humanCount: number;

  /** Match time in seconds. Runs during the countdown too (so the water moves); frozen while paused. */
  t = 0;
  /** Total dart hits that landed (not counting shield blocks). */
  hits = 0;

  private readonly input: InputManager;
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
    this.pickups = buildOrFallback('createPickups', () => createPickups(scene, this.world, modeId), fallbackPickups);
    this.fx = guard('fx', buildOrFallback('createEffects', () => createEffects(scene), quietFx));
    this.darts = buildOrFallback('createDartSystem', () => createDartSystem(scene, this.fx), fallbackDarts);

    this.createBoats();
    this.mode = modeId === 'race' ? new RaceMode(this) : new BattleMode(this);

    for (let i = 0; i < this.humanCount; i++) {
      const cam = new ChaseCamera();
      cam.snap(this.boats[i], this.world, 0);
      this.cams.push(cam);
    }
  }

  slotOf(boatId: number): number {
    return boatId < this.humanCount ? boatId : -1;
  }

  // ───────────────────────────── setup ─────────────────────────────

  private createBoats(): void {
    const { setup } = this;
    const humans = this.humanCount;
    const bots = clamp(Math.round(setup.bots), 0, Math.max(0, CONFIG.match.maxBoats - humans));
    const total = humans + bots;
    const spawns = this.pickSpawns(total);

    // Computer boats get paint colors the humans did not pick.
    const used = new Set<number>();
    for (let i = 0; i < humans; i++) used.add(setup.players[i]?.color ?? -1);
    const freeColors = CONFIG.colors.filter((c) => !used.has(c));

    for (let i = 0; i < total; i++) {
      const isHuman = i < humans;
      const botIndex = i - humans;
      const player = setup.players[i];
      const init: BoatInit = {
        id: i,
        name: isHuman ? player?.name || `Player ${i + 1}` : CONFIG.botNames[botIndex % CONFIG.botNames.length],
        color: isHuman
          ? player?.color ?? CONFIG.colors[i % CONFIG.colors.length]
          : freeColors.length > 0 ? freeColors[botIndex % freeColors.length] : CONFIG.colors[i % CONFIG.colors.length],
        isHuman,
        spawn: spawns[i],
        style: i % 3,
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
      this.firing[i] = driven && c.fire === true;
      try {
        boat.update(c, dt, t, this.world, this.others[i]);
      } catch (e) {
        reportError(`boat[${i}].update`, e);
      }
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

    // 4. Darts fly; apply what they hit.
    let flight = NO_DARTS;
    try {
      flight = this.darts.update(dt, t, boats, this.world, mode.stunSeconds);
    } catch (e) {
      reportError('darts.update', e);
    }
    this.onHits(flight.hits, rulesOn);
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
      const verb = TAG_VERBS[this.tagCount++ % TAG_VERBS.length];
      this.hud.feed(`${shooter.name} ${verb} ${target.name}!`, shooter.color);
      if (shooterSlot >= 0 && mode.id === 'battle') {
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
        const label = POWER_NAMES[e.kind] ?? String(e.kind);
        this.hud.feed(`${boat.name} grabbed ${label}!`, boat.color);
        this.hud.announce(`${label.toUpperCase()}!`, { ms: 900, viewport: slot });
      }
    }
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
    for (const boat of this.boats) safely('boat', () => boat.dispose());
    safely('fx', () => this.fx.dispose());
    safely('world', () => this.world.dispose());
    safely('scene', () => disposeSceneResources(this.scene));
    this.boats.length = 0;
    this.cams.length = 0;
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
