/**
 * Stand-ins for the other modules.
 *
 * They are used in two ways:
 *  1. "quiet" versions (no sound, no HUD) power the demo lagoon behind the title screen.
 *  2. If a real module throws while being created (still a stub, or a bug), the game
 *     swaps in one of these so the loop keeps running. The failure is still recorded
 *     in `__foam.errors` and `__foam.fallbacks`.
 *
 * Nothing here is meant to be fun to play; it only needs to be safe.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type {
  Boat, BoatControls, BoatInit, Checkpoint, Controller, DartSystem, DartUpdateResult, Effects, Hud,
  InputManager, MatchSetup, Menu, MenuInput, ModeId, PickupEvent, Pickups, PowerUpKind, Sfx, SpawnPoint,
  World, ActivePowerUp, DartSpawn,
} from '../types';

const noop = (): void => {};

export const ZERO_CONTROLS: BoatControls = Object.freeze({ throttle: 0, steer: 0, fire: false, boost: false });

export const EMPTY_MENU: MenuInput = Object.freeze({
  up: false, down: false, left: false, right: false, confirm: false, back: false, pause: false, mute: false,
});

export function idleController(kind: 'human' | 'bot'): Controller {
  return { kind, update: () => ZERO_CONTROLS };
}

// ───────────────────────────── silent services ─────────────────────────────

export function quietSfx(): Sfx {
  let muted = false;
  return {
    unlock: noop, fire: noop, hit: noop, shieldBlock: noop, splash: noop, bump: noop, pickup: noop,
    boost: noop, checkpoint: noop, lap: noop, countdown: noop, go: noop, victory: noop,
    uiMove: noop, uiSelect: noop, setEngines: noop, setMusic: noop,
    setMuted: (m: boolean) => { muted = m; },
    get muted() { return muted; },
  };
}

export function quietFx(): Effects {
  return { splash: noop, hitBurst: noop, sparkle: noop, wake: noop, update: noop, clear: noop, dispose: noop };
}

export function quietHud(): Hud {
  return {
    show: noop, hide: noop, update: noop, announce: noop, feed: noop, showPause: noop, hidePause: noop,
    showResults: noop, hideResults: noop, handleMenuInput: noop,
  };
}

// ───────────────────────────── bare-bones UI ─────────────────────────────

/** Minimal overlays so a match can still be left if the real HUD module is missing. */
export function fallbackHud(root: HTMLElement): Hud {
  let overlay: HTMLElement | null = null;
  const clear = (): void => { overlay?.remove(); overlay = null; };
  const panel = (title: string, buttons: [string, () => void][]): void => {
    clear();
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;color:#fff;font:700 28px system-ui,sans-serif;background:rgba(0,0,0,.45);pointer-events:auto';
    box.textContent = title;
    for (const [label, fn] of buttons) {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:700 22px system-ui,sans-serif;padding:10px 28px';
      b.onclick = fn;
      box.appendChild(b);
    }
    root.appendChild(box);
    overlay = box;
  };
  return {
    ...quietHud(),
    showPause: (onResume, onQuit) => panel('Paused', [['Resume', onResume], ['Quit', onQuit]]),
    hidePause: clear,
    showResults: (result, onRematch, onMenu) => panel(result.title, [['Rematch', onRematch], ['Menu', onMenu]]),
    hideResults: clear,
  };
}

export function fallbackMenu(root: HTMLElement, defaults: () => MatchSetup): Menu {
  let el: HTMLElement | null = null;
  const hide = (): void => { el?.remove(); el = null; };
  return {
    show(initial, onStart) {
      hide();
      const b = document.createElement('button');
      b.textContent = 'Play (menu module missing)';
      b.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:700 24px system-ui,sans-serif;padding:14px 28px;pointer-events:auto';
      b.onclick = () => onStart(initial ?? defaults());
      root.appendChild(b);
      el = b;
    },
    hide,
    update: noop,
    get visible() { return el !== null; },
  };
}

export function fallbackInput(): InputManager {
  const idle = idleController('human');
  return { poll: noop, humanController: () => idle, menu: EMPTY_MENU, gamepadCount: () => 0, rumble: noop, dispose: noop };
}

// ───────────────────────────── layout helpers ─────────────────────────────

/** A ring of gates around the lagoon, used only when the real world has no usable course. */
export function fallbackCheckpoints(): Checkpoint[] {
  const count = 8;
  const ringR = CONFIG.arena.radius * 0.55;
  const gates: Checkpoint[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    gates.push({
      position: new THREE.Vector3(Math.cos(a) * ringR, 0, Math.sin(a) * ringR),
      heading: -a, // travelling counter-clockwise around the ring
      radius: 9,
    });
  }
  return gates;
}

/** Spawn points laid out the way DESIGN.md describes, for when `world.spawnPoints` can't be trusted. */
export function fallbackSpawns(count: number, mode: ModeId, gates: readonly Checkpoint[]): SpawnPoint[] {
  const out: SpawnPoint[] = [];
  if (mode === 'race' && gates.length > 0) {
    const g = gates[0];
    const fx = Math.sin(g.heading), fz = Math.cos(g.heading);
    const rx = -Math.cos(g.heading), rz = Math.sin(g.heading); // driver's right
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -2 : 2;
      const back = 6 + 6 * row;
      out.push({
        x: g.position.x - fx * back + rx * side,
        z: g.position.z - fz * back + rz * side,
        heading: g.heading,
      });
    }
    return out;
  }
  const r = CONFIG.arena.radius * 0.55;
  for (let i = 0; i < count; i++) {
    const a = (i / Math.max(1, count)) * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    out.push({ x, z, heading: Math.atan2(-x, -z) }); // facing the middle
  }
  return out;
}

// ───────────────────────────── world, pickups, darts ─────────────────────────────

/** A flat blue disc with sun and sky. Enough to see boats on. */
export function fallbackWorld(scene: THREE.Scene, mode: ModeId): World {
  const R = CONFIG.arena.radius;
  scene.background = new THREE.Color(0x9fdcff);
  scene.fog = new THREE.Fog(0x9fdcff, 150, 700);
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(R * 3, 48),
    new THREE.MeshStandardMaterial({ color: 0x2aa6c9, flatShading: true }),
  );
  water.rotation.x = -Math.PI / 2;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x4488aa, 1.2);
  const sun = new THREE.DirectionalLight(0xfff2cc, 1.6);
  sun.position.set(60, 100, 40);
  scene.add(water, hemi, sun);

  const checkpoints = fallbackCheckpoints();
  return {
    checkpoints,
    obstacles: [],
    arenaRadius: R,
    waveHeight: () => 0,
    waveNormal: (_x, _z, _t, out) => out.set(0, 1, 0),
    spawnPoints: (count, m) => fallbackSpawns(count, m ?? mode, checkpoints),
    update: noop,
    dispose() {
      scene.remove(water, hemi, sun);
      water.geometry.dispose();
      (water.material as THREE.Material).dispose();
      hemi.dispose();
      sun.dispose();
    },
  };
}

const NO_EVENTS: PickupEvent[] = [];
export function fallbackPickups(): Pickups {
  return { positions: [], update: () => NO_EVENTS, clear: noop, dispose: noop };
}

const NO_DART_RESULT: DartUpdateResult = { hits: [], waterSplashes: [] };
export function fallbackDarts(): DartSystem {
  return { spawn: noop, update: () => NO_DART_RESULT, activeCount: 0, clear: noop, dispose: noop };
}

// ───────────────────────────── a plain box boat ─────────────────────────────

/** A coloured box that drives. No darts, no polish. */
class FallbackBoat implements Boat {
  readonly object = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  heading: number;
  speed = 0;
  readonly radius = CONFIG.boat.radius;
  readonly hitRadius = CONFIG.boat.hitRadius;
  readonly ammo = CONFIG.blaster.magazine;
  readonly maxAmmo = CONFIG.blaster.magazine;
  readonly reloading = false;
  readonly reloadProgress = 1;
  readonly boost = 1;
  boosting = false;
  readonly powerUp: ActivePowerUp | null = null;
  readonly shielded = false;
  readonly stunned = false;
  readonly aimTargetId: number | null = null;

  readonly id: number;
  readonly name: string;
  readonly color: number;
  readonly isHuman: boolean;
  private readonly hull: THREE.Mesh;

  constructor(init: BoatInit) {
    this.id = init.id;
    this.name = init.name;
    this.color = init.color;
    this.isHuman = init.isHuman;
    this.heading = init.spawn.heading;
    this.hull = new THREE.Mesh(
      new THREE.BoxGeometry(2, 0.9, 4.5),
      new THREE.MeshStandardMaterial({ color: init.color, flatShading: true }),
    );
    this.hull.position.y = 0.45;
    this.object.add(this.hull);
    this.respawn(init.spawn);
  }

  update(controls: BoatControls, dt: number, t: number, world: { arenaRadius: number; waveHeight(x: number, z: number, t: number): number }): void {
    const c = CONFIG.boat;
    this.boosting = controls.boost;
    const top = controls.throttle >= 0 ? (controls.boost ? c.boostSpeed : c.maxSpeed) : c.reverseSpeed;
    this.speed += (controls.throttle * top - this.speed) * Math.min(1, dt * 2);
    this.heading -= controls.steer * c.turnRate * dt * Math.min(1, Math.abs(this.speed) / 6 + 0.3);
    this.velocity.set(Math.sin(this.heading) * this.speed, 0, Math.cos(this.heading) * this.speed);
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    const d = Math.hypot(this.position.x, this.position.z);
    const edge = world.arenaRadius - 3;
    if (d > edge) {
      this.position.x *= edge / d;
      this.position.z *= edge / d;
    }
    this.position.y = world.waveHeight(this.position.x, this.position.z, t);
    this.object.position.copy(this.position);
    this.object.rotation.y = this.heading;
  }

  tryFire(): DartSpawn[] { return []; }
  hitCenter(out: THREE.Vector3): THREE.Vector3 { return out.set(this.position.x, this.position.y + 0.8, this.position.z); }
  onHit(): boolean { return true; }
  applyPowerUp(_kind: PowerUpKind): void {}

  respawn(spawn: SpawnPoint): void {
    this.position.set(spawn.x, 0, spawn.z);
    this.velocity.set(0, 0, 0);
    this.heading = spawn.heading;
    this.speed = 0;
    this.object.position.copy(this.position);
    this.object.rotation.y = this.heading;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.hull.geometry.dispose();
    (this.hull.material as THREE.Material).dispose();
  }
}

export function fallbackBoat(init: BoatInit): Boat {
  return new FallbackBoat(init);
}
