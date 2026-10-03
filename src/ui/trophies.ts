import type { PlayerMatchStats, TrophyAward, TrophyDef } from '../types';
import { storeGet, storeSet } from './dom';

/**
 * The Trophy Shelf: what there is to win, how a match earns it, and what each player has won so far.
 * (Players are told apart by their name, so "Sam" keeps their trophies from game to game.)
 */

const SHELF_KEY = 'foamfleet.trophies';
const COLOR_KEY = 'foamfleet.trophies.colors';
const MAX_SHELVES = 12; // a kid who types a new name every game must not grow this forever

/** Every trophy in the game, in shelf order. */
export const TROPHIES: readonly TrophyDef[] = [
  { id: 'first-splat', name: 'First Splat', icon: '💦', description: 'Tag any boat with a foam dart.' },
  { id: 'sharpshooter', name: 'Sharpshooter', icon: '🎯', description: 'Tag 10 boats in one Dart Battle.' },
  { id: 'gotcha', name: 'Gotcha!', icon: '😜', description: 'Tag the other player.' },
  { id: 'champion', name: 'Champion', icon: '🏆', description: 'Win a Dart Battle.' },
  { id: 'finish-line', name: 'Finish Line', icon: '🏁', description: 'Finish a Buoy Race.' },
  { id: 'race-winner', name: 'Race Winner', icon: '🥇', description: 'Come in first in a Buoy Race.' },
  { id: 'teamwork', name: 'Teamwork', icon: '🤝', description: 'Win a Team Up game.' },
  { id: 'balloon-buster', name: 'Balloon Buster', icon: '🎈', description: 'Score 10 balloon points in one game.' },
  { id: 'pop-star', name: 'Pop Star', icon: '🌟', description: 'Pop every balloon in Balloon Pop.' },
  { id: 'rocket-boat', name: 'Rocket Boat', icon: '🚀', description: 'Boost for 10 seconds in one game.' },
  { id: 'honk-honk', name: 'Honk Honk', icon: '📯', description: 'Honk your horn 10 times in one game.' },
  { id: 'treasure-hunter', name: 'Treasure Hunter', icon: '🎁', description: 'Grab 3 power-ups in one game.' },
];

/** How a match earns each trophy (by id). */
const CHECKS: Record<string, (s: PlayerMatchStats) => boolean> = {
  'first-splat': (s) => s.hits >= 1,
  sharpshooter: (s) => s.mode === 'battle' && s.hits >= 10,
  gotcha: (s) => s.tagsOnOtherHuman >= 1,
  champion: (s) => s.mode === 'battle' && s.won,
  'finish-line': (s) => s.mode === 'race' && s.finished,
  'race-winner': (s) => s.mode === 'race' && s.finished && s.won,
  teamwork: (s) => s.mode === 'team' && s.won,
  'balloon-buster': (s) => s.balloons >= 10,
  // A Balloon Pop game only ends when the last balloon is gone, so a finish time means every one popped.
  'pop-star': (s) => s.mode === 'practice' && s.finishTime !== null && s.balloons >= 1,
  'rocket-boat': (s) => s.boostSeconds >= 10,
  'honk-honk': (s) => s.honks >= 10,
  'treasure-hunter': (s) => s.pickups >= 3,
};

// ───────────── saving ─────────────
// The shelf is a Map while we work (a name like "__proto__" is then just a name) and plain JSON on disk.
// `memory` is this session's copy, so a browser that blocks localStorage still doesn't re-award every match.

let memory = new Map<string, string[]>();

function readShelf(): Map<string, string[]> {
  const text = storeGet(SHELF_KEY);
  if (text) {
    try {
      const raw: unknown = JSON.parse(text);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const out = new Map<string, string[]>();
        for (const [name, ids] of Object.entries(raw)) {
          if (Array.isArray(ids)) out.set(name, ids.filter((id): id is string => typeof id === 'string'));
        }
        return out;
      }
    } catch {
      /* damaged save: fall back to this session's copy */
    }
  }
  return new Map([...memory].map(([name, ids]) => [name, [...ids]]));
}

function writeShelf(shelf: Map<string, string[]>): void {
  while (shelf.size > MAX_SHELVES) {
    const oldest = shelf.keys().next().value;
    if (oldest === undefined) break;
    shelf.delete(oldest);
  }
  memory = new Map([...shelf].map(([name, ids]) => [name, [...ids]]));
  storeSet(SHELF_KEY, JSON.stringify(Object.fromEntries(shelf)));
}

function readColors(): Map<string, number> {
  const out = new Map<string, number>();
  const text = storeGet(COLOR_KEY);
  if (!text) return out;
  try {
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [name, c] of Object.entries(raw)) {
        if (typeof c === 'number' && Number.isFinite(c)) out.set(name, c);
      }
    }
  } catch {
    /* ignore: the shelf just falls back to a plain color */
  }
  return out;
}

/** Remember each winner's boat color, for tinting their shelf. Only players still on the shelf are kept. */
function saveColors(awards: readonly TrophyAward[], shelf: ReadonlyMap<string, string[]>): void {
  const colors = readColors();
  for (const a of awards) colors.set(a.playerName, a.color);
  const keep = [...colors].filter(([name]) => shelf.has(name));
  storeSet(COLOR_KEY, JSON.stringify(Object.fromEntries(keep)));
}

function cleanName(name: string): string {
  return name.trim() || 'Player';
}

/**
 * Check this match's stats against every trophy, save any trophy a player earned for the
 * FIRST time (per player name, in localStorage), and return just those new awards.
 */
export function awardTrophies(stats: readonly PlayerMatchStats[]): TrophyAward[] {
  const awards: TrophyAward[] = [];
  const shelf = readShelf();
  let changed = false;
  for (const s of stats) {
    const name = cleanName(s.name);
    const have = new Set(shelf.get(name) ?? []);
    const fresh = TROPHIES.filter((t) => !have.has(t.id) && CHECKS[t.id]?.(s) === true);
    if (fresh.length === 0) continue;
    for (const t of fresh) {
      have.add(t.id);
      awards.push({ playerName: name, color: s.color, trophy: t });
    }
    shelf.delete(name); // re-insert so the most recent winner is last (the oldest shelf is dropped first)
    shelf.set(name, [...have]);
    changed = true;
  }
  if (changed) {
    writeShelf(shelf);
    saveColors(awards, shelf);
  }
  return awards;
}

/** Saved trophies: player name -> trophy ids earned. Least recent winner first. */
export function loadShelf(): Record<string, string[]> {
  return Object.fromEntries(readShelf());
}

/** The boat color each saved player last won with (player name -> 0xRRGGBB), for tinting the shelf. */
export function loadShelfColors(): Record<string, number> {
  return Object.fromEntries(readColors());
}
