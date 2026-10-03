/** Match setup helpers: defaults, cleaning up whatever the menu hands us, and ?quick= URL parsing. */
import { CONFIG } from '../config';
import type { BotDifficulty, MatchSetup, ModeId } from '../types';
import { clamp } from './util';

const DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];

export function defaultSetup(mode: ModeId = 'battle'): MatchSetup {
  return sanitizeSetup({
    mode,
    humans: 1,
    bots: CONFIG.match.defaultBots,
    botDifficulty: 'normal',
    players: [],
    durationSec: CONFIG.battle.durationSec,
    laps: CONFIG.race.laps,
  });
}

/**
 * Make any setup safe to play: counts in range, one player entry per human,
 * names trimmed, bots capped so humans + bots <= maxBoats.
 */
export function sanitizeSetup(s: MatchSetup): MatchSetup {
  const humans: 1 | 2 = s.humans === 2 ? 2 : 1;
  const maxBots = Math.max(0, CONFIG.match.maxBoats - humans);
  const bots = clamp(Math.round(Number(s.bots) || 0), 0, maxBots);
  const players: MatchSetup['players'] = [];
  for (let i = 0; i < humans; i++) {
    const p = s.players?.[i];
    const name = (typeof p?.name === 'string' ? p.name.trim() : '').slice(0, 16) || `Player ${i + 1}`;
    const color = typeof p?.color === 'number' && Number.isFinite(p.color) ? p.color : CONFIG.colors[i % CONFIG.colors.length];
    players.push({ name, color });
  }
  const duration = Number(s.durationSec);
  const laps = Math.round(Number(s.laps));
  return {
    mode: s.mode === 'race' ? 'race' : 'battle',
    humans,
    bots,
    botDifficulty: DIFFICULTIES.includes(s.botDifficulty) ? s.botDifficulty : 'normal',
    players,
    durationSec: duration > 0 ? duration : CONFIG.battle.durationSec,
    laps: laps >= 1 ? laps : CONFIG.race.laps,
  };
}

/** Read ?quick=battle|race&humans=&bots=&difficulty=&duration=&laps= . Returns null if `quick` is absent. */
export function setupFromQuery(q: URLSearchParams): MatchSetup | null {
  const quick = q.get('quick');
  if (!quick) return null;
  const mode: ModeId = quick === 'race' ? 'race' : 'battle';
  const base = defaultSetup(mode);
  const bots = q.get('bots');
  const difficulty = q.get('difficulty') as BotDifficulty | null;
  const duration = q.get('duration');
  const laps = q.get('laps');
  return sanitizeSetup({
    ...base,
    humans: q.get('humans') === '2' ? 2 : 1,
    bots: bots !== null && bots !== '' ? Number(bots) : base.bots,
    botDifficulty: difficulty && DIFFICULTIES.includes(difficulty) ? difficulty : base.botDifficulty,
    durationSec: duration ? Number(duration) : base.durationSec,
    laps: laps ? Number(laps) : base.laps,
  });
}
