import './styles.css';
import type { BoatLook, BotDifficulty, MatchSetup, Menu, MenuInput, ModeId, Sfx, TrophyDef } from '../types';
import { CONFIG } from '../config';
import {
  button,
  collectRows,
  cssColor,
  el,
  field,
  guardActivationKeys,
  installUnlock,
  makeSeg,
  makeSwatches,
  silentTestMode,
  stepFocus,
  storeGet,
  storeSet,
  svgNode,
  touchAvailable,
} from './dom';
import { createGarage, defaultLook, describeLook, sanitizeLook } from './garage';
import { TROPHIES, loadShelf, loadShelfColors } from './trophies';

/** Title, match-setup, Boat Garage and Trophy Shelf screens. */

// Same key as v1: old saves still load, and anything they lack (looks, Easy Driving) gets a default.
const STORAGE_KEY = 'foamfleet.setup.v1';
const NAME_MAX = 12;
const MAX_BOTS = 5; // the setup screen offers 0..5 bots
const MAX_HELPERS = 3; // Boats vs. Sharks: 0..3 helper boats on your team
const BATTLE_SECONDS = [120, 180, 300]; // 2 / 3 / 5 minutes
const RACE_LAPS = [1, 3, 5];

const MODES: ReadonlyArray<{ id: ModeId; label: string; icon: string; sub: string }> = [
  { id: 'battle', label: 'Dart Battle', icon: '🎯', sub: 'Tag boats with foam darts. Most tags wins!' },
  { id: 'race', label: 'Buoy Race', icon: '🏁', sub: 'Zip through the gates. First across wins!' },
  { id: 'team', label: 'Team Up', icon: '🤝', sub: `Your team vs. the ${CONFIG.team.names[1]}. Most tags wins!` },
  { id: 'practice', label: 'Balloon Pop', icon: '🎈', sub: 'Pop all the balloons! Dart them or just drive through.' },
  {
    id: 'sharks',
    label: 'Boats vs. Sharks',
    icon: '🦈',
    sub: `Team up! Scare off ${CONFIG.sharks.waves.length} waves of sharks, then the MEGA SHARK!`,
  },
];

// The bot-skill buttons double as the sharks' swimming speed in Boats vs. Sharks.
const SKILL_LABELS: readonly string[] = ['Easy', 'Normal', 'Hard'];
const SPEED_LABELS: readonly string[] = ['Slow', 'Normal', 'Fast'];
const BOT_SKILL_HINT = 'Add some computer boats to pick their skill.';
const SHARK_SPEED_HINT = 'Slow sharks are easy to dodge. Fast ones keep you busy!';

/** Everything the setup screen edits. (Both players are kept so switching 1 <-> 2 players remembers them.) */
interface Form {
  humans: 1 | 2;
  mode: ModeId;
  bots: number;
  /** Boats vs. Sharks: helper boats on your team (kept apart from `bots`, so each mode remembers its own number). */
  helpers: number;
  skill: BotDifficulty;
  names: [string, string];
  colors: [number, number];
  looks: [BoatLook, BoatLook];
  easy: [boolean, boolean];
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
    helpers: Math.max(0, Math.min(MAX_HELPERS, CONFIG.sharks.defaultHelpers)),
    skill: 'normal',
    names: ['Player 1', 'Player 2'],
    colors: [CONFIG.colors[0], CONFIG.colors[1] ?? CONFIG.colors[0]],
    looks: [defaultLook(0), defaultLook(1)],
    easy: [true, true], // Easy Driving starts ON: it is the friendly way in
    durationSec: nearest(BATTLE_SECONDS, CONFIG.battle.durationSec),
    laps: nearest(RACE_LAPS, CONFIG.race.laps),
  };
}

function isMode(v: unknown): v is ModeId {
  return MODES.some((m) => m.id === v);
}

/** Read one player (the shape of `PlayerSetup`, but any field may be missing) into the form. */
function applyPlayer(f: Form, i: number, p: unknown): void {
  if (!p || typeof p !== 'object') return;
  const r = p as Record<string, unknown>;
  if (typeof r.name === 'string') f.names[i] = r.name.slice(0, NAME_MAX);
  if (typeof r.color === 'number' && CONFIG.colors.includes(r.color)) f.colors[i] = r.color;
  f.looks[i] = sanitizeLook(r.look, f.looks[i]);
  if (typeof r.easyDriving === 'boolean') f.easy[i] = r.easyDriving;
}

/** Never trust saved data: copy over only the fields that look right. */
function sanitize(raw: unknown, base: Form): Form {
  const f: Form = {
    ...base,
    names: [...base.names],
    colors: [...base.colors],
    looks: [{ ...base.looks[0] }, { ...base.looks[1] }],
    easy: [...base.easy],
  };
  if (!raw || typeof raw !== 'object') return f;
  const r = raw as Record<string, unknown>;
  if (r.humans === 1 || r.humans === 2) f.humans = r.humans;
  // A mode this version doesn't know (an old or damaged save) falls back to the classic Dart Battle.
  if (r.mode !== undefined) f.mode = isMode(r.mode) ? r.mode : 'battle';
  if (typeof r.bots === 'number' && Number.isFinite(r.bots)) {
    f.bots = Math.max(0, Math.min(MAX_BOTS, Math.round(r.bots)));
  }
  if (typeof r.helpers === 'number' && Number.isFinite(r.helpers)) {
    f.helpers = Math.max(0, Math.min(MAX_HELPERS, Math.round(r.helpers)));
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
  if (Array.isArray(r.looks)) {
    for (let i = 0; i < 2; i++) f.looks[i] = sanitizeLook(r.looks[i], f.looks[i]);
  }
  if (Array.isArray(r.easy)) {
    for (let i = 0; i < 2; i++) {
      const e = r.easy[i];
      if (typeof e === 'boolean') f.easy[i] = e;
    }
  }
  // A saved MatchSetup-style `players` list (name / color / look / easyDriving) works too.
  if (Array.isArray(r.players)) {
    for (let i = 0; i < 2; i++) applyPlayer(f, i, r.players[i]);
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

// ───────────── Trophy Shelf pieces ─────────────

function trophyTile(t: TrophyDef, earned: boolean): HTMLElement {
  const tile = el('div', 'ff-trophy ' + (earned ? 'is-earned' : 'is-locked'));
  tile.setAttribute('role', 'listitem');
  const icon = el('span', 'ff-trophy-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(el('span', 'ff-trophy-emoji', t.icon));
  const text = el('div', 'ff-trophy-text');
  // Earned = full color; not yet = grey silhouette. The tag says so in words too.
  text.append(
    el('div', 'ff-trophy-name', t.name),
    el('div', 'ff-trophy-desc', t.description),
    el('div', 'ff-trophy-tag', earned ? 'Earned!' : 'Not yet'),
  );
  tile.append(icon, text);
  return tile;
}

/** One player's shelf: every trophy in the game, earned ones lit up. */
function shelfCard(name: string, earned: ReadonlySet<string>, color: number | null): HTMLElement {
  const card = el('div', 'ff-card ff-shelf-card');
  if (color !== null) card.style.setProperty('--c', cssColor(color));
  const head = el('div', 'ff-shelf-head');
  const count = TROPHIES.filter((t) => earned.has(t.id)).length;
  head.append(
    el('span', 'ff-shelf-dot'),
    el('h3', 'ff-shelf-name', name),
    el('span', 'ff-shelf-count', `${count} of ${TROPHIES.length}`),
  );
  const grid = el('div', 'ff-trophy-grid');
  grid.setAttribute('role', 'list');
  for (const t of TROPHIES) grid.append(trophyTile(t, earned.has(t.id)));
  card.append(head, grid);
  return card;
}

// ───────────── the menu ─────────────

type Screen = 'title' | 'setup' | 'garage' | 'shelf';

export function createMenu(root: HTMLElement, sfx: Sfx): Menu {
  root.classList.add('ff-ui');
  installUnlock(sfx);
  const touchDevice = touchAvailable(); // an iPad (or ?touch=1): show the Touch card, hide the keyboard focus ring
  const silent = silentTestMode(); // ?mute=1: the sound button is switched off so a test page stays quiet

  let visible = false;
  let started = false; // stops a double-click from starting the match twice
  let screen: Screen = 'title';
  let garageFor: 0 | 1 = 0; // whose boat the garage is showing
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
  /** Team Up needs someone to play against; Balloon Pop has no computer boats at all. */
  function minBots(): number {
    return form.mode === 'team' ? 1 : 0;
  }
  /** The computer boats this setup really gets (the saved numbers are kept for the other modes). */
  function botCount(): number {
    if (form.mode === 'practice') return 0;
    if (form.mode === 'sharks') return Math.max(0, Math.min(form.helpers, MAX_HELPERS, maxBots())); // helper boats
    return Math.max(minBots(), Math.min(form.bots, maxBots()));
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
  const shelfBtn = button('🏆 Trophy Shelf', 'ff-btn ff-btn--lg');
  const shelfRow = el('div', 'ff-row');
  shelfRow.append(shelfBtn);

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
  if (touchDevice) {
    // Fingers first on an iPad; the keyboard and gamepad cards stay (a gamepad can still be paired).
    controls.classList.add('ff-controls--touch');
    const touchCard = keysCard('Touch', [
      { keys: ['Left thumb'], text: 'Steer' },
      { keys: ['Right thumb'], text: 'FIRE and BOOST' },
      { keys: ['II'], text: 'Pause' },
    ]);
    touchCard.classList.add('ff-keys--touch');
    controls.append(touchCard);
  }
  controls.append(
    keysCard('Player 1 keys', [
      { keys: ['W', 'A', 'S', 'D'], text: 'Drive' },
      { keys: ['Space'], text: 'Fire' },
      { keys: ['Shift'], text: 'Boost' },
      { keys: ['R'], text: 'Rescue' },
      { keys: ['Q'], text: 'Honk' },
    ]),
    keysCard('Player 2 keys', [
      { keys: ['↑', '←', '↓', '→'], text: 'Drive' },
      { keys: ['Enter'], text: 'Fire' },
      { keys: ['Right Shift'], text: 'Boost' },
      { keys: ['/'], text: 'Rescue' },
      { keys: ["'"], text: 'Honk' },
    ]),
    keysCard('Gamepad', [
      { keys: ['Left stick'], text: 'Steer' },
      { keys: ['RT'], text: 'Go' },
      { keys: ['A'], text: 'Fire' },
      { keys: ['B'], text: 'Boost' },
      { keys: ['Y'], text: 'Rescue' },
      { keys: ['X'], text: 'Honk' },
    ]),
  );
  titleEl.append(logo, tagline, boatArt, playRow, shelfRow, controls);

  // ───── setup screen ─────
  const setupEl = el('section', 'ff-screen ff-setup');
  setupEl.hidden = true;

  const head = el('div', 'ff-setup-head');
  const backBtn = button('← Back', 'ff-btn');
  const backRow = el('div', 'ff-row');
  backRow.append(backBtn);
  head.append(backRow, el('h2', 'ff-setup-title ff-ol', 'Get ready!'));

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
    sfx,
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
    sfx,
    'Computer boats',
    Array.from({ length: MAX_BOTS + 1 }, (_, n) => ({ value: n, label: String(n) })),
    (v) => {
      form.bots = v;
      changed();
    },
  );
  const helpersSeg = makeSeg<number>(
    sfx,
    'Helper boats',
    Array.from({ length: MAX_HELPERS + 1 }, (_, n) => ({ value: n, label: String(n) })),
    (v) => {
      form.helpers = v;
      changed();
    },
  );
  const modeSeg = makeSeg<ModeId>(
    sfx,
    'Game mode',
    MODES.map((m) => ({ value: m.id, label: m.label, icon: m.icon, sub: m.sub })),
    (v) => {
      form.mode = v;
      changed();
    },
  );
  modeSeg.row.classList.add('ff-modes');
  const battleSeg = makeSeg<number>(
    sfx,
    'Match length',
    BATTLE_SECONDS.map((s) => ({ value: s, label: s / 60 + ' min' })),
    (v) => {
      form.durationSec = v;
      changed();
    },
  );
  const lapsSeg = makeSeg<number>(
    sfx,
    'Race laps',
    RACE_LAPS.map((n) => ({ value: n, label: n + (n === 1 ? ' lap' : ' laps') })),
    (v) => {
      form.laps = v;
      changed();
    },
  );
  const skillSeg = makeSeg<BotDifficulty>(
    sfx,
    'Bot skill',
    [
      { value: 'easy', label: SKILL_LABELS[0] },
      { value: 'normal', label: SKILL_LABELS[1] },
      { value: 'hard', label: SKILL_LABELS[2] },
    ],
    (v) => {
      form.skill = v;
      changed();
    },
  );

  const modeField = field('Game', modeSeg.row);
  const playersField = field('Players', playersSeg.row);
  const teamHint = el('div', 'ff-help');
  const botsField = field('Computer boats', botsSeg.row, teamHint);
  const helpersHint = el('div', 'ff-help', 'Helper boats are on your team. They scare off sharks too!');
  const helpersField = field('Helper boats', helpersSeg.row, helpersHint);
  const lengthField = field('Battle length', battleSeg.row, lapsSeg.row);
  const skillHint = el('div', 'ff-help', BOT_SKILL_HINT);
  const skillField = field('Bot skill', skillSeg.row, skillHint);
  const practiceNote = el(
    'div',
    'ff-note',
    `No computer boats here! Pop all ${CONFIG.practice.balloons} balloons as fast as you can. ` +
      'Gold balloons are worth 3. Dart them, or just drive right through them!',
  );
  const sharksNote = el(
    'div',
    'ff-note',
    `Scare off ${CONFIG.sharks.waves.length} waves of sharks with your darts, then the MEGA SHARK! ` +
      `Every bump pops a life ring. Your team has ${CONFIG.sharks.lifeRings}.`,
  );

  // per-player name + color + Easy Driving + garage
  interface PlayerCard {
    card: HTMLElement;
    input: HTMLInputElement;
    swatches: ReturnType<typeof makeSwatches>;
    easyBtn: HTMLButtonElement;
    easyState: HTMLElement;
    easyHint: HTMLElement;
    garageBtn: HTMLButtonElement;
    garageSub: HTMLElement;
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
    // iPad keyboard: capital letters for names, no auto-correct, and a "done" key that closes it.
    input.setAttribute('autocapitalize', 'words');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('enterkeyhint', 'done');
    input.placeholder = `Player ${i + 1}`;
    input.setAttribute('data-nav', '');
    input.setAttribute('aria-label', `Player ${i + 1} name`);
    input.addEventListener('input', () => {
      form.names[i] = input.value;
      save();
    });
    input.addEventListener('focus', () => input.select()); // easy to type over the default
    nameRow.append(input);

    const swatches = makeSwatches(sfx, `Player ${i + 1} boat color`, CONFIG.colors, (c) => {
      form.colors[i] = c;
      changed();
    });

    // Easy Driving: one big switch, with a sentence about what it does.
    const easyBtn = button('', 'ff-btn ff-toggle');
    const easySwitch = el('span', 'ff-switch');
    easySwitch.append(el('i'));
    easySwitch.setAttribute('aria-hidden', 'true');
    const easyState = el('span', 'ff-toggle-state');
    easyBtn.append(el('span', 'ff-toggle-name', 'Easy Driving'), easySwitch, easyState);
    easyBtn.addEventListener('click', () => {
      form.easy[i] = !form.easy[i];
      sfx.uiSelect();
      changed();
    });
    const easyRow = el('div', 'ff-row');
    easyRow.append(easyBtn);
    const easyHint = el('div', 'ff-help');

    const garageBtn = button('🔧 Boat Garage', 'ff-btn ff-garage-btn');
    const garageSub = el('span', 'ff-seg-sub');
    garageBtn.append(garageSub);
    garageBtn.addEventListener('click', () => {
      sfx.uiSelect();
      openGarage(i);
    });
    const garageRow = el('div', 'ff-row');
    garageRow.append(garageBtn);

    card.append(nameRow, swatches.row, easyRow, easyHint, garageRow);
    return { card, input, swatches, easyBtn, easyState, easyHint, garageBtn, garageSub };
  }
  const pcards: [PlayerCard, PlayerCard] = [buildPlayerCard(0), buildPlayerCard(1)];

  const optsCol = el('div', 'ff-col');
  optsCol.append(
    playersField.box,
    botsField.box,
    helpersField.box,
    skillField.box,
    lengthField.box,
    practiceNote,
    sharksNote,
  );
  const grid = el('div', 'ff-grid');
  grid.append(optsCol, pcards[0].card, pcards[1].card);
  const setupCard = el('div', 'ff-card ff-setup-card');
  setupCard.append(modeField.box, grid);

  const startBtn = button('Start!', 'ff-btn ff-btn--primary ff-btn--hero');
  const startRow = el('div', 'ff-row ff-start-wrap');
  startRow.append(startBtn);

  setupEl.append(head, setupCard, startRow);

  // ───── Boat Garage screen (its own module) ─────
  const garage = createGarage(sfx);
  garage.el.hidden = true;

  function openGarage(i: 0 | 1): void {
    garageFor = i;
    garage.open(
      {
        title: `${cleanName(i)}'s boat`,
        look: form.looks[i],
        color: form.colors[i],
        takenBy: (c) => (form.humans === 2 && form.colors[1 - i] === c ? 'P' + (2 - i) : null),
        onLook: (look) => {
          form.looks[i] = look;
          changed();
        },
        onColor: (c) => {
          form.colors[i] = c;
          changed();
        },
      },
      closeGarage,
    );
    showScreen('garage');
  }
  function closeGarage(): void {
    showScreen('setup', pcards[garageFor].garageBtn);
  }

  // ───── Trophy Shelf screen ─────
  const shelfEl = el('section', 'ff-screen ff-shelf');
  shelfEl.hidden = true;
  const shelfBackBtn = button('← Back', 'ff-btn');
  const shelfBackRow = el('div', 'ff-row');
  shelfBackRow.append(shelfBackBtn);
  const shelfHead = el('div', 'ff-setup-head');
  shelfHead.append(shelfBackRow, el('h2', 'ff-setup-title ff-ol', 'Trophy Shelf'));
  const shelfBody = el('div', 'ff-shelf-body');
  shelfEl.append(shelfHead, shelfBody);

  /** Rebuild the shelf from what is saved right now (a match may have just added trophies). */
  function renderShelf(): void {
    shelfBody.replaceChildren();
    const saved = loadShelf();
    const colors = loadShelfColors();
    // The people about to play come first, then everyone else, newest winners first.
    const current = form.names.slice(0, form.humans).map((_, i) => cleanName(i));
    const rank = (n: string): number => {
      const k = current.indexOf(n);
      return k < 0 ? current.length : k;
    };
    const names = Object.keys(saved)
      .reverse()
      .sort((a, b) => rank(a) - rank(b));
    if (names.length === 0) {
      shelfBody.append(
        el('p', 'ff-shelf-empty ff-ol', 'No trophies yet. Play a game to win your first one!'),
        shelfCard('Trophies to win', new Set(), null),
      );
      return;
    }
    for (const name of names) {
      const c = colors[name];
      shelfBody.append(shelfCard(name, new Set(saved[name]), typeof c === 'number' ? c : null));
    }
  }

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
  soundBtn.disabled = silent;
  soundBtn.addEventListener('click', () => {
    if (silent) return; // silent test mode: the game stays muted for this page load
    sfx.setMuted(!sfx.muted);
    refreshSound();
    if (!sfx.muted) sfx.uiSelect();
  });

  menuEl.append(titleEl, setupEl, garage.el, shelfEl, soundRow);

  // ───── keeping the screen in sync with `form` ─────
  function teamSplitText(): string {
    const humans = form.humans;
    const total = humans + botCount();
    const mine = Math.max(humans, Math.ceil(total / 2)); // humans + helper boats
    const helpers = mine - humans;
    const them = total - mine;
    const [mineName, theirName] = CONFIG.team.names;
    const who = humans === 1 ? 'you' : 'you both';
    const plus = helpers > 0 ? ` + ${helpers} helper boat${helpers === 1 ? '' : 's'}` : '';
    return `${mineName}: ${who}${plus}. ${theirName}: ${them} boat${them === 1 ? '' : 's'}.`;
  }

  function applyForm(): void {
    const f = form;
    const cap = maxBots();
    const count = botCount();
    const practice = f.mode === 'practice';
    const sharks = f.mode === 'sharks';
    const hasBots = !practice && !sharks;

    playersSeg.select(f.humans);
    modeSeg.select(f.mode);

    // computer boats (not in Balloon Pop; Team Up needs at least one rival; Boats vs. Sharks has helper boats instead)
    botsField.box.hidden = !hasBots;
    botsField.label.textContent = f.mode === 'team' ? 'Computer boats (both teams)' : 'Computer boats';
    botsSeg.select(count);
    botsSeg.buttons.forEach((b, n) => {
      b.disabled = n > cap || n < minBots();
    });
    teamHint.hidden = f.mode !== 'team';
    if (f.mode === 'team') teamHint.textContent = teamSplitText();
    helpersField.box.hidden = !sharks;
    helpersSeg.select(count);
    helpersSeg.buttons.forEach((b, n) => {
      b.disabled = n > cap;
    });

    // the skill buttons: bot skill, or in Boats vs. Sharks how fast the sharks swim
    skillField.box.hidden = practice;
    skillField.label.textContent = sharks ? 'Shark speed' : 'Bot skill';
    skillSeg.row.setAttribute('aria-label', sharks ? 'Shark speed' : 'Bot skill');
    skillSeg.buttons.forEach((b, i) => {
      b.textContent = (sharks ? SPEED_LABELS : SKILL_LABELS)[i];
    });
    skillSeg.select(f.skill);
    const noBots = count === 0 && !sharks; // sharks swim whether or not any helpers come along
    skillSeg.buttons.forEach((b) => {
      b.disabled = noBots;
    });
    skillHint.textContent = sharks ? SHARK_SPEED_HINT : BOT_SKILL_HINT;
    skillHint.hidden = !(noBots || sharks);

    // length: minutes (Dart Battle, Team Up), laps (Buoy Race), nothing (Balloon Pop counts up; Boats vs. Sharks has waves)
    lengthField.box.hidden = practice || sharks;
    lengthField.label.textContent = f.mode === 'race' ? 'Race laps' : f.mode === 'team' ? 'Match length' : 'Battle length';
    battleSeg.row.hidden = f.mode === 'race';
    lapsSeg.row.hidden = f.mode !== 'race';
    battleSeg.select(f.durationSec);
    lapsSeg.select(f.laps);
    practiceNote.hidden = !practice;
    sharksNote.hidden = !sharks;

    pcards.forEach((pc, i) => {
      pc.card.hidden = i >= f.humans;
      pc.card.style.setProperty('--c', cssColor(f.colors[i]));
      pc.swatches.sync(f.colors[i], (c) => (f.humans === 2 && f.colors[1 - i] === c ? 'P' + (2 - i) : null));
      const easy = f.easy[i];
      pc.easyBtn.setAttribute('aria-pressed', String(easy));
      pc.easyState.textContent = easy ? 'ON' : 'OFF';
      pc.easyHint.textContent = easy
        ? 'Your boat cruises by itself, turns gently and glides past rocks. Just steer and shoot!'
        : 'You do all the driving: go, brake and steer yourself. For pros!';
      pc.garageSub.textContent = describeLook(f.looks[i]);
    });
    boatArt.style.setProperty('--boat', cssColor(f.colors[0]));
  }

  // ───── screen switching ─────
  function showScreen(which: Screen, focusEl?: HTMLElement): void {
    screen = which;
    titleEl.hidden = which !== 'title';
    setupEl.hidden = which !== 'setup';
    garage.el.hidden = which !== 'garage';
    shelfEl.hidden = which !== 'shelf';
    if (which !== 'garage') garage.close(); // frees the 3D preview
    if (which === 'setup' && !focusEl) setupEl.scrollTop = 0;
    if (which === 'garage') garage.el.scrollTop = 0;
    if (which === 'shelf') {
      renderShelf();
      shelfEl.scrollTop = 0;
    }
    // Land on the big button so Enter / A keeps things moving.
    if (which === 'garage') garage.focusFirst();
    else (focusEl ?? mainButton()).focus({ preventScroll: focusEl === undefined });
  }

  function mainButton(): HTMLElement {
    if (screen === 'setup') return startBtn;
    if (screen === 'shelf') return shelfBackBtn;
    return playBtn;
  }

  playBtn.addEventListener('click', () => {
    sfx.uiSelect();
    showScreen('setup');
  });
  shelfBtn.addEventListener('click', () => {
    sfx.uiSelect();
    showScreen('shelf');
  });
  backBtn.addEventListener('click', () => {
    sfx.uiMove();
    showScreen('title');
  });
  shelfBackBtn.addEventListener('click', () => {
    sfx.uiMove();
    showScreen('title', shelfBtn);
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
    for (let i = 0; i < humans; i++) {
      players.push({
        name: cleanName(i),
        color: form.colors[i],
        look: { ...form.looks[i] },
        easyDriving: form.easy[i],
      });
    }
    return {
      mode: form.mode,
      humans,
      bots: botCount(),
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
      } else if (screen === 'garage') {
        sfx.uiMove();
        closeGarage();
      } else if (screen === 'shelf') {
        sfx.uiMove();
        showScreen('title', shelfBtn);
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
      } else if (screen === 'garage') {
        garage.focusFirst();
      } else {
        mainButton().focus();
      }
      return;
    }
    if (screen === 'shelf') {
      // Nothing to hop between here, so up / down just scroll the shelf.
      const dy = (down ? 1 : 0) - (up ? 1 : 0);
      if (dy !== 0) shelfEl.scrollBy({ top: dy * shelfEl.clientHeight * 0.6 });
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
      form.humans = initial.humans === 2 ? 2 : 1;
      form.mode = isMode(initial.mode) ? initial.mode : 'battle';
      // Balloon Pop has no computer boats (its setup says 0): keep the saved number for the other modes.
      // Boats vs. Sharks keeps its helper boats in a number of its own.
      if (form.mode === 'sharks') form.helpers = Math.max(0, Math.min(MAX_HELPERS, initial.bots));
      else if (form.mode !== 'practice') form.bots = Math.max(0, Math.min(MAX_BOTS, initial.bots));
      form.skill = initial.botDifficulty;
      form.durationSec = nearest(BATTLE_SECONDS, initial.durationSec);
      form.laps = nearest(RACE_LAPS, initial.laps);
      // Players from an older setup may have no look / easyDriving: the saved ones (or defaults) stay.
      initial.players.forEach((p, i) => {
        if (i <= 1) applyPlayer(form, i, p);
      });
    }
    pcards[0].input.value = form.names[0];
    pcards[1].input.value = form.names[1];
    changed();
    menuEl.hidden = false;
    visible = true;
    // Keyboard and gamepad users get the focus ring right away; on an iPad it waits for a key or button press.
    menuEl.classList.toggle('ff-nav', !touchDevice);
    refreshSound();
    showScreen('title');
  }

  function hide(): void {
    garage.close();
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
