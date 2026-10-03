/** Match setup helpers: defaults, cleaning up whatever the menu hands us, and ?quick= URL parsing. */
import { CONFIG } from '../config';
import { MAX_ONLINE_PLAYERS } from '../net/protocol';
import type {
  BotDifficulty, BoatLook, FlagId, HatId, HornId, MatchSetup, ModeId, OnlineRoster, PatternId, PlayerSetup,
} from '../types';
import { clamp } from './util';

const DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];
const MODES: readonly ModeId[] = ['battle', 'race', 'team', 'practice', 'sharks'];
const PATTERNS: readonly PatternId[] = ['solid', 'stripes', 'flames', 'dots', 'shark'];
const HATS: readonly HatId[] = ['captain', 'pirate', 'crown', 'cowboy', 'propeller', 'none'];
const FLAGS: readonly FlagId[] = ['none', 'star', 'heart', 'skull', 'lightning', 'smile'];
const HORNS: readonly HornId[] = ['beep', 'duck', 'foghorn', 'clown'];
/** Hull 3 is the BoneBoat (a shark skeleton). */
const HULLS = 4;
/** Boats vs. Sharks: the most helper boats on the players' team. */
export const MAX_HELPERS = 3;

/** The look a player gets until they visit the Garage (player 2 starts with the chunky tug, like v1). */
export function defaultLook(slot = 0): BoatLook {
  return { hull: slot % HULLS, pattern: 'solid', hat: 'captain', flag: 'none', horn: 'beep' };
}

function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return list.includes(v as T) ? (v as T) : fallback;
}

/** Fill in anything missing or unknown (old saved setups have no look at all). */
export function sanitizeLook(look: Partial<BoatLook> | null | undefined, slot: number): BoatLook {
  const base = defaultLook(slot);
  const hull = Number(look?.hull);
  return {
    hull: Number.isInteger(hull) && hull >= 0 && hull < HULLS ? hull : base.hull,
    pattern: oneOf(PATTERNS, look?.pattern, base.pattern),
    hat: oneOf(HATS, look?.hat, base.hat),
    flag: oneOf(FLAGS, look?.flag, base.flag),
    horn: oneOf(HORNS, look?.horn, base.horn),
  };
}

/** Computer boats get a look of their own (any of the four hulls, BoneBoat included), the same every time for the same boat id. */
export function botLook(id: number): BoatLook {
  let h = Math.imul(id + 1, 0x9e3779b1) >>> 0;
  const next = (n: number): number => {
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h >>> 8) % n;
  };
  return {
    hull: id % HULLS,
    pattern: PATTERNS[next(PATTERNS.length)],
    hat: HATS[next(HATS.length)],
    flag: FLAGS[next(FLAGS.length)],
    horn: HORNS[next(HORNS.length)],
  };
}

export function defaultPlayer(slot: number): PlayerSetup {
  return {
    name: `Player ${slot + 1}`,
    color: CONFIG.colors[slot % CONFIG.colors.length],
    look: defaultLook(slot),
    easyDriving: true,
  };
}

export function defaultSetup(mode: ModeId = 'battle'): MatchSetup {
  return sanitizeSetup({
    mode,
    humans: 1,
    bots: mode === 'sharks' ? CONFIG.sharks.defaultHelpers : CONFIG.match.defaultBots,
    botDifficulty: 'normal',
    players: [],
    durationSec: CONFIG.battle.durationSec,
    laps: CONFIG.race.laps,
  });
}

/**
 * Make any setup safe to play: counts in range, one player entry per human (with a look and an
 * Easy Driving switch, even from an old save), names trimmed, bots capped so humans + bots <= maxBoats,
 * no bots in Balloon Pop, at least one bot in Team Up (so there is another team to play against), and
 * 0 to 3 helper boats in Boats vs. Sharks.
 *
 * Online (`s.online`): every human on every device counts toward the boat limit, `humans` is 1 and `players` is just
 * the player on THIS device (the contract in types.ts). A local setup comes back with no `online` key at all.
 */
export function sanitizeSetup(s: MatchSetup): MatchSetup {
  const mode: ModeId = MODES.includes(s.mode) ? s.mode : 'battle';
  const roster = Array.isArray(s.online?.players) && s.online.players.length > 0
    ? sanitizePlayers(s.online.players.slice(0, MAX_ONLINE_PLAYERS), Math.min(s.online.players.length, MAX_ONLINE_PLAYERS))
    : null;
  const online: OnlineRoster | null = roster
    ? { players: roster, localSlot: clamp(Math.round(Number(s.online?.localSlot) || 0), 0, roster.length - 1) }
    : null;
  const humans: 1 | 2 = online ? 1 : s.humans === 2 ? 2 : 1;
  const everyone = online ? online.players.length : humans;
  const maxBots = Math.max(0, CONFIG.match.maxBoats - everyone);
  let bots = clamp(Math.round(Number(s.bots) || 0), 0, maxBots);
  if (mode === 'practice') bots = 0;
  else if (mode === 'team') bots = clamp(bots, 1, Math.max(1, maxBots));
  else if (mode === 'sharks') bots = clamp(bots, 0, Math.min(MAX_HELPERS, maxBots));
  const players = online ? [online.players[online.localSlot]] : sanitizePlayers(s.players, humans);
  const duration = Number(s.durationSec);
  const laps = Math.round(Number(s.laps));
  const out: MatchSetup = {
    mode,
    humans,
    bots,
    botDifficulty: DIFFICULTIES.includes(s.botDifficulty) ? s.botDifficulty : 'normal',
    players,
    durationSec: duration > 0 ? duration : CONFIG.battle.durationSec,
    laps: laps >= 1 ? laps : CONFIG.race.laps,
  };
  if (online) out.online = online;
  return out;
}

/** One clean PlayerSetup per human: a name, a paint color nobody else has, a look and the Easy Driving switch. */
function sanitizePlayers(list: readonly Partial<PlayerSetup>[] | undefined, count: number): PlayerSetup[] {
  const players: PlayerSetup[] = [];
  for (let i = 0; i < count; i++) {
    const p = list?.[i];
    const name = (typeof p?.name === 'string' ? p.name.trim() : '').slice(0, 16) || `Player ${i + 1}`;
    let color = typeof p?.color === 'number' && Number.isFinite(p.color) ? p.color : CONFIG.colors[i % CONFIG.colors.length];
    // Two players can't share a paint color: the later one takes the first free swatch.
    if (i > 0 && players.some((q) => q.color === color)) {
      color = CONFIG.colors.find((c) => !players.some((q) => q.color === c)) ?? color;
    }
    players.push({
      name,
      color,
      look: sanitizeLook(p?.look, i),
      easyDriving: typeof p?.easyDriving === 'boolean' ? p.easyDriving : true,
    });
  }
  return players;
}

/** Everyone playing the match, in boat-id order: the whole online roster, or the local players. */
export function rosterOf(s: MatchSetup): readonly PlayerSetup[] {
  return s.online?.players ?? s.players;
}

/**
 * Read ?quick=battle|race|team|practice|sharks&humans=&bots=&difficulty=&duration=&laps=&easy=0|1 .
 * Returns null if `quick` is absent. `easy` turns Easy Driving on or off for every human (default on).
 */
export function setupFromQuery(q: URLSearchParams): MatchSetup | null {
  const quick = q.get('quick');
  if (!quick) return null;
  const mode: ModeId = MODES.includes(quick as ModeId) ? (quick as ModeId) : 'battle';
  const base = defaultSetup(mode);
  const bots = q.get('bots');
  const difficulty = q.get('difficulty') as BotDifficulty | null;
  const duration = q.get('duration');
  const laps = q.get('laps');
  const humans: 1 | 2 = q.get('humans') === '2' ? 2 : 1;
  const easy = q.get('easy');
  const players: PlayerSetup[] = [];
  for (let i = 0; i < humans; i++) {
    const p = defaultPlayer(i);
    if (easy === '0') p.easyDriving = false;
    else if (easy === '1') p.easyDriving = true;
    players.push(p);
  }
  return sanitizeSetup({
    ...base,
    humans,
    bots: bots !== null && bots !== '' ? Number(bots) : base.bots,
    botDifficulty: difficulty && DIFFICULTIES.includes(difficulty) ? difficulty : base.botDifficulty,
    players,
    durationSec: duration ? Number(duration) : base.durationSec,
    laps: laps ? Number(laps) : base.laps,
  });
}
