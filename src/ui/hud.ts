import './styles.css';
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
  Viewport,
} from '../types';
import { CONFIG } from '../config';
import { button, clamp, cssColor, el, guardActivationKeys, installUnlock, ordinal, svgNode } from './dom';

/** In-match overlay: per-player panels, timer, feed, pause and results screens. */

/** Event-feed lines on screen at once (newest on top, right under the timer). */
const FEED_MAX = 3;
/** One player in a race has the next-gate arrow under the timer, so the feed gets one line less room there. */
const FEED_MAX_1P_RACE = 2;
/** Ignore "confirm" for a moment after an overlay opens, so a kid mashing Fire can't skip the results. */
const RESULTS_ARM_MS = 900;
const PAUSE_ARM_MS = 250;

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

const BOAT_MINI_SVG = `<svg viewBox="0 0 48 32" aria-hidden="true">
  <path d="M3 18 H45 Q42 29 31 29 H14 Q6 29 3 18 Z" fill="#ffffff" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
  <path d="M17 18 L21 8 H31 L35 18 Z" fill="#bfeaff" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
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

// ───────────── one player's panel (fills one viewport) ─────────────

interface Panel {
  root: HTMLElement;
  setRect(v: Viewport): void;
  apply(p: PlayerHud, mode: ModeId): void;
  reset(): void;
  announcer: Announcer;
}

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
  scoreBox.append(el('span', 'ff-scorelbl', 'SCORE'), scoreNum);
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

  cluster.append(powerEl, shieldEl, ammoEl, boostEl);

  const announcer = createAnnouncer('');
  root.append(tag, arrowEl, reticle, cluster, announcer.root);

  // what is currently on screen (NaN / sentinel values force the first write)
  let cx = NaN, cy = NaN, cw = NaN, ch = NaN;
  let cMode: ModeId | '' = '';
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

  function setRect(v: Viewport): void {
    if (v.x !== cx) { root.style.left = v.x + 'px'; cx = v.x; }
    if (v.y !== cy) { root.style.top = v.y + 'px'; cy = v.y; }
    if (v.width !== cw || v.height !== ch) {
      cw = v.width;
      ch = v.height;
      root.style.width = v.width + 'px';
      root.style.height = v.height + 'px';
      // --u scales every size in this panel: smaller viewport (split screen) = smaller HUD
      root.style.setProperty('--u', panelScale(v).toFixed(3));
    }
  }

  function apply(p: PlayerHud, mode: ModeId): void {
    if (mode !== cMode) {
      cMode = mode;
      root.classList.toggle('is-race', mode === 'race');
    }
    if (p.name !== cName) {
      cName = p.name;
      nameEl.textContent = p.name;
    }
    if (p.color !== cColor) {
      cColor = p.color;
      root.style.setProperty('--pc', cssColor(p.color));
    }

    // score or race standing
    if (mode === 'battle') {
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
  }

  function reset(): void {
    cx = cy = cw = ch = NaN;
    cMode = '';
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

  return { root, setRect, apply, reset, announcer };
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
    name: HTMLElement;
    score: HTMLElement;
    nameText: string | null;
    color: number;
    scoreVal: number;
    human: boolean | null;
  }
  const sbRows: SbRow[] = [];
  let sbCount = -1;
  let cSbRace: boolean | null = null;

  function addSbRow(rank: number): SbRow {
    const row = el('div', 'ff-sbrow');
    const dot = el('span', 'ff-sb-dot');
    const name = el('span', 'ff-sb-name');
    const score = el('span', 'ff-sb-score');
    row.append(el('span', 'ff-sb-rank', String(rank)), dot, name, score);
    sbEl.append(row);
    return { row, dot, name, score, nameText: null, color: -1, scoreVal: NaN, human: null };
  }

  // feed + global announcer
  const feedEl = el('div', 'ff-feed');
  let feedMax = FEED_MAX;
  let cLiveRace: boolean | null = null;
  let cFeedU = NaN;
  const globalAnn = createAnnouncer('ff-ann--global');
  live.append(timerEl, sbEl, feedEl, globalAnn.root);
  root.append(live);

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
  pauseCard.append(el('h2', 'ff-h1 ff-ol', 'Paused'), pauseRow1, pauseRow2);
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
  const podium = el('div', 'ff-podium');
  const table = el('div', 'ff-table');
  const resBody = el('div', 'ff-res-body');
  resBody.append(podium, table);
  const rematchBtn = button('Rematch', 'ff-btn ff-btn--primary ff-btn--xl');
  const menuBtn = button('Menu', 'ff-btn ff-btn--xl');
  const resActions = el('div', 'ff-row ff-res-actions');
  resActions.append(rematchBtn, menuBtn);
  resCard.append(resTitle, resBody, resActions);
  resultsEl.append(confetti, resCard);
  const resultBtns = [rematchBtn, menuBtn];
  let resultsCb: { onRematch: () => void; onMenu: () => void } | null = null;
  let resultsArmedAt = 0;

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
    if (!cb) return;
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
    for (const r of sbRows) {
      r.nameText = null;
      r.color = -1;
      r.scoreVal = NaN;
      r.human = null;
    }
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
    let kind: 'battle' | 'race' | '' = '';
    let key = NaN;
    if (s.mode === 'battle' && s.timeLeft !== null) {
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

  function update(state: HudState): void {
    const n = Math.min(state.viewports.length, state.players.length);
    while (panels.length < n) {
      const p = createPanel();
      panelsEl.append(p.root);
      panels.push(p);
    }
    for (let i = 0; i < panels.length; i++) {
      const on = i < n;
      const panel = panels[i];
      if (panel.root.hidden === on) panel.root.hidden = !on;
      if (on) {
        panel.setRect(state.viewports[i]);
        panel.apply(state.players[i], state.mode);
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
    updateScoreboard(state);
  }

  function announce(text: string, opts?: { sub?: string; ms?: number; viewport?: number }): void {
    const ms = opts?.ms ?? 1200;
    const v = opts?.viewport;
    const target = v !== undefined && v >= 0 && v < panels.length ? panels[v].announcer : globalAnn;
    target.show(text, opts?.sub, ms);
  }

  function feed(text: string, color?: number): void {
    const item = el('div', 'ff-feed-item', text);
    item.style.setProperty('--fc', cssColor(color ?? 0xffffff));
    item.addEventListener('animationend', () => item.remove(), { once: true });
    feedEl.prepend(item); // newest on top, nearest the timer where eyes already are
    while (feedEl.childElementCount > feedMax) feedEl.lastElementChild?.remove();
  }

  function showPause(onResume: () => void, onQuit: () => void): void {
    pauseCb = { onResume, onQuit };
    pauseArmedAt = performance.now() + PAUSE_ARM_MS;
    pauseEl.hidden = false;
    pauseEl.classList.add('ff-nav');
    resumeBtn.focus({ preventScroll: true });
  }

  function hidePause(): void {
    pauseEl.hidden = true;
    pauseCb = null;
  }

  function buildResults(result: MatchResult): void {
    resTitle.textContent = result.title;
    podium.textContent = '';
    table.textContent = '';

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
      row.append(el('span', 'ff-trow-place', ordinal(r.place)), dot, el('span', 'ff-trow-name', r.name));
      if (r.isHuman) row.append(svgNode(STAR_SVG));
      row.append(el('span', 'ff-trow-detail', r.detail));
      table.append(row);
    }
  }

  function showResults(result: MatchResult, onRematch: () => void, onMenu: () => void): void {
    hidePause();
    resultsCb = { onRematch, onMenu };
    resultsArmedAt = performance.now() + RESULTS_ARM_MS;
    buildResults(result);
    resultsEl.hidden = false;
    resultsEl.classList.add('ff-nav');
    rematchBtn.focus({ preventScroll: true });
    sfx.victory(); // rate-limited inside Sfx, so it is harmless if the game also calls it
  }

  function hideResults(): void {
    resultsEl.hidden = true;
    resultsCb = null;
  }

  function handleMenuInput(input: MenuInput): void {
    const open = !resultsEl.hidden ? resultsEl : !pauseEl.hidden ? pauseEl : null;
    if (!open) return;
    const { up, down, left, right, confirm } = input;
    if (!(up || down || left || right || confirm)) return;
    const results = open === resultsEl;
    const btns = results ? resultBtns : pauseBtns;
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
    feed,
    showPause,
    hidePause,
    showResults,
    hideResults,
    handleMenuInput,
  };
}
