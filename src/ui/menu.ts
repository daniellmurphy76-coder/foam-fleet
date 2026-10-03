import './styles.css';
import type {
  BoatLook,
  BotDifficulty,
  LobbyPlayer,
  LobbyState,
  MatchSetup,
  Menu,
  MenuInput,
  ModeId,
  OnlineMenuHooks,
  PlayerSetup,
  Sfx,
  TrophyDef,
} from '../types';
import { CONFIG } from '../config';
import { CODE_ALPHABET, CODE_LENGTH, MAX_ONLINE_PLAYERS } from '../net/protocol';
import {
  button,
  collectRows,
  cssColor,
  el,
  errorText,
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
import type { Swatches } from './dom';
import { createGarage, defaultLook, describeLook, sanitizeLook } from './garage';
import { TROPHIES, loadShelf, loadShelfColors } from './trophies';

/** Title, match-setup, Boat Garage, Trophy Shelf and the Play Online screens (online, join, lobby). */

// Same key as v1: old saves still load, and anything they lack (looks, Easy Driving) gets a default.
const STORAGE_KEY = 'foamfleet.setup.v1';
const NAME_MAX = 12;
const MAX_BOTS = 5; // the setup screen offers 0..5 bots
const MAX_HELPERS = 3; // Boats vs. Sharks: 0..3 helper boats on your team
const BATTLE_SECONDS = [120, 180, 300]; // 2 / 3 / 5 minutes
const RACE_LAPS = [1, 3, 5];
/** Letter keys per row on the join keypad (23 letters + Delete = 3 rows of 8: big keys, short screen). */
const KEYPAD_COLS = 8;
/** The name box tells the host about a new name this long after the last key (it does not send every letter). */
const PROFILE_SEND_MS = 400;
/** After a color change a lobby update may still carry the old color: don't let it undo the pick for this long. */
const PROFILE_ECHO_MS = 1500;
/** Start! stays pressed this long (a double-tap must not start twice), then comes back if no match began. */
const START_REARM_MS = 4000;

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

/** A tiny boat for the lobby's player list; the hull takes the player's color (--c). */
const LOBBY_BOAT_SVG = `
<svg viewBox="0 0 48 32" aria-hidden="true">
  <path class="hull" d="M3 18 H45 Q42 29 31 29 H14 Q6 29 3 18 Z" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
  <path d="M17 18 L21 8 H31 L35 18 Z" fill="#bfeaff" stroke="#06173d" stroke-width="3" stroke-linejoin="round"/>
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

type Screen = 'title' | 'setup' | 'garage' | 'shelf' | 'online' | 'join' | 'lobby';

const SKILL_ORDER: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];
/** Letters a game code never uses (the look-alikes), for the little note on the join screen: "I, L or O". */
const MISSING_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((ch) => !CODE_ALPHABET.includes(ch));
const MISSING_TEXT =
  MISSING_LETTERS.length < 2
    ? MISSING_LETTERS.join('')
    : MISSING_LETTERS.slice(0, -1).join(', ') + ' or ' + MISSING_LETTERS[MISSING_LETTERS.length - 1];

/** Only letters a code can have, in capitals, at most CODE_LENGTH of them (typed, pasted or from a link). */
function cleanCode(text: string): string {
  let out = '';
  for (const ch of text.toUpperCase()) if (out.length < CODE_LENGTH && CODE_ALPHABET.includes(ch)) out += ch;
  return out;
}

/** A friendly "Oops!" box for things that go wrong online. Hidden until it has something to say. */
interface Problem {
  root: HTMLElement;
  /** Show this message, or hide the box (null). */
  set(text: string | null): void;
}
function makeProblem(): Problem {
  const root = el('div', 'ff-problem');
  root.setAttribute('role', 'alert');
  root.hidden = true;
  const ico = el('span', 'ff-problem-ico', '😕');
  ico.setAttribute('aria-hidden', 'true');
  const msg = el('div', 'ff-problem-msg');
  const body = el('div', 'ff-problem-body');
  body.append(el('div', 'ff-problem-head', 'Oops!'), msg);
  root.append(ico, body);
  return {
    root,
    set(text) {
      root.hidden = !text; // null and '' both mean "nothing to say"
      if (text) msg.textContent = text;
    },
  };
}

/** The game-option widgets (game, computer boats, helpers, skill, length). The setup screen has one set, the lobby another. */
interface Options {
  /** The "Game" field: the five game cards. */
  modeBox: HTMLElement;
  /** The rest, top to bottom: computer boats, helper boats, skill, length, and the two game notes. */
  boxes: HTMLElement[];
  /** Make every widget match `form`, for a game with this many humans. */
  sync(humans: number): void;
}

export function createMenu(root: HTMLElement, sfx: Sfx): Menu {
  root.classList.add('ff-ui');
  installUnlock(sfx);
  const touchDevice = touchAvailable(); // an iPad (or ?touch=1): show the Touch card, hide the keyboard focus ring
  const silent = silentTestMode(); // ?mute=1: the sound button is switched off so a test page stays quiet

  let visible = false;
  let started = false; // stops a double-click from starting the match twice
  let screen: Screen = 'title';
  let garageFor: 0 | 1 = 0; // whose boat the garage is showing
  let garageBack: 'setup' | 'lobby' = 'setup'; // ...and which screen it goes back to
  let onStart: ((setup: MatchSetup) => void) | null = null;
  let form: Form = loadForm();

  // ── online state ──
  let hooks: OnlineMenuHooks | null = null; // null until the app calls setOnlineHooks: no Play Online button before that
  let pendingOnline: { view: 'join' | 'lobby'; code?: string } | null = null; // showOnline() that came too early
  let role: 'host' | 'guest' | null = null; // set while we are in a room
  let lobby: LobbyState | null = null; // the newest lobby the app pushed
  let roomCode = ''; // the room's code until the first lobby arrives
  let busy: '' | 'host' | 'join' = ''; // a host / join request is in flight
  let netToken = 0; // bumped when the player walks away, so a late answer is not acted on
  let joinCode = ''; // letters typed on the join screen
  let lobbyStarting = false; // Start! was pressed
  let startTimer = 0;
  let profileTimer = 0; // a half-typed name goes out after a short pause
  let profileSentAt = 0;
  let settingsKey = ''; // the settings the host app was last told about

  const menuEl = el('div', 'ff-menu');
  menuEl.hidden = true;
  root.append(menuEl);

  function save(): void {
    storeSet(STORAGE_KEY, JSON.stringify(form));
  }

  function maxBots(humans: number): number {
    return Math.max(0, Math.min(MAX_BOTS, CONFIG.match.maxBoats - humans));
  }
  /** Team Up needs someone to play against; Balloon Pop has no computer boats at all. */
  function minBots(): number {
    return form.mode === 'team' ? 1 : 0;
  }
  /** The computer boats this game really gets (the saved numbers are kept for the other modes). */
  function botCount(humans: number): number {
    if (form.mode === 'practice') return 0;
    if (form.mode === 'sharks') return Math.max(0, Math.min(form.helpers, MAX_HELPERS, maxBots(humans))); // helper boats
    return Math.max(minBots(), Math.min(form.bots, maxBots(humans)));
  }
  /** Humans in the online lobby (just you until the first lobby arrives). */
  function lobbyHumans(): number {
    return Math.max(1, lobby?.players.length ?? 1);
  }

  function cleanName(i: number): string {
    return form.names[i].trim().slice(0, NAME_MAX) || `Player ${i + 1}`;
  }

  /** Online, you are Player 1 of the setup screen: same name, color, boat and Easy Driving. */
  function profile(): PlayerSetup {
    return { name: cleanName(0), color: form.colors[0], look: { ...form.looks[0] }, easyDriving: form.easy[0] };
  }

  /** Is this lobby row me? (The host's own row may not carry `isYou`.) */
  function isMe(p: LobbyPlayer): boolean {
    return p.isYou || (role === 'host' && p.isHost);
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

  // "The host left the game" and friends land here when the app sends the player back to the title.
  const titleNotice = makeProblem();
  titleNotice.root.classList.add('ff-problem--title');

  const playBtn = button('Play', 'ff-btn ff-btn--primary ff-btn--hero');
  const playRow = el('div', 'ff-row');
  playRow.append(playBtn);
  const onlineBtn = button('🌐 Play Online', 'ff-btn ff-btn--xl ff-btn--online');
  onlineBtn.hidden = true; // until the app turns online play on
  const shelfBtn = button('🏆 Trophy Shelf', 'ff-btn ff-btn--lg');
  // Play Online and the Trophy Shelf share a row (left / right hops between them), so the title does not grow taller.
  const moreRow = el('div', 'ff-row ff-title-row');
  moreRow.append(onlineBtn, shelfBtn);

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
  titleEl.append(logo, tagline, boatArt, titleNotice.root, playRow, moreRow, controls);

  // ───── setup screen ─────
  const setupEl = el('section', 'ff-screen ff-setup');
  setupEl.hidden = true;

  const head = el('div', 'ff-setup-head');
  const backBtn = button('← Back', 'ff-btn');
  const backRow = el('div', 'ff-row');
  backRow.append(backBtn);
  head.append(backRow, el('h2', 'ff-setup-title ff-ol', 'Get ready!'));

  /** Something in `form` changed: fix clashes, redraw every screen that shows it, save. */
  function changed(): void {
    // Two humans can't share a boat color: if P1 and P2 collide, P2 gets the next free one.
    if (form.humans === 2 && form.colors[0] === form.colors[1]) {
      form.colors[1] = CONFIG.colors.find((c) => c !== form.colors[0]) ?? form.colors[1];
    }
    form.bots = Math.min(form.bots, maxBots(form.humans));
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

  /** The game options, built once for the setup screen and once for the online lobby (`onPick` runs after a change). */
  function buildOptions(onPick: () => void): Options {
    const botsSeg = makeSeg<number>(
      sfx,
      'Computer boats',
      Array.from({ length: MAX_BOTS + 1 }, (_, n) => ({ value: n, label: String(n) })),
      (v) => {
        form.bots = v;
        onPick();
      },
    );
    const helpersSeg = makeSeg<number>(
      sfx,
      'Helper boats',
      Array.from({ length: MAX_HELPERS + 1 }, (_, n) => ({ value: n, label: String(n) })),
      (v) => {
        form.helpers = v;
        onPick();
      },
    );
    const modeSeg = makeSeg<ModeId>(
      sfx,
      'Game mode',
      MODES.map((m) => ({ value: m.id, label: m.label, icon: m.icon, sub: m.sub })),
      (v) => {
        form.mode = v;
        onPick();
      },
    );
    modeSeg.row.classList.add('ff-modes');
    const battleSeg = makeSeg<number>(
      sfx,
      'Match length',
      BATTLE_SECONDS.map((s) => ({ value: s, label: s / 60 + ' min' })),
      (v) => {
        form.durationSec = v;
        onPick();
      },
    );
    const lapsSeg = makeSeg<number>(
      sfx,
      'Race laps',
      RACE_LAPS.map((n) => ({ value: n, label: n + (n === 1 ? ' lap' : ' laps') })),
      (v) => {
        form.laps = v;
        onPick();
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
        onPick();
      },
    );

    const modeField = field('Game', modeSeg.row);
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

    function teamSplitText(humans: number, count: number): string {
      const total = humans + count;
      const mine = Math.max(humans, Math.ceil(total / 2)); // humans + helper boats
      const helpers = mine - humans;
      const them = total - mine;
      const [mineName, theirName] = CONFIG.team.names;
      const who = humans === 1 ? 'you' : humans === 2 ? 'you both' : 'you all';
      const plus = helpers > 0 ? ` + ${helpers} helper boat${helpers === 1 ? '' : 's'}` : '';
      return `${mineName}: ${who}${plus}. ${theirName}: ${them} boat${them === 1 ? '' : 's'}.`;
    }

    function sync(humans: number): void {
      const f = form;
      const cap = maxBots(humans);
      const count = botCount(humans);
      const practice = f.mode === 'practice';
      const sharks = f.mode === 'sharks';
      const hasBots = !practice && !sharks;

      modeSeg.select(f.mode);

      // computer boats (not in Balloon Pop; Team Up needs at least one rival; Boats vs. Sharks has helper boats instead)
      botsField.box.hidden = !hasBots;
      botsField.label.textContent = f.mode === 'team' ? 'Computer boats (both teams)' : 'Computer boats';
      botsSeg.select(count);
      botsSeg.buttons.forEach((b, n) => {
        b.disabled = n > cap || n < minBots();
      });
      teamHint.hidden = f.mode !== 'team';
      if (f.mode === 'team') teamHint.textContent = teamSplitText(humans, count);
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
    }

    return {
      modeBox: modeField.box,
      boxes: [botsField.box, helpersField.box, skillField.box, lengthField.box, practiceNote, sharksNote],
      sync,
    };
  }
  const setupOpts = buildOptions(changed);

  const playersField = field('Players', playersSeg.row);

  // per-player name + color + Easy Driving + garage (the setup screen has two; the online lobby has one for you)
  interface PlayerCard {
    card: HTMLElement;
    input: HTMLInputElement;
    swatches: Swatches;
    easyBtn: HTMLButtonElement;
    easyState: HTMLElement;
    easyHint: HTMLElement;
    garageBtn: HTMLButtonElement;
    garageSub: HTMLElement;
  }
  function buildPlayerCard(i: 0 | 1, online = false): PlayerCard {
    // an edit in the lobby also tells the host (and through it the other players)
    const edited = (): void => (online ? profileChanged() : changed());
    const card = el('div', 'ff-pcard');
    card.append(el('div', 'ff-label', online ? 'Your boat' : `Player ${i + 1}`));

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
    input.placeholder = online ? 'Your name' : `Player ${i + 1}`;
    input.setAttribute('data-nav', '');
    input.setAttribute('aria-label', online ? 'Your name' : `Player ${i + 1} name`);
    input.addEventListener('input', () => {
      form.names[i] = input.value;
      save();
      if (online) scheduleProfile();
    });
    input.addEventListener('focus', () => input.select()); // easy to type over the default
    if (online) input.addEventListener('blur', flushProfile);
    nameRow.append(input);

    const swatches = makeSwatches(sfx, online ? 'Your boat color' : `Player ${i + 1} boat color`, CONFIG.colors, (c) => {
      form.colors[i] = c;
      edited();
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
      edited();
    });
    const easyRow = el('div', 'ff-row');
    easyRow.append(easyBtn);
    const easyHint = el('div', 'ff-help');

    const garageBtn = button('🔧 Boat Garage', 'ff-btn ff-garage-btn');
    const garageSub = el('span', 'ff-seg-sub');
    garageBtn.append(garageSub);
    garageBtn.addEventListener('click', () => {
      sfx.uiSelect();
      openGarage(i, online ? 'lobby' : 'setup');
    });
    const garageRow = el('div', 'ff-row');
    garageRow.append(garageBtn);

    card.append(nameRow, swatches.row, easyRow, easyHint, garageRow);
    return { card, input, swatches, easyBtn, easyState, easyHint, garageBtn, garageSub };
  }
  const pcards: [PlayerCard, PlayerCard] = [buildPlayerCard(0), buildPlayerCard(1)];
  const ocard = buildPlayerCard(0, true); // "Your boat" in the online lobby

  const optsCol = el('div', 'ff-col');
  optsCol.append(playersField.box, ...setupOpts.boxes);
  const grid = el('div', 'ff-grid');
  grid.append(optsCol, pcards[0].card, pcards[1].card);
  const setupCard = el('div', 'ff-card ff-setup-card');
  setupCard.append(setupOpts.modeBox, grid);

  const startBtn = button('Start!', 'ff-btn ff-btn--primary ff-btn--hero');
  const startRow = el('div', 'ff-row ff-start-wrap');
  startRow.append(startBtn);

  setupEl.append(head, setupCard, startRow);

  // ───── Boat Garage screen (its own module) ─────
  const garage = createGarage(sfx);
  garage.el.hidden = true;

  /** For a paint swatch: a short tag ("P2") if somebody else already has that color, else null. */
  function takenFor(i: 0 | 1, online: boolean): (c: number) => string | null {
    if (online) {
      return (c) => {
        const other = lobby?.players.find((p) => !isMe(p) && p.color === c);
        return other ? 'P' + (other.slot + 1) : null;
      };
    }
    return (c) => (form.humans === 2 && form.colors[1 - i] === c ? 'P' + (2 - i) : null);
  }

  function openGarage(i: 0 | 1, back: 'setup' | 'lobby'): void {
    garageFor = i;
    garageBack = back;
    const edited = (): void => (back === 'lobby' ? profileChanged() : changed());
    garage.open(
      {
        title: `${cleanName(i)}'s boat`,
        look: form.looks[i],
        color: form.colors[i],
        takenBy: takenFor(i, back === 'lobby'),
        onLook: (look) => {
          form.looks[i] = look;
          edited();
        },
        onColor: (c) => {
          form.colors[i] = c;
          edited();
        },
      },
      closeGarage,
    );
    showScreen('garage');
  }
  function closeGarage(): void {
    showScreen(garageBack, (garageBack === 'lobby' ? ocard : pcards[garageFor]).garageBtn);
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

  // ───── Play Online: host or join ─────
  const onlineEl = el('section', 'ff-screen ff-online');
  onlineEl.hidden = true;
  const onlineBackBtn = button('← Back', 'ff-btn');
  const onlineBackRow = el('div', 'ff-row');
  onlineBackRow.append(onlineBackBtn);
  const onlineHead = el('div', 'ff-setup-head');
  onlineHead.append(onlineBackRow, el('h2', 'ff-setup-title ff-ol', 'Play Online'));

  /** A big card-button: picture, title, one line about it. */
  function bigCard(icon: string, title: string, sub: string): { btn: HTMLButtonElement; title: HTMLElement } {
    const btn = button('', 'ff-btn ff-bigcard');
    const ico = el('span', 'ff-bigcard-ico', icon);
    ico.setAttribute('aria-hidden', 'true');
    const heading = el('span', 'ff-bigcard-title', title);
    btn.append(ico, heading, el('span', 'ff-bigcard-sub', sub));
    return { btn, title: heading };
  }
  const hostCard = bigCard('🎉', 'Host a game', 'Start a game and share the code');
  const joinCard = bigCard('🎟️', 'Join a game', 'Type the code from the other screen');
  const hostBtn = hostCard.btn;
  const joinBtn = joinCard.btn;
  const onlineCards = el('div', 'ff-row ff-bigcards');
  onlineCards.append(hostBtn, joinBtn);
  const onlineProblem = makeProblem();
  const onlineHelp = el('p', 'ff-online-help ff-ol', 'Everyone opens this same game page. You need the internet!');
  onlineEl.append(onlineHead, onlineCards, onlineProblem.root, onlineHelp);

  // ───── Play Online: join with a code ─────
  const joinEl = el('section', 'ff-screen ff-join');
  joinEl.hidden = true;
  const joinBackBtn = button('← Back', 'ff-btn');
  const joinBackRow = el('div', 'ff-row');
  joinBackRow.append(joinBackBtn);
  const joinHead = el('div', 'ff-setup-head');
  joinHead.append(joinBackRow, el('h2', 'ff-setup-title ff-ol', 'Join a game'));

  // The code: four big letter tiles. Under them sits an invisible text box, so a real keyboard works too
  // (it must be a text box: the game's own keys, like W A S D and M, are switched off while one is focused).
  // inputmode="none" keeps the iPad's own keyboard from popping up over our big one.
  const codeBox = el('div', 'ff-row ff-codebox');
  const codeTiles = Array.from({ length: CODE_LENGTH }, () => el('span', 'ff-slot is-empty'));
  codeTiles.forEach((t) => t.setAttribute('aria-hidden', 'true'));
  const codeInput = el('input', 'ff-codeinput');
  codeInput.type = 'text';
  codeInput.autocomplete = 'off';
  codeInput.spellcheck = false;
  codeInput.setAttribute('inputmode', 'none');
  codeInput.setAttribute('autocapitalize', 'characters');
  codeInput.setAttribute('autocorrect', 'off');
  codeInput.setAttribute('enterkeyhint', 'go');
  codeInput.setAttribute('data-nav', '');
  codeInput.setAttribute('aria-label', `Game code: ${CODE_LENGTH} letters`);
  codeBox.append(...codeTiles, codeInput);

  const keypad = el('div', 'ff-keypad');
  const keyButtons: HTMLButtonElement[] = [];
  const keyItems = [...CODE_ALPHABET, '⌫'];
  for (let r = 0; r * KEYPAD_COLS < keyItems.length; r++) {
    const row = el('div', 'ff-row ff-keyrow');
    row.style.setProperty('--n', String(KEYPAD_COLS));
    for (const ch of keyItems.slice(r * KEYPAD_COLS, (r + 1) * KEYPAD_COLS)) {
      const isDelete = ch === '⌫';
      const k = button(ch, 'ff-btn ff-keyl' + (isDelete ? ' ff-keyl--del' : ''));
      if (isDelete) {
        k.setAttribute('aria-label', 'Delete');
        k.append(el('span', 'ff-keyl-sub', 'Delete'));
      } else {
        k.setAttribute('aria-label', ch);
      }
      k.addEventListener('click', (e) => {
        if (busy !== '') return;
        // (detail 0 = pressed from the keyboard or a gamepad, not with a mouse or finger)
        if (isDelete) {
          sfx.uiMove();
          setCode(joinCode.slice(0, -1));
        } else {
          sfx.uiSelect();
          addLetter(ch, e.detail === 0);
        }
        // After a mouse click or a tap, typing goes back to the code box, so a real keyboard still works.
        if (e.detail > 0 && !touchDevice) codeInput.focus({ preventScroll: true });
      });
      row.append(k);
      keyButtons.push(k);
    }
    keypad.append(row);
  }

  const joinLead = el('p', 'ff-join-lead', 'Type the code from the other screen');
  const joinHelp = el(
    'p',
    'ff-help ff-join-help',
    `Codes have ${CODE_LENGTH} letters.` + (MISSING_TEXT ? ` They never use ${MISSING_TEXT}.` : ''),
  );
  const joinProblem = makeProblem();
  const joinCardEl = el('div', 'ff-card ff-join-card');
  joinCardEl.append(joinLead, codeBox, joinHelp, joinProblem.root, keypad);
  const joinGoBtn = button('Join!', 'ff-btn ff-btn--primary ff-btn--hero');
  joinGoBtn.disabled = true;
  const joinGoRow = el('div', 'ff-row ff-start-wrap');
  joinGoRow.append(joinGoBtn);
  joinEl.append(joinHead, joinCardEl, joinGoRow);

  // ───── Play Online: the lobby ─────
  const lobbyEl = el('section', 'ff-screen ff-setup ff-lobby');
  lobbyEl.hidden = true;
  const lobbyLeaveBtn = button('← Leave', 'ff-btn');
  const lobbyLeaveRow = el('div', 'ff-row');
  lobbyLeaveRow.append(lobbyLeaveBtn);
  const lobbyHead = el('div', 'ff-setup-head');
  lobbyHead.append(lobbyLeaveRow, el('h2', 'ff-setup-title ff-ol', 'Online game'));

  // the room code, big enough to read out across the room
  const lobbyTiles = Array.from({ length: CODE_LENGTH }, () => el('span', 'ff-slot ff-slot--lobby'));
  lobbyTiles.forEach((t) => t.setAttribute('aria-hidden', 'true'));
  const lobbyCodeTiles = el('div', 'ff-codetiles');
  lobbyCodeTiles.setAttribute('role', 'img');
  lobbyCodeTiles.append(...lobbyTiles);
  const lobbyCodeLabel = el('div', 'ff-label', 'Game code');
  const lobbyCodeCol = el('div', 'ff-codecol');
  lobbyCodeCol.append(lobbyCodeLabel, lobbyCodeTiles);
  const lobbyCodeHelp = el('div', 'ff-codehelp');
  const codeBlock = el('div', 'ff-codeblock');
  codeBlock.append(lobbyCodeCol, lobbyCodeHelp);

  // who is here
  interface LobbyRow {
    root: HTMLElement;
    name: HTMLElement;
    tags: HTMLElement;
  }
  const lobbyRows: LobbyRow[] = [];
  const lobbyList = el('div', 'ff-lplayers');
  lobbyList.setAttribute('role', 'list');
  for (let i = 0; i < MAX_ONLINE_PLAYERS; i++) {
    const rowEl = el('div', 'ff-lplayer is-open');
    rowEl.setAttribute('role', 'listitem');
    const boat = el('span', 'ff-lboat');
    boat.setAttribute('aria-hidden', 'true');
    boat.append(svgNode(LOBBY_BOAT_SVG));
    const name = el('span', 'ff-lname');
    const tags = el('span', 'ff-ltags');
    rowEl.append(boat, name, tags);
    lobbyList.append(rowEl);
    lobbyRows.push({ root: rowEl, name, tags });
  }
  const lobbyPlayersField = field('Players', lobbyList);
  const lobbyStatus = el('div', 'ff-lobby-status');
  lobbyStatus.setAttribute('role', 'status');
  const lobbyProblem = makeProblem();
  const lobbyWho = el('div', 'ff-col');
  lobbyWho.append(lobbyPlayersField.box, lobbyStatus, lobbyProblem.root);
  const lobbyGrid = el('div', 'ff-grid ff-lgrid');
  lobbyGrid.append(lobbyWho, ocard.card);

  // the game settings: the host picks (same widgets as the setup screen), guests just read
  const lobbyOpts = buildOptions(settingsChanged);
  const lobbyOptsGrid = el('div', 'ff-grid ff-lopts');
  lobbyOptsGrid.append(...lobbyOpts.boxes);
  const lobbyHostBox = el('div', 'ff-col');
  lobbyHostBox.append(lobbyOpts.modeBox, lobbyOptsGrid);
  const lobbyGuestBox = el('div', 'ff-col');

  const lobbyCard = el('div', 'ff-card ff-setup-card');
  lobbyCard.append(codeBlock, lobbyGrid, lobbyHostBox, lobbyGuestBox);

  const lobbyStartBtn = button('Start!', 'ff-btn ff-btn--primary ff-btn--hero');
  const lobbyStartSub = el('span', 'ff-start-sub');
  lobbyStartBtn.append(lobbyStartSub);
  const lobbyStartRow = el('div', 'ff-row ff-start-wrap ff-lstart');
  lobbyStartRow.append(lobbyStartBtn);
  const lobbyWait = el('div', 'ff-start-wrap ff-waitbar');
  lobbyWait.setAttribute('role', 'status');
  const lobbyDots = el('span', 'ff-dots');
  lobbyDots.setAttribute('aria-hidden', 'true');
  lobbyDots.append(el('i'), el('i'), el('i'));
  lobbyWait.append(el('span', '', 'Waiting for the host to start...'), lobbyDots);
  lobbyEl.append(lobbyHead, lobbyCard, lobbyStartRow, lobbyWait);

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

  menuEl.append(titleEl, setupEl, garage.el, shelfEl, onlineEl, joinEl, lobbyEl, soundRow);

  // ───── keeping the screen in sync with `form` ─────
  /** One player card (setup screen or lobby) shows form slot `i`. */
  function syncCard(pc: PlayerCard, i: 0 | 1, takenBy: (c: number) => string | null): void {
    pc.card.style.setProperty('--c', cssColor(form.colors[i]));
    pc.swatches.sync(form.colors[i], takenBy);
    const easy = form.easy[i];
    pc.easyBtn.setAttribute('aria-pressed', String(easy));
    pc.easyState.textContent = easy ? 'ON' : 'OFF';
    pc.easyHint.textContent = easy
      ? 'Your boat cruises by itself, turns gently and glides past rocks. Just steer and shoot!'
      : 'You do all the driving: go, brake and steer yourself. For pros!';
    pc.garageSub.textContent = describeLook(form.looks[i]);
  }

  function applyForm(): void {
    const f = form;
    playersSeg.select(f.humans);
    setupOpts.sync(f.humans);
    lobbyOpts.sync(lobbyHumans());
    pcards.forEach((pc, i) => {
      pc.card.hidden = i >= f.humans;
      syncCard(pc, i === 1 ? 1 : 0, takenFor(i === 1 ? 1 : 0, false));
    });
    syncCard(ocard, 0, takenFor(0, true));
    boatArt.style.setProperty('--boat', cssColor(f.colors[0]));
  }

  /** The name boxes show what is in `form` (a name typed on the other screen must show up here too). */
  function syncNames(): void {
    pcards.forEach((pc, i) => {
      if (document.activeElement !== pc.input) pc.input.value = form.names[i];
    });
    if (document.activeElement !== ocard.input) ocard.input.value = lobbyName();
  }
  /** The name the host gave us (it may have added a 2 to tell two Sams apart), else the one we typed. */
  function lobbyName(): string {
    const me = lobby?.players.find(isMe);
    return me ? me.name : form.names[0];
  }

  // ───── screen switching ─────
  function showScreen(which: Screen, focusEl?: HTMLElement): void {
    screen = which;
    titleEl.hidden = which !== 'title';
    setupEl.hidden = which !== 'setup';
    garage.el.hidden = which !== 'garage';
    shelfEl.hidden = which !== 'shelf';
    onlineEl.hidden = which !== 'online';
    joinEl.hidden = which !== 'join';
    lobbyEl.hidden = which !== 'lobby';
    if (which !== 'garage') garage.close(); // frees the 3D preview
    if (which !== 'title') titleNotice.set(null);
    if (which === 'setup' || which === 'lobby') syncNames();
    if (which === 'setup' && !focusEl) setupEl.scrollTop = 0;
    if (which === 'garage') garage.el.scrollTop = 0;
    if (which === 'online') onlineEl.scrollTop = 0;
    if (which === 'join') joinEl.scrollTop = 0;
    if (which === 'lobby') {
      renderLobby();
      if (!focusEl) lobbyEl.scrollTop = 0;
    }
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
    if (screen === 'online') return hostBtn;
    if (screen === 'join') {
      if (joinCode.length === CODE_LENGTH) return joinGoBtn;
      return touchDevice ? keyButtons[0] : codeInput; // (no code box focus on an iPad: it needs no keyboard)
    }
    if (screen === 'lobby') return role === 'host' && !lobbyStartBtn.disabled ? lobbyStartBtn : lobbyLeaveBtn;
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
      bots: botCount(humans),
      botDifficulty: form.skill,
      players,
      durationSec: form.durationSec,
      laps: form.laps,
    };
  }

  // ───── online: host / join ─────
  onlineBtn.addEventListener('click', () => {
    sfx.uiSelect();
    onlineProblem.set(null);
    showScreen('online');
  });
  onlineBackBtn.addEventListener('click', leaveOnline);
  hostBtn.addEventListener('click', startHosting);
  joinBtn.addEventListener('click', () => {
    if (busy !== '') return;
    sfx.uiSelect();
    setCode('');
    showScreen('join');
  });
  joinBackBtn.addEventListener('click', leaveJoin);
  joinGoBtn.addEventListener('click', tryJoin);
  lobbyLeaveBtn.addEventListener('click', leaveRoom);
  lobbyStartBtn.addEventListener('click', startOnlineMatch);

  /** Disable the buttons that would start a second request while one is still on its way. */
  function applyBusy(): void {
    const on = busy !== '';
    hostBtn.disabled = on;
    joinBtn.disabled = on;
    hostCard.title.textContent = busy === 'host' ? 'Opening your game...' : 'Host a game';
    for (const k of keyButtons) k.disabled = on;
    joinGoBtn.textContent = busy === 'join' ? 'Joining...' : 'Join!';
    joinGoBtn.disabled = on || joinCode.length < CODE_LENGTH;
  }

  function startHosting(): void {
    const h = hooks;
    if (busy !== '' || !h) return;
    sfx.uiSelect();
    onlineProblem.set(null);
    busy = 'host';
    const token = ++netToken;
    applyBusy();
    onlineBackBtn.focus({ preventScroll: true });
    Promise.resolve()
      .then(() => h.host(profile()))
      .then(
        (code) => {
          busy = '';
          applyBusy();
          if (token !== netToken) h.leave(); // the player walked away while it was opening: close that room again
          else enterLobby('host', code);
        },
        (err: unknown) => {
          busy = '';
          applyBusy();
          if (token !== netToken) return;
          onlineProblem.set(errorText(err));
          hostBtn.focus({ preventScroll: true });
        },
      );
  }

  function tryJoin(): void {
    const h = hooks;
    if (busy !== '' || !h || joinCode.length !== CODE_LENGTH) return;
    sfx.uiSelect();
    joinProblem.set(null);
    const code = joinCode;
    busy = 'join';
    const token = ++netToken;
    applyBusy();
    joinBackBtn.focus({ preventScroll: true });
    Promise.resolve()
      .then(() => h.join(code, profile()))
      .then(
        () => {
          busy = '';
          applyBusy();
          if (token !== netToken) h.leave();
          else enterLobby('guest', code);
        },
        (err: unknown) => {
          busy = '';
          applyBusy();
          if (token !== netToken) return;
          joinProblem.set(errorText(err));
          mainButton().focus({ preventScroll: true });
        },
      );
  }

  /** Back from the Play Online screen to the title (a room that is still opening is shut again when it is ready). */
  function leaveOnline(): void {
    sfx.uiMove();
    if (busy === 'host') netToken++;
    showScreen('title', onlineBtn);
  }

  /** Back from the join screen (a join still on its way is undone when it arrives). */
  function leaveJoin(): void {
    sfx.uiMove();
    if (busy === 'join') netToken++;
    showScreen('online', joinBtn);
  }

  // ───── online: the join code ─────
  function renderCode(): void {
    codeTiles.forEach((tile, i) => {
      tile.textContent = joinCode.charAt(i);
      tile.classList.toggle('is-empty', i >= joinCode.length);
      tile.classList.toggle('is-next', i === joinCode.length);
    });
    joinGoBtn.disabled = busy !== '' || joinCode.length < CODE_LENGTH;
  }

  function setCode(text: string): void {
    joinCode = cleanCode(text);
    if (codeInput.value !== joinCode) codeInput.value = joinCode;
    joinProblem.set(null); // a new try, a fresh start
    renderCode();
  }

  function addLetter(ch: string, viaKeys: boolean): void {
    if (joinCode.length >= CODE_LENGTH) return;
    setCode(joinCode + ch);
    // With keys or a gamepad, land on the big Join button once the code is complete.
    if (viaKeys && joinCode.length === CODE_LENGTH) joinGoBtn.focus({ preventScroll: true });
  }

  /** A little shake when a typed letter can't be part of a code. */
  function shakeCode(): void {
    codeBox.classList.remove('is-shake');
    void codeBox.offsetWidth; // restart the animation
    codeBox.classList.add('is-shake');
  }
  codeBox.addEventListener('animationend', () => codeBox.classList.remove('is-shake'));

  codeInput.addEventListener('input', () => {
    const typed = codeInput.value.toUpperCase();
    if ([...typed].some((ch) => !CODE_ALPHABET.includes(ch))) shakeCode(); // not a letter a code has
    setCode(typed);
  });

  // ───── online: the lobby ─────
  function renderGuestSettings(): void {
    lobbyGuestBox.replaceChildren();
    const s = lobby?.settings ?? null;
    if (!s) {
      lobbyGuestBox.append(el('div', 'ff-help', 'The host is picking the game...'));
      return;
    }
    const mode = MODES.find((m) => m.id === s.mode) ?? MODES[0];
    const card = el('div', 'ff-gmode');
    const ico = el('span', 'ff-gmode-ico', mode.icon);
    ico.setAttribute('aria-hidden', 'true');
    const text = el('div', 'ff-gmode-text');
    text.append(el('div', 'ff-gmode-name', mode.label), el('div', 'ff-help', mode.sub));
    card.append(ico, text);

    const chips = el('div', 'ff-chips');
    const chip = (label: string, value: string): void => {
      const c = el('div', 'ff-chip');
      c.append(el('span', 'ff-chip-label', label), el('b', 'ff-chip-value', value));
      chips.append(c);
    };
    const sharks = s.mode === 'sharks';
    if (s.mode !== 'practice') {
      chip(sharks ? 'Helper boats' : 'Computer boats', String(s.bots));
      if (sharks || s.bots > 0) {
        const skill = (sharks ? SPEED_LABELS : SKILL_LABELS)[SKILL_ORDER.indexOf(s.botDifficulty)] ?? '';
        chip(sharks ? 'Shark speed' : 'Bot skill', skill);
      }
    }
    if (s.mode === 'race') chip('Race laps', String(s.laps));
    else if (s.mode === 'battle' || s.mode === 'team') chip('Match length', s.durationSec / 60 + ' min');

    lobbyGuestBox.append(field('Game (the host picks)', card, chips).box);
  }

  /** The lobby's players (or just you, while the first lobby is still on its way to a host). */
  function lobbyPlayers(): LobbyPlayer[] {
    if (lobby && lobby.players.length > 0) return lobby.players;
    if (role !== 'host') return [];
    return [
      { slot: 0, name: cleanName(0), color: form.colors[0], look: form.looks[0], easyDriving: form.easy[0], isHost: true, isYou: true },
    ];
  }

  /** Redraw everything the lobby shows from `lobby` + `form`. Only runs when something changed. */
  function renderLobby(): void {
    const host = role !== 'guest';
    const code = lobby?.code || roomCode;
    for (let i = 0; i < CODE_LENGTH; i++) {
      lobbyTiles[i].textContent = code.charAt(i) || '·';
      lobbyTiles[i].classList.toggle('is-empty', code.charAt(i) === '');
    }
    lobbyCodeTiles.setAttribute('aria-label', code ? `Game code ${[...code].join(' ')}` : 'Getting the game code');
    lobbyCodeHelp.textContent = code
      ? `On the other device: Play Online → Join → type ${code}`
      : 'Getting your game ready...';
    lobbyStatus.textContent = lobby?.status || (host ? 'Waiting for players...' : 'Joining the game...');
    lobbyProblem.set(lobby?.error ?? null);

    const players = lobbyPlayers();
    lobbyPlayersField.label.textContent = `Players (${players.length} of ${MAX_ONLINE_PLAYERS})`;
    lobbyRows.forEach((row, i) => {
      const p: LobbyPlayer | undefined = players[i];
      row.root.classList.toggle('is-open', p === undefined);
      if (p) {
        row.root.style.setProperty('--c', cssColor(p.color));
        row.name.textContent = p.name;
        row.tags.textContent = [isMe(p) ? '(you)' : '', p.isHost ? '(host)' : ''].filter(Boolean).join(' ');
      } else {
        row.name.textContent = 'Waiting for a player...';
        row.tags.textContent = '';
      }
    });
    if (document.activeElement !== ocard.input) ocard.input.value = lobbyName();

    lobbyHostBox.hidden = !host;
    lobbyGuestBox.hidden = host;
    if (host) lobbyOpts.sync(players.length);
    else renderGuestSettings();

    lobbyStartRow.hidden = !host;
    lobbyWait.hidden = host;
    lobbyStartBtn.disabled = lobbyStarting || players.length < 2;
    lobbyStartSub.textContent =
      players.length < 2 ? 'Waiting for a friend to join...' : lobbyStarting ? 'Here we go!' : 'Everyone is here!';
  }

  /** A brand new room is open (we hosted it, or the host let us in). */
  function enterLobby(r: 'host' | 'guest', code: string): void {
    if (lobby && lobby.code && lobby.code !== code) lobby = null; // an old room's lobby
    role = r;
    roomCode = code.toUpperCase();
    lobbyStarting = false;
    settingsKey = '';
    if (r === 'host') pushSettings(); // tell the room what the host picked (the lobby mirrors it to guests)
    if (screen === 'lobby') renderLobby();
    else showScreen('lobby');
  }

  /** The player left the room (or walked away from joining it). */
  function resetOnline(): void {
    role = null;
    lobby = null;
    roomCode = '';
    netToken++; // an answer still on its way is no longer wanted
    lobbyStarting = false;
    settingsKey = '';
    window.clearTimeout(startTimer);
    startTimer = 0;
    window.clearTimeout(profileTimer);
    profileTimer = 0;
    onlineProblem.set(null);
    setCode('');
  }

  function leaveRoom(): void {
    const h = hooks;
    sfx.uiMove();
    resetOnline();
    showScreen('title', onlineBtn);
    h?.leave();
  }

  /** The match settings as the online app wants them (it adds the lobby's players itself). */
  function onlineSetup(): MatchSetup {
    return {
      mode: form.mode,
      humans: 1,
      bots: botCount(lobbyHumans()),
      botDifficulty: form.skill,
      players: [profile()],
      durationSec: form.durationSec,
      laps: form.laps,
      online: null,
    };
  }

  /** Tell the app the host's settings (only when they really changed: friends joining can shrink the bot count). */
  function pushSettings(): void {
    if (!hooks || role !== 'host') return;
    const s = onlineSetup();
    const key = [s.mode, s.bots, s.botDifficulty, s.durationSec, s.laps].join('|');
    if (key === settingsKey) return;
    settingsKey = key;
    hooks.settings(s);
  }

  /** The host changed a setting in the lobby. */
  function settingsChanged(): void {
    changed();
    pushSettings();
  }

  /** The player changed their name, color, boat or Easy Driving while in the lobby. */
  function profileChanged(): void {
    changed();
    pushProfile();
  }
  function pushProfile(): void {
    window.clearTimeout(profileTimer);
    profileTimer = 0;
    if (!hooks || role === null) return;
    profileSentAt = performance.now();
    hooks.profile(profile());
  }
  /** A name is typed one letter at a time: tell the host once the typing pauses. */
  function scheduleProfile(): void {
    window.clearTimeout(profileTimer);
    profileTimer = window.setTimeout(pushProfile, PROFILE_SEND_MS);
  }
  function flushProfile(): void {
    if (profileTimer !== 0) pushProfile();
  }

  function startOnlineMatch(): void {
    if (!hooks || role !== 'host' || lobbyStarting || lobbyHumans() < 2) return;
    lobbyStarting = true; // a double tap must not start two matches; it comes back if no match begins
    sfx.uiSelect();
    save();
    flushProfile();
    renderLobby();
    window.clearTimeout(startTimer);
    startTimer = window.setTimeout(() => {
      startTimer = 0;
      lobbyStarting = false;
      if (screen === 'lobby') renderLobby();
    }, START_REARM_MS);
    hooks.start(onlineSetup());
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
      if (screen === 'join') {
        leaveJoin(); // even from the code box
      } else if (typing) {
        active.blur(); // Escape just leaves the name box
      } else if (screen === 'setup') {
        sfx.uiMove();
        showScreen('title');
      } else if (screen === 'garage') {
        sfx.uiMove();
        closeGarage();
      } else if (screen === 'shelf') {
        sfx.uiMove();
        showScreen('title', shelfBtn);
      } else if (screen === 'online') {
        leaveOnline();
      } else if (screen === 'lobby') {
        // Leaving shuts the room for everyone when you are the host, so Back only walks to the Leave button.
        sfx.uiMove();
        lobbyLeaveBtn.focus();
      }
      return;
    }
    if (confirm) {
      if (screen === 'join' && active === codeInput) {
        // Enter in the code box = Join (or on to the keypad while the code is short)
        if (joinCode.length === CODE_LENGTH) tryJoin();
        else keyButtons[0].focus();
      } else if (typing) {
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
  /** Make the menu visible (first time, or coming back from a match). */
  function open(): void {
    menuEl.hidden = false;
    visible = true;
    started = false;
    // Keyboard and gamepad users get the focus ring right away; on an iPad it waits for a key or button press.
    menuEl.classList.toggle('ff-nav', !touchDevice);
    refreshSound();
  }

  function show(initial: MatchSetup | null, cb: (setup: MatchSetup) => void): void {
    onStart = cb;
    resetOnline(); // the title screen is offline: any room we were in is over
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
    ocard.input.value = form.names[0];
    changed();
    open();
    showScreen('title');
  }

  function hide(): void {
    flushProfile(); // a half-typed name still goes out
    garage.close();
    menuEl.hidden = true;
    visible = false;
    started = false;
    window.clearTimeout(startTimer);
    startTimer = 0;
    titleNotice.set(null);
  }

  function setOnlineHooks(h: OnlineMenuHooks): void {
    hooks = h;
    onlineBtn.hidden = false;
    if (pendingOnline) {
      const p = pendingOnline;
      pendingOnline = null;
      showOnline(p.view, p.code);
    }
  }

  function showOnline(view: 'join' | 'lobby', code?: string): void {
    if (!hooks) {
      pendingOnline = { view, code }; // online play is not switched on yet: do it as soon as it is
      return;
    }
    if (!visible) open();
    if (view === 'join') {
      setCode(code ?? '');
      showScreen('join');
      return;
    }
    // Back in the lobby (after a match): the app has the room, we just show it again.
    role = role ?? lobby?.role ?? (busy === 'join' ? 'guest' : 'host');
    lobbyStarting = false;
    window.clearTimeout(startTimer);
    startTimer = 0;
    if (code) roomCode = cleanCode(code);
    if (screen === 'lobby') renderLobby();
    else showScreen('lobby');
    if (role === 'host') pushSettings(); // (show() forgot what the room was last told)
  }

  function updateLobby(state: LobbyState): void {
    lobby = state;
    // The host keeps every boat a different color, so it may have moved ours: follow it (unless we just picked one).
    const me = state.players.find((p) => p.isYou || (state.role === 'host' && p.isHost));
    if (me && me.color !== form.colors[0] && CONFIG.colors.includes(me.color) && performance.now() - profileSentAt > PROFILE_ECHO_MS) {
      form.colors[0] = me.color;
      changed();
    }
    if (role === 'host') pushSettings(); // friends joining leave fewer seats for computer boats
    if (!visible) return; // drawn when the lobby is shown again
    if (screen === 'lobby' || (screen === 'garage' && garageBack === 'lobby')) renderLobby(); // (or waiting behind the garage)
    else {
      lobbyOpts.sync(lobbyHumans());
      if (state.error) showProblem(state.error); // e.g. "The host left the game", sent as the app returns to the title
    }
  }

  /** A problem message on whatever online screen is open (or the title screen, where players land after one). */
  function showProblem(text: string): void {
    if (screen === 'online') onlineProblem.set(text);
    else if (screen === 'join') joinProblem.set(text);
    else titleNotice.set(text);
  }

  return {
    show,
    hide,
    update,
    setOnlineHooks,
    showOnline,
    updateLobby,
    get visible(): boolean {
      return visible;
    },
  };
}
