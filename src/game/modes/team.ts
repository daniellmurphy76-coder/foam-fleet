/**
 * Team Up: the humans (and any helper bots) play as one team against the other bots.
 *
 * It is Dart Battle with a team scoreboard: every boat scores its own hits, the team score is the
 * sum, and the clock decides. Darts pass through teammates (the dart system does that), so there is
 * nothing to do here for friendly fire. Rows are still ranked by each boat's own hits.
 */
import { CONFIG } from '../../config';
import type { ResultRow, TeamScore } from '../../types';
import { BattleMode } from './battle';
import type { ModeOutcome, ModeResult } from './mode';

export class TeamMode extends BattleMode {
  override readonly id = 'team' as const;

  /** Team scores in team order (team 0 = the humans' side). */
  override teams(): TeamScore[] {
    const sums = [0, 0];
    for (const b of this.host.boats) {
      if (b.team === 0 || b.team === 1) sums[b.team] += this.score[b.id] ?? 0;
    }
    return [0, 1].map((team) => ({
      team,
      name: CONFIG.team.names[team],
      color: CONFIG.team.colors[team],
      score: sums[team],
    }));
  }

  override outcome(boatId: number): ModeOutcome {
    const boat = this.host.boats[boatId];
    const [a, b] = this.teams();
    const mine = boat?.team === 1 ? b : a;
    const theirs = boat?.team === 1 ? a : b;
    return { won: mine.score > theirs.score, finished: false, finishTime: null };
  }

  override result(): ModeResult {
    const [a, b] = this.teams();
    const tied = a.score === b.score;
    const winner = b.score > a.score ? b : a;
    const loser = winner === a ? b : a;
    const rows: ResultRow[] = this.rows();
    return {
      mode: 'team',
      rows,
      title: tied ? "It's a tie!" : `${winner.name} wins!`,
      teams: [winner, loser],
    };
  }
}
