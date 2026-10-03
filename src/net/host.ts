/**
 * The online host's side of a room.
 *
 *  - The LOBBY: who is here, with which name and color. Slot 0 is the host, guests take the lowest free slot.
 *    Names and colors are made unique on the host, and every change is mirrored to every guest.
 *  - The MATCH: each guest's controls drive its boat through a RemoteController inside the host's Match; the Match's
 *    snapshots (every SNAPSHOT_EVERY_STEPS fixed steps) and the events it recorded go back out to every guest.
 *  - The ENDS: guests leaving (in the lobby they are just removed, mid-match their boat stops and the others are
 *    told), and the host closing the room.
 *
 * The app drives it (see HostSession in session.ts): buildSetup -> startMatch -> beginMatch, then afterStep after
 * every fixed step, setState on every state change, sendResults at the finish, close when leaving.
 *
 * Slots and boat ids: a guest's slot IS its boat id (1..3, the host is 0), so the slots must never have gaps. When a
 * guest leaves, the guests above it move down a slot and are told so with a fresh `welcome` (the guest keeps the
 * newest one). Mid-match a leaver's boat stays on the water and keeps its slot until the room is tidied, which happens
 * when the next match is built or the room goes back to the lobby.
 */
import { CONFIG } from '../config';
import type { Match } from '../game/match';
import { defaultPlayer, defaultSetup, sanitizeLook, sanitizeSetup } from '../game/setup';
import type { LobbyPlayer, LobbyState, MatchResult, MatchSetup, PlayerSetup } from '../types';
import {
  MAX_ONLINE_PLAYERS, PROTOCOL_VERSION, SNAPSHOT_EVERY_STEPS,
  type GuestControls, type GuestHello, type GuestMsg, type HostMsg, type HostTransport, type NetAppState, type NetEvent,
  type PeerLink,
} from './protocol';
import type { HostSession } from './session';
import { openHost } from './transport';

/** Longest player name in an online game. */
const MAX_NAME = 12;
/** Reasons a guest is turned away: all of them shown to a kid as they are. */
const WHY_VERSION = 'That game is a different version. Refresh the page and try again!';
const WHY_STARTED = 'That game already started. Ask the host for the next one!';
const WHY_FULL = 'That game is full!';
/** How long a goodbye gets to leave before the connection is closed on top of it (ms). */
const GOODBYE_MS = 250;
/** A controls packet whose number is this far behind the last one means the guest started counting again. */
const SEQ_RESET_GAP = 300;

/** One guest in the room. */
interface Guest {
  link: PeerLink;
  /** Lobby slot, 1..MAX_ONLINE_PLAYERS-1. */
  slot: number;
  /** What the guest asked for (cleaned up, but names and colors not yet made unique). */
  profile: PlayerSetup;
  /** The boat id this guest drives in the running match, or -1 while in the lobby. */
  boatSlot: number;
  /** Newest controls packet number seen (the fast channel may reorder). */
  lastSeq: number;
  /** The name shown for them when they left mid-match. */
  name: string;
  /** Left (or dropped out) mid-match: their boat is parked until the room goes back to the lobby. */
  gone: boolean;
}

/** Open a room for `profile` (the host player) and run its lobby. Rejects with a kid-friendly message. */
export async function createHostSession(profile: PlayerSetup): Promise<HostSession> {
  const transport = await openHost();
  return new HostRoom(transport, profile);
}

// ───────────────────────────── cleaning up what players typed ─────────────────────────────

/** A name nobody could be confused by: no control characters, single spaces, at most MAX_NAME letters. */
function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
}

/** Whatever a guest sent as its profile, made safe to use (a missing or odd part falls back to the default for the slot). */
function cleanProfile(raw: unknown, slot: number): PlayerSetup {
  const base = defaultPlayer(slot);
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<PlayerSetup>;
  const color = typeof p.color === 'number' && Number.isFinite(p.color) ? Math.round(p.color) & 0xffffff : base.color;
  return {
    name: cleanName(p.name) || base.name,
    color,
    look: sanitizeLook(p.look, slot),
    easyDriving: typeof p.easyDriving === 'boolean' ? p.easyDriving : true,
  };
}

/**
 * Make every player's name and color unique, in slot order (the earlier player keeps theirs): a repeated name gets
 * " 2", " 3"... added, a repeated color moves to a free paint color nobody asked for.
 */
function makeUnique(list: readonly PlayerSetup[]): PlayerSetup[] {
  const names = new Set<string>();
  const colors = new Set<number>();
  const asked = new Set<number>(list.map((p) => p.color));
  return list.map((p) => {
    let name = p.name;
    for (let n = 2; names.has(name.toLowerCase()); n++) {
      const tail = ` ${n}`;
      name = p.name.slice(0, MAX_NAME - tail.length).trim() + tail;
    }
    names.add(name.toLowerCase());
    let color = p.color;
    if (colors.has(color)) {
      color = CONFIG.colors.find((c) => !colors.has(c) && !asked.has(c))
        ?? CONFIG.colors.find((c) => !colors.has(c))
        ?? color;
    }
    colors.add(color);
    return { ...p, name, color };
  });
}

// ───────────────────────────── the room ─────────────────────────────

class HostRoom implements HostSession {
  readonly role = 'host' as const;
  onLobby: ((lobby: LobbyState) => void) | null = null;
  onPlayerLeft: ((name: string) => void) | null = null;

  private readonly guests = new Map<PeerLink, Guest>();
  private hostProfile: PlayerSetup;
  private settings: NonNullable<LobbyState['settings']>;
  private current: LobbyState;
  private match: Match | null = null;
  /** From the lobby to the end of the results: nobody new can join, and lobby changes are not broadcast. */
  private matchRunning = false;
  /** Who plays in the match being (or about to be) played: index = boat id, null = the host or someone not there. */
  private lineup: (Guest | null)[] = [null];
  private steps = 0;
  /** Snapshot number: keeps counting up across matches, so a stale snapshot from the last match never looks new. */
  private seq = 0;
  private closed = false;

  constructor(private readonly transport: HostTransport, profile: PlayerSetup) {
    this.hostProfile = cleanProfile(profile, 0);
    const d = defaultSetup('battle');
    this.settings = { mode: d.mode, bots: d.bots, botDifficulty: d.botDifficulty, durationSec: d.durationSec, laps: d.laps };
    this.current = this.buildLobby('host');
    transport.onHello = (link, hello) => this.onHello(link, hello);
    transport.onMessage = (link, msg) => this.onMessage(link, msg);
    transport.onDisconnect = (link) => this.onDisconnect(link);
  }

  get code(): string {
    return this.transport.code;
  }

  get lobby(): LobbyState {
    return this.current;
  }

  /** Round trip to the slowest guest still here, in ms (0 until measured): for `__foam.net` and the debug page. */
  get rttMs(): number {
    let worst = 0;
    for (const g of this.guests.values()) {
      if (!g.gone && g.link.rttMs > worst) worst = g.link.rttMs;
    }
    return worst;
  }

  // ───────────── lobby ─────────────

  setProfile(profile: PlayerSetup): void {
    this.hostProfile = cleanProfile(profile, 0);
    this.refresh();
  }

  setSettings(setup: MatchSetup): void {
    this.takeSettings(setup);
    this.refresh();
  }

  private takeSettings(s: MatchSetup): void {
    this.settings = {
      mode: s.mode,
      bots: Math.max(0, Math.round(Number(s.bots) || 0)),
      botDifficulty: s.botDifficulty,
      durationSec: s.durationSec,
      laps: s.laps,
    };
  }

  /** A guest connected and said hello: let it in, or turn it away with a kid-friendly reason. */
  private onHello(link: PeerLink, hello: GuestHello): void {
    if (this.closed) return;
    if (!hello || hello.v !== PROTOCOL_VERSION) return this.turnAway(link, WHY_VERSION);
    if (this.matchRunning) return this.turnAway(link, WHY_STARTED);
    const slot = this.freeSlot();
    if (slot < 0) return this.turnAway(link, WHY_FULL);
    const guest: Guest = {
      link, slot, profile: cleanProfile(hello.profile, slot), boatSlot: -1, lastSeq: -1, name: '', gone: false,
    };
    this.guests.set(link, guest);
    this.send(guest, { k: 'welcome', v: PROTOCOL_VERSION, slot });
    this.refresh();
  }

  private turnAway(link: PeerLink, reason: string): void {
    try {
      link.send({ k: 'reject', reason });
    } catch { /* already gone */ }
    // Let the message out before the connection closes on top of it.
    setTimeout(() => {
      try {
        link.close();
      } catch { /* already closed */ }
    }, GOODBYE_MS);
  }

  /** The lowest lobby slot nobody has (1..MAX_ONLINE_PLAYERS-1), or -1 when the room is full. */
  private freeSlot(): number {
    for (let slot = 1; slot < MAX_ONLINE_PLAYERS; slot++) {
      let taken = false;
      for (const g of this.guests.values()) if (g.slot === slot && !g.gone) taken = true;
      if (!taken) return slot;
    }
    return -1;
  }

  /** Everyone in the room, in slot order: the host, then the guests who are still here. */
  private present(): { slot: number; guest: Guest | null; profile: PlayerSetup }[] {
    const list: { slot: number; guest: Guest | null; profile: PlayerSetup }[] = [{ slot: 0, guest: null, profile: this.hostProfile }];
    const guests: Guest[] = [];
    for (const g of this.guests.values()) if (!g.gone) guests.push(g);
    guests.sort((a, b) => a.slot - b.slot);
    for (const g of guests) list.push({ slot: g.slot, guest: g, profile: g.profile });
    return list;
  }

  /** The lobby as one side sees it. Guests get the same list with `role` 'guest' and each marks its own slot. */
  private buildLobby(role: 'host' | 'guest'): LobbyState {
    const here = this.present();
    const players = makeUnique(here.map((e) => e.profile));
    const list: LobbyPlayer[] = here.map((e, i) => ({
      slot: e.slot,
      name: players[i].name,
      color: players[i].color,
      look: players[i].look,
      easyDriving: players[i].easyDriving,
      isHost: e.slot === 0,
      isYou: role === 'host' && e.slot === 0,
    }));
    const status = role === 'guest'
      ? 'Waiting for the host to start...'
      : here.length < 2 ? 'Waiting for players...' : 'Everyone here? Press Start!';
    return { role, code: this.transport.code, players: list, status, error: null, settings: { ...this.settings } };
  }

  /**
   * Close up any gap in the guest slots (1, 2, 3...) so a guest's slot is always its boat id, and tell each guest
   * that moved. Guests who left mid-match are forgotten first.
   */
  private tidy(): void {
    for (const g of [...this.guests.values()]) {
      if (g.gone) this.guests.delete(g.link);
    }
    const here = [...this.guests.values()].sort((a, b) => a.slot - b.slot);
    for (let i = 0; i < here.length; i++) {
      const g = here[i];
      if (g.slot === i + 1) continue;
      g.slot = i + 1;
      this.send(g, { k: 'welcome', v: PROTOCOL_VERSION, slot: g.slot });
    }
  }

  /** Something in the lobby changed: tell the host's menu and every guest (but not while a match is on). */
  private refresh(): void {
    if (this.closed) return;
    this.current = this.buildLobby('host');
    if (this.matchRunning) return;
    const msg: HostMsg = { k: 'lobby', lobby: this.buildLobby('guest') };
    for (const g of this.guests.values()) this.send(g, msg);
    this.onLobby?.(this.current);
  }

  // ───────────── the match ─────────────

  buildSetup(settings: MatchSetup): MatchSetup {
    this.takeSettings(settings);
    // A rematch comes here too: whoever left the last match is gone, and the others close up the gap.
    this.tidy();
    const here = this.present();
    const players = makeUnique(here.map((e) => e.profile));
    this.lineup = here.map((e) => e.guest);
    return sanitizeSetup({
      mode: settings.mode,
      humans: 1,
      bots: settings.bots,
      botDifficulty: settings.botDifficulty,
      players: [players[0]],
      durationSec: settings.durationSec,
      laps: settings.laps,
      online: { players, localSlot: 0 },
    });
  }

  beginMatch(match: Match): void {
    if (this.closed) return;
    const roster = match.setup.online?.players;
    if (!roster) return;
    this.match = match;
    this.matchRunning = true;
    this.steps = 0;
    // The line-up is the one buildSetup made (the roster is in the same order); if the app skipped it, make one now.
    if (this.lineup.length !== roster.length) {
      this.tidy();
      this.lineup = this.present().map((e) => e.guest);
    }
    for (let i = 1; i < roster.length; i++) {
      const g = this.lineup[i];
      if (!g || g.gone) {
        match.remote(i)?.disconnect();
        continue;
      }
      // Slot = boat id (see the top of this file), so the guest's own idea of its slot matches.
      g.boatSlot = i;
      g.lastSeq = -1;
      g.name = roster[i].name;
      const setup: MatchSetup = { ...match.setup, humans: 1, players: [roster[i]], online: { players: roster, localSlot: i } };
      this.send(g, { k: 'start', setup, inits: match.inits });
    }
  }

  afterStep(match: Match): void {
    if (this.closed) return;
    const events = match.drainEvents();
    if (events.length > 0) this.sendEvents(match.t, events);
    if (++this.steps % SNAPSHOT_EVERY_STEPS !== 0) return;
    let snap: HostMsg | null = null;
    for (const g of this.guests.values()) {
      if (g.gone || g.boatSlot < 0) continue;
      snap ??= { k: 'snap', s: match.netSnapshot(++this.seq) };
      this.send(g, snap, true);
    }
  }

  setState(state: NetAppState): void {
    if (this.closed) return;
    this.broadcast({ k: 'state', state });
    if (state !== 'lobby') return;
    // Back in the lobby: the match is over. Guests who left during it are forgotten, everyone else is just waiting.
    this.matchRunning = false;
    this.match = null;
    this.lineup = [null];
    for (const g of this.guests.values()) g.boatSlot = -1;
    this.tidy();
    this.refresh();
  }

  sendResults(match: Match): void {
    if (this.closed) return;
    // Everybody gets the same table; the stats are each guest's own, for the trophies it awards on its own device.
    const result: MatchResult = { ...match.result(), stats: [], awards: [] };
    const winnerId = (match.mode.ranking[0] ?? match.boats[0])?.id ?? 0;
    const lost = match.setup.mode === 'sharks' && !match.mode.outcome(match.boats[0]?.id ?? 0).won;
    for (const g of this.guests.values()) {
      if (g.gone || g.boatSlot < 0) continue;
      const stats = match.statsFor(g.boatSlot);
      if (stats) this.send(g, { k: 'results', result, stats, winnerId, lost });
    }
  }

  emit(event: NetEvent): void {
    if (this.closed) return;
    this.sendEvents(this.match ? this.match.t : 0, [event]);
  }

  /** Send events to the guests they are for: an event with `to` goes to that boat's player only. */
  private sendEvents(t: number, events: readonly NetEvent[]): void {
    let aimed = false;
    for (let k = 0; k < events.length && !aimed; k++) aimed = (events[k] as { to?: number }).to !== undefined;
    // Nobody in particular: one message for everyone.
    const shared: HostMsg | null = aimed ? null : { k: 'ev', t, e: events as NetEvent[] };
    for (const g of this.guests.values()) {
      if (g.gone || g.boatSlot < 0) continue;
      if (shared) {
        this.send(g, shared);
        continue;
      }
      const mine: NetEvent[] = [];
      for (let k = 0; k < events.length; k++) {
        const to = (events[k] as { to?: number }).to;
        if (to === undefined || to === g.boatSlot) mine.push(events[k]);
      }
      if (mine.length > 0) this.send(g, { k: 'ev', t, e: mine });
    }
  }

  // ───────────── messages from guests ─────────────

  private onMessage(link: PeerLink, msg: GuestMsg): void {
    const g = this.guests.get(link);
    if (this.closed || !g || g.gone || !msg || typeof msg !== 'object') return;
    switch (msg.k) {
      case 'ctl':
        this.onControls(g, msg);
        break;
      case 'profile':
        g.profile = cleanProfile(msg.profile, g.slot);
        this.refresh();
        break;
      case 'ping':
        this.send(g, { k: 'pong', at: msg.at }, true);
        break;
      case 'bye':
        this.drop(g);
        break;
      default:
        break; // a second hello: they are in already
    }
  }

  private onControls(g: Guest, msg: GuestControls): void {
    const match = this.match;
    if (!match || g.boatSlot < 0) return;
    // The fast channel can reorder: an older packet must not undo a newer one. (A number far behind means the
    // guest started counting again, e.g. a new match: take it.)
    if (typeof msg.seq === 'number') {
      if (msg.seq <= g.lastSeq && g.lastSeq - msg.seq < SEQ_RESET_GAP) return;
      g.lastSeq = msg.seq;
    }
    match.remote(g.boatSlot)?.receive(msg);
  }

  private onDisconnect(link: PeerLink): void {
    const g = this.guests.get(link);
    if (g) this.drop(g);
  }

  /** A guest left or its connection died. In the lobby it is just removed; mid-match its boat stops. */
  private drop(g: Guest): void {
    if (g.gone) return;
    g.gone = true; // first: closing the link may report the disconnect straight back to us
    try {
      g.link.close();
    } catch { /* already closed */ }
    if (!this.matchRunning || g.boatSlot < 0) {
      this.guests.delete(g.link);
      this.tidy();
      this.refresh();
      return;
    }
    // Mid-match: the boat stops and keeps its place. (The app writes "Sam left the game" on every screen,
    // its own through hud.feed and the guests' through emit, so it is not sent from here too.)
    this.match?.remote(g.boatSlot)?.disconnect();
    this.refresh(); // (keeps `lobby` honest for a rematch check; nothing is sent while the match is on)
    this.onPlayerLeft?.(g.name);
  }

  // ───────────── sending ─────────────

  /** Send to one guest; a connection that is already gone must never break the match. */
  private send(g: Guest, msg: HostMsg, fast = false): void {
    try {
      if (fast) g.link.sendFast(msg);
      else g.link.send(msg);
    } catch { /* it will show up as a disconnect */ }
  }

  /** Send to every guest who is still here. */
  private broadcast(msg: HostMsg): void {
    for (const g of this.guests.values()) {
      if (!g.gone) this.send(g, msg);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.broadcast({ k: 'bye', reason: 'The host left the game' });
    this.guests.clear();
    this.match = null;
    this.onLobby = null;
    this.onPlayerLeft = null;
    const t = this.transport;
    t.onHello = null;
    t.onMessage = null;
    t.onDisconnect = null;
    // Let the goodbye out before the connections close on top of it.
    setTimeout(() => t.close(), GOODBYE_MS);
  }
}
