/**
 * The small interface every game mode (Dart Battle, Buoy Race, Team Up, Balloon Pop, Boats vs. Sharks) implements.
 * The Match calls these hooks; the mode decides what counts as scoring and winning.
 */
import type * as THREE from 'three';
import type {
  Balloons, BalloonPop, Boat, Checkpoint, Hud, MatchResult, MatchSetup, ModeId, RaceHudInfo, Sfx, SharkBump, SharkHud,
  Sharks, SharkTag, TeamScore, World,
} from '../../types';

/** What a mode needs to know about the match it lives in. */
export interface ModeHost {
  readonly setup: MatchSetup;
  readonly boats: readonly Boat[];
  readonly humanCount: number;
  readonly world: World;
  readonly hud: Hud;
  readonly sfx: Sfx;
  /** Balloon Pop's balloons; null in every other mode. */
  readonly balloons: Balloons | null;
  /** Every shark in the lagoon (Boats vs. Sharks sends its waves in through this). */
  readonly sharks: Sharks;
  /** Which human viewport a boat belongs to (0 or 1), or -1 for a computer boat. */
  slotOf(boatId: number): number;
}

/** Scratch object the Match fills in per boat (so we do not allocate every step). */
export interface GateTargets {
  next: Checkpoint | null;
  following: Checkpoint | null;
}

/** How one boat did, for trophies. Only asked for once the match is over. */
export interface ModeOutcome {
  /** Won the match (Team Up: their team won; Balloon Pop: popped the most, or the only player). */
  won: boolean;
  /** Race: crossed the finish line. Balloon Pop: every balloon got popped. */
  finished: boolean;
  /** Race / Balloon Pop: seconds it took, else null. */
  finishTime: number | null;
  /** Boats vs. Sharks: the team beat the MEGA SHARK. Every other mode leaves it out (= false). */
  megaDefeated?: boolean;
}

/** A mode's result; the Match adds the per-player stats and trophy awards on top. */
export type ModeResult = Omit<MatchResult, 'stats' | 'awards'>;

export interface GameMode {
  readonly id: ModeId;
  /** How long a boat is wobbly after a dart hit in this mode. */
  readonly stunSeconds: number;
  /** True once the match is finished and the results screen should appear. */
  readonly over: boolean;
  /** All boats, best first. Updated as the match goes on. */
  readonly ranking: readonly Boat[];
  /** Race: the gates, in order, for the mini-map. Empty in every other mode. */
  readonly gateList: readonly Checkpoint[];

  /** "GO!" just happened: start the clock. */
  begin(): void;
  /** One fixed simulation step of the rules (timers, gates, announcements). */
  update(dt: number): void;
  /** A dart tagged `target` (shield did not block it). */
  onTag(shooter: Boat, target: Boat): void;
  /** Balloon Pop: a balloon popped (by a dart or by ramming). */
  onBalloon(pop: BalloonPop): void;
  /** A shark bumped a boat (rules on). Boats vs. Sharks pops life rings for it; every other mode ignores it. */
  onSharkBump(bump: SharkBump): void;
  /** A dart tagged a shark (rules on). Boats vs. Sharks scores it; every other mode ignores it. */
  onSharkTag(shooter: Boat, tag: SharkTag): void;

  /** Race: which gates this boat should aim for. Battle: both null. */
  gates(boatId: number, out: GateTargets): void;
  /** Race: where the HUD arrow should point for this boat (null in battle or once finished). */
  gatePosition(boatId: number): THREE.Vector3 | null;
  /** Race: index into gateList of this boat's next gate (null in other modes or once finished). */
  nextGate(boatId: number): number | null;
  /** Race: finished boats stop being driven by their controller. */
  isFinished(boatId: number): boolean;

  timeLeft(): number | null;
  raceTime(): number | null;
  scoreOf(boatId: number): number;
  /** 1-based placement. */
  rankOf(boatId: number): number;
  raceInfo(boatId: number): RaceHudInfo | null;
  /** Team Up: both teams, the humans' team first. null otherwise. */
  teams(): TeamScore[] | null;
  /** Balloon Pop: balloons left. null otherwise. */
  balloonCount(): { remaining: number; total: number } | null;
  /** Boats vs. Sharks: wave, sharks left, life rings, MEGA health. null otherwise. */
  sharkHud(): SharkHud | null;

  /** Only meaningful once `over`. */
  outcome(boatId: number): ModeOutcome;
  result(): ModeResult;
}
