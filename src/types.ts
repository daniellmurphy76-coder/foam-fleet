/**
 * Foam Fleet: shared contracts.
 *
 * Every module codes against these interfaces. Do NOT change this file from a
 * module; if a contract is wrong, report it and work around it locally.
 *
 * Conventions (all modules):
 *  - Units are meters and seconds. Y is up. Water rest level is y = 0.
 *  - heading: radians about +Y. forward = (sin(heading), 0, cos(heading)).
 *    heading 0 faces +Z. Boat meshes are modeled with the bow toward local +Z,
 *    so `object.rotation.y = heading` points the bow forward.
 *  - steer +1 = turn to the driver's RIGHT, which DECREASES heading.
 *    (Facing +Z, the driver's right is -X.)
 *  - Colors are 0xRRGGBB numbers.
 *  - `t` is match time in seconds: monotonic, frozen while paused.
 */
import type * as THREE from 'three';

export type ModeId = 'battle' | 'race';
export type BotDifficulty = 'easy' | 'normal' | 'hard';
export type PowerUpKind = 'triple' | 'rapid' | 'shield' | 'turbo';

// ───────────────────────────── Controls ─────────────────────────────

export interface BoatControls {
  /** -1 (full reverse) .. 1 (full ahead) */
  throttle: number;
  /** -1 (hard left) .. 1 (hard right) */
  steer: number;
  /** true while the fire button is held */
  fire: boolean;
  /** true while the boost button is held */
  boost: boolean;
}

export interface ControllerContext {
  self: Boat;
  boats: readonly Boat[];
  world: World;
  mode: ModeId;
  t: number;
  /** Race: the gate this boat must pass next. null in battle or after finishing. */
  nextCheckpoint: Checkpoint | null;
  /** Race: the gate after that (for a smoother racing line). null when n/a. */
  followingCheckpoint: Checkpoint | null;
  /** Positions of power-up crates currently floating (may be empty). */
  pickups: readonly THREE.Vector3[];
}

export interface Controller {
  readonly kind: 'human' | 'bot';
  update(ctx: ControllerContext, dt: number): BoatControls;
}

/** System/UI buttons. Each flag is true only on the frame the button went down. */
export interface MenuInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  confirm: boolean;
  back: boolean;
  pause: boolean;
  mute: boolean;
}

export interface InputManager {
  /** Call once per frame, before reading controllers or `menu`. */
  poll(): void;
  /** Controller for human slot 0 or 1, given how many humans are playing. */
  humanController(slot: 0 | 1, humans: 1 | 2): Controller;
  /** Edge-triggered system buttons for this frame (all keyboards + all gamepads). */
  readonly menu: MenuInput;
  gamepadCount(): number;
  /** Best-effort gamepad rumble for a human slot; no-op without a gamepad. */
  rumble(slot: 0 | 1, humans: 1 | 2, strength: number, ms: number): void;
  dispose(): void;
}

// ───────────────────────────── World ─────────────────────────────

/** Circular obstacle on the XZ plane (islands, rocks, landmarks). */
export interface Obstacle {
  x: number;
  z: number;
  radius: number;
}

export interface SpawnPoint {
  x: number;
  z: number;
  heading: number;
}

export interface Checkpoint {
  /** Center of the gate at water level (y = 0). */
  position: THREE.Vector3;
  /** Direction boats travel through the gate (heading convention). */
  heading: number;
  /** Half the gate width: a boat within this XZ distance of `position` has passed it. */
  radius: number;
}

export interface WorldQuery {
  /** Water surface height at (x, z) at time t. MUST match the water shader's displacement. */
  waveHeight(x: number, z: number, t: number): number;
  /** Unit surface normal at (x, z, t), written into `out` and returned. */
  waveNormal(x: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3;
  readonly obstacles: readonly Obstacle[];
  /** Playable area is a circle of this radius around the origin. */
  readonly arenaRadius: number;
}

export interface World extends WorldQuery {
  /**
   * Race course gates in order. checkpoints[0] is the start/finish gate.
   * Always populated; gates are only VISIBLE when the world was created for 'race'.
   */
  readonly checkpoints: readonly Checkpoint[];
  /**
   * Battle: spread around the arena facing inward.
   * Race: a starting grid just BEHIND checkpoints[0], facing its heading.
   */
  spawnPoints(count: number, mode: ModeId): SpawnPoint[];
  /** Animate water, sky, props. */
  update(t: number, dt: number): void;
  dispose(): void;
}

export interface PickupEvent {
  boatId: number;
  kind: PowerUpKind;
  position: THREE.Vector3;
}

export interface Pickups {
  /** Positions of crates currently available (live references are fine). */
  readonly positions: readonly THREE.Vector3[];
  /** Bob/spin crates, respawn them, detect boat overlap. Returns crates collected this frame. */
  update(t: number, dt: number, boats: readonly Boat[]): PickupEvent[];
  clear(): void;
  dispose(): void;
}

// ───────────────────────────── Boats ─────────────────────────────

export interface BoatInit {
  id: number;
  name: string;
  color: number;
  isHuman: boolean;
  spawn: SpawnPoint;
  /** Hull variant, 0..2. */
  style: number;
}

export interface ActivePowerUp {
  kind: PowerUpKind;
  timeLeft: number;
}

export interface Boat {
  readonly id: number;
  readonly name: string;
  readonly color: number;
  readonly isHuman: boolean;
  /** Root object; the game adds it to the scene. The boat drives its transform. */
  readonly object: THREE.Object3D;
  /** Waterline reference point (x, surface height, z). Mutable in place by collision code. */
  readonly position: THREE.Vector3;
  /** Horizontal velocity (y always 0). Mutable in place by collision code. */
  readonly velocity: THREE.Vector3;
  heading: number;
  /** Signed speed along forward, m/s. */
  readonly speed: number;
  /** Collision circle radius on XZ for boat/obstacle/arena collisions. */
  readonly radius: number;
  /** Sphere radius for dart hits, centered at hitCenter(). */
  readonly hitRadius: number;

  readonly ammo: number;
  readonly maxAmmo: number;
  readonly reloading: boolean;
  /** 0..1 while reloading, else 1. */
  readonly reloadProgress: number;
  /** Boost meter 0..1. */
  readonly boost: number;
  readonly boosting: boolean;
  readonly powerUp: ActivePowerUp | null;
  readonly shielded: boolean;
  /** True briefly after being hit (reduced thrust, wobble). */
  readonly stunned: boolean;
  /** Boat currently inside the aim-assist cone (updated in update()), else null. */
  readonly aimTargetId: number | null;

  /** Physics, bobbing, timers, aim-assist target selection, visual animation. */
  update(controls: BoatControls, dt: number, t: number, world: WorldQuery, others: readonly Boat[]): void;
  /**
   * Fire if the blaster allows it (cooldown, ammo). Returns darts to spawn:
   * [] if not ready, 1 normally, 3 with 'triple'. Aims at aimTargetId when locked.
   */
  tryFire(t: number, others: readonly Boat[]): DartSpawn[];
  /** Center of the dart-hit sphere, written into `out` and returned. */
  hitCenter(out: THREE.Vector3): THREE.Vector3;
  /**
   * A dart hit this boat travelling in `direction` (unit vector).
   * Returns false if a shield absorbed it (shield is consumed; no stun, no score).
   */
  onHit(direction: THREE.Vector3, stunSeconds: number): boolean;
  applyPowerUp(kind: PowerUpKind): void;
  /** Teleport to spawn, zero velocity, clear stun/power-ups, refill ammo and boost. */
  respawn(spawn: SpawnPoint): void;
  dispose(): void;
}

export interface BumpEvent {
  aId: number;
  bId: number;
  /** Closing speed in m/s. */
  strength: number;
  point: THREE.Vector3;
}

// ───────────────────────────── Darts & FX ─────────────────────────────

export interface DartSpawn {
  origin: THREE.Vector3;
  /** Unit vector. */
  direction: THREE.Vector3;
  speed: number;
  ownerId: number;
}

export interface DartHit {
  ownerId: number;
  targetId: number;
  point: THREE.Vector3;
  direction: THREE.Vector3;
  /** true if the target's shield absorbed it. */
  blocked: boolean;
}

export interface DartUpdateResult {
  hits: DartHit[];
  /** Points where darts landed in the water this frame. */
  waterSplashes: THREE.Vector3[];
}

export interface DartSystem {
  spawn(spawn: DartSpawn): void;
  /**
   * Fly darts, collide with boats (never their owner), obstacles and water.
   * On a boat hit it calls target.onHit(direction, stunSeconds) and sticks the dart
   * to the boat (or bounces it off a shield).
   */
  update(dt: number, t: number, boats: readonly Boat[], world: WorldQuery, stunSeconds: number): DartUpdateResult;
  readonly activeCount: number;
  clear(): void;
  dispose(): void;
}

export interface Effects {
  splash(position: THREE.Vector3, size: number): void;
  hitBurst(position: THREE.Vector3, color: number): void;
  sparkle(position: THREE.Vector3, color: number): void;
  /** Call every frame per boat: spray + wake foam proportional to speed. */
  wake(boat: Boat): void;
  update(dt: number, t: number, world: WorldQuery): void;
  clear(): void;
  dispose(): void;
}

// ───────────────────────────── Audio ─────────────────────────────

export interface Sfx {
  /** Resume/create the AudioContext; call from a user gesture. Safe to call repeatedly. */
  unlock(): void;
  fire(): void;
  hit(): void;
  shieldBlock(): void;
  splash(volume?: number): void;
  bump(strength: number): void;
  pickup(): void;
  boost(): void;
  checkpoint(): void;
  lap(): void;
  countdown(n: number): void;
  go(): void;
  victory(): void;
  uiMove(): void;
  uiSelect(): void;
  /** Continuous engine hum per human boat; levels 0..1. Pass [] to silence. */
  setEngines(levels: number[]): void;
  setMusic(on: boolean): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
}

// ───────────────────────────── UI ─────────────────────────────

/** CSS pixels, origin top-left of the window. */
export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RaceHudInfo {
  lap: number;
  laps: number;
  /** Gates passed this lap. */
  checkpoint: number;
  checkpoints: number;
  finished: boolean;
}

export interface PlayerHud {
  name: string;
  color: number;
  score: number;
  ammo: number;
  maxAmmo: number;
  reloading: boolean;
  reloadProgress: number;
  boost: number;
  powerUp: ActivePowerUp | null;
  shielded: boolean;
  /** 1-based placement among all boats. */
  rank: number;
  race: RaceHudInfo | null;
  /** Radians, 0 = straight up the screen, positive = clockwise. null hides the arrow. */
  arrow: number | null;
  /** Name of the boat the blaster is locked onto, or null. */
  lockedTarget: string | null;
}

export interface ScoreRow {
  id: number;
  name: string;
  color: number;
  score: number;
  isHuman: boolean;
}

export interface HudState {
  mode: ModeId;
  /** Seconds left (battle). null for race. */
  timeLeft: number | null;
  /** Elapsed race time in seconds (race), else null. */
  raceTime: number | null;
  /** One entry per human, same order as `viewports`. */
  players: PlayerHud[];
  viewports: Viewport[];
  /** All boats, best first. */
  scoreboard: ScoreRow[];
}

export interface ResultRow extends ScoreRow {
  place: number;
  /** e.g. "12 hits" or "2:14.3" or "DNF". */
  detail: string;
}

export interface MatchResult {
  mode: ModeId;
  rows: ResultRow[];
  /** Headline, e.g. "Sam wins!" */
  title: string;
}

export interface Hud {
  show(): void;
  hide(): void;
  update(state: HudState): void;
  /** Big centered text (countdown, "SPLAT!", "FINAL LAP"). viewport = index into players; omit for all. */
  announce(text: string, opts?: { sub?: string; ms?: number; viewport?: number }): void;
  /** Short message in the event feed ("Sam tagged Salty Sal!"). */
  feed(text: string, color?: number): void;
  showPause(onResume: () => void, onQuit: () => void): void;
  hidePause(): void;
  showResults(result: MatchResult, onRematch: () => void, onMenu: () => void): void;
  hideResults(): void;
  /** Route keyboard/gamepad navigation into whichever overlay (pause/results) is open. */
  handleMenuInput(input: MenuInput): void;
}

export interface MatchSetup {
  mode: ModeId;
  humans: 1 | 2;
  bots: number;
  botDifficulty: BotDifficulty;
  /** Length === humans. */
  players: { name: string; color: number }[];
  /** Battle length. */
  durationSec: number;
  /** Race laps. */
  laps: number;
}

export interface Menu {
  /** Show the title/setup screens, prefilled with `initial` (or defaults). */
  show(initial: MatchSetup | null, onStart: (setup: MatchSetup) => void): void;
  hide(): void;
  /** Feed keyboard/gamepad navigation each frame while visible. */
  update(input: MenuInput): void;
  readonly visible: boolean;
}
