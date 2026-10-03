/**
 * Foam Fleet online transport: PeerJS (free public signaling), then direct WebRTC data channels.
 *
 *   openHost()  - open a room: pick a code, register "foamfleet-v1-CODE" with the signaling server, accept guests.
 *   joinHost()  - connect to a room code and say hello.
 *
 * Each guest talks to the host over two PeerJS DataConnections, one Link:
 *   "rel"  - reliable + ordered: lobby, start, state, events, results, hello, goodbye.
 *   "fast" - unordered: snapshots and controls. (PeerJS 1.5.5 only turns off ordering for it; a lost packet
 *            is still re-sent, just without holding up the newer ones.) Until it opens, or if it never
 *            does, sendFast uses rel. When the line backs up, sendFast drops the message instead of queuing
 *            it: the next snapshot is fresher anyway.
 *
 * The transport also owns the plumbing nobody else should repeat:
 *   - ping/pong once a second -> smoothed rttMs, and "no message for LINK_TIMEOUT" -> the link is gone;
 *   - goodbyes: a guest's `bye` becomes onDisconnect, the host's `bye` becomes onClose(reason);
 *   - ping, pong, bye and a repeated hello never reach onMessage.
 * peerjs is loaded with a dynamic import, so offline play never downloads it.
 */
import type { DataConnection, Peer } from 'peerjs';
import { guestPeerId, hostPeerId, normalizeCode, randomCode } from './codes';
import { LINK_TIMEOUT, PEER_PREFIX } from './protocol';
import type { GuestHello, GuestMsg, GuestTransport, HostMsg, HostTransport, PeerLink } from './protocol';

// ───────────────────────────── Kid-friendly messages ─────────────────────────────

const MSG_SERVER = "Couldn't reach the game server. Check the internet and try again.";
const MSG_NO_GAME = 'No game with that code. Check the letters!';
const MSG_CONNECT = "Couldn't connect to that game. Try again, or play on the same Wi-Fi.";
const MSG_BROWSER = "This browser can't play online games. Try a newer one.";
const MSG_NO_ROOM = "Couldn't open a game. Try again!";
const MSG_HOST_LEFT = 'The host left the game';
const MSG_LOST = 'Lost the connection to the game. Check the internet and try again.';

// ───────────────────────────── Tunables ─────────────────────────────

/** Opening a peer on the signaling server may take this long. */
const SIGNAL_TIMEOUT_MS = 10000;
/** Both channels to the host may take this long (a wrong code answers after about 5 s). */
const CONNECT_TIMEOUT_MS = 12000;
/** Once rel is open, wait this long for fast before going on without it. */
const FAST_GRACE_MS = 3000;
/** A connection on the host that has not said hello by now is dropped (nobody was told about it). */
const PENDING_HELLO_MS = 10000;
/** Time given to a goodbye / "game is full" to leave before the channels are torn down. */
const FLUSH_MS = 400;
/** Health tick: ping once a second, check for silence. */
const TICK_MS = 1000;
/** A tick this late means the page was asleep (tab suspended, laptop lid): forgive the silence. */
const SUSPEND_GAP_MS = 3000;
const LINK_TIMEOUT_MS = LINK_TIMEOUT * 1000;
/** New room codes tried when one is taken / new guest ids tried when one is taken. */
const MAX_CODE_TRIES = 5;
const MAX_ID_TRIES = 3;
/** Connections that have not said hello yet, host side. */
const MAX_PENDING_LINKS = 8;
/** sendFast drops a message while this many bytes already wait to leave. */
const FAST_BACKLOG_BYTES = 64 * 1024;
/** Round-trip smoothing: how much of each new sample is mixed in. */
const RTT_SMOOTH = 0.2;
/** The host re-registers a room that lost the signaling server, with a growing wait, this many times. */
const MAX_RECONNECTS = 30;
/** Messages held for a consumer that has not set its handler yet. */
const MAX_QUEUED = 128;

// ───────────────────────────── Errors ─────────────────────────────

/** An Error whose message is already kid-friendly (also when printed: String(e) is just the message). */
class NetError extends Error {
  /** The PeerJS id was already taken: try another. */
  readonly taken: boolean;
  constructor(message: string, taken = false) {
    super(message);
    this.name = 'NetError';
    this.taken = taken;
  }
  toString(): string {
    return this.message;
  }
}

/** Why the signaling server could not be used. */
function signalMessage(type: string): string {
  return type === 'browser-incompatible' ? MSG_BROWSER : MSG_SERVER;
}

/** A PeerJS error while connecting to a room. */
function joinMessage(type: string): string {
  if (type === 'peer-unavailable') return MSG_NO_GAME;
  if (type === 'webrtc') return MSG_CONNECT;
  return signalMessage(type);
}

// ───────────────────────────── PeerJS ─────────────────────────────

type PeerClass = typeof Peer;
let peerLib: Promise<PeerClass> | null = null;

/** Load PeerJS the first time online play needs it (a failed load can be retried). */
function loadPeer(): Promise<PeerClass> {
  if (peerLib === null) {
    peerLib = import('peerjs').then(
      (m) => m.Peer,
      () => {
        peerLib = null;
        throw new NetError(MSG_SERVER);
      },
    );
  }
  return peerLib;
}

function discard(conn: DataConnection): void {
  conn.removeAllListeners();
  try {
    conn.close();
  } catch {
    // already gone
  }
}

function destroyPeer(peer: Peer): void {
  peer.removeAllListeners();
  try {
    peer.destroy();
  } catch {
    // already gone
  }
}

/** Register `id` with the signaling server. Resolves once it is open; rejects with a NetError. */
function openPeer(PeerCtor: PeerClass, id: string): Promise<Peer> {
  return new Promise<Peer>((resolve, reject) => {
    let peer: Peer;
    try {
      peer = new PeerCtor(id);
    } catch {
      reject(new NetError(MSG_SERVER));
      return;
    }
    let timer = 0;
    const settle = (err: NetError | null): void => {
      window.clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', onError);
      peer.off('disconnected', onGone);
      if (err === null) {
        resolve(peer);
      } else {
        destroyPeer(peer);
        reject(err);
      }
    };
    const onOpen = (): void => settle(null);
    const onError = (e: { type: string }): void =>
      settle(e.type === 'unavailable-id' ? new NetError(MSG_SERVER, true) : new NetError(signalMessage(e.type)));
    const onGone = (): void => settle(new NetError(MSG_SERVER));
    peer.on('open', onOpen);
    peer.on('error', onError);
    peer.on('disconnected', onGone);
    timer = window.setTimeout(() => settle(new NetError(MSG_SERVER)), SIGNAL_TIMEOUT_MS);
  });
}

/** openPeer with a fresh id from `makeId` each time the id turns out to be taken. */
async function openPeerRetry(
  PeerCtor: PeerClass,
  makeId: () => string,
  tries: number,
  giveUp: string,
): Promise<{ peer: Peer; id: string }> {
  for (let i = 0; i < tries; i++) {
    const id = makeId();
    try {
      return { peer: await openPeer(PeerCtor, id), id };
    } catch (e) {
      if (!(e instanceof NetError) || !e.taken) throw e;
    }
  }
  throw new NetError(giveUp);
}

// ───────────────────────────── One link (two channels) ─────────────────────────────

type Kind = 'rel' | 'fast';
type Raw = { k: string; [key: string]: unknown };

/** Who a Link reports to: the HostImpl or the GuestImpl below. */
interface LinkOwner {
  /** A message for the consumer (ping and pong are already handled). */
  linkMessage(link: Link, msg: Raw): void;
  /** The other side is gone. Called after the current call stack unwinds, never inside a send. */
  linkDead(link: Link): void;
  /** Someone called link.close(). Called before the channels go, so a goodbye can still be sent. */
  linkClosed(link: Link): void;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

class Link implements PeerLink {
  readonly id: string;
  rttMs = 0;
  /** performance.now() of the newest message from the other side. */
  lastRx: number;
  /** performance.now() when this link first appeared. */
  readonly born: number;
  /** Host side: the hello arrived and the consumer knows this link. */
  accepted = false;
  /** Closed by us or lost: nothing flows any more. */
  closed = false;
  private readonly owner: LinkOwner;
  private rel: DataConnection | null = null;
  private fast: DataConnection | null = null;
  private warned = false;
  /** Reused for every pong (messages are serialized inside send, so reuse is safe). */
  private readonly pong = { k: 'pong' as const, at: 0 };

  constructor(id: string, owner: LinkOwner) {
    this.id = id;
    this.owner = owner;
    this.born = this.lastRx = performance.now();
  }

  /** Take over a freshly created DataConnection. False when that channel is already filled. */
  attach(conn: DataConnection, kind: Kind): boolean {
    if ((kind === 'rel' ? this.rel : this.fast) !== null) return false;
    if (kind === 'rel') this.rel = conn;
    else this.fast = conn;
    conn.on('data', (d) => this.receive(d));
    conn.on('close', () => this.ended(kind));
    conn.on('error', (e: { type: string }) => {
      if (e.type === 'negotiation-failed' || e.type === 'connection-closed') this.ended(kind);
    });
    if (kind === 'rel') {
      conn.on('iceStateChanged', (s) => {
        if (s === 'failed') this.ended('rel');
      });
    }
    return true;
  }

  send(msg: HostMsg | GuestMsg): void {
    const rel = this.rel;
    if (this.closed || rel === null || !rel.open) return;
    this.put(rel, msg);
  }

  sendFast(msg: HostMsg | GuestMsg): void {
    if (this.closed) return;
    const fast = this.fast;
    const conn = fast !== null && fast.open ? fast : this.rel;
    if (conn === null || !conn.open) return;
    // A stuck line piles bytes up here; a snapshot that would wait in line is worse than none.
    if (conn.dataChannel.bufferedAmount > FAST_BACKLOG_BYTES) return;
    this.put(conn, msg);
  }

  /** Stop using this link. Whatever was sent just before (a goodbye, "that game is full") gets FLUSH_MS to leave. */
  close(): void {
    if (this.closed) return;
    this.owner.linkClosed(this);
    if (this.closed) return; // the owner closed us while saying goodbye
    this.closed = true;
    window.setTimeout(() => this.dropAll(), FLUSH_MS);
  }

  /** The other side is gone (or silent too long): drop the channels now and tell the owner. */
  die(): void {
    if (this.closed) return;
    this.closed = true;
    this.dropAll();
    queueMicrotask(() => this.owner.linkDead(this));
  }

  private put(conn: DataConnection, msg: HostMsg | GuestMsg): void {
    try {
      conn.send(msg);
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[net] could not send a message', e);
      }
    }
  }

  private ended(kind: Kind): void {
    if (this.closed) return;
    if (kind === 'rel') {
      this.die();
      return;
    }
    // Only the fast channel went: carry on over rel.
    const fast = this.fast;
    this.fast = null;
    if (fast !== null) discard(fast);
  }

  private dropAll(): void {
    const rel = this.rel;
    const fast = this.fast;
    this.rel = null;
    this.fast = null;
    if (rel !== null) discard(rel);
    if (fast !== null) discard(fast);
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    const now = performance.now();
    this.lastRx = now;
    if (!isObject(data)) return;
    const k = data.k;
    if (typeof k !== 'string') return;
    if (k === 'ping') {
      // Guests add their own smoothed rtt to the ping, so the host can show it too.
      const rtt = data.rtt;
      if (typeof rtt === 'number' && rtt >= 0 && rtt < 60000) this.rttMs = rtt;
      const at = data.at;
      if (typeof at === 'number') {
        this.pong.at = at;
        this.sendFast(this.pong);
      }
      return;
    }
    if (k === 'pong') {
      const at = data.at;
      if (typeof at === 'number') {
        const sample = now - at;
        if (sample >= 0 && sample < 30000) {
          this.rttMs = this.rttMs === 0 ? Math.max(1, sample) : this.rttMs + (sample - this.rttMs) * RTT_SMOOTH;
        }
      }
      return;
    }
    try {
      this.owner.linkMessage(this, data as Raw);
    } catch (e) {
      console.error('[net] message handler failed', e);
    }
  }
}

// ───────────────────────────── Host ─────────────────────────────

const HOST_BYE: HostMsg = { k: 'bye', reason: MSG_HOST_LEFT };
const GUEST_BYE: GuestMsg = { k: 'bye' };

class HostImpl implements HostTransport, LinkOwner {
  readonly code: string;
  onMessage: ((link: PeerLink, msg: GuestMsg) => void) | null = null;
  onDisconnect: ((link: PeerLink) => void) | null = null;
  private helloHandler: ((link: PeerLink, hello: GuestHello) => void) | null = null;
  /** Hellos that arrived before anyone listened. */
  private waiting: { link: Link; hello: GuestHello }[] = [];
  /** Links that said hello, in join order. Rebuilt (never edited) so a loop over it survives changes. */
  private accepted: readonly Link[] = [];
  /** Every link, hello or not, by the guest's peer id. */
  private readonly byId = new Map<string, Link>();
  private readonly peer: Peer;
  private closed = false;
  private tickTimer = 0;
  private lastTick = performance.now();
  private reconnectTimer = 0;
  private reconnectTries = 0;

  constructor(code: string, peer: Peer) {
    this.code = code;
    this.peer = peer;
    peer.on('connection', (conn) => this.adopt(conn));
    peer.on('open', () => {
      this.reconnectTries = 0;
    });
    // Losing the signaling server leaves live guests alone; only new guests can no longer find the room.
    peer.on('disconnected', () => this.scheduleReconnect());
    this.tickTimer = window.setInterval(() => this.tick(), TICK_MS);
    window.addEventListener('pagehide', this.onPageHide);
  }

  get links(): readonly PeerLink[] {
    return this.accepted;
  }

  get onHello(): ((link: PeerLink, hello: GuestHello) => void) | null {
    return this.helloHandler;
  }

  set onHello(fn: ((link: PeerLink, hello: GuestHello) => void) | null) {
    this.helloHandler = fn;
    if (fn !== null && this.waiting.length > 0) queueMicrotask(() => this.flushHellos());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.tickTimer);
    window.clearTimeout(this.reconnectTimer);
    window.removeEventListener('pagehide', this.onPageHide);
    this.helloHandler = null;
    this.onMessage = null;
    this.onDisconnect = null;
    this.waiting.length = 0;
    for (const link of this.accepted) link.send(HOST_BYE);
    // Everyone else (guests that never said hello) is dropped quietly.
    for (const link of Array.from(this.byId.values())) link.close();
    // The peer goes after the links (timers of equal length run in order), so goodbyes get out first.
    window.setTimeout(() => destroyPeer(this.peer), FLUSH_MS);
  }

  // LinkOwner

  linkMessage(link: Link, msg: Raw): void {
    if (this.closed) return;
    const k = msg.k;
    if (!link.accepted) {
      // Nothing counts until the hello.
      if (k === 'hello' && typeof msg.v === 'number' && isObject(msg.profile)) {
        link.accepted = true;
        this.accepted = [...this.accepted, link];
        this.announce(link, msg as unknown as GuestHello);
      } else if (k === 'hello') {
        link.close();
      }
      return;
    }
    const fn = this.onMessage;
    if (k === 'ctl') {
      if (fn !== null && typeof msg.seq === 'number' && isObject(msg.c) && isObject(msg.presses)) {
        fn(link, msg as unknown as GuestMsg);
      }
    } else if (k === 'profile') {
      if (fn !== null && isObject(msg.profile)) fn(link, msg as unknown as GuestMsg);
    } else if (k === 'bye') {
      link.die();
    }
  }

  linkDead(link: Link): void {
    this.forget(link);
    const fn = this.onDisconnect;
    if (this.closed || !link.accepted || fn === null) return;
    try {
      fn(link);
    } catch (e) {
      console.error('[net] onDisconnect failed', e);
    }
  }

  linkClosed(link: Link): void {
    this.forget(link);
  }

  // Internals

  private readonly onPageHide = (): void => {
    for (const link of this.accepted) link.send(HOST_BYE);
  };

  private adopt(conn: DataConnection): void {
    const kind: Kind | null = conn.label === 'rel' ? 'rel' : conn.label === 'fast' ? 'fast' : null;
    if (this.closed || kind === null) {
      discard(conn);
      return;
    }
    let link = this.byId.get(conn.peer);
    if (link === undefined) {
      if (this.byId.size - this.accepted.length >= MAX_PENDING_LINKS) {
        discard(conn);
        return;
      }
      link = new Link(conn.peer, this);
      this.byId.set(conn.peer, link);
    }
    if (link.closed || !link.attach(conn, kind)) discard(conn);
  }

  private announce(link: Link, hello: GuestHello): void {
    const fn = this.helloHandler;
    if (fn === null) {
      this.waiting.push({ link, hello });
      return;
    }
    try {
      fn(link, hello);
    } catch (e) {
      console.error('[net] onHello failed', e);
    }
  }

  private flushHellos(): void {
    while (this.helloHandler !== null && this.waiting.length > 0) {
      const w = this.waiting.shift() as { link: Link; hello: GuestHello };
      if (!w.link.closed) this.announce(w.link, w.hello);
    }
  }

  private forget(link: Link): void {
    if (this.byId.get(link.id) === link) this.byId.delete(link.id);
    if (this.accepted.includes(link)) this.accepted = this.accepted.filter((l) => l !== link);
  }

  private tick(): void {
    const now = performance.now();
    const slept = now - this.lastTick > SUSPEND_GAP_MS;
    this.lastTick = now;
    for (const link of this.byId.values()) {
      if (link.closed) continue;
      if (slept) link.lastRx = now;
      else if (link.accepted) {
        if (now - link.lastRx > LINK_TIMEOUT_MS) link.die();
      } else if (now - link.born > PENDING_HELLO_MS) {
        link.close();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== 0 || this.reconnectTries >= MAX_RECONNECTS) return;
    this.reconnectTries++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      if (this.closed || this.peer.destroyed || !this.peer.disconnected) return;
      try {
        this.peer.reconnect();
      } catch {
        // destroyed in the meantime
      }
    }, Math.min(1000 * this.reconnectTries, 8000));
  }
}

// ───────────────────────────── Guest ─────────────────────────────

class GuestImpl implements GuestTransport, LinkOwner {
  readonly code: string;
  readonly link: Link;
  private readonly peer: Peer;
  private msgHandler: ((msg: HostMsg) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;
  /** Messages that arrived while nobody listened (the host may answer our hello before the app is ready). */
  private readonly queue: HostMsg[] = [];
  /** Why the connection ended, until the consumer has been told. */
  private closeReason: string | null = null;
  private closed = false;
  private joined = false;
  /** While joining: settles the join (null = success). */
  private endJoin: ((err: NetError | null) => void) | null = null;
  private tickTimer = 0;
  private lastTick = performance.now();
  /** Reused for every ping (serialized inside send). `rtt` is our smoothed round trip, for the host's display. */
  private readonly ping = { k: 'ping' as const, at: 0, rtt: 0 };

  constructor(code: string, peer: Peer, hostId: string) {
    this.code = code;
    this.peer = peer;
    this.link = new Link(hostId, this);
  }

  get onMessage(): ((msg: HostMsg) => void) | null {
    return this.msgHandler;
  }

  set onMessage(fn: ((msg: HostMsg) => void) | null) {
    this.msgHandler = fn;
    if (fn !== null && this.queue.length > 0) queueMicrotask(() => this.drain());
  }

  get onClose(): ((reason: string) => void) | null {
    return this.closeHandler;
  }

  set onClose(fn: ((reason: string) => void) | null) {
    this.closeHandler = fn;
    if (fn !== null && this.closeReason !== null) queueMicrotask(() => this.drain());
  }

  /** Open both channels to the host. Resolves once rel is open (and fast, or FAST_GRACE_MS passed). */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const peer = this.peer;
      let timer = 0;
      let grace = 0;
      let relUp = false;
      let fastUp = false;
      const end = (err: NetError | null): void => {
        if (this.endJoin === null) return; // already settled
        this.endJoin = null;
        window.clearTimeout(timer);
        window.clearTimeout(grace);
        peer.off('error', onPeerError);
        peer.off('disconnected', onGone);
        if (err === null) resolve();
        else reject(err);
      };
      // Once rel is open the host exists; stray errors about the second channel no longer matter.
      const onPeerError = (e: { type: string }): void => {
        if (!relUp) end(new NetError(joinMessage(e.type)));
      };
      const onGone = (): void => {
        if (!relUp) end(new NetError(MSG_SERVER));
      };
      this.endJoin = end;
      peer.on('error', onPeerError);
      peer.on('disconnected', onGone);
      timer = window.setTimeout(() => end(new NetError(MSG_CONNECT)), CONNECT_TIMEOUT_MS);

      const hostId = this.link.id;
      const rel = peer.connect(hostId, { label: 'rel', reliable: true, serialization: 'binary' });
      const fast = peer.connect(hostId, { label: 'fast', reliable: false, serialization: 'binary' });
      if (!rel || !fast) {
        end(new NetError(MSG_SERVER));
        return;
      }
      this.link.attach(rel, 'rel');
      this.link.attach(fast, 'fast');
      rel.once('open', () => {
        relUp = true;
        if (fastUp) end(null);
        else grace = window.setTimeout(() => end(null), FAST_GRACE_MS);
      });
      fast.once('open', () => {
        fastUp = true;
        if (relUp) end(null);
      });
    });
  }

  /** The join worked: say hello and start watching the line. */
  start(hello: GuestHello): void {
    if (this.link.closed) throw new NetError(MSG_CONNECT); // the line died in the instant since connect()
    this.joined = true;
    this.lastTick = performance.now();
    this.link.lastRx = this.lastTick;
    this.link.send(hello);
    this.tickTimer = window.setInterval(() => this.tick(), TICK_MS);
    window.addEventListener('pagehide', this.onPageHide);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.link.send(GUEST_BYE);
    this.link.close();
    this.clearHandlers();
    window.setTimeout(() => destroyPeer(this.peer), FLUSH_MS);
  }

  /** A join that failed: tear everything down now, silently. */
  abort(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.link.close();
    this.clearHandlers();
    destroyPeer(this.peer);
  }

  // LinkOwner

  linkMessage(_link: Link, msg: Raw): void {
    if (msg.k === 'bye') {
      const r = msg.reason;
      this.finish(typeof r === 'string' && r.length > 0 && r.length <= 120 ? r : MSG_HOST_LEFT);
      return;
    }
    this.deliver(msg as unknown as HostMsg);
  }

  linkDead(_link: Link): void {
    if (this.closed) return;
    if (!this.joined) {
      if (this.endJoin !== null) this.endJoin(new NetError(MSG_CONNECT));
      return;
    }
    this.finish(MSG_LOST);
  }

  linkClosed(_link: Link): void {
    this.close();
  }

  // Internals

  private readonly onPageHide = (): void => {
    this.link.send(GUEST_BYE);
  };

  private stop(): void {
    window.clearInterval(this.tickTimer);
    window.removeEventListener('pagehide', this.onPageHide);
  }

  private clearHandlers(): void {
    this.msgHandler = null;
    this.closeHandler = null;
    this.queue.length = 0;
    this.closeReason = null;
  }

  /** The connection ended without us asking: the host said goodbye, or the line went dead. */
  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.link.die();
    destroyPeer(this.peer);
    this.closeReason = reason;
    this.drain();
  }

  private deliver(msg: HostMsg): void {
    const handler = this.msgHandler;
    if (handler !== null && this.queue.length === 0) {
      try {
        handler(msg);
      } catch (e) {
        console.error('[net] message handler failed', e);
      }
      return;
    }
    if (this.queue.length < MAX_QUEUED) this.queue.push(msg);
    if (handler !== null) this.drain();
  }

  /** Hand over everything held back, then the reason the connection ended (once). */
  private drain(): void {
    const q = this.queue;
    while (this.msgHandler !== null && q.length > 0) {
      const msg = q.shift() as HostMsg;
      try {
        this.msgHandler(msg);
      } catch (e) {
        console.error('[net] message handler failed', e);
      }
    }
    const reason = this.closeReason;
    if (reason !== null && this.closeHandler !== null && (q.length === 0 || this.msgHandler === null)) {
      const fn = this.closeHandler;
      this.closeReason = null;
      this.queue.length = 0;
      try {
        fn(reason);
      } catch (e) {
        console.error('[net] onClose failed', e);
      }
    }
  }

  private tick(): void {
    const now = performance.now();
    const slept = now - this.lastTick > SUSPEND_GAP_MS;
    this.lastTick = now;
    const link = this.link;
    if (link.closed) return;
    if (slept) {
      link.lastRx = now;
    } else if (now - link.lastRx > LINK_TIMEOUT_MS) {
      link.die(); // lands in linkDead -> onClose
      return;
    }
    this.ping.at = now;
    this.ping.rtt = link.rttMs;
    link.sendFast(this.ping);
  }
}

// ───────────────────────────── Public API ─────────────────────────────

/** Open a room: pick a free room code and listen for guests (PeerJS public server). */
export async function openHost(): Promise<HostTransport> {
  const PeerCtor = await loadPeer();
  const { peer, id } = await openPeerRetry(PeerCtor, () => hostPeerId(randomCode()), MAX_CODE_TRIES, MSG_NO_ROOM);
  return new HostImpl(id.slice(PEER_PREFIX.length), peer);
}

/** Connect to room `code` and say hello. Rejects with a kid-friendly message. */
export async function joinHost(code: string, hello: GuestHello): Promise<GuestTransport> {
  const room = normalizeCode(code);
  if (room === null) throw new NetError(MSG_NO_GAME);
  const PeerCtor = await loadPeer();
  const { peer } = await openPeerRetry(PeerCtor, guestPeerId, MAX_ID_TRIES, MSG_CONNECT);
  const guest = new GuestImpl(room, peer, hostPeerId(room));
  try {
    await guest.connect();
    guest.start(hello);
  } catch (e) {
    guest.abort();
    throw e;
  }
  return guest;
}
