/**
 * Buoy Race: drive through the gates in order, lap after lap. Darts only stun.
 *
 * Per boat we track `lap` and `next` (the index of the gate it must pass next).
 * Every boat starts on the grid just BEHIND gate 0, so:
 *   - the first time a boat reaches gate 0, lap 1 begins and `next` becomes gate 1;
 *   - passing gate 0 again after all the other gates completes a lap;
 *   - completing the last lap means the boat has finished.
 */
import { CONFIG } from '../../config';
import type * as THREE from 'three';
import type { Boat, Checkpoint, RaceHudInfo, ResultRow, TeamScore } from '../../types';
import { fallbackCheckpoints } from '../fallbacks';
import { formatTime, ordinal } from '../util';
import type { GameMode, GateTargets, ModeHost, ModeOutcome, ModeResult } from './mode';

/*
 * When does the race end? Whichever comes first:
 *   - every human has finished (after a short breather),
 *   - CONFIG.race.finishGraceSec seconds after the FIRST HUMAN finishes (so a slower second
 *     player still gets a go),
 *   - every boat has finished,
 *   - the hard cap below.
 * A computer boat finishing first ends nothing: the humans keep racing.
 */
/** A little breathing room so the "FINISHED!" banner is seen before the results appear. */
const GRACE_AFTER_LAST = 2.5;
/** Safety net: no race lasts longer than this. */
const MAX_RACE_SEC = 720;
/** Heading away from the gate: cosine of the angle to the gate is below this (about 107 degrees). */
const WRONG_WAY_DOT = -0.3;
const WRONG_WAY_SECONDS = 2;

export class RaceMode implements GameMode {
  readonly id = 'race' as const;
  readonly stunSeconds = CONFIG.race.stunSeconds;
  readonly ranking: Boat[];
  /** The gates this race really uses (the mini-map draws these). */
  readonly gateList: readonly Checkpoint[];
  over = false;

  private readonly cps: readonly Checkpoint[];
  private readonly laps: number;
  private elapsed = 0;
  private endAt = MAX_RACE_SEC;
  private finishedCount = 0;
  private finishedHumans = 0;

  // Per-boat state, indexed by boat id.
  private readonly lap: number[];
  private readonly next: number[];
  private readonly finished: boolean[];
  private readonly finishTime: number[];
  private readonly dist: number[];
  private readonly wrong: number[];
  private readonly rank: number[];

  constructor(private readonly host: ModeHost) {
    const n = host.boats.length;
    const real = host.world.checkpoints;
    this.cps = real.length >= 2 ? real : fallbackCheckpoints();
    this.gateList = this.cps;
    this.laps = Math.max(1, Math.round(host.setup.laps || CONFIG.race.laps));
    this.lap = new Array<number>(n).fill(0);
    this.next = new Array<number>(n).fill(0);
    this.finished = new Array<boolean>(n).fill(false);
    this.finishTime = new Array<number>(n).fill(0);
    this.dist = new Array<number>(n).fill(0);
    this.wrong = new Array<number>(n).fill(0);
    this.rank = new Array<number>(n).fill(0);
    this.ranking = host.boats.slice();
    this.measureDistances();
    this.resort();
  }

  begin(): void {
    this.elapsed = 0;
    this.endAt = MAX_RACE_SEC;
    this.over = false;
    this.measureDistances();
    this.resort();
  }

  update(dt: number): void {
    if (this.over) return;
    this.elapsed += dt;
    const boats = this.host.boats;
    for (let i = 0; i < boats.length; i++) {
      if (this.finished[i]) continue;
      const boat = boats[i];
      const cp = this.cps[this.next[i]];
      const dx = cp.position.x - boat.position.x;
      const dz = cp.position.z - boat.position.z;
      const d2 = dx * dx + dz * dz;
      this.dist[i] = Math.sqrt(d2);
      if (d2 < cp.radius * cp.radius) {
        this.pass(i, boat);
      } else if (boat.isHuman) {
        this.checkWrongWay(i, boat, dx, dz, dt);
      }
    }
    this.resort();
    if (this.elapsed >= this.endAt) this.over = true;
  }

  /** Darts only stun in a race (the dart system does that); no points to hand out. */
  onTag(): void {}
  onBalloon(): void {}

  gates(boatId: number, out: GateTargets): void {
    if (this.finished[boatId]) {
      out.next = null;
      out.following = null;
      return;
    }
    const k = this.next[boatId];
    out.next = this.cps[k];
    // On the very last crossing there is no "gate after that" worth blending toward.
    const lastCrossing = this.lap[boatId] >= this.laps && k === 0;
    out.following = lastCrossing ? null : this.cps[(k + 1) % this.cps.length];
  }

  gatePosition(boatId: number): THREE.Vector3 | null {
    return this.finished[boatId] ? null : this.cps[this.next[boatId]].position;
  }

  nextGate(boatId: number): number | null {
    return this.finished[boatId] ? null : this.next[boatId];
  }

  isFinished(boatId: number): boolean { return this.finished[boatId]; }

  timeLeft(): number | null { return null; }
  raceTime(): number { return this.elapsed; }
  scoreOf(boatId: number): number { return this.finished[boatId] ? this.laps : Math.max(0, this.lap[boatId] - 1); }
  rankOf(boatId: number): number { return this.rank[boatId] || 1; }
  teams(): TeamScore[] | null { return null; }
  balloonCount(): { remaining: number; total: number } | null { return null; }

  raceInfo(boatId: number): RaceHudInfo {
    return {
      lap: Math.min(this.laps, Math.max(1, this.lap[boatId])),
      laps: this.laps,
      // The HUD counts only the NUMBERED gates (the start/finish line is not "Gate 0"), so "Gate 3/9"
      // always matches the signs floating on the water: gate sign k is checkpoints[k], k = 1..N-1.
      checkpoint: this.numberedGatesPassed(boatId),
      checkpoints: this.cps.length - 1,
      finished: this.finished[boatId],
    };
  }

  outcome(boatId: number): ModeOutcome {
    const done = this.finished[boatId] === true;
    return { won: done && this.ranking[0]?.id === boatId, finished: done, finishTime: done ? this.finishTime[boatId] : null };
  }

  result(): ModeResult {
    const rows: ResultRow[] = this.ranking.map((b, i) => ({
      id: b.id, name: b.name, color: b.color, score: this.scoreOf(b.id), isHuman: b.isHuman, team: b.team,
      place: i + 1,
      // Boats still racing when the race ends show how far they got (never "DNF"), e.g. "Lap 2 · Gate 5/9".
      detail: this.finished[b.id] ? formatTime(this.finishTime[b.id]) : this.progressText(b.id),
    }));
    const winner = this.ranking[0];
    const title = this.finished[winner.id] ? `${winner.name} wins!` : "Time's up!";
    return { mode: 'race', rows, title, teams: null };
  }

  // ───────────── internals ─────────────

  /** "Lap 2 · Gate 5/9": how far an unfinished boat got. Same counting as the HUD. */
  private progressText(i: number): string {
    const info = this.raceInfo(i);
    return `Lap ${info.lap} · Gate ${info.checkpoint}/${info.checkpoints}`;
  }

  /** Numbered gates (1..N-1) passed in the current lap: 0 right after the start line, N-1 once only the finish line is left. */
  private numberedGatesPassed(i: number): number {
    if (this.lap[i] === 0) return 0;
    const k = this.next[i];
    return k === 0 ? this.cps.length - 1 : k - 1;
  }

  /** Gates passed in the current lap, counting the start line (0 before the start line, N once only the finish line is left). Used for ranking. */
  private passedThisLap(i: number): number {
    if (this.lap[i] === 0) return 0;
    const k = this.next[i];
    return k === 0 ? this.cps.length : k;
  }

  private pass(i: number, boat: Boat): void {
    const n = this.cps.length;
    const k = this.next[i];
    const slot = this.host.slotOf(i);
    const { hud, sfx } = this.host;

    if (k !== 0) {
      this.next[i] = (k + 1) % n; // after the last gate this wraps to 0: the finish line
      if (slot >= 0) sfx.checkpoint();
      return;
    }
    if (this.lap[i] === 0) {
      // Rolled up to the start line: lap 1 begins.
      this.lap[i] = 1;
      this.next[i] = 1 % n;
      return;
    }
    // Crossed the line with every gate behind us: a lap is done.
    if (this.lap[i] >= this.laps) {
      this.finish(i, boat, slot);
      return;
    }
    this.lap[i]++;
    this.next[i] = 1 % n;
    if (slot >= 0) {
      sfx.lap();
      if (this.lap[i] === this.laps) hud.announce('FINAL LAP!', { viewport: slot, ms: 1600 });
      else hud.announce(`LAP ${this.lap[i]}/${this.laps}`, { viewport: slot, ms: 1100 });
    }
  }

  private finish(i: number, boat: Boat, slot: number): void {
    const { hud, sfx, humanCount, boats } = this.host;
    this.finished[i] = true;
    this.finishTime[i] = this.elapsed;
    this.lap[i] = this.laps;
    this.next[i] = 0;
    this.finishedCount++;
    const place = this.finishedCount;
    hud.feed(`${boat.name} finished ${ordinal(place)}!`, boat.color);

    if (slot >= 0) {
      this.finishedHumans++;
      sfx.lap();
      hud.announce('FINISHED!', { sub: `${ordinal(place)} place`, viewport: slot, ms: 2600 });
      if (this.finishedHumans === 1) {
        const grace = CONFIG.race.finishGraceSec;
        this.endAt = Math.min(this.endAt, this.elapsed + grace);
        // Tell the other human they have a limited time left.
        const secs = Math.max(1, Math.round(grace));
        for (let s = 0; s < humanCount; s++) {
          if (s !== slot && !this.finished[s]) {
            hud.announce(`${secs} ${secs === 1 ? 'SECOND' : 'SECONDS'} LEFT!`, { sub: `${boat.name} finished`, viewport: s, ms: 2200 });
          }
        }
      }
      if (this.finishedHumans >= humanCount) this.endAt = Math.min(this.endAt, this.elapsed + GRACE_AFTER_LAST);
    }
    if (this.finishedCount >= boats.length) this.endAt = Math.min(this.endAt, this.elapsed + GRACE_AFTER_LAST);
  }

  /** If a human has been pointing away from their next gate for 2 s, shout about it (then hush for a while). */
  private checkWrongWay(i: number, boat: Boat, dx: number, dz: number, dt: number): void {
    const len = Math.hypot(dx, dz);
    const facing = len > 1 ? (Math.sin(boat.heading) * dx + Math.cos(boat.heading) * dz) / len : 1;
    if (facing < WRONG_WAY_DOT && boat.speed > 3) this.wrong[i] += dt;
    else this.wrong[i] = 0;
    if (this.wrong[i] >= WRONG_WAY_SECONDS) {
      this.wrong[i] = -3;
      this.host.hud.announce('WRONG WAY!', { sub: 'Turn around', viewport: this.host.slotOf(i), ms: 1500 });
    }
  }

  private measureDistances(): void {
    const boats = this.host.boats;
    for (let i = 0; i < boats.length; i++) {
      const cp = this.cps[this.next[i]];
      this.dist[i] = Math.hypot(cp.position.x - boats[i].position.x, cp.position.z - boats[i].position.z);
    }
  }

  /** Finished boats first (by time), then by lap, gates passed, and distance to the next gate. */
  private readonly compare = (a: Boat, b: Boat): number => {
    const ia = a.id, ib = b.id;
    if (this.finished[ia] !== this.finished[ib]) return this.finished[ia] ? -1 : 1;
    if (this.finished[ia]) return (this.finishTime[ia] - this.finishTime[ib]) || (ia - ib);
    const pa = this.lap[ia] * 1000 + this.passedThisLap(ia);
    const pb = this.lap[ib] * 1000 + this.passedThisLap(ib);
    if (pa !== pb) return pb - pa;
    return (this.dist[ia] - this.dist[ib]) || (ia - ib);
  };

  private resort(): void {
    this.ranking.sort(this.compare);
    for (let r = 0; r < this.ranking.length; r++) this.rank[this.ranking[r].id] = r + 1;
  }
}
