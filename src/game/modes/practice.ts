/**
 * Balloon Pop: no bots, no clock to beat. Pop every balloon in the lagoon by shooting it or
 * simply driving through it (so a kid who can't aim yet still scores). The clock counts up and
 * the match ends when the last balloon pops. With two players, the most points wins.
 */
import type * as THREE from 'three';
import { CONFIG } from '../../config';
import type { BalloonPop, Boat, Checkpoint, RaceHudInfo, ResultRow, TeamScore } from '../../types';
import { formatTime } from '../util';
import type { GameMode, GateTargets, ModeHost, ModeOutcome, ModeResult } from './mode';

const NO_GATES: readonly Checkpoint[] = [];
/** After the last pop, a short pause so the pop (and "ALL POPPED!") is seen before the results appear. */
const CELEBRATE_SEC = 1.8;
/** Safety net: nobody plays Balloon Pop for longer than this. */
const MAX_SEC = 900;

export class PracticeMode implements GameMode {
  readonly id = 'practice' as const;
  /** Boats only wobble if the other player tags them; nobody scores for it. */
  readonly stunSeconds = CONFIG.battle.stunSeconds;
  readonly ranking: Boat[];
  readonly gateList = NO_GATES;
  over = false;

  private elapsed = 0;
  /** Clock time when the last balloon popped (null while balloons remain). */
  private doneAt: number | null = null;
  private tail = 0;
  private lastOneCalled = false;
  private readonly score: number[];
  private readonly rank: number[];

  constructor(private readonly host: ModeHost) {
    const n = host.boats.length;
    this.score = new Array<number>(n).fill(0);
    this.rank = new Array<number>(n).fill(0);
    this.ranking = host.boats.slice();
    this.resort();
  }

  begin(): void {
    this.elapsed = 0;
    this.doneAt = null;
    this.tail = 0;
    this.over = false;
  }

  update(dt: number): void {
    if (this.over) return;
    const balloons = this.host.balloons;
    if (this.doneAt === null) {
      this.elapsed += dt;
      if (balloons && balloons.total > 1 && balloons.remaining === 1 && !this.lastOneCalled) {
        this.lastOneCalled = true;
        this.host.hud.announce('LAST BALLOON!', { ms: 1400 });
      }
      if (!balloons || balloons.remaining <= 0) {
        this.doneAt = this.elapsed;
        this.host.hud.announce('ALL POPPED!', { sub: formatTime(this.elapsed), ms: CELEBRATE_SEC * 1000 });
      }
    } else {
      this.tail += dt;
      if (this.tail >= CELEBRATE_SEC) this.over = true;
    }
    if (this.elapsed >= MAX_SEC) this.over = true;
  }

  onTag(): void {}

  onBalloon(pop: BalloonPop): void {
    if (pop.boatId < 0 || pop.boatId >= this.score.length) return;
    this.score[pop.boatId] += pop.value;
    this.resort();
  }

  gates(_boatId: number, out: GateTargets): void {
    out.next = null;
    out.following = null;
  }
  gatePosition(): THREE.Vector3 | null { return null; }
  nextGate(): number | null { return null; }
  isFinished(): boolean { return false; }

  timeLeft(): number | null { return null; }
  raceTime(): number { return this.doneAt ?? this.elapsed; }
  scoreOf(boatId: number): number { return this.score[boatId] ?? 0; }
  rankOf(boatId: number): number { return this.rank[boatId] || 1; }
  raceInfo(): RaceHudInfo | null { return null; }
  teams(): TeamScore[] | null { return null; }

  balloonCount(): { remaining: number; total: number } | null {
    const b = this.host.balloons;
    return b ? { remaining: b.remaining, total: b.total } : null;
  }

  outcome(boatId: number): ModeOutcome {
    const top = this.ranking[0] ? this.score[this.ranking[0].id] : 0;
    const only = this.host.humanCount < 2;
    return {
      won: only || (this.score[boatId] ?? 0) >= top,
      finished: this.doneAt !== null,
      finishTime: this.doneAt,
    };
  }

  result(): ModeResult {
    const time = formatTime(this.raceTime());
    const rows: ResultRow[] = this.ranking.map((b, i) => {
      const s = this.score[b.id];
      return {
        id: b.id, name: b.name, color: b.color, score: s, isHuman: b.isHuman, team: b.team,
        // Points, not a balloon count: a gold balloon is worth 3.
        place: i + 1, detail: `${s} ${s === 1 ? 'point' : 'points'} · ${time}`,
      };
    });
    const first = this.ranking[0];
    const second = this.ranking[1];
    let title: string;
    if (this.doneAt === null) title = "Time's up!";
    else if (this.host.humanCount < 2 || !second) title = `${first.name} popped them all!`;
    else title = this.score[first.id] === this.score[second.id] ? "It's a tie!" : `${first.name} wins!`;
    return { mode: 'practice', rows, title, teams: null };
  }

  /** Most points first; boat id keeps the order steady. */
  private resort(): void {
    this.ranking.sort((a, b) => (this.score[b.id] - this.score[a.id]) || (a.id - b.id));
    for (let r = 0; r < this.ranking.length; r++) this.rank[this.ranking[r].id] = r + 1;
  }
}
