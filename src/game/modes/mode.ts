/**
 * The small interface every game mode (Dart Battle, Buoy Race) implements.
 * The Match calls these hooks; the mode decides what counts as scoring and winning.
 */
import type * as THREE from 'three';
import type { Boat, Checkpoint, Hud, MatchResult, MatchSetup, ModeId, RaceHudInfo, Sfx, World } from '../../types';

/** What a mode needs to know about the match it lives in. */
export interface ModeHost {
  readonly setup: MatchSetup;
  readonly boats: readonly Boat[];
  readonly humanCount: number;
  readonly world: World;
  readonly hud: Hud;
  readonly sfx: Sfx;
  /** Which human viewport a boat belongs to (0 or 1), or -1 for a computer boat. */
  slotOf(boatId: number): number;
}

/** Scratch object the Match fills in per boat (so we do not allocate every step). */
export interface GateTargets {
  next: Checkpoint | null;
  following: Checkpoint | null;
}

export interface GameMode {
  readonly id: ModeId;
  /** How long a boat is wobbly after a dart hit in this mode. */
  readonly stunSeconds: number;
  /** True once the match is finished and the results screen should appear. */
  readonly over: boolean;
  /** All boats, best first. Updated as the match goes on. */
  readonly ranking: readonly Boat[];

  /** "GO!" just happened: start the clock. */
  begin(): void;
  /** One fixed simulation step of the rules (timers, gates, announcements). */
  update(dt: number): void;
  /** A dart tagged `target` (shield did not block it). */
  onTag(shooter: Boat, target: Boat): void;

  /** Race: which gates this boat should aim for. Battle: both null. */
  gates(boatId: number, out: GateTargets): void;
  /** Race: where the HUD arrow should point for this boat (null in battle or once finished). */
  gatePosition(boatId: number): THREE.Vector3 | null;
  /** Race: finished boats stop being driven by their controller. */
  isFinished(boatId: number): boolean;

  timeLeft(): number | null;
  raceTime(): number | null;
  scoreOf(boatId: number): number;
  /** 1-based placement. */
  rankOf(boatId: number): number;
  raceInfo(boatId: number): RaceHudInfo | null;

  result(): MatchResult;
}
