import './styles.css';
import type { BotDifficulty, MatchSetup, Menu, MenuInput, ModeId, Sfx } from '../types';
import { CONFIG } from '../config';
import {
  button,
  collectRows,
  colorName,
  cssColor,
  el,
  guardActivationKeys,
  installUnlock,
  stepFocus,
  storeGet,
  storeSet,
  svgNode,
} from './dom';

/** Title and match-setup screens. */

const STORAGE_KEY = 'foamfleet.setup.v1';
const NAME_MAX = 12;
const MAX_BOTS = 5; // the setup screen offers 0..5 bots
const BATTLE_SECONDS = [120, 180, 300]; // 2 / 3 / 5 minutes
const RACE_LAPS = [1, 3, 5];

/** Everything the setup screen edits. (Both players are kept so switching 1 <-> 2 players remembers them.) */
interface Form {
  humans: 1 | 2;
  mode: ModeId;
  bots: number;
  skill: BotDifficulty;
  names: [string, string];
  colors: [number, number];
  durationSec: number;
  laps: number;
}

// ───────────── form defaults, loading and saving ─────────────

function nearest(options: number[], v: number): number {
  let best = options[0];
  for (const o of options) if (Math.abs(o - v) < Math.abs(best - v)) best = o;
  return best;
}

function defaultForm(): Form {
  return {
    humans: 1,
    mode: 'battle',
    bots: Math.min(MAX_BOTS, CONFIG.match.defaultBots),
    skill: 'normal',
    names: ['Player 1', 'Player 2'],
    colors: [CONFIG.colors[0], CONFIG.colors[1] ?? CONFIG.colors[0]],
    durationSec: nearest(BATTLE_SECONDS, CONFIG.battle.durationSec),
    laps: nearest(RACE_LAPS, CONFIG.race.laps),
  };
}

/** Never trust saved data: copy over only the fields that look right. */
function sanitize(raw: unknown, base: Form): Form {
  const f: Form = { ...base, names: [...base.names], colors: [...base.colors] };
  if (!raw || typeof raw !== 'object') return f;
  const r = raw as Record<string, unknown>;
  if (r.humans === 1 || r.humans === 2) f.humans = r.humans;
  if (r.mode === 'battle' || r.mode === 'race') f.mode = r.mode;
  if (typeof r.bots === 'number' && Number.isFinite(r.bots)) {
    f.bots = Math.max(0, Math.min(MAX_BOTS, Math.round(r.bots)));
  }
  if (r.skill === 'easy' || r.skill === 'normal' || r.skill === 'hard') f.skill = r.skill;
  if (Array.isArray(r.names)) {
    for (let i = 0; i < 2; i++) {
      const n = r.names[i];
      if (typeof n === 'string') f.names[i] = n.slice(0, NAME_MAX);
    }
  }
  if (Array.isArray(r.colors)) {
    for (let i = 0; i < 2; i++) {
      const c = r.colors[i];
      if (typeof c === 'number' && CONFIG.colors.includes(c)) f.colors[i] = c;
    }
  }
  if (typeof r.durationSec === 'number') f.durationSec = nearest(BATTLE_SECONDS, r.durationSec);
  if (typeof r.laps === 'number') f.laps = nearest(RACE_LAPS, r.laps);
  return f;
}

function loadForm(): Form {
  const base = defaultForm();
  const text = storeGet(STORAGE_KEY);
  if (!text) return base;
  try {
    return sanitize(JSON.parse(text), base);
  } catch {
    return base;
  }
}

// ───────────── little pieces of art ─────────────

const BOAT_SVG = `
<svg viewBox="0 0 250 130" aria-hidden="true">
  <ellipse cx="118" cy="108" rx="104" ry="9" fill="#ffffff" fill-opacity=".45"/>
  <path class="hull" d="M14 62 H214 Q232 62 224 78 Q212 104 172 104 H58 Q28 104 20 84 Q12 70 14 62 Z" stroke="#06173d" stroke-width="4" stroke-linejoin="round"/>
  <path d="M22 78 H222 Q219 86 214 90 H30 Q25 85 22 78 Z" fill="#ffffff" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="92" cy="50" r="11" fill="#ffcf9f" stroke="#06173d" stroke-width="3"/>
  <path class="hull" d="M80 46 Q92 30 104 46 Z" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
  <path d="M120 62 L136 36 H154 L164 62 Z" fill="#bfeaff" stroke="#06173d" stroke-width="4" stroke-linejoin="round"/>
  <g transform="rotate(-12 178 56)">
    <rect x="168" y="42" width="58" height="16" rx="7" fill="#ff8a1f" stroke="#06173d" stroke-width="3.5"/>
    <rect x="206" y="42" width="20" height="16" rx="7" fill="#1e78ff" stroke="#06173d" stroke-width="3.5"/>
    <circle cx="176" cy="60" r="10" fill="#1e78ff" stroke="#06173d" stroke-width="3.5"/>
  </g>
  <g transform="translate(236 14) rotate(-12)">
    <rect x="-3" y="0" width="30" height="10" rx="5" fill="#1e78ff" stroke="#06173d" stroke-width="3"/>
    <rect x="20" y="0" width="12" height="10" rx="5" fill="#ff8a1f" stroke="#06173d" stroke-width="3"/>
  </g>
  <path d="M220 12 H236 M226 24 H240" stroke="#ffffff" stroke-width="4" stroke-linecap="round" stroke-opacity=".8"/>
</svg>`;

const SPEAKER_SVG = `
<svg class="ff-sound-icon" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M3 9 H7 L12 4.5 V19.5 L7 15 H3 Z" fill="#0b2a5b"/>
  <path class="waves" d="M15.5 8.5 Q18.5 12 15.5 15.5 M18 5.5 Q23 12 18 18.5" fill="none" stroke="#0b2a5b" stroke-width="2.2" stroke-linecap="round"/>
  <path class="slash" d="M3 3 L21 21" stroke="#d9261c" stroke-width="2.8" stroke-linecap="round"/>
</svg>`;

// ───────────── the menu ─────────────

export function createMenu(root: HTMLElement, sfx: Sfx): Menu {
  root.classList.add('ff-ui');
  installUnlock(sfx);

  let visible = false;
  let started = false; // stops a double-click from starting the match twice
  let screen: 'title' | 'setup' = 'title';
  let onStart: ((setup: MatchSetup) => void) | null = null;
  let form: Form = loadForm();

  const menuEl = el('div', 'ff-menu');
  menuEl.hidden = true;
  root.append(menuEl);

  function save(): void {
    storeSet(STORAGE_KEY, JSON.stringify(form));
  }

  function maxBots(): number {
    return Math.max(0, Math.min(MAX_BOTS, CONFIG.match.maxBoats - form.humans));
  }

  // ───── backdrop: sky, sun, bubbles and rolling waves (pure CSS, no images) ─────
  const bg = el('div', 'ff-bg');
  bg.append(el('div', 'ff-sun'));
  for (let i = 0; i < 12; i++) {
    const b = el('span', 'ff-bubble');
    b.style.setProperty('--x', ((i * 37 + 11) % 96) + '%');
    b.style.setProperty('--s', 14 + ((i * 13) % 5) * 9 + 'px');
    b.style.setProperty('--d', 9 + ((i * 7) % 6) * 2 + 's');
    b.style.setProperty('--dl', -((i * 5) % 11) + 's');
    bg.append(b);
  }
  bg.append(el('div', 'ff-waves'));
  menuEl.append(bg);

  // ───── title screen ─────
  const titleEl = el('section', 'ff-screen ff-title');

  const logo = el('h1', 'ff-logo');
  logo.setAttribute('aria-label', 'Foam Fleet');
  ['FOAM', 'FLEET'].forEach((word, w) => {
    const wordEl = el('span', 'ff-logo-word ff-logo-word--' + (w + 1));
    wordEl.setAttribute('aria-hidden', 'true');
    [...word].forEach((ch, i) => {
      const letter = el('span', 'ff-logo-letter ff-ol', ch);
      letter.style.setProperty('--i', String(i + w * 4));
      wordEl.append(letter);
    });
    logo.append(wordEl);
  });

  const tagline = el('p', 'ff-tagline ff-ol', 'Splashy speedboat dart battles!');
  const boatArt = el('div', 'ff-boat-art');
  boatArt.append(svgNode(BOAT_SVG));

  const playBtn = button('Play', 'ff-btn ff-btn--primary ff-btn--hero');
  const playRow = el('div', 'ff-row');
  playRow.append(playBtn);

  function keysCard(heading: string, lines: Array<{ keys: string[]; text: string }>): HTMLElement {
    const card = el('div', 'ff-keys');
    card.append(el('h3', 'ff-keys-head', heading));
    for (const line of lines) {
      const row = el('div', 'ff-keys-row');
      const caps = el('span', 'ff-keys-caps');
      for (const k of line.keys) caps.append(el('kbd', 'ff-key', k));
      row.append(caps, el('span', '', line.text));
      card.append(row);
    }
    return card;
  }
  const controls = el('div', 'ff-controls');
  controls.append(
    keysCard('Player 1 keys', [
      { keys: ['W', 'A', 'S', 'D'], text: 'Drive' },
      { keys: ['Space'], text: 'Fire' },
      { keys: ['Shift'], text: 'Boost' },
    ]),
    keysCard('Player 2 keys', [
      { keys: ['↑', '←', '↓', '→'], text: 'Drive' },
      { keys: ['Enter'], text: 'Fire' },
      { keys: ['Right Shift'], text: 'Boost' },
    ]),
    keysCard('Gamepad', [
      { keys: ['Left stick'], text: 'Steer' },
      { keys: ['RT'], text: 'Go' },
      { keys: ['A'], text: 'Fire' },
      { keys: ['B'], text: 'Boost' },
    ]),
  );
  titleEl.append(logo, tagline, boatArt, playRow, controls);

  // ───── setup screen ─────
  const setupEl = el('section', 'ff-screen ff-setup');
  setupEl.hidden = true;

  const head = el('div', 'ff-setup-head');
  const backBtn = button('← Back', 'ff-btn');
  const backRow = el('div', 'ff-row');
  backRow.append(backBtn);
  head.append(backRow, el('h2', 'ff-setup-title ff-ol', 'Get ready!'));

  /** A row of big toggle buttons where exactly one is selected. */
  interface SegItem<T> {
    value: T;
    label: string;
    sub?: string;
  }
  function makeSeg<T>(
    ariaLabel: string,
    items: SegItem<T>[],
    onPick: (v: T) => void,
  ): { row: HTMLElement; buttons: HTMLButtonElement[]; select: (v: T) => void } {
    const row = el('div', 'ff-row ff-seg');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', ariaLabel);
    const buttons = items.map((it) => {
      const b = button(it.label, 'ff-btn ff-seg-btn');
      if (it.sub) b.append(el('span', 'ff-seg-sub', it.sub));
      b.addEventListener('click', () => {
        sfx.uiSelect();
        onPick(it.value);
      });
      row.append(b);
      return b;
    });
    return {
      row,
      buttons,
      select(v: T) {
        items.forEach((it, i) => buttons[i].setAttribute('aria-pressed', String(it.value === v)));
      },
    };
  }

  function field(title: string, ...content: HTMLElement[]): { box: HTMLElement; label: HTMLElement } {
    const box = el('div', 'ff-field');
    const label = el('div', 'ff-label', title);
    box.append(label, ...content);
    return { box, label };
  }

  function changed(): void {
    // Two humans can't share a boat color: if P1 and P2 collide, P2 gets the next free one.
    if (form.humans === 2 && form.colors[0] === form.colors[1]) {
      form.colors[1] = CONFIG.colors.find((c) => c !== form.colors[0]) ?? form.colors[1];
    }
    form.bots = Math.min(form.bots, maxBots());
    applyForm();
    save();
  }

  const playersSeg = makeSeg<1 | 2>(
    'Players',
    [
      { value: 1, label: '1 Player' },
      { value: 2, label: '2 Players' },
    ],
    (v) => {
      form.humans = v;
      changed();
    },
  );
  const botsSeg = makeSeg<number>(
    'Computer boats',
    Array.from({ length: MAX_BOTS + 1 }, (_, n) => ({ value: n, label: String(n) })),
    (v) => {
      form.bots = v;
      changed();
    },
  );
  const modeSeg = makeSeg<ModeId>(
    'Game mode',
    [
      { value: 'battle', label: 'Dart Battle', sub: 'Tag boats with foam darts. Most tags wins!' },
      { value: 'race', label: 'Buoy Race', sub: 'Zip through the gates. First across wins!' },
    ],
    (v) => {
      form.mode = v;
      changed();
    },
  );
  const battleSeg = makeSeg<number>(
    'Battle length',
    BATTLE_SECONDS.map((s) => ({ value: s, label: s / 60 + ' min' })),
    (v) => {
      form.durationSec = v;
      changed();
    },
  );
  const lapsSeg = makeSeg<number>(
    'Race laps',
    RACE_LAPS.map((n) => ({ value: n, label: n + (n === 1 ? ' lap' : ' laps') })),
    (v) => {
      form.laps = v;
      changed();
    },
  );
  const skillSeg = makeSeg<BotDifficulty>(
    'Bot skill',
    [
      { value: 'easy', label: 'Easy' },
      { value: 'normal', label: 'Normal' },
      { value: 'hard', label: 'Hard' },
    ],
    (v) => {
      form.skill = v;
      changed();
    },
  );

  const playersField = field('Players', playersSeg.row);
  const botsField = field('Computer boats', botsSeg.row);
  const modeField = field('Game', modeSeg.row);
  const lengthField = field('Battle length', battleSeg.row, lapsSeg.row);
  const skillHint = el('div', 'ff-hint', 'Add some computer boats to pick their skill.');
  const skillField = field('Bot skill', skillSeg.row, skillHint);

  // per-player name + color
  interface PlayerCard {
    card: HTMLElement;
    input: HTMLInputElement;
    swatches: HTMLButtonElement[];
  }
  function buildPlayerCard(i: 0 | 1): PlayerCard {
    const card = el('div', 'ff-pcard');
    card.append(el('div', 'ff-label', `Player ${i + 1}`));

    const nameRow = el('div', 'ff-row');
    const input = el('input', 'ff-input');
    input.type = 'text';
    input.maxLength = NAME_MAX;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = `Player ${i + 1}`;
    input.setAttribute('data-nav', '');
    input.setAttribute('aria-label', `Player ${i + 1} name`);
    input.addEventListener('input', () => {
      form.names[i] = input.value;
      save();
    });
    input.addEventListener('focus', () => input.select()); // easy to type over the default
    nameRow.append(input);

    const swatchRow = el('div', 'ff-row ff-swatches');
    swatchRow.setAttribute('role', 'group');
    swatchRow.setAttribute('aria-label', `Player ${i + 1} boat color`);
    const swatches = CONFIG.colors.map((c) => {
      const s = el('button', 'ff-swatch');
      s.type = 'button';
      s.setAttribute('data-nav', '');
      s.style.setProperty('--c', cssColor(c));
      const nm = colorName(c);
      s.setAttribute('aria-label', nm);
      s.title = nm;
      s.addEventListener('click', () => {
        if (s.disabled) return;
        form.colors[i] = c;
        sfx.uiSelect();
        changed();
      });
      swatchRow.append(s);
      return s;
    });

    card.append(nameRow, swatchRow);
    return { card, input, swatches };
  }
  const pcards: [PlayerCard, PlayerCard] = [buildPlayerCard(0), buildPlayerCard(1)];

  const leftCol = el('div', 'ff-col');
  leftCol.append(playersField.box, botsField.box, modeField.box, lengthField.box);
  const rightCol = el('div', 'ff-col');
  rightCol.append(skillField.box, pcards[0].card, pcards[1].card);
  const grid = el('div', 'ff-card ff-grid');
  grid.append(leftCol, rightCol);

  const startBtn = button('Start!', 'ff-btn ff-btn--primary ff-btn--hero');
  const startRow = el('div', 'ff-row ff-start-wrap');
  startRow.append(startBtn);

  setupEl.append(head, grid, startRow);

  // ───── sound toggle (always reachable) ─────
  const soundRow = el('div', 'ff-row ff-sound-wrap');
  const soundBtn = button('', 'ff-btn ff-sound');
  const soundIcon = svgNode(SPEAKER_SVG);
  const soundText = el('span', '', '');
  soundBtn.append(soundIcon, soundText);
  soundRow.append(soundBtn);
  let shownMuted: boolean | null = null;
  function refreshSound(): void {
    const m = sfx.muted;
    shownMuted = m;
    soundBtn.setAttribute('aria-pressed', String(!m));
    soundBtn.setAttribute('aria-label', m ? 'Sound off. Turn sound on' : 'Sound on. Turn sound off');
    soundText.textContent = m ? 'Sound: Off' : 'Sound: On';
    soundIcon.classList.toggle('is-off', m);
  }
  soundBtn.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted);
    refreshSound();
    if (!sfx.muted) sfx.uiSelect();
  });

  menuEl.append(titleEl, setupEl, soundRow);

  // ───── keeping the screen in sync with `form` ─────
  function applyForm(): void {
    const f = form;
    const cap = maxBots();
    playersSeg.select(f.humans);
    botsSeg.select(f.bots);
    botsSeg.buttons.forEach((b, n) => {
      b.disabled = n > cap;
    });
    modeSeg.select(f.mode);
    lengthField.label.textContent = f.mode === 'battle' ? 'Battle length' : 'Race laps';
    battleSeg.row.hidden = f.mode !== 'battle';
    lapsSeg.row.hidden = f.mode !== 'race';
    battleSeg.select(f.durationSec);
    lapsSeg.select(f.laps);
    skillSeg.select(f.skill);
    const noBots = f.bots === 0;
    skillSeg.buttons.forEach((b) => {
      b.disabled = noBots;
    });
    skillHint.hidden = !noBots;

    pcards.forEach((pc, i) => {
      pc.card.hidden = i >= f.humans;
      pc.card.style.setProperty('--c', cssColor(f.colors[i]));
      pc.swatches.forEach((s, j) => {
        const c = CONFIG.colors[j];
        const mine = f.colors[i] === c;
        const takenByOther = f.humans === 2 && f.colors[1 - i] === c;
        s.setAttribute('aria-pressed', String(mine));
        s.disabled = takenByOther && !mine;
        if (takenByOther) s.dataset.taken = 'P' + (2 - i);
        else delete s.dataset.taken;
      });
    });
    boatArt.style.setProperty('--boat', cssColor(f.colors[0]));
  }

  // ───── screen switching ─────
  function showScreen(which: 'title' | 'setup'): void {
    screen = which;
    titleEl.hidden = which !== 'title';
    setupEl.hidden = which !== 'setup';
    if (which === 'setup') setupEl.scrollTop = 0;
    // Land on the big button so Enter / A keeps things moving.
    (which === 'title' ? playBtn : startBtn).focus({ preventScroll: true });
  }

  playBtn.addEventListener('click', () => {
    sfx.uiSelect();
    showScreen('setup');
  });
  backBtn.addEventListener('click', () => {
    sfx.uiMove();
    showScreen('title');
  });
  startBtn.addEventListener('click', () => {
    if (started || !onStart) return;
    started = true;
    sfx.uiSelect();
    save();
    onStart(buildSetup());
  });

  function cleanName(i: number): string {
    return form.names[i].trim().slice(0, NAME_MAX) || `Player ${i + 1}`;
  }

  function buildSetup(): MatchSetup {
    const humans = form.humans;
    const players: MatchSetup['players'] = [];
    for (let i = 0; i < humans; i++) players.push({ name: cleanName(i), color: form.colors[i] });
    return {
      mode: form.mode,
      humans,
      bots: Math.min(form.bots, maxBots()),
      botDifficulty: form.skill,
      players,
      durationSec: form.durationSec,
      laps: form.laps,
    };
  }

  // ───── input from mouse / keyboard focus / gamepad ─────
  guardActivationKeys(() => visible);
  menuEl.addEventListener('pointerdown', () => menuEl.classList.remove('ff-nav'));
  window.addEventListener('keydown', (e) => {
    if (visible && e.key === 'Tab') menuEl.classList.add('ff-nav');
  });

  function update(input: MenuInput): void {
    if (!visible) return;
    if (sfx.muted !== shownMuted) refreshSound(); // someone pressed M
    const { up, down, left, right, confirm, back } = input;
    if (!(up || down || left || right || confirm || back)) return;

    menuEl.classList.add('ff-nav'); // show the focus ring now that keys/pad are in use
    const active = document.activeElement;
    const inMenu = active instanceof HTMLElement && menuEl.contains(active);
    const typing = active instanceof HTMLInputElement;

    if (back) {
      if (typing) active.blur(); // Escape just leaves the name box
      else if (screen === 'setup') {
        sfx.uiMove();
        showScreen('title');
      }
      return;
    }
    if (confirm) {
      if (typing) {
        // Enter in the name box = "done", hop to the colors
        const next = stepFocus(collectRows(menuEl), active, 0, 1);
        active.blur();
        if (next) next.focus();
      } else if (inMenu && active instanceof HTMLButtonElement) {
        active.click();
      } else {
        (screen === 'title' ? playBtn : startBtn).focus();
      }
      return;
    }
    const dx = (right ? 1 : 0) - (left ? 1 : 0);
    const dy = (down ? 1 : 0) - (up ? 1 : 0);
    const target = stepFocus(collectRows(menuEl), inMenu ? active : null, dx, dy);
    if (target) {
      target.focus();
      sfx.uiMove();
    }
  }

  // ───── public ─────
  function show(initial: MatchSetup | null, cb: (setup: MatchSetup) => void): void {
    onStart = cb;
    started = false;
    form = loadForm();
    if (initial) {
      form.humans = initial.humans;
      form.mode = initial.mode;
      form.bots = Math.max(0, Math.min(MAX_BOTS, initial.bots));
      form.skill = initial.botDifficulty;
      form.durationSec = nearest(BATTLE_SECONDS, initial.durationSec);
      form.laps = nearest(RACE_LAPS, initial.laps);
      initial.players.forEach((p, i) => {
        if (i > 1) return;
        form.names[i] = p.name.slice(0, NAME_MAX);
        if (CONFIG.colors.includes(p.color)) form.colors[i] = p.color;
      });
    }
    pcards[0].input.value = form.names[0];
    pcards[1].input.value = form.names[1];
    changed();
    menuEl.hidden = false;
    visible = true;
    menuEl.classList.add('ff-nav');
    refreshSound();
    showScreen('title');
  }

  function hide(): void {
    menuEl.hidden = true;
    visible = false;
    started = false;
  }

  return {
    show,
    hide,
    update,
    get visible(): boolean {
      return visible;
    },
  };
}
