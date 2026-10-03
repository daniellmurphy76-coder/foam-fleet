import './styles.css';
import './hud.css'; // v2 additions; must come after styles.css so it can refine it
import type {
  Hud,
  HudState,
  MatchResult,
  MenuInput,
  ModeId,
  PlayerHud,
  PowerUpKind,
  ResultRow,
  Sfx,
  TeamScore,
  Viewport,
} from '../types';
import { CONFIG } from '../config';
import { button, clamp, cssColor, el, guardActivationKeys, installUnlock, ordinal, svgNode } from './dom';
import { createMinimap } from './minimap';
import type { Minimap } from './minimap';

/** In-match overlay: per-player panels, mini-map, timer, team banner, Boats vs. Sharks banner, feed, pause and results screens. */

/** Event-feed lines on screen at once (newest on top, right under the timer). */
const FEED_MAX = 3;
/** One player in a race has the next-gate arrow under the timer, so the feed gets one line less room there. */
const FEED_MAX_1P_RACE = 2;
/** Ignore "confirm" for a moment after an overlay opens, so a kid mashing Fire can't skip the results. */
const RESULTS_ARM_MS = 900;
const PAUSE_ARM_MS = 250;
/** Trophy cards pop in this long after the results open (after the victory fanfare gets going), 0.3 s apart. */
const TROPHY_DELAY_MS = 1100;
const TROPHY_STAGGER_MS = 300;
/** Mini-map: a circle this tall as a share of the viewport, but never bigger / smaller than this (CSS px). */
const MAP_SHARE = 0.22;
const MAP_MAX_PX = 180;
const MAP_MIN_PX = 110;
/** Under touch controls the radar is smaller (and sits top-right, see hud.css): min(18% of the height, 140 px). */
const MAP_TOUCH_SHARE = 0.18;
const MAP_TOUCH_MAX_PX = 140;
const MAP_TOUCH_MIN_PX = 96;
const HINT_DEFAULT_MS = 4200;
/** The class the input module puts on <html> while on-screen touch controls are in use. */
const TOUCH_CLASS = 'ff-touch';
/** Boats vs. Sharks: the MEGA health bar is drawn as chunky blocks, one per point of health, up to this many. */
const MEGA_SEGS_MAX = 24;
/** Boats vs. Sharks: most life rings the banner draws (the game gives 12). */
const RINGS_MAX = 24;
/** Online: a connection line that says something is wrong gets the warning look (yellow, blinking dot). */
const NET_TROUBLE = /reconnect|lost|trouble|problem/i;
/** Online guests get no stats, so the "sharks won" look falls back on the headline the host wrote. */
const SHARKS_WIN_TITLE = /sharks win/i;

// ───────────── little pieces of art (all our own static markup) ─────────────

const DART_SVG = `<svg class="ff-dart" viewBox="0 0 16 46" aria-hidden="true">
  <rect x="3" y="15" width="10" height="27" rx="3" fill="#1e78ff" stroke="#06173d" stroke-width="2.5"/>
  <rect x="3" y="31" width="10" height="4" fill="#ffffff"/>
  <path d="M3 16 V11 C3 4 8 2 8 2 C8 2 13 4 13 11 V16 Z" fill="#ff8a1f" stroke="#06173d" stroke-width="2.5" stroke-linejoin="round"/>
</svg>`;

const RELOAD_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 5 a7 7 0 1 0 6.6 4.6" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
  <path d="M10 0.5 L17.5 5.2 L9.6 9.6 Z" fill="#ffffff"/>
</svg>`;

const ARROW_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true">
  <path d="M32 6 L55 40 H40 V58 H24 V40 H9 Z" fill="#ffd23f" stroke="#06173d" stroke-width="5" stroke-linejoin="round"/>
</svg>`;

const RETICLE_PATHS = `<circle cx="50" cy="50" r="26"/><path d="M50 6 V22 M50 78 V94 M6 50 H22 M78 50 H94"/>`;
const RETICLE_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <g class="ff-ret-back">${RETICLE_PATHS}</g>
  <g class="ff-ret-main">${RETICLE_PATHS}</g>
  <path class="ff-ret-lock" d="M18 34 V18 H34 M66 18 H82 V34 M82 66 V82 H66 M34 82 H18 V66"/>
</svg>`;

const SHIELD_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <path d="M16 3 L27 7 V16 C27 23 22 27 16 30 C10 27 5 23 5 16 V7 Z" fill="#ffffff" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
  <path d="M11 10 Q10 14 11 17" fill="none" stroke="#7fd4ff" stroke-width="3" stroke-linecap="round"/>
</svg>`;

const STAR_SVG = `<svg class="ff-trow-star" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 2 L14.8 8.6 L22 9.3 L16.6 14 L18.2 21 L12 17.4 L5.8 21 L7.4 14 L2 9.3 L9.2 8.6 Z" fill="#ffd23f" stroke="#0b2a5b" stroke-width="2" stroke-linejoin="round"/>
</svg>`;

const CROWN_SVG = `<svg class="ff-crown" viewBox="0 0 40 28" aria-hidden="true">
  <path d="M4 24 L2 6 L12 14 L20 3 L28 14 L38 6 L36 24 Z" fill="#ffd23f" stroke="#0b2a5b" stroke-width="3" stroke-linejoin="round"/>
</svg>`;

/** The shape that floats above every boat in Team Up; its color comes from `--tc` (see hud.css). */
const DIAMOND_SVG = `<svg class="ff-diamond" viewBox="0 0 20 20" aria-hidden="true">
  <path d="M10 1.5 L18.5 10 L10 18.5 L1.5 10 Z"/>
</svg>`;

const CROWN_MINI_SVG = `<svg class="ff-team-crown" viewBox="0 0 40 28" aria-hidden="true">
  <path d="M4 24 L2 6 L12 14 L20 3 L28 14 L38 6 L36 24 Z" fill="#ffd23f" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>
</svg>`;

/** A little ship's wheel for the Easy Driving badge. */
const WHEEL_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <path d="M16 3 V29 M3 16 H29 M7 7 L25 25 M25 7 L7 25" fill="none" stroke="#06173d" stroke-width="3" stroke-linecap="round"/>
  <circle cx="16" cy="16" r="9.5" fill="none" stroke="#06173d" stroke-width="4"/>
  <circle cx="16" cy="16" r="3.6" fill="#ffffff" stroke="#06173d" stroke-width="2.4"/>
</svg>`;

const BALLOON_SVG = `<svg class="ff-bl-icon" viewBox="0 0 34 44" aria-hidden="true">
  <path d="M17 36 C15 39 19 41 17 43" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
  <path d="M17 31 L13.5 36.5 H20.5 Z" fill="#ff5d73" stroke="#06173d" stroke-width="2" stroke-linejoin="round"/>
  <path d="M17 2 C26 2 31 9 31 16.5 C31 25 23 31 17 31 C11 31 3 25 3 16.5 C3 9 8 2 17 2 Z" fill="#ff5d73" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
  <path d="M9.5 12 Q10.5 7.5 14.5 6.5" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;

const BOAT_MINI_SVG = `<svg viewBox="0 0 48 32" aria-hidden="true">
  <path d="M3 18 H45 Q42 29 31 29 H14 Q6 29 3 18 Z" fill="#ffffff" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
  <path d="M17 18 L21 8 H31 L35 18 Z" fill="#bfeaff" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
</svg>`;

/** A slate-blue shark fin cutting the water: the "sharks left" icon in the Boats vs. Sharks banner. */
const FIN_SVG = `<svg class="ff-shark-fin" viewBox="0 0 34 28" aria-hidden="true">
  <path d="M4 23 C11 21 15 12 17 2 C21 11 28 18 31 23 Z" fill="#7f93b2" stroke="#06173d" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M1.5 25.5 Q6 22.5 10 25.5 T18.5 25.5 T27 25.5 T32.5 25.5" fill="none" stroke="#7fd4ff" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

/** A life ring: a white donut with four red bands. The colors come from CSS (--ra, --rb, --ro) so a popped ring can go grey. */
const RING_SVG = `<svg class="ff-ring" viewBox="0 0 32 32" aria-hidden="true">
  <circle class="ro" cx="16" cy="16" r="14.4" fill="none" stroke-width="2.2"/>
  <circle class="ro" cx="16" cy="16" r="5.6" fill="none" stroke-width="2.2"/>
  <circle class="rb" cx="16" cy="16" r="10" fill="none" stroke-width="8"/>
  <circle class="ra" cx="16" cy="16" r="10" fill="none" stroke-width="8" stroke-dasharray="7.854 7.854" stroke-dashoffset="3.927"/>
</svg>`;

interface PowerInfo {
  label: string;
  color: string;
  icon: string;
}
const POWER: Record<PowerUpKind, PowerInfo> = {
  triple: {
    label: 'TRIPLE SHOT',
    color: '#ff8a1f',
    icon: `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 29 L5 7 M16 29 L16 4 M16 29 L27 7" fill="none" stroke="#06173d" stroke-width="3.5" stroke-linecap="round"/><circle cx="5" cy="7" r="3.2" fill="#ffffff" stroke="#06173d" stroke-width="2"/><circle cx="16" cy="4" r="3.2" fill="#ffffff" stroke="#06173d" stroke-width="2"/><circle cx="27" cy="7" r="3.2" fill="#ffffff" stroke="#06173d" stroke-width="2"/></svg>`,
  },
  rapid: {
    label: 'RAPID FIRE',
    color: '#ffd23f',
    icon: `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M19 2 L6 18 H15 L12 30 L26 12 H17 Z" fill="#ffffff" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/></svg>`,
  },
  turbo: {
    label: 'TURBO',
    color: '#5de0ff',
    icon: `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 C23 8 23 17 21 24 H11 C9 17 9 8 16 2 Z" fill="#ffffff" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/><circle cx="16" cy="13" r="3" fill="#06173d"/><path d="M12 26 L16 31 L20 26 Z" fill="#ff8a1f" stroke="#06173d" stroke-width="2" stroke-linejoin="round"/></svg>`,
  },
  shield: {
    label: 'SHIELD',
    color: '#aef0ff',
    icon: SHIELD_SVG,
  },
};

// ───────────── formatting helpers ─────────────

function mmss(totalSec: number): string {
  const s = Math.max(0, totalSec);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Race clock like 1:23.4 from a count of tenths of a second. */
function clockTenths(tenths: number): string {
  const t = Math.max(0, tenths);
  const sec = Math.floor(t / 10);
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') + '.' + (t % 10);
}

/** A team's color: from the live standings if they are there, else from the config. */
function teamColor(team: number, teams: readonly TeamScore[] | null): number {
  if (teams) {
    for (let i = 0; i < teams.length; i++) if (teams[i].team === team) return teams[i].color;
  }
  return CONFIG.team.colors[team] ?? 0xffffff;
}

/** Longer announcements get smaller text so they always fit on screen. */
function textScale(len: number): number {
  if (len <= 2) return 1;
  if (len <= 5) return 0.8;
  if (len <= 9) return 0.65;
  if (len <= 16) return 0.55;
  return 0.42;
}

// ───────────── announcer: big bouncy text ─────────────

interface Announcer {
  root: HTMLElement;
  show(text: string, sub: string | undefined, ms: number): void;
  clear(): void;
}

function createAnnouncer(extraClass: string): Announcer {
  const root = el('div', 'ff-ann ' + extraClass);
  const inner = el('div', 'ff-ann-in');
  const text = el('div', 'ff-ann-text ff-ol');
  const sub = el('div', 'ff-ann-sub ff-ol');
  inner.append(text, sub);
  root.append(inner);
  return {
    root,
    show(t, s, ms) {
      text.textContent = t;
      sub.textContent = s ?? '';
      sub.hidden = !s;
      inner.style.setProperty('--s', String(textScale(t.length)));
      inner.style.setProperty('--ms', ms + 'ms');
      // Restart the CSS animation: remove the class, force a layout, add it back.
      inner.classList.remove('on');
      void inner.offsetWidth;
      inner.classList.add('on');
    },
    clear() {
      inner.classList.remove('on');
    },
  };
}

/** The --u scale for a viewport: smaller viewport (split screen) = smaller HUD. */
function panelScale(v: Viewport): number {
  return clamp(Math.min(v.width / 800, v.height / 600), 0.55, 1.5);
}

/** Mini-map diameter in CSS px for a viewport this tall. */
function mapDiameter(height: number, touch: boolean): number {
  const d = touch
    ? clamp(height * MAP_TOUCH_SHARE, MAP_TOUCH_MIN_PX, MAP_TOUCH_MAX_PX)
    : clamp(height * MAP_SHARE, MAP_MIN_PX, MAP_MAX_PX);
  return Math.round(d);
}

/** Run `onSize` whenever `target` changes size (no polling). Without ResizeObserver the CSS defaults stay. */
function watchSize(target: HTMLElement, onSize: () => void): void {
  if (typeof ResizeObserver !== 'function') return;
  new ResizeObserver(onSize).observe(target);
}

// ───────────── one player's panel (fills one viewport) ─────────────

interface Panel {
  root: HTMLElement;
  /** The name + score stack (top-left): the online connection pill hangs under it. */
  tag: HTMLElement;
  setRect(v: Viewport): void;
  apply(p: PlayerHud, state: HudState, nowMs: number): void;
  /** Coaching line (bottom of this player's view; just above the middle with touch controls). */
  showHint(text: string, ms: number, delayMs: number): void;
  /** Touch controls on or off: the mini-map changes size. */
  setTouch(on: boolean): void;
  reset(): void;
  announcer: Announcer;
}

/** Score box caption per mode (race shows the place instead of a score). */
const SCORE_LABEL: Record<ModeId, string> = {
  battle: 'SCORE',
  race: 'SCORE',
  team: 'MY SCORE',
  practice: 'POINTS',
  sharks: 'SHARK POINTS',
};

/**
 * Builds the DOM for one player's corner of the screen once, then `apply()` only writes
 * to the DOM when a value actually changed (the `c*` variables remember what is on screen).
 */
function createPanel(): Panel {
  const root = el('div', 'ff-vp');

  // top-left: name, then score (battle) or place + lap/gate (race)
  const tag = el('div', 'ff-tag');
  const nameEl = el('div', 'ff-name');
  const scoreBox = el('div', 'ff-scorebox');
  const scoreNum = el('span', 'ff-scorenum', '0');
  const scoreLbl = el('span', 'ff-scorelbl', 'SCORE');
  scoreBox.append(scoreLbl, scoreNum);
  const raceBox = el('div', 'ff-racebox');
  const placeEl = el('span', 'ff-place', '');
  const lapEl = el('span', 'ff-raceline', '');
  const gateEl = el('span', 'ff-raceline', '');
  raceBox.append(placeEl, lapEl, gateEl);
  tag.append(nameEl, scoreBox, raceBox);

  // race arrow
  const arrowEl = el('div', 'ff-arrow');
  const arrowSvg = svgNode(ARROW_SVG);
  arrowEl.append(arrowSvg);
  arrowEl.hidden = true;

  // reticle + locked target name
  const reticle = el('div', 'ff-reticle');
  reticle.append(svgNode(RETICLE_SVG));
  const lockName = el('div', 'ff-lockname');
  lockName.hidden = true;
  reticle.append(lockName);

  // bottom-left cluster
  const cluster = el('div', 'ff-cluster');
  const powerEl = el('div', 'ff-power');
  const powerIcon = el('div', 'ff-power-icon');
  const powerLabel = el('span', '', '');
  const powerSecs = el('span', 'ff-power-secs', '');
  const powerText = el('div', 'ff-power-text');
  powerText.append(powerLabel, powerSecs);
  const powerBar = el('div', 'ff-power-bar');
  powerEl.append(powerIcon, powerText, powerBar);
  powerEl.hidden = true;

  const shieldEl = el('div', 'ff-shield');
  shieldEl.append(svgNode(SHIELD_SVG), el('span', '', 'SHIELD'));
  shieldEl.hidden = true;

  const ammoEl = el('div', 'ff-ammo');
  const reload = el('div', 'ff-reload');
  reload.append(svgNode(RELOAD_SVG));
  const dartsEl = el('div', 'ff-darts');
  ammoEl.append(reload, dartsEl);
  const dartIcons: SVGSVGElement[] = [];

  const boostEl = el('div', 'ff-boost');
  const boostTrack = el('div', 'ff-boost-track');
  const boostFill = el('div', 'ff-boost-fill');
  boostTrack.append(boostFill);
  boostEl.append(el('span', 'ff-boost-lbl', 'BOOST'), boostTrack);

  // Easy Driving reminder, on top of the bottom-left stack
  const easyEl = el('div', 'ff-easy');
  easyEl.append(svgNode(WHEEL_SVG), el('span', '', 'EASY DRIVING'));
  easyEl.hidden = true;

  cluster.append(easyEl, powerEl, shieldEl, ammoEl, boostEl);

  // coaching hint: bottom-center, in the gap between the cluster and the mini-map
  const hintZone = el('div', 'ff-hintzone');
  const hintEl = el('div', 'ff-hint');
  hintZone.append(hintEl);

  // round radar, bottom-right
  const map: Minimap = createMinimap();

  const announcer = createAnnouncer('');
  root.append(tag, arrowEl, reticle, cluster, hintZone, map.canvas, announcer.root);

  // what is currently on screen (NaN / sentinel values force the first write)
  let cx = NaN, cy = NaN, cw = NaN, ch = NaN;
  let cAtL: boolean | null = null; // does this panel touch the left / right edge of the screen? (safe-area margins)
  let cAtR: boolean | null = null;
  let cMapPx = NaN;
  let cTagH = NaN;
  let touch = false;
  let cMode: ModeId | '' = '';
  let cEasy: boolean | null = null;
  let cName: string | null = null;
  let cColor = -1;
  let cScore = NaN;
  let cRank = NaN;
  let cLap = NaN, cLaps = NaN, cGate = NaN, cGates = NaN;
  let cFinished: boolean | null = null;
  let cHasRace: boolean | null = null;
  let cAmmo = NaN, cMax = NaN;
  let cReloading: boolean | null = null;
  let cReloadQ = NaN;
  let cBoostQ = NaN;
  let cKind: PowerUpKind | null | '' = '';
  let cSecs = NaN;
  let cPowerQ = NaN;
  let cShield: boolean | null = null;
  let cLock: string | null | undefined = undefined;
  let cArrowDeg: number | null = NaN;

  function buildDarts(n: number): void {
    dartsEl.textContent = '';
    dartIcons.length = 0;
    for (let i = 0; i < n; i++) {
      const d = svgNode(DART_SVG);
      dartsEl.append(d);
      dartIcons.push(d);
    }
    cAmmo = NaN; // force the filled/spent look to be redrawn
  }

  /** The mini-map is a circle sized from the viewport; the hint strip needs to know where it starts. */
  function applyMapSize(): void {
    if (Number.isNaN(ch)) return; // no rectangle yet
    const d = mapDiameter(ch, touch);
    if (d === cMapPx) return;
    cMapPx = d;
    root.style.setProperty('--mapd', d + 'px');
    map.resize(d);
  }

  function setRect(v: Viewport): void {
    let moved = false;
    if (v.x !== cx) { root.style.left = v.x + 'px'; cx = v.x; moved = true; }
    if (v.y !== cy) { root.style.top = v.y + 'px'; cy = v.y; }
    if (v.width !== cw || v.height !== ch) {
      cw = v.width;
      ch = v.height;
      root.style.width = v.width + 'px';
      root.style.height = v.height + 'px';
      // --u scales every size in this panel: smaller viewport (split screen) = smaller HUD
      root.style.setProperty('--u', panelScale(v).toFixed(3));
      applyMapSize();
      moved = true;
    }
    if (moved) {
      // Only a panel at the edge of the screen keeps clear of the iPad's rounded corners (hud.css: .at-l / .at-r).
      const atL = v.x <= 1;
      const atR = v.x + v.width >= window.innerWidth - 1;
      if (atL !== cAtL) { cAtL = atL; root.classList.toggle('at-l', atL); }
      if (atR !== cAtR) { cAtR = atR; root.classList.toggle('at-r', atR); }
    }
  }

  function setTouch(on: boolean): void {
    touch = on;
    applyMapSize();
  }

  // hud.css hangs the stats cluster under the name/score stack with touch controls, so it needs that stack's height
  watchSize(tag, () => {
    const h = tag.offsetHeight;
    if (h === cTagH) return;
    cTagH = h;
    root.style.setProperty('--tagh', h + 'px');
  });

  function showHint(text: string, ms: number, delayMs: number): void {
    hintEl.textContent = text;
    hintEl.style.setProperty('--ms', ms + 'ms');
    hintEl.style.setProperty('--hd', delayMs + 'ms');
    // Restart the CSS animation (same trick as the announcer).
    hintEl.classList.remove('on');
    void hintEl.offsetWidth;
    hintEl.classList.add('on');
  }

  function apply(p: PlayerHud, state: HudState, nowMs: number): void {
    const mode = state.mode;
    if (mode !== cMode) {
      cMode = mode;
      root.classList.toggle('is-race', mode === 'race');
      scoreLbl.textContent = SCORE_LABEL[mode];
      cScore = NaN; // the score box may have been showing another mode's number
    }
    if (p.easyDriving !== cEasy) {
      cEasy = p.easyDriving;
      easyEl.hidden = !p.easyDriving;
    }
    if (p.name !== cName) {
      cName = p.name;
      nameEl.textContent = p.name;
    }
    if (p.color !== cColor) {
      cColor = p.color;
      root.style.setProperty('--pc', cssColor(p.color));
    }

    // score (battle, Team Up, Balloon Pop) or race standing
    if (mode !== 'race') {
      if (p.score !== cScore) {
        const grew = p.score > cScore;
        cScore = p.score;
        scoreNum.textContent = String(p.score);
        if (grew) {
          scoreNum.classList.remove('pop');
          void scoreNum.offsetWidth;
          scoreNum.classList.add('pop');
        }
      }
    } else {
      if (p.rank !== cRank) {
        const moved = !Number.isNaN(cRank);
        cRank = p.rank;
        placeEl.textContent = ordinal(p.rank);
        if (moved) {
          placeEl.classList.remove('pop');
          void placeEl.offsetWidth;
          placeEl.classList.add('pop');
        }
      }
      const r = p.race;
      const hasRace = r !== null;
      if (hasRace !== cHasRace) {
        cHasRace = hasRace;
        lapEl.hidden = !hasRace;
        gateEl.hidden = !hasRace;
      }
      if (r) {
        const lap = clamp(Math.max(1, r.lap), 1, Math.max(1, r.laps));
        if (lap !== cLap || r.laps !== cLaps || r.finished !== cFinished) {
          cLap = lap;
          cLaps = r.laps;
          lapEl.textContent = r.finished ? 'FINISHED!' : 'Lap ' + lap + '/' + r.laps;
        }
        if (r.checkpoint !== cGate || r.checkpoints !== cGates || r.finished !== cFinished) {
          cGate = r.checkpoint;
          cGates = r.checkpoints;
          gateEl.hidden = r.finished;
          if (!r.finished) gateEl.textContent = 'Gate ' + r.checkpoint + '/' + r.checkpoints;
        }
        cFinished = r.finished;
      }
    }

    // ammo icons
    if (p.maxAmmo !== cMax) {
      cMax = p.maxAmmo;
      buildDarts(Math.max(0, Math.round(p.maxAmmo)));
    }
    if (p.ammo !== cAmmo) {
      cAmmo = p.ammo;
      for (let i = 0; i < dartIcons.length; i++) {
        dartIcons[i].classList.toggle('is-spent', i >= p.ammo);
      }
    }
    // reload ring
    if (p.reloading !== cReloading) {
      cReloading = p.reloading;
      reload.classList.toggle('on', p.reloading);
      if (!p.reloading) cReloadQ = NaN;
    }
    if (p.reloading) {
      const q = Math.round(clamp(p.reloadProgress, 0, 1) * 50);
      if (q !== cReloadQ) {
        cReloadQ = q;
        reload.style.setProperty('--p', String(q / 50));
      }
    }
    // boost bar (2% steps are plenty)
    const bq = Math.round(clamp(p.boost, 0, 1) * 50);
    if (bq !== cBoostQ) {
      cBoostQ = bq;
      boostFill.style.transform = 'scaleX(' + bq / 50 + ')';
    }

    // power-up badge (the shield has its own pill; it lasts until it blocks a hit)
    const pu = p.powerUp;
    const kind: PowerUpKind | null = pu && pu.kind !== 'shield' ? pu.kind : null;
    if (kind !== cKind) {
      cKind = kind;
      powerEl.hidden = kind === null;
      if (kind) {
        const info = POWER[kind];
        powerEl.style.setProperty('--k', info.color);
        powerLabel.textContent = info.label;
        powerIcon.replaceChildren(svgNode(info.icon));
        cSecs = NaN;
        cPowerQ = NaN;
      }
    }
    if (pu && kind) {
      const secs = pu.timeLeft > 0 && pu.timeLeft < 100 ? Math.ceil(pu.timeLeft) : 0;
      if (secs !== cSecs) {
        cSecs = secs;
        powerSecs.textContent = secs > 0 ? secs + 's' : '';
      }
      const pq = Math.round(clamp(pu.timeLeft / CONFIG.powerUps.durationSec, 0, 1) * 40);
      if (pq !== cPowerQ) {
        cPowerQ = pq;
        powerBar.style.transform = 'scaleX(' + pq / 40 + ')';
      }
    }
    const shielded = p.shielded || (pu !== null && pu.kind === 'shield');
    if (shielded !== cShield) {
      cShield = shielded;
      shieldEl.hidden = !shielded;
    }

    // reticle: red + brackets + the target's name when locked on
    if (p.lockedTarget !== cLock) {
      cLock = p.lockedTarget;
      reticle.classList.toggle('is-locked', p.lockedTarget !== null);
      lockName.hidden = p.lockedTarget === null;
      if (p.lockedTarget !== null) lockName.textContent = p.lockedTarget;
    }

    // arrow to the next gate (2-degree steps)
    const deg = p.arrow === null ? null : Math.round((p.arrow * 180) / Math.PI / 2) * 2;
    if (deg !== cArrowDeg) {
      cArrowDeg = deg;
      arrowEl.hidden = deg === null;
      if (deg !== null) arrowSvg.style.transform = 'rotate(' + deg + 'deg)';
    }

    // mini-map (it keeps itself to ~20 redraws a second)
    if (state.map) map.draw(state.map, p, mode, nowMs);
  }

  function reset(): void {
    cx = cy = cw = ch = NaN;
    cMode = '';
    cEasy = null;
    hintEl.classList.remove('on');
    map.invalidate();
    cName = null;
    cColor = -1;
    cScore = NaN;
    cRank = NaN;
    cLap = cLaps = cGate = cGates = NaN;
    cFinished = null;
    cHasRace = null;
    cAmmo = cMax = NaN;
    cReloading = null;
    cReloadQ = NaN;
    cBoostQ = NaN;
    cKind = '';
    cSecs = NaN;
    cPowerQ = NaN;
    cShield = null;
    cLock = undefined;
    cArrowDeg = NaN;
    announcer.clear();
  }

  return { root, tag, setRect, apply, showHint, setTouch, reset, announcer };
}

// ───────────── the HUD ─────────────

export function createHud(root: HTMLElement, sfx: Sfx): Hud {
  root.classList.add('ff-ui');
  installUnlock(sfx);

  // The "live" layer (panels, timer, scoreboard, feed) is separate from the pause/results
  // overlays, so hide() never hides a results screen that is open.
  const live = el('div', 'ff-live');
  const panelsEl = el('div', 'ff-panels');
  live.append(panelsEl);
  const panels: Panel[] = [];
  let panelsOn = 0;

  // Online connection pill ("Online · DUCK · 3 players", "Reconnecting..."). It hangs under the first player's
  // name/score stack, so it follows that stack in every layout and never lands on the touch Pause button or controls.
  const netEl = el('div', 'ff-net');
  netEl.hidden = true;
  netEl.setAttribute('role', 'status');
  const netText = el('span', 'ff-net-text');
  netEl.append(el('i', 'ff-net-dot'), netText);
  let cNet: string | null = null;

  // timer
  const timerEl = el('div', 'ff-timer');
  timerEl.hidden = true;
  let cTimerKey = NaN;
  let cTimerKind: 'battle' | 'race' | '' = '';
  let cUrgent: boolean | null = null;

  // scoreboard (rows are created on demand and reused)
  const sbEl = el('div', 'ff-sb');
  sbEl.hidden = true;
  interface SbRow {
    row: HTMLElement;
    dot: HTMLElement;
    teamMark: SVGSVGElement;
    name: HTMLElement;
    score: HTMLElement;
    nameText: string | null;
    color: number;
    teamCol: number;
    scoreVal: number;
    human: boolean | null;
  }
  const sbRows: SbRow[] = [];
  let sbCount = -1;
  let cSbRace: boolean | null = null;
  let cSbTeam: boolean | null = null;

  function addSbRow(rank: number): SbRow {
    const row = el('div', 'ff-sbrow');
    const dot = el('span', 'ff-sb-dot');
    const teamMark = svgNode(DIAMOND_SVG); // only shown in Team Up (CSS: .ff-sb.is-team)
    teamMark.classList.add('ff-sb-team');
    const name = el('span', 'ff-sb-name');
    const score = el('span', 'ff-sb-score');
    row.append(el('span', 'ff-sb-rank', String(rank)), dot, teamMark, name, score);
    sbEl.append(row);
    return { row, dot, teamMark, name, score, nameText: null, color: -1, teamCol: -1, scoreVal: NaN, human: null };
  }

  // Team Up banner: one pill each side of the timer, humans' team on the left
  interface TeamPill {
    root: HTMLElement;
    name: HTMLElement;
    score: HTMLElement;
    num: HTMLElement;
    crown: SVGSVGElement;
    nameText: string | null;
    color: number;
    scoreVal: number;
    lead: boolean | null;
  }
  function createTeamPill(side: 'l' | 'r'): TeamPill {
    const root = el('div', 'ff-team ff-team--' + side);
    root.hidden = true;
    const head = el('div', 'ff-team-head');
    const name = el('span', 'ff-team-name');
    head.append(svgNode(DIAMOND_SVG), name);
    const score = el('div', 'ff-team-score');
    const crown = svgNode(CROWN_MINI_SVG);
    crown.toggleAttribute('hidden', true); // SVG nodes have no .hidden property; the [hidden] attribute still works
    const num = el('span', '', '0');
    score.append(crown, num);
    root.append(head, score);
    return { root, name, score, num, crown, nameText: null, color: -1, scoreVal: NaN, lead: null };
  }
  const teamPills = [createTeamPill('l'), createTeamPill('r')];
  let cTeamsOn: boolean | null = null;

  // Balloon Pop counter: sits to the right of the clock
  const balloonsEl = el('div', 'ff-balloons');
  balloonsEl.hidden = true;
  const blNum = el('span', 'ff-bl-num', '0');
  const blBar = el('div', 'ff-bl-bar');
  const blFill = el('div', 'ff-bl-fill');
  blBar.append(blFill);
  balloonsEl.append(svgNode(BALLOON_SVG), blNum, el('span', 'ff-bl-lbl', 'left'), blBar);
  let cBlOn: boolean | null = null;
  let cBlRemaining = NaN;
  let cBlQ = NaN;

  // Boats vs. Sharks banner: it takes the timer's place. Row one is the wave and the sharks left (or "Get ready…"
  // between waves), row two is the team's life rings. The MEGA SHARK's health bar hangs right under it.
  const sharkEl = el('div', 'ff-shark');
  sharkEl.hidden = true;
  const sharkWave = el('span', 'ff-shark-wave', '');
  const sharkNum = el('span', 'ff-shark-num', '0');
  const sharkLeft = el('span', 'ff-shark-left');
  sharkLeft.append(svgNode(FIN_SVG), sharkNum, el('span', 'ff-shark-lbl', 'left'));
  const sharkReady = el('span', 'ff-shark-ready', 'Get ready…');
  const sharkTop = el('div', 'ff-shark-top');
  sharkTop.append(sharkWave, sharkLeft, sharkReady);
  const ringsEl = el('div', 'ff-rings');
  sharkEl.append(sharkTop, ringsEl);
  const ringIcons: SVGSVGElement[] = [];
  const megaEl = el('div', 'ff-mega');
  megaEl.hidden = true;
  const megaSegsEl = el('div', 'ff-mega-segs');
  megaEl.append(megaSegsEl, el('span', 'ff-mega-name ff-ol', 'MEGA SHARK'));
  const megaSegs: HTMLElement[] = [];
  let cShOn: boolean | null = null;
  let cShMegaRound: boolean | null = null;
  let cShBreak: boolean | null = null;
  let cShWave = NaN;
  let cShWaves = NaN;
  let cShLeft = NaN;
  let cShRings = NaN;
  let cShMaxRings = NaN;
  let cShReady = NaN;
  let shBreakStart = 0; // performance.now() when the current break between waves began
  let cMegaOn: boolean | null = null;
  let cMegaMax = NaN;
  let cMegaFilled = NaN;

  // feed + global announcer
  const feedEl = el('div', 'ff-feed');
  let feedMax = FEED_MAX;
  let cLiveRace: boolean | null = null;
  let cFeedU = NaN;
  const globalAnn = createAnnouncer('ff-ann--global');
  live.append(timerEl, teamPills[0].root, teamPills[1].root, balloonsEl, sharkEl, megaEl, sbEl, feedEl, globalAnn.root);
  root.append(live);

  // With touch controls the mini-map hangs under the scoreboard, so the CSS needs the scoreboard's height.
  let cSbH = NaN;
  watchSize(sbEl, () => {
    const h = Math.ceil(sbEl.offsetHeight);
    if (h === cSbH) return;
    cSbH = h;
    live.style.setProperty('--sbh', h + 'px');
  });

  // Touch controls on? (the input module toggles the class on <html>; checked once a frame, written only on change)
  const htmlEl = document.documentElement;
  let cTouch = false;
  /** When the latest announcement finishes: a hint appearing at the same moment ("GO!") waits its turn. */
  let annEnd = 0;

  function rescale(): void {
    const g = clamp(Math.min(window.innerWidth / 1200, window.innerHeight / 675), 0.7, 1.5);
    live.style.setProperty('--g', g.toFixed(3));
  }
  rescale();
  window.addEventListener('resize', rescale);

  // ───── pause overlay ─────
  const pauseEl = el('div', 'ff-overlay ff-pause');
  pauseEl.hidden = true;
  const pauseCard = el('div', 'ff-card ff-card--dark ff-card--pause');
  const resumeBtn = button('Resume', 'ff-btn ff-btn--primary ff-btn--xl');
  const quitBtn = button('Quit to Menu', 'ff-btn ff-btn--xl');
  const pauseRow1 = el('div', 'ff-row');
  pauseRow1.append(resumeBtn);
  const pauseRow2 = el('div', 'ff-row');
  pauseRow2.append(quitBtn);
  const pauseTitle = el('h2', 'ff-h1 ff-ol', 'Paused');
  pauseCard.append(pauseTitle, pauseRow1, pauseRow2);
  pauseEl.append(pauseCard);
  const pauseBtns = [resumeBtn, quitBtn];
  let pauseCb: { onResume: () => void; onQuit: () => void } | null = null;
  let pauseArmedAt = 0;

  // ───── results overlay ─────
  const resultsEl = el('div', 'ff-overlay ff-results');
  resultsEl.hidden = true;
  const confetti = el('div', 'ff-confetti');
  for (let i = 0; i < 34; i++) {
    const c = el('i');
    c.style.setProperty('--x', ((i * 29 + 7) % 100) + '%');
    c.style.setProperty('--w', 8 + ((i * 5) % 4) * 3 + 'px');
    c.style.setProperty('--d', 3.2 + ((i * 7) % 6) * 0.6 + 's');
    c.style.setProperty('--dl', -((i * 13) % 9) * 0.5 + 's');
    c.style.setProperty('--c', cssColor(CONFIG.colors[i % CONFIG.colors.length]));
    confetti.append(c);
  }
  const resCard = el('div', 'ff-card ff-card--dark ff-card--results');
  const resTitle = el('h2', 'ff-res-title ff-ol');
  const resTeams = el('div', 'ff-res-teams'); // Team Up standings
  const awardsEl = el('div', 'ff-awards'); // trophy celebration
  const podium = el('div', 'ff-podium');
  const table = el('div', 'ff-table');
  const resBody = el('div', 'ff-res-body');
  resBody.append(podium, table);
  // title and buttons stay in view; everything between them scrolls on a short window
  const resMid = el('div', 'ff-res-mid');
  resMid.append(resTeams, awardsEl, resBody);
  const rematchBtn = button('Rematch', 'ff-btn ff-btn--primary ff-btn--xl');
  const menuBtn = button('Menu', 'ff-btn ff-btn--xl');
  // Online guest: no Rematch button (only the host can start one), a "Waiting for the host..." note in its place.
  const resWait = el('div', 'ff-res-wait');
  resWait.setAttribute('role', 'status');
  resWait.hidden = true;
  const resWaitText = el('span', 'ff-res-wait-text');
  const resWaitDots = el('span', 'ff-dots');
  resWaitDots.setAttribute('aria-hidden', 'true');
  resWaitDots.append(el('i'), el('i'), el('i'));
  resWait.append(resWaitText, resWaitDots);
  const resActions = el('div', 'ff-row ff-res-actions');
  resActions.append(rematchBtn, resWait, menuBtn);
  resCard.append(resTitle, resMid, resActions);
  resultsEl.append(confetti, resCard);
  const resultBtns = [rematchBtn, menuBtn];
  const resultBtnsMenuOnly = [menuBtn]; // while the Rematch button is away
  let resultsCb: { onRematch: (() => void) | null; onMenu: () => void } | null = null;
  let resultsArmedAt = 0;
  let trophyTimer = 0; // pending "play the trophy fanfare" (cleared when the results close)

  root.append(pauseEl, resultsEl);

  // The input module reports Enter/Space itself, so stop the browser double-clicking buttons.
  guardActivationKeys(() => !pauseEl.hidden || !resultsEl.hidden);
  for (const o of [pauseEl, resultsEl]) {
    o.addEventListener('pointerdown', () => o.classList.remove('ff-nav'));
  }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    if (!pauseEl.hidden) pauseEl.classList.add('ff-nav');
    if (!resultsEl.hidden) resultsEl.classList.add('ff-nav');
  });

  // buttons close their own overlay first, then tell the game (each callback runs once)
  resumeBtn.addEventListener('click', () => {
    const cb = pauseCb;
    if (!cb) return;
    sfx.uiSelect();
    hidePause();
    cb.onResume();
  });
  quitBtn.addEventListener('click', () => {
    const cb = pauseCb;
    if (!cb) return;
    sfx.uiSelect();
    hidePause();
    cb.onQuit();
  });
  rematchBtn.addEventListener('click', () => {
    const cb = resultsCb;
    if (!cb || !cb.onRematch) return;
    sfx.uiSelect();
    hideResults();
    cb.onRematch();
  });
  menuBtn.addEventListener('click', () => {
    const cb = resultsCb;
    if (!cb) return;
    sfx.uiSelect();
    hideResults();
    cb.onMenu();
  });

  // ───── Hud methods ─────

  function resetLive(): void {
    for (const p of panels) p.reset();
    globalAnn.clear();
    feedEl.textContent = '';
    cTimerKey = NaN;
    cTimerKind = '';
    cUrgent = null;
    sbCount = -1;
    cSbRace = null;
    cSbTeam = null;
    for (const r of sbRows) {
      r.nameText = null;
      r.color = -1;
      r.teamCol = -1;
      r.scoreVal = NaN;
      r.human = null;
    }
    cTeamsOn = null;
    for (const t of teamPills) {
      t.nameText = null;
      t.color = -1;
      t.scoreVal = NaN;
      t.lead = null;
    }
    cBlOn = null;
    cBlRemaining = NaN;
    cBlQ = NaN;
    // Boats vs. Sharks banner: forget what it showed, so the next match redraws it from scratch
    cShOn = null;
    cShMegaRound = null;
    cShBreak = null;
    cShWave = cShWaves = cShLeft = cShRings = cShMaxRings = cShReady = NaN;
    cMegaOn = null;
    cMegaMax = cMegaFilled = NaN;
    sharkEl.hidden = true;
    megaEl.hidden = true;
    sharkEl.classList.remove('is-mega', 'is-break', 'hit');
    megaEl.classList.remove('hit');
    live.classList.remove('is-sharks');
  }

  function show(): void {
    live.hidden = false;
    resetLive();
  }

  function hide(): void {
    live.hidden = true;
    for (const p of panels) p.announcer.clear();
    globalAnn.clear();
  }

  function updateTimer(s: HudState): void {
    // 'battle' = counts down (Dart Battle, Team Up); 'race' = counts up (Buoy Race, Balloon Pop)
    let kind: 'battle' | 'race' | '' = '';
    let key = NaN;
    if (s.sharks) {
      // Boats vs. Sharks: the banner (updateSharks) takes the clock's place
    } else if (s.timeLeft !== null) {
      kind = 'battle';
      key = Math.max(0, Math.ceil(s.timeLeft));
    } else if (s.raceTime !== null) {
      kind = 'race';
      key = Math.floor(s.raceTime * 10);
    }
    if (kind !== cTimerKind) {
      cTimerKind = kind;
      timerEl.hidden = kind === '';
      timerEl.classList.toggle('is-race', kind === 'race');
      cTimerKey = NaN;
    }
    if (kind === '') return;
    if (key !== cTimerKey) {
      cTimerKey = key;
      timerEl.textContent = kind === 'battle' ? mmss(key) : clockTenths(key);
    }
    const urgent = kind === 'battle' && s.timeLeft !== null && s.timeLeft < 10;
    if (urgent !== cUrgent) {
      cUrgent = urgent;
      timerEl.classList.toggle('is-urgent', urgent);
    }
  }

  function updateScoreboard(s: HudState): void {
    const rows = s.scoreboard;
    const n = rows.length;
    if (n !== sbCount) {
      sbCount = n;
      sbEl.hidden = n === 0;
      while (sbRows.length < n) {
        const r = addSbRow(sbRows.length + 1);
        sbRows.push(r);
      }
      for (let i = 0; i < sbRows.length; i++) sbRows[i].row.hidden = i >= n;
    }
    const race = s.mode === 'race';
    if (race !== cSbRace) {
      cSbRace = race;
      sbEl.classList.toggle('is-race', race); // race standings show place only, no score column
    }
    const teamUp = !!s.teams;
    if (teamUp !== cSbTeam) {
      cSbTeam = teamUp;
      sbEl.classList.toggle('is-team', teamUp); // Team Up rows carry a team-colored diamond
    }
    for (let i = 0; i < n; i++) {
      const d = rows[i];
      const r = sbRows[i];
      if (d.name !== r.nameText) {
        r.nameText = d.name;
        r.name.textContent = d.name;
      }
      if (d.color !== r.color) {
        r.color = d.color;
        r.dot.style.setProperty('--c', cssColor(d.color));
      }
      if (teamUp) {
        const tc = teamColor(d.team, s.teams);
        if (tc !== r.teamCol) {
          r.teamCol = tc;
          r.teamMark.style.setProperty('--tc', cssColor(tc));
        }
      }
      if (d.score !== r.scoreVal) {
        r.scoreVal = d.score;
        r.score.textContent = String(d.score);
      }
      if (d.isHuman !== r.human) {
        r.human = d.isHuman;
        r.row.classList.toggle('is-human', d.isHuman);
      }
    }
  }

  /** Team Up: the two score pills beside the timer. Leader gets a crown and a yellow ring; a tie gets neither. */
  function updateTeams(s: HudState): void {
    const teams = s.teams;
    const on = !!teams && teams.length >= 2;
    if (on !== cTeamsOn) {
      cTeamsOn = on;
      for (const t of teamPills) t.root.hidden = !on;
    }
    if (!teams || !on) return;
    const best = Math.max(teams[0].score, teams[1].score);
    const tied = teams[0].score === teams[1].score;
    for (let i = 0; i < 2; i++) {
      const d = teams[i];
      const t = teamPills[i];
      if (d.name !== t.nameText) {
        t.nameText = d.name;
        t.name.textContent = d.name;
      }
      if (d.color !== t.color) {
        t.color = d.color;
        t.root.style.setProperty('--tc', cssColor(d.color));
      }
      if (d.score !== t.scoreVal) {
        const grew = d.score > t.scoreVal;
        t.scoreVal = d.score;
        t.num.textContent = String(d.score);
        if (grew) {
          t.score.classList.remove('pop');
          void t.score.offsetWidth;
          t.score.classList.add('pop');
        }
      }
      const lead = !tied && d.score === best;
      if (lead !== t.lead) {
        t.lead = lead;
        t.root.classList.toggle('is-lead', lead);
        t.crown.toggleAttribute('hidden', !lead);
      }
    }
  }

  /** Balloon Pop: "12 left" plus a bar that fills as balloons get popped. */
  function updateBalloons(s: HudState): void {
    const b = s.balloons;
    const on = !!b;
    if (on !== cBlOn) {
      cBlOn = on;
      balloonsEl.hidden = !on;
    }
    if (!b) return;
    if (b.remaining !== cBlRemaining) {
      const popped = b.remaining < cBlRemaining;
      cBlRemaining = b.remaining;
      blNum.textContent = String(b.remaining);
      if (popped) {
        blNum.classList.remove('pop');
        void blNum.offsetWidth;
        blNum.classList.add('pop');
      }
    }
    const q = Math.round(clamp(b.total > 0 ? 1 - b.remaining / b.total : 0, 0, 1) * 50);
    if (q !== cBlQ) {
      cBlQ = q;
      blFill.style.transform = 'scaleX(' + q / 50 + ')';
    }
  }

  /** Restart a one-shot CSS animation on `node` (the class is removed, a layout is forced, and it goes back on). */
  function replay(node: Element, cls: string): void {
    node.classList.remove(cls);
    void (node as HTMLElement).offsetWidth;
    node.classList.add(cls);
  }

  /** (Re)build the row of life-ring icons. */
  function buildRings(max: number): void {
    ringsEl.textContent = '';
    ringIcons.length = 0;
    const n = clamp(Math.round(max), 0, RINGS_MAX);
    for (let i = 0; i < n; i++) {
      const r = svgNode(RING_SVG);
      ringsEl.append(r);
      ringIcons.push(r);
    }
    cShRings = NaN; // force the popped/ready look to be redrawn
  }

  /** (Re)build the MEGA health bar's chunky blocks. */
  function buildMegaSegs(n: number): void {
    megaSegsEl.textContent = '';
    megaSegs.length = 0;
    for (let i = 0; i < n; i++) {
      const seg = el('i');
      megaSegsEl.append(seg);
      megaSegs.push(seg);
    }
    cMegaFilled = NaN;
  }

  /**
   * Boats vs. Sharks: the banner (wave, sharks left, life rings), the "Get ready…" break, and the MEGA health bar.
   * Everything is written only when it changed; a lost ring or a MEGA hit also gets a little wobble.
   */
  function updateSharks(s: HudState, nowMs: number): void {
    const sh = s.sharks ?? null; // (an older game core may not send it)
    const on = sh !== null;
    if (on !== cShOn) {
      cShOn = on;
      sharkEl.hidden = !on;
      live.classList.toggle('is-sharks', on);
      if (!on) cShMegaRound = null;
    }
    if (!sh) {
      if (cMegaOn !== false) {
        cMegaOn = false;
        megaEl.hidden = true;
      }
      return;
    }

    // MEGA round: the wave number runs past the last wave (or the MEGA SHARK is out)
    const megaRound = sh.wave > sh.waves || sh.mega !== null;
    if (megaRound !== cShMegaRound) {
      cShMegaRound = megaRound;
      sharkEl.classList.toggle('is-mega', megaRound);
      cShWave = NaN;
    }
    // break between waves: "Get ready…" with a gentle count (the MEGA SHARK being out is never a break)
    const brk = sh.betweenWaves && sh.mega === null;
    if (brk !== cShBreak) {
      cShBreak = brk;
      sharkEl.classList.toggle('is-break', brk);
      shBreakStart = nowMs;
      cShReady = NaN;
    }
    if (brk) {
      const waited = (nowMs - shBreakStart) / 1000;
      // the count only makes sense while the break is as long as the game says it is (it stays off after a pause)
      const left = waited <= CONFIG.sharks.waveBreakSec + 0.5 ? Math.max(1, Math.ceil(CONFIG.sharks.waveBreakSec - waited)) : 0;
      if (left !== cShReady) {
        cShReady = left;
        sharkReady.textContent = left > 0 ? 'Get ready… ' + left : 'Get ready…';
      }
    } else if (megaRound) {
      if (cShWave !== -1) {
        cShWave = -1; // -1 stands for "MEGA SHARK!" on screen
        sharkWave.textContent = 'MEGA SHARK!';
      }
    } else {
      const wave = clamp(Math.round(sh.wave), 1, Math.max(1, sh.waves));
      if (wave !== cShWave || sh.waves !== cShWaves) {
        cShWave = wave;
        cShWaves = sh.waves;
        sharkWave.textContent = 'WAVE ' + wave + '/' + sh.waves;
      }
    }

    // sharks left (hidden by CSS during a break and in the MEGA round)
    if (sh.sharksLeft !== cShLeft) {
      const fewer = sh.sharksLeft < cShLeft;
      cShLeft = sh.sharksLeft;
      sharkNum.textContent = String(Math.max(0, sh.sharksLeft));
      if (fewer) replay(sharkNum, 'pop');
    }

    // life rings: the ones at the end go flat first
    if (sh.maxRings !== cShMaxRings) {
      cShMaxRings = sh.maxRings;
      buildRings(sh.maxRings);
    }
    const rings = clamp(Math.round(sh.rings), 0, ringIcons.length);
    if (rings !== cShRings) {
      const before = cShRings;
      cShRings = rings;
      for (let i = 0; i < ringIcons.length; i++) ringIcons[i].classList.toggle('is-popped', i >= rings);
      if (rings < before) {
        for (let i = rings; i < before && i < ringIcons.length; i++) replay(ringIcons[i], 'pop');
        replay(sharkEl, 'hit');
      }
    }

    // MEGA SHARK health: chunky blocks that go dark from the right
    const mega = sh.mega;
    const megaOn = mega !== null;
    if (megaOn !== cMegaOn) {
      cMegaOn = megaOn;
      megaEl.hidden = !megaOn;
      cMegaFilled = NaN;
    }
    if (mega) {
      const max = Math.max(1, mega.maxHealth);
      const segs = clamp(Math.round(max), 1, MEGA_SEGS_MAX);
      if (segs !== cMegaMax) {
        cMegaMax = segs;
        buildMegaSegs(segs);
      }
      const health = clamp(mega.health, 0, max);
      const filled = health > 0 ? clamp(Math.ceil((health / max) * segs), 1, segs) : 0;
      if (filled !== cMegaFilled) {
        const hurt = filled < cMegaFilled;
        cMegaFilled = filled;
        for (let i = 0; i < megaSegs.length; i++) megaSegs[i].classList.toggle('is-gone', i >= filled);
        if (hurt) replay(megaEl, 'hit');
      }
    }
  }

  function update(state: HudState): void {
    const nowMs = performance.now();
    const n = Math.min(state.viewports.length, state.players.length);
    const touch = htmlEl.classList.contains(TOUCH_CLASS);
    if (touch !== cTouch) {
      cTouch = touch;
      for (const p of panels) p.setTouch(touch);
    }
    while (panels.length < n) {
      const p = createPanel();
      p.setTouch(cTouch);
      panelsEl.append(p.root);
      if (panels.length === 0) p.tag.append(netEl);
      panels.push(p);
    }
    for (let i = 0; i < panels.length; i++) {
      const on = i < n;
      const panel = panels[i];
      if (panel.root.hidden === on) panel.root.hidden = !on;
      if (on) {
        panel.setRect(state.viewports[i]);
        panel.apply(state.players[i], state, nowMs);
      }
    }
    if (n !== panelsOn) {
      panelsOn = n;
      live.classList.toggle('is-split', n > 1);
    }
    // The feed sits under the timer, so the CSS needs to know where the next-gate arrow (race, 1 player)
    // or the name/score panels (2 players) end. Both are sized by the panel scale, so share it.
    const race = state.mode === 'race';
    if (race !== cLiveRace) {
      cLiveRace = race;
      live.classList.toggle('is-race', race);
    }
    if (n > 0) {
      const u = panelScale(state.viewports[0]);
      if (u !== cFeedU) {
        cFeedU = u;
        live.style.setProperty('--uf', u.toFixed(3));
      }
    }
    feedMax = race && n < 2 ? FEED_MAX_1P_RACE : FEED_MAX;
    updateTimer(state);
    updateTeams(state);
    updateBalloons(state);
    updateSharks(state, nowMs);
    updateScoreboard(state);
  }

  function announce(text: string, opts?: { sub?: string; ms?: number; viewport?: number }): void {
    const ms = opts?.ms ?? 1200;
    const v = opts?.viewport;
    const target = v !== undefined && v >= 0 && v < panels.length ? panels[v].announcer : globalAnn;
    target.show(text, opts?.sub, ms);
    annEnd = Math.max(annEnd, performance.now() + ms);
  }

  function hint(text: string, viewport: number, ms = HINT_DEFAULT_MS): void {
    if (viewport < 0 || viewport >= panels.length) return; // that player's panel doesn't exist (yet)
    // (only the touch layout uses the delay: there the hint sits right where the big announcements are drawn)
    panels[viewport].showHint(text, ms, Math.max(0, Math.round(annEnd - performance.now())));
  }

  function feed(text: string, color?: number): void {
    const item = el('div', 'ff-feed-item', text);
    item.style.setProperty('--fc', cssColor(color ?? 0xffffff));
    item.addEventListener('animationend', () => item.remove(), { once: true });
    feedEl.prepend(item); // newest on top, nearest the timer where eyes already are
    while (feedEl.childElementCount > feedMax) feedEl.lastElementChild?.remove();
  }

  /** Small connection pill for online play; null (or empty) hides it. */
  function setNetStatus(text: string | null): void {
    if (text === cNet) return; // (the app may say the same thing every frame)
    cNet = text;
    const t = text === null ? '' : text.trim();
    netEl.hidden = t === '';
    if (t === '') return;
    netText.textContent = t;
    netEl.classList.toggle('is-warn', NET_TROUBLE.test(t));
  }

  /**
   * `opts` is an extra for online play (not in the shared Hud type): an online guest's Pause does not stop the game, so
   * the app can say "Leave the game?" instead of "Paused". Every call sets all three words, so nothing sticks around.
   */
  function showPause(
    onResume: () => void,
    onQuit: () => void,
    opts?: { title?: string; resumeLabel?: string; quitLabel?: string },
  ): void {
    pauseCb = { onResume, onQuit };
    pauseTitle.textContent = opts?.title ?? 'Paused';
    resumeBtn.textContent = opts?.resumeLabel ?? 'Resume';
    quitBtn.textContent = opts?.quitLabel ?? 'Quit to Menu';
    pauseArmedAt = performance.now() + PAUSE_ARM_MS;
    pauseEl.hidden = false;
    pauseEl.classList.add('ff-nav');
    resumeBtn.focus({ preventScroll: true });
  }

  function hidePause(): void {
    pauseEl.hidden = true;
    pauseCb = null;
  }

  /** A diamond in the team's color (Team Up only). */
  function teamDiamond(className: string, color: number): SVGSVGElement {
    const d = svgNode(DIAMOND_SVG);
    d.classList.add(className);
    d.style.setProperty('--tc', cssColor(color));
    return d;
  }

  /** Team Up standings: both teams side by side, a crown and ring on the winner (none on a tie). */
  function buildTeams(teams: readonly TeamScore[] | null): void {
    resTeams.textContent = '';
    resTeams.hidden = !teams || teams.length < 2;
    if (!teams || teams.length < 2) return;
    let best = -Infinity;
    for (const t of teams) best = Math.max(best, t.score);
    const tied = teams.every((t) => t.score === teams[0].score);
    for (const t of teams) {
      const win = !tied && t.score === best;
      const card = el('div', 'ff-res-team' + (win ? ' is-win' : ''));
      card.style.setProperty('--tc', cssColor(t.color));
      card.append(svgNode(DIAMOND_SVG), el('span', 'ff-res-team-name', t.name), el('span', 'ff-res-team-score', String(t.score)));
      if (win) card.append(svgNode(CROWN_MINI_SVG));
      resTeams.append(card);
    }
  }

  /** Trophy celebration: a card per first-time trophy, bouncing in one after another. */
  function buildAwards(result: MatchResult): void {
    awardsEl.textContent = '';
    const awards = result.awards ?? []; // (an older game core may not send any)
    awardsEl.hidden = awards.length === 0;
    if (awards.length === 0) return;
    awardsEl.append(el('h3', 'ff-awards-head ff-ol', awards.length > 1 ? 'NEW TROPHIES!' : 'NEW TROPHY!'));
    const rowEl = el('div', 'ff-awards-row');
    awards.forEach((a, i) => {
      const card = el('div', 'ff-award');
      card.style.setProperty('--dl', (TROPHY_DELAY_MS + i * TROPHY_STAGGER_MS) / 1000 + 's');
      card.style.setProperty('--c', cssColor(a.color));
      const icon = el('div', 'ff-award-icon', a.trophy.icon); // an emoji
      const text = el('div', 'ff-award-text');
      text.append(
        el('div', 'ff-award-name', a.trophy.name),
        el('div', 'ff-award-who', a.playerName),
        el('div', 'ff-award-desc', a.trophy.description),
      );
      card.append(icon, text);
      rowEl.append(card);
    });
    awardsEl.append(rowEl);
  }

  function buildResults(result: MatchResult): void {
    resTitle.textContent = result.title;
    podium.textContent = '';
    table.textContent = '';
    buildTeams(result.teams);
    buildAwards(result);
    resMid.scrollTop = 0;

    const rows = [...result.rows].sort((a, b) => a.place - b.place);
    // podium order on screen: 2nd, 1st, 3rd (winner in the middle, tallest)
    const top = rows.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter((r): r is ResultRow => r !== undefined);
    order.forEach((r, i) => {
      const p = clamp(r.place, 1, 3);
      const pod = el('div', 'ff-pod ff-pod--p' + p);
      pod.style.setProperty('--dl', 0.15 * (i === 1 ? 2 : i === 0 ? 1 : 0) + 's');
      const disc = el('div', 'ff-pod-disc');
      disc.style.setProperty('--c', cssColor(r.color));
      disc.append(svgNode(BOAT_MINI_SVG));
      if (r.place === 1) disc.append(svgNode(CROWN_SVG));
      if (result.teams) disc.append(teamDiamond('ff-pod-team', teamColor(r.team, result.teams)));
      pod.append(
        disc,
        el('div', 'ff-pod-name', r.name),
        el('div', 'ff-pod-detail', r.detail),
        el('div', 'ff-pod-block', ordinal(r.place)),
      );
      if (r.isHuman) pod.querySelector('.ff-pod-name')?.prepend(svgNode(STAR_SVG), ' ');
      podium.append(pod);
    });

    for (const r of rows) {
      const row = el('div', 'ff-trow' + (r.isHuman ? ' is-human' : ''));
      const dot = el('span', 'ff-trow-dot');
      dot.style.setProperty('--c', cssColor(r.color));
      row.append(el('span', 'ff-trow-place', ordinal(r.place)), dot);
      if (result.teams) row.append(teamDiamond('ff-trow-team', teamColor(r.team, result.teams)));
      row.append(el('span', 'ff-trow-name', r.name));
      if (r.isHuman) row.append(svgNode(STAR_SVG));
      row.append(el('span', 'ff-trow-detail', r.detail));
      table.append(row);
    }
  }

  /**
   * `onRematch` null = an online guest: only the host can start another match, so the Rematch button is swapped for
   * `opts.waiting`, and `opts.menuLabel` renames the Menu button ("Leave").
   * `opts.lost` is an extra (not in the shared Hud type): a guest knows the sharks won even though it has no stats.
   */
  function showResults(
    result: MatchResult,
    onRematch: (() => void) | null,
    onMenu: () => void,
    opts?: { waiting?: string; menuLabel?: string; lost?: boolean },
  ): void {
    hidePause();
    resultsCb = { onRematch, onMenu };
    resultsArmedAt = performance.now() + RESULTS_ARM_MS;
    window.clearTimeout(trophyTimer);
    buildResults(result);
    rematchBtn.hidden = onRematch === null;
    resWait.hidden = onRematch !== null;
    if (onRematch === null) resWaitText.textContent = opts?.waiting ?? 'Waiting for the host...';
    menuBtn.textContent = opts?.menuLabel ?? 'Menu';
    resultsEl.hidden = false;
    resultsEl.classList.add('ff-nav');
    (onRematch === null ? menuBtn : rematchBtn).focus({ preventScroll: true });
    // Boats vs. Sharks: if nobody beat the MEGA SHARK, the sharks won. The game plays the friendly "wah-wah" itself,
    // so here there is no victory fanfare and no confetti (hud.css hides it under .is-lose).
    const stats = result.stats ?? [];
    const sharksWon =
      result.mode === 'sharks' &&
      (opts?.lost ?? (stats.length > 0 ? !stats.some((st) => st.megaDefeated) : SHARKS_WIN_TITLE.test(result.title)));
    resultsEl.classList.toggle('is-lose', sharksWon);
    if (!sharksWon) sfx.victory(); // rate-limited inside Sfx, so it is harmless if the game also calls it
    if ((result.awards ?? []).length > 0) {
      // one fanfare as the first trophy card pops in (the cards' CSS delay is the same TROPHY_DELAY_MS)
      trophyTimer = window.setTimeout(() => {
        trophyTimer = 0;
        if (!resultsEl.hidden) sfx.trophy();
      }, TROPHY_DELAY_MS);
    }
  }

  function hideResults(): void {
    window.clearTimeout(trophyTimer);
    trophyTimer = 0;
    resultsEl.hidden = true;
    resultsEl.classList.remove('is-lose');
    resultsCb = null;
  }

  function handleMenuInput(input: MenuInput): void {
    const open = !resultsEl.hidden ? resultsEl : !pauseEl.hidden ? pauseEl : null;
    if (!open) return;
    const { up, down, left, right, confirm } = input;
    if (!(up || down || left || right || confirm)) return;
    const results = open === resultsEl;
    const btns = results ? (rematchBtn.hidden ? resultBtnsMenuOnly : resultBtns) : pauseBtns;
    const active = document.activeElement;
    let idx = btns.indexOf(active as HTMLButtonElement);
    open.classList.add('ff-nav');

    if (confirm) {
      if (performance.now() < (results ? resultsArmedAt : pauseArmedAt)) return; // still "armed-off"
      btns[idx >= 0 ? idx : 0].click();
      return;
    }
    const step = (down || right ? 1 : 0) - (up || left ? 1 : 0);
    if (step === 0) return;
    idx = idx < 0 ? 0 : (idx + step + btns.length) % btns.length;
    btns[idx].focus();
    sfx.uiMove();
  }

  return {
    show,
    hide,
    update,
    announce,
    hint,
    feed,
    showPause,
    hidePause,
    showResults,
    setNetStatus,
    hideResults,
    handleMenuInput,
  };
}
