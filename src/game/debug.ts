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
 * URL params that start a match with no menu: ?quick=battle|race&humans=1|2&bots=N&difficulty=easy|normal|hard
 * (also &duration=SECONDS, &laps=N, &autopilot=1, &timescale=N, &nopause=1, &fps=1).
 */
import type { MatchSetup, ModeId } from '../types';

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
  powerUp: string | null;
  /** Race only. */
  lap: number | null;
  gate: number | null;
  finished: boolean | null;
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
  /** Race: elapsed seconds. */
  raceTime: number | null;
  /** Modules whose real implementation threw at creation and were replaced by a stand-in. */
  fallbacks: string[];
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
    errors: foam.errors.slice(), timeLeft: null, raceTime: null, fallbacks: foam.fallbacks.slice(), render: null,
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
