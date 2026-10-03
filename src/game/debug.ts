/**
 * Debug and test hooks. `window.__foam` is how the orchestrator (and you, in the
 * browser console) can poke the running game:
 *
 *   __foam.timeScale = 8      fast-forward the simulation
 *   __foam.autopilot = true   human boats are driven by the computer
 *   __foam.snapshot()         a plain-object picture of the match right now
 *   __foam.errors             everything that threw, collected instead of crashing the game
 *
 * Extra helpers: start(setup?), menu(), pause(), resume().
 * URL params that start a match with no menu: ?quick=battle|race|team|practice|sharks&humans=1|2&bots=N&difficulty=easy|normal|hard
 * (also &easy=0|1 for Easy Driving, &duration=SECONDS, &laps=N, &autopilot=1, &timescale=N, &nopause=1, &fps=1,
 * &mute=1 for a silent page load that is never saved).
 */
import type { MatchSetup, ModeId, SharkHud } from '../types';

export interface FoamBoatSnapshot {
  id: number;
  name: string;
  x: number;
  z: number;
  heading: number;
  speed: number;
  score: number;
  ammo: number;
  stunned: boolean;
  boost: number;
  shielded: boolean;
  /** Team Up: 0 = the humans' side. Boats vs. Sharks: 0 for everyone. Otherwise the boat id. */
  team: number;
  /** Easy Driving handling on? */
  easy: boolean;
  powerUp: string | null;
  /** Race only. */
  lap: number | null;
  gate: number | null;
  finished: boolean | null;
}

/** What one human has done so far this match (the numbers behind the trophies). */
export interface FoamHumanSnapshot {
  slot: number;
  hits: number;
  tagsOnOtherHuman: number;
  timesTagged: number;
  balloons: number;
  boostSeconds: number;
  pickups: number;
  honks: number;
  rescues: number;
  /** Sharks scared off with darts, and bumps taken from sharks. */
  sharkTags: number;
  sharkBumps: number;
}

export interface FoamSnapshot {
  state: string;
  t: number;
  fps: number;
  mode: ModeId | null;
  boats: FoamBoatSnapshot[];
  darts: number;
  hits: number;
  errors: string[];
  /** Battle: seconds left. */
  timeLeft: number | null;
  /** Race and Balloon Pop: elapsed seconds. */
  raceTime: number | null;
  /** Balloon Pop: balloons left and in total. */
  balloons: { remaining: number; total: number } | null;
  /** Team Up: both teams' scores (humans' team first). */
  teams: { team: number; name: string; color: number; score: number }[] | null;
  /**
   * The sharks in the lagoon right now (every mode): wave sharks not yet tagged, the MEGA SHARK's health while
   * it is out, and how many live sharks can be hit.
   */
  sharks: { waveLeft: number; mega: { health: number; maxHealth: number } | null; count: number } | null;
  /** Boats vs. Sharks only: wave, sharks left, life rings, MEGA health, between waves? (what the HUD banner shows). */
  sharkRules: SharkHud | null;
  /** One entry per human. */
  humans: FoamHumanSnapshot[];
  /** Modules whose real implementation threw at creation and were replaced by a stand-in. */
  fallbacks: string[];
  /** On-screen touch controls in use right now (input.touchActive). */
  touchActive: boolean;
  /** Is the sound muted right now (sfx.muted)? */
  muted: boolean;
  /** Renderer stats, handy for spotting leaks (these should not climb across rematches). */
  render: { calls: number; triangles: number; geometries: number; textures: number } | null;
}

export interface FoamDebug {
  state: string;
  timeScale: number;
  autopilot: boolean;
  snapshot(): FoamSnapshot;
  errors: string[];
  fallbacks: string[];
  start(setup?: Partial<MatchSetup>): void;
  menu(): void;
  pause(): void;
  resume(): void;
  /** Run n simulation steps + draws synchronously (GPU-synced); returns ms per frame. */
  bench(n?: number): { stepMs: number; drawMs: number };
}

declare global {
  interface Window {
    __foam?: FoamDebug;
  }
}

function emptySnapshot(): FoamSnapshot {
  return {
    state: foam.state, t: 0, fps: 0, mode: null, boats: [], darts: 0, hits: 0,
    errors: foam.errors.slice(), timeLeft: null, raceTime: null, balloons: null, teams: null, sharks: null,
    sharkRules: null, humans: [],
    fallbacks: foam.fallbacks.slice(), touchActive: false, muted: false, render: null,
  };
}

/** The one shared debug object. The app fills in the function bodies at boot. */
export const foam: FoamDebug = {
  state: 'boot',
  timeScale: 1,
  autopilot: false,
  errors: [],
  fallbacks: [],
  snapshot: emptySnapshot,
  start: () => {},
  menu: () => {},
  pause: () => {},
  resume: () => {},
  bench: () => ({ stepMs: 0, drawMs: 0 }),
};

const MAX_ERRORS = 100;
const seen = new Map<string, { index: number; count: number }>();

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Record a problem without stopping the game. Repeats of the same message are
 * counted ("... (x240)") so one broken module can't flood the list.
 */
export function reportError(label: string, err: unknown): void {
  const text = `${label}: ${describe(err)}`;
  const known = seen.get(text);
  if (known && known.index < foam.errors.length) {
    known.count++;
    foam.errors[known.index] = `${text} (x${known.count})`;
    return;
  }
  if (foam.errors.length >= MAX_ERRORS) return;
  seen.set(text, { index: foam.errors.length, count: 1 });
  foam.errors.push(text);
  console.error(`[foam] ${label}`, err);
}

/** Collect uncaught errors and unhandled promise rejections too. */
export function installErrorCapture(): void {
  window.addEventListener('error', (ev) => {
    const file = ev.filename ? ev.filename.split('/').pop() : '';
    const where = file ? ` @ ${file}:${ev.lineno}` : '';
    reportError('window.onerror', `${ev.message}${where}`);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    reportError('unhandledrejection', ev.reason);
  });
}
