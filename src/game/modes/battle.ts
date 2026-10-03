/**
 * Dart Battle: tag the other boats with foam darts. Most tags when the clock hits zero wins.
 * Ties are broken by who got tagged fewer times.
 */
import type * as THREE from 'three';
import { CONFIG } from '../../config';
import type { Boat, MatchResult, RaceHudInfo, ResultRow } from '../../types';
import type { GameMode, GateTargets, ModeHost } from './mode';

export class BattleMode implements GameMode {
  readonly id = 'battle' as const;
  readonly stunSeconds = CONFIG.battle.stunSeconds;
  readonly ranking: Boat[];
  over = false;

  private elapsed = 0;
  private readonly duration: number;
  private readonly score: number[];
  private readonly hitsTaken: number[];
  private readonly rank: number[];
  private warned30 = false;
  private lastBeep = -1;

  constructor(private readonly host: ModeHost) {
    const n = host.boats.length;
    this.duration = Math.max(5, host.setup.durationSec || CONFIG.battle.durationSec);
    this.score = new Array<number>(n).fill(0);
    this.hitsTaken = new Array<number>(n).fill(0);
    this.rank = new Array<number>(n).fill(0);
    this.ranking = host.boats.slice();
    this.resort();
  }

  begin(): void {
    this.elapsed = 0;
    this.over = false;
  }

  update(dt: number): void {
    if (this.over) return;
    this.elapsed += dt;
    const left = this.duration - this.elapsed;
    const { hud, sfx } = this.host;

    if (!this.warned30 && this.duration > 30 && left <= 30) {
      this.warned30 = true;
      hud.announce('30 SECONDS LEFT!', { ms: 1800 });
    }
    // One beep per second over the last ten seconds.
    if (left <= 10 && left > 0) {
      const secs = Math.ceil(left);
      if (secs !== this.lastBeep) {
        this.lastBeep = secs;
        sfx.countdown(Math.min(secs, 3));
      }
    }
    if (left <= 0) this.over = true;
  }

  onTag(shooter: Boat, target: Boat): void {
    this.score[shooter.id] += CONFIG.battle.pointsPerHit;
    this.hitsTaken[target.id]++;
    this.resort();
  }

  gates(_boatId: number, out: GateTargets): void {
    out.next = null;
    out.following = null;
  }
  gatePosition(): THREE.Vector3 | null { return null; }
  isFinished(): boolean { return false; }

  timeLeft(): number { return Math.max(0, this.duration - this.elapsed); }
  raceTime(): number | null { return null; }
  scoreOf(boatId: number): number { return this.score[boatId] ?? 0; }
  rankOf(boatId: number): number { return this.rank[boatId] || 1; }
  raceInfo(): RaceHudInfo | null { return null; }

  result(): MatchResult {
    const rows: ResultRow[] = this.ranking.map((b, i) => {
      const s = this.score[b.id];
      return {
        id: b.id, name: b.name, color: b.color, score: s, isHuman: b.isHuman,
        place: i + 1, detail: `${s} ${s === 1 ? 'hit' : 'hits'}`,
      };
    });
    const first = this.ranking[0];
    const second = this.ranking[1];
    const tied = second !== undefined
      && this.score[first.id] === this.score[second.id]
      && this.hitsTaken[first.id] === this.hitsTaken[second.id];
    return { mode: 'battle', rows, title: tied ? "It's a tie!" : `${first.name} wins!` };
  }

  /** Most hits first; fewer hits taken breaks a tie; boat id keeps the order steady. */
  private resort(): void {
    this.ranking.sort((a, b) =>
      (this.score[b.id] - this.score[a.id]) || (this.hitsTaken[a.id] - this.hitsTaken[b.id]) || (a.id - b.id));
    for (let r = 0; r < this.ranking.length; r++) this.rank[this.ranking[r].id] = r + 1;
  }
}
