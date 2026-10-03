/**
 * Boats vs. Sharks: the humans and their helper boats are one team. Five waves of goofy cartoon
 * sharks swim in from the edge of the lagoon, then the MEGA SHARK. Darts scare sharks off (1 point each);
 * every shark bump pops one of the team's life rings. Beat the MEGA SHARK to win. Lose every ring and the
 * sharks win this time. There is no clock: the HUD counts up.
 *
 * The Sharks module does the swimming, chasing and bumping. This file only keeps the rules: which wave
 * is next, how many rings are left, who scored, and when it is over.
 */
import type * as THREE from 'three';
import { CONFIG } from '../../config';
import type {
  Boat, Checkpoint, RaceHudInfo, ResultRow, SharkBump, SharkHud, SharkTag, TeamScore,
} from '../../types';
import type { GameMode, GateTargets, ModeHost, ModeOutcome, ModeResult } from './mode';

const NO_GATES: readonly Checkpoint[] = [];
/**
 * A quiet moment between GO! and the first wave. It is as long as a break between waves, because the HUD's
 * "Get ready… n" count runs for CONFIG.sharks.waveBreakSec whenever betweenWaves is true.
 */
const INTRO_SEC = Math.max(1, CONFIG.sharks.waveBreakSec);
/** After sending a wave in, wait this long before believing "no sharks left" (the module may count them in late). */
const SETTLE_SEC = 1.5;
/** After the last MEGA hit or the last ring, a pause so the moment is seen before the results appear. */
const WIN_TAIL_SEC = 3;
const LOSE_TAIL_SEC = 2;
/** If the MEGA SHARK never shows up this long after being sent in, the round counts as done (nothing to fight). */
const MEGA_APPEAR_SEC = 8;
/** Bonus for the dart that beats the MEGA SHARK (on top of the 1 point every hit gets). */
const FINAL_HIT_BONUS = 5;
/** Safety net: nobody plays Boats vs. Sharks for longer than this. */
const MAX_SEC = 1500;

type Phase = 'break' | 'wave' | 'mega' | 'won' | 'lost';

export class SharksMode implements GameMode {
  readonly id = 'sharks' as const;
  /** Only helper boats and humans are on the water, so darts never really stun anyone. */
  readonly stunSeconds = CONFIG.battle.stunSeconds;
  readonly ranking: Boat[];
  readonly gateList = NO_GATES;
  over = false;

  private phase: Phase = 'break';
  /** The wave being fought (or about to start), 1-based. waves + 1 = the MEGA SHARK round. */
  private wave = 1;
  private elapsed = 0;
  private breakLeft = INTRO_SEC;
  private sinceSpawn = 0;
  private seenMega = false;
  private tail = 0;
  private rings: number;
  private warnedLow = false;
  private warnedLast = false;
  private readonly waves: number;
  private readonly maxRings: number;
  private readonly score: number[];
  private readonly tags: number[];
  private readonly bumps: number[];
  private readonly rank: number[];

  constructor(private readonly host: ModeHost) {
    const n = host.boats.length;
    this.waves = CONFIG.sharks.waves.length;
    this.maxRings = Math.max(1, Math.round(CONFIG.sharks.lifeRings));
    this.rings = this.maxRings;
    this.score = new Array<number>(n).fill(0);
    this.tags = new Array<number>(n).fill(0);
    this.bumps = new Array<number>(n).fill(0);
    this.rank = new Array<number>(n).fill(0);
    this.ranking = host.boats.slice();
    this.resort();
  }

  begin(): void {
    this.phase = 'break';
    this.wave = 1;
    this.elapsed = 0;
    this.breakLeft = INTRO_SEC;
    this.sinceSpawn = 0;
    this.seenMega = false;
    this.tail = 0;
    this.rings = this.maxRings;
    this.warnedLow = false;
    this.warnedLast = false;
    this.over = false;
  }

  update(dt: number): void {
    if (this.over) return;
    if (this.phase === 'won' || this.phase === 'lost') {
      this.tail += dt;
      if (this.tail >= (this.phase === 'won' ? WIN_TAIL_SEC : LOSE_TAIL_SEC)) this.over = true;
      return;
    }
    this.elapsed += dt;
    if (this.elapsed >= MAX_SEC) {
      this.lose();
      return;
    }
    const sharks = this.host.sharks;
    switch (this.phase) {
      case 'break':
        this.breakLeft -= dt;
        if (this.breakLeft <= 0) this.startRound();
        break;
      case 'wave':
        this.sinceSpawn += dt;
        if (this.sinceSpawn >= SETTLE_SEC && sharks.waveLeft <= 0) this.waveCleared();
        break;
      case 'mega':
        // The dart that beats it ends the round (onSharkTag). This is the backstop: it came out and is gone now,
        // or the module never had one to send.
        this.sinceSpawn += dt;
        if (sharks.mega) this.seenMega = true;
        else if (this.seenMega || this.sinceSpawn >= MEGA_APPEAR_SEC) this.win();
        break;
      default:
        break;
    }
  }

  /** Announce the next wave (or the MEGA SHARK) and send the sharks in. */
  private startRound(): void {
    const { hud, sfx, sharks } = this.host;
    this.sinceSpawn = 0;
    if (this.wave <= this.waves) {
      this.phase = 'wave';
      hud.announce(`WAVE ${this.wave}`, { sub: 'Here come the sharks!', ms: 1800 });
      sfx.waveStart();
      sharks.spawnWave(this.countFor(this.wave), false);
    } else {
      this.phase = 'mega';
      this.seenMega = false;
      hud.announce('MEGA SHARK!', { sub: 'Everybody shoot it!', ms: 2400 });
      sfx.megaRoar();
      sharks.spawnWave(1, true);
    }
  }

  private waveCleared(): void {
    this.wave++;
    this.phase = 'break';
    this.breakLeft = Math.max(1, CONFIG.sharks.waveBreakSec);
    this.host.hud.announce('WAVE CLEARED!', {
      sub: this.wave > this.waves ? 'Something big is coming…' : 'Get ready…',
      ms: Math.min(1400, this.breakLeft * 1000 - 400),
    });
    this.host.sfx.lap();
  }

  private win(): void {
    if (this.phase === 'won' || this.phase === 'lost') return;
    this.phase = 'won';
    this.tail = 0;
    this.host.hud.announce('YOU DID IT!', { sub: 'The MEGA SHARK is beaten!', ms: 2400 });
  }

  private lose(): void {
    if (this.phase === 'won' || this.phase === 'lost') return;
    this.phase = 'lost';
    this.tail = 0;
    this.host.hud.announce('OUT OF LIFE RINGS!', { sub: 'The sharks win this time…', ms: 1800 });
  }

  private countFor(wave: number): number {
    return Math.max(1, Math.round(CONFIG.sharks.waves[wave - 1] ?? 1));
  }

  // ───────────── events from the Match ─────────────

  onSharkBump(bump: SharkBump): void {
    // A shield soaks the bump up; a bump on a PLAYER's boat costs the team a ring (the MEGA SHARK takes two).
    // Helper boats just wobble: they're there to help, not to lose the game for you.
    if (bump.blocked || this.phase === 'won' || this.phase === 'lost') return;
    if (bump.boatId >= 0 && bump.boatId < this.bumps.length) this.bumps[bump.boatId]++;
    if (this.host.slotOf(bump.boatId) < 0) return;
    this.rings = Math.max(0, this.rings - (bump.mega ? 2 : 1));
    this.resort();
    if (this.rings <= 0) {
      this.lose();
    } else if (this.rings === 1 && !this.warnedLast) {
      this.warnedLast = true;
      this.host.hud.announce('LAST LIFE RING!', { ms: 1400 });
    } else if (this.rings <= 3 && !this.warnedLow) {
      this.warnedLow = true;
      this.host.hud.announce(`ONLY ${this.rings} RINGS LEFT!`, { ms: 1400 });
    }
  }

  onSharkTag(shooter: Boat, tag: SharkTag): void {
    if (this.phase === 'won' || this.phase === 'lost') return;
    const id = shooter.id;
    if (id < 0 || id >= this.score.length) return;
    this.score[id] += 1;
    if (!tag.mega) this.tags[id]++;
    if (tag.mega && tag.defeated) {
      this.score[id] += FINAL_HIT_BONUS;
      this.resort();
      this.win();
      return;
    }
    this.resort();
  }

  onTag(): void {}
  onBalloon(): void {}

  gates(_boatId: number, out: GateTargets): void {
    out.next = null;
    out.following = null;
  }
  gatePosition(): THREE.Vector3 | null { return null; }
  nextGate(): number | null { return null; }
  isFinished(): boolean { return false; }

  timeLeft(): number | null { return null; }
  raceTime(): number { return this.elapsed; }
  scoreOf(boatId: number): number { return this.score[boatId] ?? 0; }
  rankOf(boatId: number): number { return this.rank[boatId] || 1; }
  raceInfo(): RaceHudInfo | null { return null; }
  teams(): TeamScore[] | null { return null; }
  balloonCount(): { remaining: number; total: number } | null { return null; }

  /** A fresh object every call: the HUD compares what it drew last time with what it gets now. */
  sharkHud(): SharkHud {
    const sharks = this.host.sharks;
    const mega = sharks.mega;
    let left: number;
    switch (this.phase) {
      case 'mega': left = Math.max(sharks.waveLeft, mega ? 1 : 0); break;
      // Between waves, show how many are on their way.
      case 'break': left = this.wave <= this.waves ? this.countFor(this.wave) : 1; break;
      case 'won': left = 0; break;
      default: left = sharks.waveLeft; break;
    }
    return {
      wave: Math.min(this.wave, this.waves + 1),
      waves: this.waves,
      sharksLeft: Math.max(0, left),
      rings: this.rings,
      maxRings: this.maxRings,
      mega: mega ? { health: mega.health, maxHealth: mega.maxHealth } : null,
      betweenWaves: this.phase === 'break',
    };
  }

  outcome(_boatId: number): ModeOutcome {
    const won = this.phase === 'won';
    return { won, finished: false, finishTime: null, megaDefeated: won };
  }

  result(): ModeResult {
    const rows: ResultRow[] = this.ranking.map((b, i) => {
      const s = this.score[b.id];
      const t = this.tags[b.id];
      return {
        id: b.id, name: b.name, color: b.color, score: s, isHuman: b.isHuman, team: b.team,
        place: i + 1, detail: `${s} ${s === 1 ? 'point' : 'points'} · ${t} shark ${t === 1 ? 'tag' : 'tags'}`,
      };
    });
    return {
      mode: 'sharks',
      rows,
      title: this.phase === 'won' ? 'You beat the sharks!' : 'The sharks win this time!',
      teams: null,
    };
  }

  /** Most points first; getting bumped less breaks a tie; boat id keeps the order steady. */
  private resort(): void {
    this.ranking.sort((a, b) =>
      (this.score[b.id] - this.score[a.id]) || (this.bumps[a.id] - this.bumps[b.id]) || (a.id - b.id));
    for (let r = 0; r < this.ranking.length; r++) this.rank[this.ranking[r].id] = r + 1;
  }
}
