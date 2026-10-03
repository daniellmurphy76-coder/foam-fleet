/**
 * The guest side of an online game: joins the host's room, mirrors its lobby, and builds the render-only
 * GuestView for each match. (The view itself lives in src/net/guestView.ts.)
 */
import type { MatchServices } from '../game/match';
import { reportError } from '../game/debug';
import { awardTrophies } from '../ui/trophies';
import type { BoatInit, LobbyState, MatchResult, MatchSetup, PlayerMatchStats, PlayerSetup, TrophyAward } from '../types';
import { PROTOCOL_VERSION } from './protocol';
import type { GuestControls, GuestHello, GuestMsg, GuestTransport, HostEvents, HostMsg, NetAppState, NetSnapshot } from './protocol';
import type { GuestSession, GuestView } from './session';
import { createGuestView } from './guestView';
import type { NetGuestView } from './guestView';
import { joinHost } from './transport';

/** How long we wait for the host to answer our hello once the connection is open. */
const WELCOME_TIMEOUT_MS = 10000;
/** Events that arrive before the app has built the view are kept (up to this many messages) and handed over. */
const MAX_PENDING_EVENTS = 200;
const HOST_LEFT = 'The host left the game';
const WAITING = 'Waiting for the host to start...';

/** Extra numbers for the debug page (__foam.net); the app can read them when it wants. */
export interface GuestSessionStats {
  /** Smoothed round-trip time to the host in ms (0 until measured). */
  readonly rttMs: number;
  /** Milliseconds since the last snapshot arrived, or -1 if none has yet. */
  readonly snapshotAgeMs: number;
}

/** Join room `code` as `profile`. Resolves once the host accepted us; rejects with a kid-friendly message. */
export async function joinGuestSession(code: string, profile: PlayerSetup): Promise<GuestSession> {
  const hello: GuestHello = { k: 'hello', v: PROTOCOL_VERSION, profile };
  let transport: GuestTransport;
  try {
    transport = await joinHost(code.trim().toUpperCase(), hello);
  } catch (e) {
    throw new Error(e instanceof Error && e.message ? e.message : "Couldn't connect to that game. Try again!");
  }
  const session = new GuestSessionImpl(transport);
  try {
    await session.joined;
  } catch (e) {
    session.close();
    throw e instanceof Error ? e : new Error(String(e));
  }
  return session;
}

class GuestSessionImpl implements GuestSession, GuestSessionStats {
  readonly role = 'guest' as const;
  readonly code: string;
  slot = 0;
  onLobby: ((lobby: LobbyState) => void) | null = null;
  onStart: ((setup: MatchSetup) => void) | null = null;
  onState: ((state: NetAppState) => void) | null = null;
  onResults: ((result: MatchResult, winnerId: number, lost: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;

  /** Settles when the host has said welcome (resolves) or turned us away / went quiet (rejects). */
  readonly joined: Promise<void>;

  private lobbyState: LobbyState;
  private closed = false;
  private resolveJoin: (() => void) | null = null;
  private rejectJoin: ((e: Error) => void) | null = null;
  private joinTimer = 0;

  // What the current match needs: the host's boat list, and everything that arrives before the app builds the view.
  private inits: readonly BoatInit[] | null = null;
  private matchState: NetAppState = 'countdown';
  private resultsSent = false;
  private view: NetGuestView | null = null;
  private pendingSnap: NetSnapshot | null = null;
  private readonly pendingEvents: HostEvents[] = [];
  private lastSnapAt = -1;

  constructor(private readonly transport: GuestTransport) {
    this.code = transport.code;
    this.lobbyState = { role: 'guest', code: transport.code, players: [], status: WAITING, error: null, settings: null };
    this.joined = new Promise<void>((resolve, reject) => {
      this.resolveJoin = resolve;
      this.rejectJoin = reject;
    });
    this.joinTimer = window.setTimeout(() => {
      this.failJoin("Couldn't connect to that game. Try again, or play on the same Wi-Fi.");
    }, WELCOME_TIMEOUT_MS);
    transport.onMessage = (msg) => this.handle(msg);
    transport.onClose = (reason) => this.end(reason || HOST_LEFT);
  }

  get lobby(): LobbyState {
    return this.lobbyState;
  }

  get rttMs(): number {
    return this.transport.link.rttMs;
  }

  get snapshotAgeMs(): number {
    return this.lastSnapAt < 0 ? -1 : performance.now() - this.lastSnapAt;
  }

  // ───────────────────────────── what the app calls ─────────────────────────────

  setProfile(profile: PlayerSetup): void {
    this.send({ k: 'profile', profile });
  }

  createView(setup: MatchSetup, services: MatchServices): GuestView {
    const inits = this.inits;
    if (!inits) throw new Error('The host has not started a game yet');
    const view = createGuestView({
      setup,
      inits,
      slot: this.slot,
      services,
      sendControls: (msg) => this.sendFast(msg),
    });
    this.view = view;
    view.noteState(this.matchState);
    // Hand over whatever arrived while the app was getting ready.
    if (this.pendingSnap) view.pushSnapshot(this.pendingSnap);
    for (let i = 0; i < this.pendingEvents.length; i++) view.pushEvents(this.pendingEvents[i].t, this.pendingEvents[i].e);
    this.pendingSnap = null;
    this.pendingEvents.length = 0;
    return view;
  }

  close(): void {
    if (this.closed) return;
    this.send({ k: 'bye' });
    this.shutdown();
  }

  // ───────────────────────────── messages from the host ─────────────────────────────

  private handle(msg: HostMsg): void {
    if (this.closed) return;
    try {
      switch (msg.k) {
        case 'welcome':
          if (msg.v !== PROTOCOL_VERSION) {
            this.failJoin('This game is a different version. Refresh the page and try again!');
            return;
          }
          this.slot = msg.slot;
          window.clearTimeout(this.joinTimer);
          this.resolveJoin?.();
          this.resolveJoin = this.rejectJoin = null;
          return;
        case 'reject':
          this.failJoin(msg.reason || "Couldn't join that game.");
          return;
        case 'lobby':
          this.setLobby(msg.lobby);
          return;
        case 'start':
          this.begin(msg.setup, msg.inits);
          return;
        case 'state':
          this.matchState = msg.state;
          this.view?.noteState(msg.state);
          this.onState?.(msg.state);
          return;
        case 'results':
          this.finish(msg.result, msg.stats, msg.winnerId, msg.lost);
          return;
        case 'snap':
          this.lastSnapAt = performance.now();
          if (this.view) this.view.pushSnapshot(msg.s);
          else this.pendingSnap = msg.s;
          return;
        case 'ev':
          if (this.view) this.view.pushEvents(msg.t, msg.e);
          else if (this.pendingEvents.length < MAX_PENDING_EVENTS) this.pendingEvents.push(msg);
          return;
        case 'bye':
          this.end(msg.reason || HOST_LEFT);
          return;
        default:
          return; // pong: the transport keeps the round-trip time itself
      }
    } catch (e) {
      reportError(`guest.${msg.k}`, e);
    }
  }

  /** The host's lobby, with this player marked. */
  private setLobby(lobby: LobbyState): void {
    const slot = this.slot;
    this.lobbyState = {
      ...lobby,
      role: 'guest',
      code: lobby.code || this.code,
      players: lobby.players.map((p) => ({ ...p, isYou: p.slot === slot })),
      // The host words its status for itself ("Waiting for players..."); a guest is always waiting for the host.
      status: lobby.role === 'host' ? WAITING : lobby.status,
    };
    this.onLobby?.(this.lobbyState);
  }

  /** The host started (or restarted) a match. */
  private begin(setup: MatchSetup, inits: readonly BoatInit[]): void {
    this.inits = inits;
    this.view = null; // the app disposes the old view; late messages for the old match go nowhere
    this.pendingSnap = null;
    this.pendingEvents.length = 0;
    this.matchState = 'countdown';
    this.resultsSent = false;
    // Make sure the setup says which boat is ours.
    const own = setup.online ? { ...setup, online: { ...setup.online, localSlot: this.slot } } : setup;
    this.onStart?.(own);
  }

  /** The match is over: award this device's own trophies from its own stats, then show the results. */
  private finish(result: MatchResult, stats: PlayerMatchStats, winnerId: number, lost: boolean): void {
    if (this.resultsSent) return;
    this.resultsSent = true;
    let awards: TrophyAward[] = [];
    try {
      awards = awardTrophies([stats]);
    } catch (e) {
      reportError('awardTrophies', e);
    }
    this.onResults?.({ ...result, stats: [stats], awards }, winnerId, lost);
  }

  // ───────────────────────────── ending ─────────────────────────────

  private send(msg: GuestMsg): void {
    if (this.closed) return;
    try {
      this.transport.link.send(msg);
    } catch (e) {
      reportError('guest.send', e);
    }
  }

  private sendFast(msg: GuestControls): void {
    if (this.closed) return;
    try {
      this.transport.link.sendFast(msg);
    } catch (e) {
      reportError('guest.sendFast', e);
    }
  }

  private failJoin(reason: string): void {
    const reject = this.rejectJoin;
    window.clearTimeout(this.joinTimer);
    this.resolveJoin = this.rejectJoin = null;
    if (reject) reject(new Error(reason));
  }

  /** The connection is over (host left, network gone): tell the app once. */
  private end(reason: string): void {
    if (this.closed) return;
    const joining = this.rejectJoin !== null;
    this.shutdown();
    if (joining) this.failJoin(reason);
    else this.onClosed?.(reason);
  }

  private shutdown(): void {
    this.closed = true;
    window.clearTimeout(this.joinTimer);
    this.view = null;
    this.pendingSnap = null;
    this.pendingEvents.length = 0;
    this.transport.onMessage = null;
    this.transport.onClose = null;
    try {
      this.transport.close();
    } catch (e) {
      reportError('guest.close', e);
    }
  }
}
