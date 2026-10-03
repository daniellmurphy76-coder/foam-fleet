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

/**
 * battle   = every boat for itself, tag for points.
 * race     = laps through gates.
 * team     = Team Up: humans (+ helper bots) vs. a bot team, tag for team points.
 * practice = Balloon Pop: no bots; pop balloons by darting or ramming them.
 * World and pickups treat every mode except 'race' like 'battle' unless stated otherwise.
 */
export type ModeId = 'battle' | 'race' | 'team' | 'practice';
export type BotDifficulty = 'easy' | 'normal' | 'hard';
export type PowerUpKind = 'triple' | 'rapid' | 'shield' | 'turbo';

// ───────────────────────────── Boat looks (Garage) ─────────────────────────────

export type PatternId = 'solid' | 'stripes' | 'flames' | 'dots' | 'shark';
export type HatId = 'captain' | 'pirate' | 'crown' | 'cowboy' | 'propeller' | 'none';
export type FlagId = 'none' | 'star' | 'heart' | 'skull' | 'lightning' | 'smile';
export type HornId = 'beep' | 'duck' | 'foghorn' | 'clown';

export interface BoatLook {
  /** Hull variant: 0 sleek speedboat, 1 chunky tug, 2 catamaran. */
  hull: number;
  pattern: PatternId;
  hat: HatId;
  flag: FlagId;
  horn: HornId;
}

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
  /** true while the rescue button is held (the game core acts on the press, with a cooldown) */
  rescue: boolean;
  /** true while the honk button is held (the game core acts on the press) */
  honk: boolean;
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
  /** What a human slot is driving with right now (for on-screen hints). */
  schemeOf(slot: 0 | 1, humans: 1 | 2): 'keysA' | 'keysB' | 'gamepad';
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
  /** Team Up: side A spawns on one side of the arena, side B on the opposite side, all facing in. */
  teamSpawnPoints(countA: number, countB: number): [SpawnPoint[], SpawnPoint[]];
  /**
   * Rescue: the nearest open-water spot to (x, z), clear of every obstacle by at least 4 m and
   * inside arenaRadius - 8 m. Faces `heading` if the water ahead is open for 20 m, otherwise
   * faces away from the nearest obstacle.
   */
  safeSpot(x: number, z: number, heading: number): SpawnPoint;
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

export interface BalloonPop {
  targetId: number;
  boatId: number;
  position: THREE.Vector3;
  /** Points: 1 for a normal balloon, 3 for a gold one. */
  value: number;
  color: number;
}

/** Balloon Pop targets: bunches of balloons tied to little floats around the lagoon. */
export interface Balloons {
  /** Every balloon (popped ones have alive = false). Pass to DartSystem.update as targets. */
  readonly targets: readonly DartTarget[];
  readonly total: number;
  readonly remaining: number;
  /** Bob and sway; pop balloons a boat drives through. Returns pops this frame. */
  update(t: number, dt: number, boats: readonly Boat[]): BalloonPop[];
  /** Pop one by dart. Returns null if it was already popped. */
  pop(targetId: number, boatId: number): BalloonPop | null;
  dispose(): void;
}

// ───────────────────────────── Boats ─────────────────────────────

export interface BoatInit {
  id: number;
  name: string;
  color: number;
  isHuman: boolean;
  spawn: SpawnPoint;
  look: BoatLook;
  /** Boats on the same team never hit or aim at each other. Free-for-all: team = id. */
  team: number;
  /** Color of a small floating diamond above the boat (Team Up), or null for none. */
  marker: number | null;
  /** Kid-friendly handling (DESIGN.md "Easy Driving"). */
  easyDriving: boolean;
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
  readonly team: number;
  readonly easyDriving: boolean;
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
  /** Rescue: move to `spot`, zero velocity and stun; KEEP ammo, boost and power-ups. */
  teleport(spot: SpawnPoint): void;
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

/** Something other than a boat that a dart can pop (Balloon Pop balloons). */
export interface DartTarget {
  readonly id: number;
  readonly position: THREE.Vector3;
  readonly radius: number;
  readonly alive: boolean;
}

export interface DartTargetHit {
  ownerId: number;
  targetId: number;
  point: THREE.Vector3;
}

export interface DartUpdateResult {
  hits: DartHit[];
  /** Non-boat targets hit this frame (each such dart is used up). */
  targetHits: DartTargetHit[];
  /** Points where darts landed in the water this frame. */
  waterSplashes: THREE.Vector3[];
}

export interface DartSystem {
  spawn(spawn: DartSpawn): void;
  /**
   * Fly darts and collide them with boats, optional extra `targets` (alive ones only),
   * obstacles and water. Darts never hit their owner and pass straight through the owner's
   * teammates (same `team`). On a boat hit it calls target.onHit(direction, stunSeconds) and
   * sticks the dart to the boat (or bounces it off a shield).
   */
  update(
    dt: number,
    t: number,
    boats: readonly Boat[],
    world: WorldQuery,
    stunSeconds: number,
    targets?: readonly DartTarget[],
  ): DartUpdateResult;
  readonly activeCount: number;
  clear(): void;
  dispose(): void;
}

export interface Effects {
  splash(position: THREE.Vector3, size: number): void;
  hitBurst(position: THREE.Vector3, color: number): void;
  sparkle(position: THREE.Vector3, color: number): void;
  /** Balloon pop: rubbery shreds and confetti in the balloon color. */
  pop(position: THREE.Vector3, color: number): void;
  /** Honk: a few cartoon music notes float up from the boat. */
  notes(position: THREE.Vector3, color: number): void;
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
  pop(): void;
  honk(horn: HornId): void;
  rescue(): void;
  /** Little fanfare when a trophy is earned. */
  trophy(): void;
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
  /** Battle: hits. Team Up: this player's own hits. Balloon Pop: balloon points. Race: laps done. */
  score: number;
  ammo: number;
  maxAmmo: number;
  reloading: boolean;
  reloadProgress: number;
  boost: number;
  powerUp: ActivePowerUp | null;
  shielded: boolean;
  /** 1-based placement among all boats (Team Up: among all boats by own hits). */
  rank: number;
  race: RaceHudInfo | null;
  /** Radians, 0 = straight up the screen, positive = clockwise. null hides the arrow. */
  arrow: number | null;
  /** Name of the boat the blaster is locked onto, or null. */
  lockedTarget: string | null;
  /** This player's boat id and team (for the mini-map). */
  boatId: number;
  team: number;
  /** Camera heading (heading convention) so the mini-map can turn "forward = up". */
  viewHeading: number;
  /** Race: index into map.gates of this player's next gate, else null. */
  nextGate: number | null;
  easyDriving: boolean;
}

export interface ScoreRow {
  id: number;
  name: string;
  color: number;
  score: number;
  isHuman: boolean;
  team: number;
}

export interface TeamScore {
  team: number;
  name: string;
  color: number;
  score: number;
}

export interface MapBoat {
  id: number;
  x: number;
  z: number;
  heading: number;
  color: number;
  isHuman: boolean;
  team: number;
}

/** Everything the mini-map draws, in world XZ meters. */
export interface MapState {
  arenaRadius: number;
  /** Same array reference for the whole match: cache static drawing by identity. */
  obstacles: readonly Obstacle[];
  boats: readonly MapBoat[];
  /** Available power-up crates. */
  pickups: readonly THREE.Vector3[];
  /** Balloon Pop: balloons still floating (gold = worth 3). Empty otherwise. */
  balloons: readonly { x: number; z: number; gold: boolean }[];
  /** Race gates in order (empty in other modes). */
  gates: readonly Checkpoint[];
}

export interface HudState {
  mode: ModeId;
  /** Seconds left (battle, team). null for race and practice. */
  timeLeft: number | null;
  /** Elapsed seconds (race, practice), else null. */
  raceTime: number | null;
  /** One entry per human, same order as `viewports`. */
  players: PlayerHud[];
  viewports: Viewport[];
  /** All boats, best first. */
  scoreboard: ScoreRow[];
  /** Team Up: both teams (humans' team first). null otherwise. */
  teams: TeamScore[] | null;
  /** Balloon Pop: how many balloons are left. null otherwise. */
  balloons: { remaining: number; total: number } | null;
  map: MapState;
}

export interface ResultRow extends ScoreRow {
  place: number;
  /** e.g. "12 hits", "2:14.3", "Lap 2 · Gate 5/9", "9 balloons". */
  detail: string;
}

/** What one human did this match: the input for trophies. */
export interface PlayerMatchStats {
  name: string;
  color: number;
  slot: number;
  mode: ModeId;
  /** 1-based place among all boats (Team Up: by own hits). */
  place: number;
  /** Won the match (Team Up: their team won; Balloon Pop: popped the most, or the only player). */
  won: boolean;
  /** Race: crossed the finish line. */
  finished: boolean;
  hits: number;
  /** Tags on the OTHER human player. */
  tagsOnOtherHuman: number;
  timesTagged: number;
  balloons: number;
  boostSeconds: number;
  pickups: number;
  honks: number;
  rescues: number;
  /** Race / Balloon Pop: seconds to finish, else null. */
  finishTime: number | null;
  easyDriving: boolean;
}

export interface TrophyDef {
  id: string;
  name: string;
  /** One kid-readable sentence: how to earn it. */
  description: string;
  /** A single emoji. */
  icon: string;
}

export interface TrophyAward {
  playerName: string;
  color: number;
  trophy: TrophyDef;
}

export interface MatchResult {
  mode: ModeId;
  rows: ResultRow[];
  /** Headline, e.g. "Sam wins!" or "Splash Squad wins!" */
  title: string;
  /** Team Up: final team scores (winner first), else null. */
  teams: TeamScore[] | null;
  stats: PlayerMatchStats[];
  /** Trophies earned for the FIRST time this match (already saved). */
  awards: TrophyAward[];
}

export interface Hud {
  show(): void;
  hide(): void;
  update(state: HudState): void;
  /** Big centered text (countdown, "SPLAT!", "FINAL LAP"). viewport = index into players; omit for all. */
  announce(text: string, opts?: { sub?: string; ms?: number; viewport?: number }): void;
  /** Friendly coaching line near the bottom of one player's view ("Press R to get unstuck!"). */
  hint(text: string, viewport: number, ms?: number): void;
  /** Short message in the event feed ("Sam tagged Salty Sal!"). */
  feed(text: string, color?: number): void;
  showPause(onResume: () => void, onQuit: () => void): void;
  hidePause(): void;
  showResults(result: MatchResult, onRematch: () => void, onMenu: () => void): void;
  hideResults(): void;
  /** Route keyboard/gamepad navigation into whichever overlay (pause/results) is open. */
  handleMenuInput(input: MenuInput): void;
}

export interface PlayerSetup {
  name: string;
  color: number;
  look: BoatLook;
  easyDriving: boolean;
}

export interface MatchSetup {
  mode: ModeId;
  humans: 1 | 2;
  /** Computer boats. Team Up: total bots, split between the two teams. Balloon Pop: always 0. */
  bots: number;
  botDifficulty: BotDifficulty;
  /** Length === humans. */
  players: PlayerSetup[];
  /** Battle / Team Up length. */
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
