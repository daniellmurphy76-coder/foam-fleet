/**
 * Foam Fleet online protocol (host-authoritative).
 *
 * The host runs the real game. Guests (one player per device) send their controls and draw the match from
 * the host's snapshots + one-shot events. Shared by src/net/transport.ts, src/net/host.ts and src/net/guest.ts.
 *
 * Everything sent must be plain data (numbers, strings, booleans, null, arrays, plain objects): it goes
 * through PeerJS's binary serializer. No Vector3s, no class instances, no functions.
 */
import type {
  BoatControls, BoatInit, BoatNetState, LobbyState, MatchResult, MatchSetup, PlayerMatchStats, PlayerSetup, RaceHudInfo,
  SharkHud, SharkNetState, TeamScore,
} from '../types';

/** Bump when the wire format changes; a guest with a different version is turned away politely. */
export const PROTOCOL_VERSION = 1;
/** PeerJS peer id = prefix + room code (e.g. "foamfleet-v1-DUCK"). */
export const PEER_PREFIX = 'foamfleet-v1-';
/** Room codes: letters with no look-alikes (no I, L, O). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;
/** Humans in one online match, host included. */
export const MAX_ONLINE_PLAYERS = 4;
/** Host sends a snapshot every this many fixed 60 Hz steps (3 = 20 Hz). */
export const SNAPSHOT_EVERY_STEPS = 3;
/** Guests send their controls this often (Hz). */
export const CONTROLS_HZ = 30;
/** Guests draw other boats and sharks this far (seconds of host time) behind the newest snapshot. */
export const INTERP_DELAY = 0.1;
/** A guest's own boat is extrapolated from the newest snapshot by at most this much (seconds). */
export const MAX_EXTRAPOLATE = 0.15;
/** No controls from a guest for this long = let go of everything. */
export const CONTROLS_TIMEOUT = 0.4;
/** No message at all from the other side for this long = the connection is gone. */
export const LINK_TIMEOUT = 8;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

// ───────────────────────────── guest → host ─────────────────────────────

export interface GuestHello {
  k: 'hello';
  v: number;
  profile: PlayerSetup;
}

export interface GuestProfile {
  k: 'profile';
  profile: PlayerSetup;
}

export interface GuestControls {
  k: 'ctl';
  seq: number;
  /** Held state right now. */
  c: BoatControls;
  /**
   * Presses since this guest started (running counters). The host compares with the last counters it
   * saw, so a quick tap is never lost even if packets drop or arrive between host steps.
   */
  presses: { fire: number; rescue: number; honk: number };
}

export interface GuestPing {
  k: 'ping';
  at: number;
  /** The guest's own smoothed round trip in ms (0 until measured): the host has no ping of its own to measure with. */
  rtt?: number;
}

export interface GuestBye {
  k: 'bye';
}

export type GuestMsg = GuestHello | GuestProfile | GuestControls | GuestPing | GuestBye;

// ───────────────────────────── host → guest ─────────────────────────────

export interface HostWelcome {
  k: 'welcome';
  v: number;
  /** This guest's slot = its boat id (1..3). */
  slot: number;
}

export interface HostReject {
  k: 'reject';
  /** Kid-friendly reason, shown as is ("That game is full!"). */
  reason: string;
}

export interface HostLobby {
  k: 'lobby';
  /** isYou is false for everyone; each guest marks its own slot. */
  lobby: LobbyState;
}

export interface HostStart {
  k: 'start';
  /** Full online setup; setup.online.localSlot is set to the receiving guest's slot. */
  setup: MatchSetup;
  /** Exactly how the host built every boat (index = boat id), so guests build identical puppets. */
  inits: BoatInit[];
}

export type NetAppState = 'countdown' | 'playing' | 'paused' | 'results' | 'lobby';

export interface HostState {
  k: 'state';
  state: NetAppState;
}

export interface HostResults {
  k: 'results';
  /** Rows/title/teams for everyone; stats = [] and awards = [] (the guest awards its own trophies). */
  result: MatchResult;
  /** This guest's own stats, for its trophies. */
  stats: PlayerMatchStats;
  /** Boat the results camera circles. */
  winnerId: number;
  /** Boats vs. Sharks lost (defeat sound instead of victory). */
  lost: boolean;
}

export interface HostSnapshot {
  k: 'snap';
  s: NetSnapshot;
}

export interface HostEvents {
  k: 'ev';
  /** Host match time when these happened. */
  t: number;
  e: NetEvent[];
}

export interface HostPong {
  k: 'pong';
  at: number;
}

export interface HostBye {
  k: 'bye';
  reason: string;
}

export type HostMsg =
  | HostWelcome | HostReject | HostLobby | HostStart | HostState | HostResults | HostSnapshot | HostEvents
  | HostPong | HostBye;

// ───────────────────────────── snapshot ─────────────────────────────

export interface NetSnapshot {
  seq: number;
  /** Host match time (seconds), the clock everything is interpolated on. */
  t: number;
  /** Index = boat id. */
  boats: BoatNetState[];
  sharks: SharkNetState;
  /** Pickups.netState(). */
  crates: number;
  /** Balloons.netState(), or null when the mode has no balloons. */
  balloons: number[] | null;
  hud: NetHud;
}

/** The mode-level numbers a guest needs to build its HudState and minimap. */
export interface NetHud {
  timeLeft: number | null;
  raceTime: number | null;
  /** Boat ids, best first. */
  ranking: number[];
  /** Index = boat id. */
  scores: number[];
  /** Index = boat id; null outside races. */
  race: (RaceHudInfo | null)[] | null;
  /** Index = boat id: next race gate index, or null. */
  nextGate: (number | null)[];
  teams: TeamScore[] | null;
  balloons: { remaining: number; total: number } | null;
  sharks: SharkHud | null;
}

// ───────────────────────────── events ─────────────────────────────

/**
 * One-shot happenings guests replay. `to` = the human slot (boat id) it is for; absent = everyone.
 * Sounds with `at` (x, z) are skipped by a guest whose own boat is more than 70 m away.
 */
export type NetEvent =
  | { k: 'sfx'; m: string; a: (number | string)[]; at?: [number, number] }
  | { k: 'fx'; m: 'splash' | 'hitBurst' | 'sparkle' | 'bubbles' | 'pop' | 'notes'; p: Vec3; a?: number }
  | { k: 'announce'; text: string; sub?: string; ms?: number; to?: number }
  | { k: 'feed'; text: string; color?: number }
  | { k: 'hint'; hint: 'start' | 'shoot' | 'go' | 'stuck'; to: number }
  | { k: 'cam'; op: 'shake' | 'kick' | 'snap'; amt: number; to: number }
  | { k: 'rumble'; strength: number; ms: number; to: number }
  /** darts: [netId, originX, originY, originZ, dirX, dirY, dirZ, speed] per dart. */
  | { k: 'fire'; boat: number; darts: number[][] }
  | { k: 'stick'; id: number; boat: number; tip: Vec3; quat: Quat }
  | { k: 'deflect'; id: number; p: Vec3 }
  | { k: 'kill'; id: number }
  | { k: 'hit'; boat: number; blocked: boolean; stun: number };

// ───────────────────────────── transport ─────────────────────────────

/** One connection to the other side. */
export interface PeerLink {
  readonly id: string;
  /** Reliable + ordered (lobby, start, state, events, results). */
  send(msg: HostMsg | GuestMsg): void;
  /** Fast, may drop or reorder (snapshots, controls). Falls back to reliable if unavailable. */
  sendFast(msg: HostMsg | GuestMsg): void;
  /** Smoothed round-trip time in ms (0 until measured). */
  readonly rttMs: number;
  close(): void;
}

export interface HostTransport {
  readonly code: string;
  readonly links: readonly PeerLink[];
  /** A guest connected and said hello: accept with link.send(welcome) or reject + close. */
  onHello: ((link: PeerLink, hello: GuestHello) => void) | null;
  onMessage: ((link: PeerLink, msg: GuestMsg) => void) | null;
  onDisconnect: ((link: PeerLink) => void) | null;
  close(): void;
}

export interface GuestTransport {
  readonly code: string;
  readonly link: PeerLink;
  onMessage: ((msg: HostMsg) => void) | null;
  /** The connection ended (host left, network gone); kid-friendly reason. */
  onClose: ((reason: string) => void) | null;
  close(): void;
}
