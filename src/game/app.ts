/**
 * The Foam Fleet app: renderer, state machine, main loop, split-screen drawing, HUD wiring.
 *
 *   menu -> countdown -> playing <-> paused -> results -> (rematch | menu)
 *
 * The simulation runs in fixed 1/60 s steps (so the game plays the same on any
 * computer); drawing happens once per animation frame.
 *
 * Online play (v5) uses the same states. The HOST device runs the real Match exactly as offline (its own boat
 * is slot 0) and mirrors the states, countdown and results to the guests through a HostSession. A GUEST device
 * has no Match at all: a GuestSession hands it a render-only GuestView of the host's game, and the app only
 * draws that view and shows the HUD. Rooms and lobbies live on the title screen (state 'menu').
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { CODE_ALPHABET, CODE_LENGTH, type NetAppState, type NetEvent } from '../net/protocol';
import type { GuestSession, GuestView, HostSession } from '../net/session';
import type {
  Controller, HudState, InputManager, LobbyState, MatchResult, MatchSetup, MenuInput, OnlineMenuHooks, PlayerHud,
  PlayerSetup, ScoreRow, Sfx, Hud, Menu, Viewport, WorldQuery,
} from '../types';
import { OrbitCamera, computeViewports } from './cameras';
import { foam, installErrorCapture, reportError, type FoamNet, type FoamSnapshot } from './debug';
import {
  EMPTY_MENU, ZERO_CONTROLS, fallbackHud, fallbackInput, fallbackMenu, idleController, quietHud, quietSfx,
} from './fallbacks';
import { V2_METHODS, buildOrFallback, guard } from './guard';
import { Match, STEP } from './match';
import { createBotController, createHud, createInput, createMenu, createSfx, loadGuestNet, loadHostNet } from './modules';
import { defaultPlayer, defaultSetup, sanitizeSetup, setupFromQuery } from './setup';
import { clamp, topSpeedOf, wrapPi } from './util';

type AppState = 'menu' | 'countdown' | 'playing' | 'paused' | 'results';

/** Shows through the gap between the two split-screen halves. */
const DIVIDER_COLOR = 0x0b2a3a;
/** The lagoon that sails behind the title screen: no humans, six bots. */
const ATTRACT_SETUP: MatchSetup = {
  mode: 'battle', humans: 1, bots: 6, botDifficulty: 'normal', players: [], durationSec: 999999, laps: 1,
};
/** How often (seconds) the little "Online · DUCK · 3 players" pill is refreshed. */
const NET_STATUS_EVERY = 0.5;
/** A guest whose newest snapshot is older than this (ms) sees "Reconnecting...". */
const STALE_MS = 2500;
/** How long a notice() message stays up. */
const NOTICE_MS = 6000;
/** While the host has the game paused, a guest is reminded this often (seconds). */
const PAUSE_NOTE_EVERY = 1.2;

/** Find a layer div by id, or make one if index.html did not have it. */
function layer(root: HTMLElement, id: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    root.appendChild(el);
  }
  return el;
}

const round = (v: number, places: number): number => {
  const k = 10 ** places;
  return Math.round(v * k) / k;
};

/** ?join=duck -> "DUCK": upper case, only the letters room codes use, at most CODE_LENGTH of them. */
function joinCodeFrom(raw: string | null): string {
  let code = '';
  for (const ch of (raw ?? '').toUpperCase()) {
    if (CODE_ALPHABET.includes(ch) && code.length < CODE_LENGTH) code += ch;
  }
  return code;
}

/** Whatever went wrong, as an Error with words a kid can read (the net code already words its own). */
function friendly(e: unknown, fallback = "Couldn't connect. Try again!"): Error {
  if (e instanceof Error && e.message) return e;
  return new Error(typeof e === 'string' && e ? e : fallback);
}

/** Extras a session may carry on top of session.ts (guest.ts has both); read for the pill and `__foam.net`. */
interface NetProbe {
  rttMs?: number;
  /** Guest: ms since the newest snapshot arrived, -1 before the first. */
  snapshotAgeMs?: number;
}
const probe = (o: object | null, key: keyof NetProbe): number => {
  const v = (o as NetProbe | null)?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

class FoamApp {
  private state: AppState = 'menu';
  private readonly root: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly sfx: Sfx;
  private readonly input: InputManager;
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly orbit = new OrbitCamera();

  private match: Match | null = null;
  private attract: Match | null = null;
  private attractFocus = 0;
  private attractTimer = 0;
  private lastSetup: MatchSetup | null = null;

  private width = 1;
  private height = 1;
  private pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  private viewports: Viewport[] = [];

  private lastTime = 0;
  private lastRaf = 0;
  private acc = 0;
  private countdownT = 0;
  private countdownShown = -1;
  /** What a pause interrupted (the 3-2-1 or the match), so Resume carries on from the same place. */
  private pausedFrom: 'countdown' | 'playing' = 'playing';
  private readonly engineLevels: number[] = [];

  private fps = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private slowSeconds = 0;
  private fpsEl: HTMLElement | null = null;
  private noPause = false;

  // Online (v5). At most one of hostNet / guestNet is set; `view` is the guest's render-only match.
  private hostNet: HostSession | null = null;
  private guestNet: GuestSession | null = null;
  private view: GuestView | null = null;
  /** Bumped whenever a connection attempt starts or the room is dropped, so a late "connected!" is thrown away. */
  private netToken = 0;
  /** A guest's own "Leave the game?" box is open (the game keeps running underneath). */
  private guestOverlay = false;
  private netStatusT = 0;
  private netStatusText: string | null = null;
  private pauseNoteT = 0;
  /** The guest's results camera: the islands (taken from the map data) and which boat it circles. */
  private resultsWorld: WorldQuery | null = null;
  private resultsFocus = 0;
  private resultsT = 0;
  private gatedInputObj: InputManager | null = null;
  private autopilotCtl: Controller | null = null;
  private noticeEl: HTMLElement | null = null;
  private noticeTimer = 0;

  constructor() {
    const params = new URLSearchParams(window.location.search);
    const root = document.getElementById('app') ?? document.body;
    this.root = root;
    const hudRoot = layer(root, 'hud');
    const menuRoot = layer(root, 'menu');

    // Renderer.
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(this.pixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    // (PCFSoftShadowMap was removed in three r18x; PCFShadowMap is the soft-edged one now.)
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // We refresh the shadow map once per frame ourselves, so split screen does not pay for it twice.
    renderer.shadowMap.autoUpdate = false;
    renderer.info.autoReset = false;
    renderer.setClearColor(DIVIDER_COLOR, 1);
    root.insertBefore(renderer.domElement, hudRoot.parentElement === root ? hudRoot : root.firstChild);
    this.renderer = renderer;

    // Services. Each is wrapped so a throwing module is logged instead of freezing the loop.
    // (?mute=1 is handled inside audio/sfx.ts: that page load is silent, the sound buttons and the M key do
    // nothing, and nothing is saved. The core only has to hand the same Sfx to everyone.)
    this.sfx = guard('sfx', buildOrFallback('createSfx', () => createSfx(), quietSfx), {}, V2_METHODS.sfx);
    this.input = guard(
      'input',
      buildOrFallback('createInput', () => createInput(window), fallbackInput),
      {
        humanController: () => idleController('human'),
        menu: () => EMPTY_MENU,
        gamepadCount: () => 0,
        schemeOf: () => 'keysA',
      },
      V2_METHODS.input,
    );
    this.hud = guard(
      'hud',
      buildOrFallback('createHud', () => createHud(hudRoot, this.sfx), () => fallbackHud(hudRoot)),
      {},
      V2_METHODS.hud,
    );
    this.menu = guard(
      'menu',
      buildOrFallback('createMenu', () => createMenu(menuRoot, this.sfx), () => fallbackMenu(menuRoot, defaultSetup)),
      { visible: () => false },
      V2_METHODS.menu,
    );
    // "Play Online" only shows once the menu has these.
    this.menu.setOnlineHooks(this.onlineHooks());

    // URL switches (handy for testing; see debug.ts).
    this.noPause = params.get('nopause') === '1';
    if (params.get('autopilot') === '1') foam.autopilot = true;
    const scale = Number(params.get('timescale'));
    if (scale > 0) foam.timeScale = scale;
    if (params.get('fps') === '1') {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:8px;bottom:8px;z-index:1000;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.55);color:#fff;font:12px monospace;pointer-events:none';
      root.appendChild(el);
      this.fpsEl = el;
    }
  }

  start(): void {
    this.layout();
    window.addEventListener('resize', () => this.layout());
    // Alt-tabbing away pauses a live match. The iPad app switcher hides the page without a blur, so
    // a page that turns hidden pauses it too. (Not online: the game goes on without you, see pauseIfAway.)
    window.addEventListener('blur', () => this.pauseIfAway());
    document.addEventListener('visibilitychange', () => {
      this.lastTime = performance.now();
      if (document.visibilityState === 'hidden') this.pauseIfAway();
    });
    // Closing the tab says goodbye properly, so the others see "left the game" now instead of after a time-out.
    window.addEventListener('pagehide', () => this.closeSessions());

    // Browsers only allow sound after a click or key press. iOS only counts the END of a touch
    // (pointerup / touchend), so listen for those as well as the start.
    const unlock = (): void => {
      this.sfx.unlock();
      this.sfx.setMusic(true);
    };
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
      window.addEventListener(type, unlock, { once: true, capture: true, passive: true });
    }
    this.sfx.setMusic(true);

    this.hookDebug();

    const query = new URLSearchParams(window.location.search);
    const quick = setupFromQuery(query);
    if (quick) {
      this.startMatch(quick);
    } else {
      this.enterMenu();
      // A shared link (?join=DUCK) opens the Join screen with the code already typed in.
      if (query.has('join')) this.menu.showOnline('join', joinCodeFrom(query.get('join')));
    }

    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
    // Hidden tabs stop animation frames; keep the simulation ticking slowly so test tools can still drive it.
    window.setInterval(() => {
      if (document.hidden && performance.now() - this.lastRaf > 300) this.tick(performance.now(), false);
    }, 250);
  }

  // ───────────────────────────── state changes ─────────────────────────────

  private setState(next: AppState): void {
    this.state = next;
    foam.state = next;
    this.syncTouch();
    this.mirrorState(next);
  }

  /**
   * Online host: tell the guests whenever the game changes state. ("menu" is not a game state: going back to
   * the lobby says so itself, see backToLobby.)
   */
  private mirrorState(next: AppState): void {
    const host = this.hostNet;
    if (!host || next === 'menu' || !this.match?.setup.online) return;
    try {
      host.setState(next);
    } catch (e) {
      reportError('net.setState', e);
    }
  }

  /** Leaving the page pauses a live match. (?nopause=1 and autopilot are test hooks that opt out.) Online games never pause. */
  private pauseIfAway(): void {
    if (this.state === 'playing' && !this.noPause && !foam.autopilot && !this.isOnlineMatch()) this.pause();
  }

  /** Is this device in a live online match (as the host or as a guest)? */
  private isOnlineMatch(): boolean {
    return this.view !== null || (this.hostNet !== null && !!this.match?.setup.online);
  }

  /** How many players share THIS screen: 2 only for local split screen; a guest and an online host have one. */
  private localCount(): 1 | 2 {
    if (this.view) return 1;
    const m = this.match;
    return m && this.state !== 'menu' && m.localSlots.length === 2 ? 2 : 1;
  }

  /**
   * Tell the touch controls where the human viewports are and whether to show: only during the countdown
   * and play. Runs on every state change and every resize. startMatch/enterMenu change state before they
   * rebuild the viewports, so a call that still sees the old viewport count waits for layout() to repeat it.
   * (A guest's "Leave the game?" box hides them too.)
   */
  private syncTouch(): void {
    const humans = this.localCount();
    if (this.viewports.length !== humans) return;
    // (A guest keeps its Pause button while the HOST has the game paused, so it can still open "Leave the game?".)
    const hostPaused = this.view !== null && this.state === 'paused';
    const live = (this.state === 'countdown' || this.state === 'playing' || hostPaused) && !this.guestOverlay;
    this.input.layoutTouch(this.viewports, humans, live);
  }

  /** Back to the title screen (with the demo lagoon behind it). */
  private enterMenu(): void {
    this.hud.hidePause();
    this.hud.hideResults();
    this.hud.hide();
    this.hud.setNetStatus(null);
    this.netStatusText = null;
    this.sfx.setEngines([]);
    this.disposeMatch();
    this.disposeView();
    if (!this.attract) {
      try {
        this.attract = new Match(ATTRACT_SETUP, { hud: quietHud(), sfx: quietSfx(), input: this.input }, true);
      } catch (e) {
        reportError('attract', e);
        this.attract = null;
      }
    }
    this.attractFocus = 0;
    this.attractTimer = 0;
    this.orbit.reset();
    this.acc = 0;
    this.setState('menu');
    this.layout();
    // (The title screen only ever starts local games: an online roster never comes from here.)
    this.menu.show(this.lastSetup, (setup) => this.startMatch({ ...setup, online: null }));
  }

  private startMatch(raw: MatchSetup): void {
    // Online only while we really host a room (sanitizeSetup keeps the roster of an online setup and drops it
    // from a local one); anything else is a local game, and any room we were in is dropped.
    const setup = sanitizeSetup(raw);
    const host = this.hostNet !== null && setup.online ? this.hostNet : null;
    if (!host) {
      delete setup.online;
      this.closeSessions();
      this.lastSetup = setup;
    }
    this.sfx.unlock();
    this.sfx.setMusic(true);
    this.menu.hide();
    this.hud.hidePause();
    this.hud.hideResults();
    this.disposeMatch();
    this.disposeView();
    this.disposeAttract();

    let match: Match;
    try {
      match = new Match(setup, { hud: this.hud, sfx: this.sfx, input: this.input });
    } catch (e) {
      reportError('startMatch', e);
      this.enterMenu();
      if (host) this.showLobby();
      return;
    }
    this.match = match;
    if (host) {
      // Plug the remote players in and tell every guest to start, BEFORE the first step.
      try {
        host.beginMatch(match);
      } catch (e) {
        reportError('net.beginMatch', e);
        this.notice("Couldn't start the game. Try again!");
        this.backToLobby();
        return;
      }
    }
    // Leave the 'menu' state BEFORE layout(): layout() only builds split-screen viewports (and sets each
    // camera's aspect) when it sees a live match, and 'menu' means "show the demo lagoon, one viewport".
    this.countdownT = 0;
    this.countdownShown = -1;
    this.acc = 0;
    this.setState('countdown');
    this.layout();
    this.hud.show();
  }

  /**
   * (The touch Pause button is on screen during the countdown too, so a tap there has to work.)
   * A guest's Pause only opens a "Leave the game?" box: the game goes on for everybody else.
   */
  private pause(): void {
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    if (this.view) {
      this.openGuestOverlay();
      return;
    }
    this.pausedFrom = this.state;
    this.setState('paused');
    this.sfx.setEngines([]);
    const online = this.hostNet !== null && !!this.match?.setup.online;
    // Quitting an online match sends everyone back to the lobby (the room stays open).
    this.hud.showPause(() => this.resume(), () => (online ? this.backToLobby() : this.enterMenu()));
  }

  private resume(): void {
    if (this.view) {
      this.closeGuestOverlay();
      return;
    }
    if (this.state !== 'paused') return;
    this.hud.hidePause();
    this.setState(this.pausedFrom);
    this.acc = 0;
    this.lastTime = performance.now();
  }

  private finish(match: Match): void {
    this.setState('results');
    this.orbit.reset();
    this.sfx.setEngines([]);
    // Clear the per-player panels (reticle, ammo, boost, scoreboard) off the podium screen. hide() only
    // touches the live layer, so the results overlay shown right below is unaffected.
    this.hud.hide();
    const online = this.hostNet !== null && !!match.setup.online;
    if (online) {
      // Every guest gets the table and its own stats (and awards its own trophies); only the host can rematch.
      try {
        this.hostNet?.sendResults(match);
      } catch (e) {
        reportError('net.sendResults', e);
      }
      this.hud.showResults(match.result(), () => this.rematchOnline(match), () => this.backToLobby(), { menuLabel: 'Lobby' });
    } else {
      this.hud.showResults(match.result(), () => this.startMatch(match.setup), () => this.enterMenu());
    }
    // Boats vs. Sharks that the sharks won gets a friendly wah-wah instead of the fanfare.
    const lost = match.setup.mode === 'sharks' && !match.mode.outcome(match.boats[0]?.id ?? 0).won;
    if (lost) this.sfx.defeat();
    else this.sfx.victory();
  }

  private disposeMatch(): void {
    if (this.match) {
      this.match.dispose();
      this.match = null;
    }
    this.renderer.renderLists.dispose();
  }

  private disposeAttract(): void {
    if (this.attract) {
      this.attract.dispose();
      this.attract = null;
    }
  }

  /** Guest: free the render-only match. */
  private disposeView(): void {
    this.guestOverlay = false;
    this.resultsWorld = null;
    if (this.view) {
      try {
        this.view.dispose();
      } catch (e) {
        reportError('view.dispose', e);
      }
      this.view = null;
      this.renderer.renderLists.dispose();
    }
  }

  // ───────────────────────────── online: rooms and lobbies ─────────────────────────────

  /** What the menu's online screens call. */
  private onlineHooks(): OnlineMenuHooks {
    return {
      host: (profile) => this.hostGame(profile),
      join: (code, profile) => this.joinGame(code, profile),
      settings: (setup) => {
        try {
          this.hostNet?.setSettings(setup);
        } catch (e) {
          reportError('net.setSettings', e);
        }
      },
      profile: (profile) => {
        try {
          (this.hostNet ?? this.guestNet)?.setProfile(profile);
        } catch (e) {
          reportError('net.setProfile', e);
        }
      },
      start: (setup) => this.startOnlineMatch(setup),
      leave: () => this.leaveOnline(),
    };
  }

  /** The net code is only loaded when somebody taps Play Online. */
  private async loadNet<T>(load: () => Promise<T>): Promise<T> {
    try {
      return await load();
    } catch (e) {
      reportError('net.load', e);
      throw new Error("Online play couldn't start. Check the internet and try again!");
    }
  }

  /** "Host a game": open a room. Resolves with its code (the menu then shows the lobby). */
  private async hostGame(profile: PlayerSetup): Promise<string> {
    this.closeSessions();
    const token = ++this.netToken;
    const { createHostSession } = await this.loadNet(loadHostNet);
    let session: HostSession;
    try {
      session = await createHostSession(profile);
    } catch (e) {
      throw friendly(e);
    }
    if (token !== this.netToken) {
      session.close(); // somebody tapped Leave (or Host again) while we were connecting
      throw new Error('That game was closed.');
    }
    this.hostNet = session;
    session.onLobby = (lobby) => this.pushLobby(lobby);
    session.onPlayerLeft = (name) => this.playerLeft(name);
    this.pushLobbySoon();
    return session.code;
  }

  /** "Join": connect to a room. Resolves once the host said welcome. */
  private async joinGame(code: string, profile: PlayerSetup): Promise<void> {
    this.closeSessions();
    const token = ++this.netToken;
    const { joinGuestSession } = await this.loadNet(loadGuestNet);
    let session: GuestSession;
    try {
      session = await joinGuestSession(code, profile);
    } catch (e) {
      throw friendly(e);
    }
    if (token !== this.netToken) {
      session.close();
      throw new Error('That game was closed.');
    }
    this.guestNet = session;
    session.onLobby = (lobby) => this.pushLobby(lobby);
    session.onStart = (setup) => this.guestStart(setup, session);
    session.onState = (state) => this.guestState(state, session);
    session.onResults = (result, winnerId, lost) => this.guestResults(result, winnerId, lost, session);
    session.onClosed = (reason) => this.guestClosed(reason, session);
    this.pushLobbySoon();
  }

  /** The lobby changed: show it, if the menu is what is on screen. */
  private pushLobby(lobby: LobbyState): void {
    if (this.state === 'menu') this.menu.updateLobby(lobby);
  }

  /** The menu switches to its lobby screen a moment after hosting/joining resolves; give it the players once it has. */
  private pushLobbySoon(): void {
    window.setTimeout(() => {
      const lobby = (this.hostNet ?? this.guestNet)?.lobby;
      if (lobby) this.pushLobby(lobby);
    }, 0);
  }

  /** Show the online lobby (after a match, or right after hosting). */
  private showLobby(): void {
    const lobby = (this.hostNet ?? this.guestNet)?.lobby;
    if (!lobby) return;
    // The lobby goes in FIRST: menu.show() (enterMenu) forgot the room, and showOnline('lobby') reads whether we are
    // the host or a guest from the lobby it already holds (without it every returning guest would get Start!).
    this.menu.updateLobby(lobby);
    this.menu.showOnline('lobby');
  }

  /** Host: a guest dropped out mid-match. Their boat just stops; everybody sees a feed line. */
  private playerLeft(name: string): void {
    const text = `${name} left the game`;
    this.hud.feed(text);
    this.emit({ k: 'feed', text });
  }

  /** Host tapped Start (or Rematch): build the online setup from the lobby and go. */
  private startOnlineMatch(settings: MatchSetup): void {
    const host = this.hostNet;
    if (!host) return;
    if (host.lobby.players.length < 2) {
      this.notice('Wait for a friend to join first!');
      return;
    }
    let setup: MatchSetup;
    try {
      setup = host.buildSetup(settings);
    } catch (e) {
      reportError('net.buildSetup', e);
      this.notice("Couldn't start the game. Try again!");
      return;
    }
    this.startMatch(setup);
  }

  /** Host: play again with whoever is still in the room (it may have changed since the last start). */
  private rematchOnline(match: Match): void {
    if ((this.hostNet?.lobby.players.length ?? 0) < 2) {
      this.notice('Everybody left. Waiting for friends!');
      this.backToLobby();
      return;
    }
    this.startOnlineMatch(match.setup);
  }

  /** Host: everyone back to the lobby (after a match, or when the host quits one). The room stays open. */
  private backToLobby(): void {
    try {
      this.hostNet?.setState('lobby');
    } catch (e) {
      reportError('net.setState', e);
    }
    this.enterMenu();
    this.showLobby();
  }

  /** Leave the room (a host closes it for everyone) and go to the title screen. */
  private leaveOnline(): void {
    this.closeSessions();
    this.enterMenu();
  }

  /** Drop whatever room we are in (or trying to get into). Safe to call any time. */
  private closeSessions(): void {
    this.netToken++;
    const host = this.hostNet;
    const guest = this.guestNet;
    this.hostNet = null;
    this.guestNet = null;
    if (host) {
      host.onLobby = null;
      host.onPlayerLeft = null;
      try {
        host.close();
      } catch (e) {
        reportError('net.close', e);
      }
    }
    if (guest) {
      guest.onLobby = null;
      guest.onStart = null;
      guest.onState = null;
      guest.onResults = null;
      guest.onClosed = null;
      try {
        guest.close();
      } catch (e) {
        reportError('net.close', e);
      }
    }
  }

  /** App-level happenings outside the Match (the 3-2-1-GO) for every guest. */
  private emit(event: NetEvent): void {
    const host = this.hostNet;
    if (!host || !this.match?.setup.online) return;
    try {
      host.emit(event);
    } catch (e) {
      reportError('net.emit', e);
    }
  }

  /** Online host: one fixed step of the match is done; the session sends snapshots and events. */
  private netAfterStep(m: Match): void {
    const host = this.hostNet;
    if (!host || !m.setup.online) return;
    try {
      host.afterStep(m);
    } catch (e) {
      reportError('net.afterStep', e);
    }
  }

  // ───────────────────────────── online: the guest side ─────────────────────────────

  /** The host started (or restarted) a match: build the render-only view and sit through the countdown. */
  private guestStart(setup: MatchSetup, session: GuestSession): void {
    if (session !== this.guestNet) return;
    this.sfx.unlock();
    this.sfx.setMusic(true);
    this.menu.hide();
    this.hud.hidePause();
    this.hud.hideResults();
    this.disposeMatch();
    this.disposeView();
    this.disposeAttract();

    let view: GuestView;
    try {
      view = session.createView(setup, { hud: this.hud, sfx: this.sfx, input: this.gatedInput() });
    } catch (e) {
      reportError('createView', e);
      this.leaveOnline();
      this.notice("Couldn't start the game. Try again!");
      return;
    }
    this.view = view;
    this.pauseNoteT = 0;
    this.setState('countdown');
    this.layout(); // gives the view its viewport and the touch controls their zone
    this.hud.show();
  }

  /** The host's state changed (it paused, resumed, finished, or went back to the lobby). */
  private guestState(state: NetAppState, session: GuestSession): void {
    if (session !== this.guestNet) return;
    if (state === 'lobby') {
      this.disposeView();
      this.enterMenu();
      this.showLobby();
      return;
    }
    if (!this.view) return;
    switch (state) {
      case 'countdown':
      case 'playing':
        if (this.state === 'paused') this.hud.announce('Back to it!', { ms: 700 });
        if (this.state !== 'results') this.setState(state);
        break;
      case 'paused':
        if (this.state === 'countdown' || this.state === 'playing') {
          this.pauseNoteT = 0;
          this.setState('paused');
          this.sfx.setEngines([]);
        }
        break;
      case 'results':
        this.beginGuestResults(null);
        break;
      default:
        break;
    }
  }

  /** The host's table, plus this device's own trophies (already awarded by the session). */
  private guestResults(result: MatchResult, winnerId: number, lost: boolean, session: GuestSession): void {
    if (session !== this.guestNet || !this.view) return;
    this.beginGuestResults(winnerId);
    this.hud.showResults(result, null, () => this.leaveOnline(), { waiting: 'Waiting for the host...', menuLabel: 'Leave', lost });
    if (lost) this.sfx.defeat();
    else this.sfx.victory();
  }

  /** Switch a guest to the results screen: HUD off, orbit camera on the winner. (Safe to call twice.) */
  private beginGuestResults(winnerId: number | null): void {
    const view = this.view;
    if (!view) return;
    if (winnerId !== null) this.resultsFocus = winnerId;
    if (this.state === 'results') return;
    if (winnerId === null) this.resultsFocus = this.guestNet?.slot ?? 0;
    this.hud.hidePause();
    this.guestOverlay = false;
    this.setState('results');
    this.orbit.reset();
    this.resultsT = 0;
    this.sfx.setEngines([]);
    this.hud.hide();
    // The orbit camera stays out of islands: the map data has them (the view itself offers no world).
    let obstacles: WorldQuery['obstacles'] = [];
    let arenaRadius: number = CONFIG.arena.radius;
    try {
      const map = view.hudState(this.viewports[0]).map;
      obstacles = map.obstacles;
      arenaRadius = map.arenaRadius;
    } catch (e) {
      reportError('view.hudState', e);
    }
    this.resultsWorld = { obstacles, arenaRadius, waveHeight: () => 0, waveNormal: (_x, _z, _t, out) => out.set(0, 1, 0) };
  }

  /** The connection ended (the host left, or the network went): back to the title with the reason. */
  private guestClosed(reason: string, session: GuestSession): void {
    if (session !== this.guestNet) return;
    this.closeSessions();
    this.enterMenu();
    this.notice(reason || 'The game ended.');
  }

  private openGuestOverlay(): void {
    if (this.guestOverlay) return;
    this.guestOverlay = true;
    this.syncTouch();
    // The game keeps running for everybody else, so this is a "Leave the game?" box, not a pause.
    this.hud.showPause(() => this.closeGuestOverlay(), () => this.leaveOnline(), {
      title: 'Leave the game?', resumeLabel: 'Keep playing', quitLabel: 'Leave',
    });
  }

  private closeGuestOverlay(): void {
    if (!this.guestOverlay) return;
    this.guestOverlay = false;
    this.hud.hidePause();
    this.syncTouch();
  }

  /**
   * The input a guest's view reads. It is the real input, except that the boat reads "hands off" while the
   * "Leave the game?" box is open or the host has paused (so the keys that press its buttons don't steer or
   * shoot), the view can't poll or dispose it, and Autopilot (a test hook) can drive the boat.
   */
  private gatedInput(): InputManager {
    if (this.gatedInputObj) return this.gatedInputObj;
    const base = this.input;
    let cached: { inner: Controller; wrapped: Controller } | null = null;
    const wrap = (inner: Controller): Controller => ({
      kind: 'human',
      update: (ctx, dt) => {
        if (this.guestOverlay || this.state === 'paused') return ZERO_CONTROLS;
        if (foam.autopilot) return this.pilot().update(ctx, dt);
        return inner.update(ctx, dt);
      },
    });
    this.gatedInputObj = {
      poll: () => {}, // the app polls once per frame
      humanController: (slot, humans) => {
        const inner = base.humanController(slot, humans);
        if (!cached || cached.inner !== inner) cached = { inner, wrapped: wrap(inner) };
        return cached.wrapped;
      },
      get menu() { return base.menu; },
      schemeOf: (slot, humans) => base.schemeOf(slot, humans),
      get touchActive() { return base.touchActive; },
      layoutTouch: (viewports, humans, visible) => base.layoutTouch(viewports, humans, visible),
      gamepadCount: () => base.gamepadCount(),
      rumble: (slot, humans, strength, ms) => base.rumble(slot, humans, strength, ms),
      dispose: () => {},
    };
    return this.gatedInputObj;
  }

  /** A computer driver for a guest's boat (?autopilot=1 / __foam.autopilot). */
  private pilot(): Controller {
    this.autopilotCtl ??= buildOrFallback('createBotController', () => createBotController('normal', 100), () => idleController('bot'));
    return this.autopilotCtl;
  }

  /** A short friendly message over whatever is on screen (the game ended, something went wrong). */
  private notice(text: string): void {
    this.noticeEl?.remove();
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:absolute;left:50%;top:max(16px,env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:1600;max-width:min(92vw,560px);padding:12px 22px;border-radius:16px;border:3px solid #fff;background:#0b2a3a;color:#fff;font:700 22px/1.25 Fredoka,system-ui,sans-serif;text-align:center;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.35)';
    el.textContent = text;
    this.root.appendChild(el);
    this.noticeEl = el;
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      el.remove();
      if (this.noticeEl === el) this.noticeEl = null;
    }, NOTICE_MS);
  }

  /** The little pill under Pause: "Online · DUCK · 3 players". Twice a second is plenty. */
  private updateNetStatus(dt: number): void {
    this.netStatusT -= dt;
    if (this.netStatusT > 0) return;
    this.netStatusT = NET_STATUS_EVERY;
    let text: string | null = null;
    if (this.state !== 'menu' && this.isOnlineMatch()) {
      const session = this.hostNet ?? this.guestNet;
      if (session) {
        const n = session.lobby.players.length;
        // (While the host has the game paused no snapshots come, and that is fine.)
        const quiet = this.view !== null && (this.state === 'countdown' || this.state === 'playing') && probe(this.guestNet, 'snapshotAgeMs') > STALE_MS;
        if (quiet) text = 'Reconnecting...';
        else text = `Online · ${session.code} · ${n} player${n === 1 ? '' : 's'}${this.guestOverlay ? ' · game still on!' : ''}`;
      }
    }
    if (text !== this.netStatusText) {
      this.netStatusText = text;
      this.hud.setNetStatus(text);
    }
  }

  /** `__foam.net`: who this device is online (a live read). */
  private netInfo(): FoamNet {
    const host = this.hostNet;
    const guest = this.guestNet;
    const session = host ?? guest;
    if (!session) return { role: null, code: '', slot: -1, rttMs: 0, snapshotAgeMs: 0, players: 0 };
    return {
      role: session.role,
      code: session.code,
      slot: guest ? guest.slot : 0,
      rttMs: probe(session, 'rttMs'),
      snapshotAgeMs: probe(guest, 'snapshotAgeMs'),
      players: session.lobby.players.length,
    };
  }

  // ───────────────────────────── the loop ─────────────────────────────

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    this.lastRaf = now;
    this.tick(now, true);
  };

  /** One pass of the app: read input, run simulation steps, then (if `draw`) cameras, HUD, sound and pixels. */
  private tick(now: number, draw: boolean): void {
    const raw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = clamp(raw > 0 ? raw : 0, 0, 0.1); // a long hitch should not make boats teleport
    try {
      if (draw) this.trackFps(raw);
      this.input.poll();
      const mi = this.input.menu;
      if (mi.mute) this.sfx.setMuted(!this.sfx.muted);
      this.routeInput(mi);
      this.simulate(dt);
    } catch (e) {
      reportError('frame', e);
    }
    if (draw) {
      this.updateCameras(dt);
      this.updateHud();
      this.updateAudio();
      this.updateNetStatus(dt);
      this.drawFrame();
    }
  }

  /** Send this frame's menu buttons to whichever screen is in charge. */
  private routeInput(mi: MenuInput): void {
    if (this.view) {
      this.routeGuestInput(mi);
      return;
    }
    switch (this.state) {
      case 'menu':
        this.menu.update(mi);
        break;
      case 'playing':
        if (mi.pause) this.pause();
        break;
      case 'paused':
        // Pause again = resume. (Escape is both "pause" and "back", so check pause first.)
        if (mi.pause) this.resume();
        else this.hud.handleMenuInput(mi);
        break;
      case 'results':
        this.hud.handleMenuInput(mi);
        break;
      case 'countdown':
        if (mi.pause) this.pause();
        break;
      default:
        break;
    }
  }

  /** A guest: Pause opens (and closes) the "Leave the game?" box; the game never stops. */
  private routeGuestInput(mi: MenuInput): void {
    if (this.state === 'results') {
      this.hud.handleMenuInput(mi);
    } else if (this.guestOverlay) {
      if (mi.pause) this.closeGuestOverlay();
      else this.hud.handleMenuInput(mi);
    } else if (mi.pause) {
      this.openGuestOverlay();
    }
  }

  /** Fixed-step simulation: accumulate real time, spend it in 1/60 s slices. */
  private simulate(dt: number): void {
    if (this.view) {
      this.guestSimulate(dt);
      return;
    }
    if (this.state === 'paused') {
      this.acc = 0;
      return;
    }
    const scale = Number.isFinite(foam.timeScale) ? clamp(Number(foam.timeScale), 0, 20) : 1;
    this.acc += dt * scale;
    // Normally at most 5 steps per frame; fast-forward earns more.
    const maxSteps = Math.max(5, Math.ceil(5 * scale));
    let steps = 0;
    while (this.acc >= STEP && steps < maxSteps && !this.isPaused()) {
      this.acc -= STEP;
      steps++;
      this.fixedStep();
    }
    if (steps >= maxSteps) this.acc = 0; // too far behind: drop the backlog instead of spiralling
  }

  /**
   * A guest does not simulate: its view reads this device's controls, applies the host's events and
   * snapshots and moves the camera, once per frame (with real frame time), in every state.
   */
  private guestSimulate(dt: number): void {
    try {
      this.view?.update(dt);
    } catch (e) {
      reportError('view.update', e);
    }
    if (this.state === 'paused') {
      // The host paused everyone: remind a guest what is going on (the message times out by itself).
      this.pauseNoteT -= dt;
      if (this.pauseNoteT <= 0) {
        this.pauseNoteT = PAUSE_NOTE_EVERY;
        this.hud.announce('Paused by the host', { sub: 'Hang on!', ms: 1500 });
      }
    }
  }

  /** (A method, not an inline comparison, because a step can change the state mid-loop.) */
  private isPaused(): boolean {
    return this.state === 'paused';
  }

  private fixedStep(): void {
    try {
      switch (this.state) {
        case 'menu':
          this.attract?.step(STEP, true, false);
          break;
        case 'countdown':
          this.countdownStep();
          break;
        case 'playing': {
          const m = this.match;
          if (!m) break;
          m.step(STEP, true, true);
          this.netAfterStep(m);
          if (m.mode.over) this.finish(m);
          break;
        }
        case 'results': {
          const m = this.match;
          if (!m) break;
          m.step(STEP, false, false);
          this.netAfterStep(m);
          break;
        }
        default:
          break;
      }
    } catch (e) {
      reportError('step', e);
    }
  }

  /** 3, 2, 1, GO! The boats sit still (and rev) until GO. Online, the guests get the same numbers and sounds. */
  private countdownStep(): void {
    const m = this.match;
    if (!m) return;
    const secs = Math.max(1, Math.round(CONFIG.match.countdownSec));
    const k = Math.floor(this.countdownT);
    if (k !== this.countdownShown && k < secs) {
      this.countdownShown = k;
      const n = secs - k;
      const sub = k === 0 ? this.countdownSub(m.setup.mode) : undefined;
      this.hud.announce(String(n), { ms: 900, sub });
      this.sfx.countdown(n);
      // (Events are plain data: no `sub: undefined` on the wire.)
      this.emit(sub ? { k: 'announce', text: String(n), sub, ms: 900 } : { k: 'announce', text: String(n), ms: 900 });
      this.emit({ k: 'sfx', m: 'countdown', a: [n] });
    }
    m.step(STEP, false, false);
    this.netAfterStep(m);
    this.countdownT += STEP;
    if (this.countdownT >= secs) {
      m.mode.begin();
      this.hud.announce('GO!', { ms: 900 });
      this.sfx.go();
      this.emit({ k: 'announce', text: 'GO!', ms: 900 });
      this.emit({ k: 'sfx', m: 'go', a: [] });
      this.setState('playing');
    }
  }

  /** The line under the first countdown number. */
  private countdownSub(mode: MatchSetup['mode']): string {
    switch (mode) {
      case 'race': return 'Race through the gates!';
      case 'team': return `${CONFIG.team.names[0]} vs ${CONFIG.team.names[1]}!`;
      case 'practice': return 'Pop all the balloons!';
      case 'sharks': return 'Team up and scare off the sharks!';
      default: return 'Tag the other boats!';
    }
  }

  // ───────────────────────────── per-frame visuals ─────────────────────────────

  private updateCameras(dt: number): void {
    try {
      if (this.state === 'menu') {
        const m = this.attract;
        if (!m || m.boats.length === 0) return;
        this.attractTimer += dt;
        if (this.attractTimer > 12) {
          this.attractTimer = 0;
          this.attractFocus = (this.attractFocus + 1) % m.boats.length;
          this.orbit.reset();
        }
        this.orbit.update(dt, m.boats[this.attractFocus].position, m.world, m.t, 18, 7, 0.25);
      } else if (this.state === 'results') {
        const view = this.view;
        if (view) {
          // A guest circles the winner's boat in its view (the view moves its own chase camera in update()).
          const obj = view.boatObject(this.resultsFocus) ?? view.boatObject(this.guestNet?.slot ?? 0);
          if (obj && this.resultsWorld) {
            this.resultsT += dt;
            this.orbit.update(dt, obj.position, this.resultsWorld, this.resultsT, 14, 5, 0.4);
          }
          return;
        }
        const m = this.match;
        if (!m) return;
        const winner = m.mode.ranking[0] ?? m.boats[0];
        this.orbit.update(dt, winner.position, m.world, m.t, 14, 5, 0.4);
      } else if (this.state === 'countdown' || this.state === 'playing') {
        this.match?.updateCameras(dt);
      }
    } catch (e) {
      reportError('updateCameras', e);
    }
  }

  private updateHud(): void {
    if (this.state === 'menu') return;
    try {
      if (this.view) {
        this.hud.update(this.view.hudState(this.viewports[0]));
        return;
      }
      const m = this.match;
      if (m) this.hud.update(this.buildHudState(m));
    } catch (e) {
      reportError('hudState', e);
    }
  }

  /** A fresh HudState every frame (small, and it keeps the HUD's "did anything change?" checks honest). */
  private buildHudState(m: Match): HudState {
    const mode = m.mode;
    const players: PlayerHud[] = [];
    // One entry per viewport: the humans playing on THIS screen (everyone offline, just you online).
    for (let k = 0; k < m.localSlots.length; k++) {
      const i = m.localSlots[k];
      const boat = m.boats[i];
      // The arrow points from the camera's forward direction toward the next gate. Right = clockwise = positive.
      const gate = mode.gatePosition(i);
      const arrow = gate
        ? wrapPi(m.cams[i].viewHeading - Math.atan2(gate.x - boat.position.x, gate.z - boat.position.z))
        : null;
      const lockId = boat.aimTargetId;
      players.push({
        name: boat.name,
        color: boat.color,
        score: mode.scoreOf(i),
        ammo: boat.ammo,
        maxAmmo: boat.maxAmmo,
        reloading: boat.reloading,
        reloadProgress: boat.reloadProgress,
        boost: boat.boost,
        powerUp: boat.powerUp,
        shielded: boat.shielded,
        rank: mode.rankOf(i),
        race: mode.raceInfo(i),
        arrow,
        // A boat's name, or "Shark" / "MEGA SHARK" when the blaster is locked onto a shark (ids from SHARK_ID_BASE up).
        lockedTarget: lockId != null ? m.targetName(lockId) : null,
        boatId: boat.id,
        team: boat.team,
        viewHeading: m.cams[i].viewHeading,
        nextGate: mode.nextGate(i),
        easyDriving: boat.easyDriving,
      });
    }
    const scoreboard: ScoreRow[] = [];
    const ranking = mode.ranking;
    for (let i = 0; i < ranking.length; i++) {
      const b = ranking[i];
      scoreboard.push({ id: b.id, name: b.name, color: b.color, score: mode.scoreOf(b.id), isHuman: b.isHuman, team: b.team });
    }
    return {
      mode: mode.id,
      timeLeft: mode.timeLeft(),
      raceTime: mode.raceTime(),
      players,
      viewports: this.viewports,
      scoreboard,
      teams: mode.teams(),
      balloons: mode.balloonCount(),
      sharks: mode.sharkHud(),
      map: m.mapState(),
    };
  }

  /** Engine hum follows the speed of each human on this screen (with a little rev during the countdown). */
  private updateAudio(): void {
    const levels = this.engineLevels;
    levels.length = 0;
    try {
      const live = this.state === 'playing' || this.state === 'countdown';
      const m = this.match;
      if (this.view) {
        if (live) levels.push(clamp(this.view.engineLevel(), 0, 1));
      } else if (m && live) {
        for (let k = 0; k < m.localSlots.length; k++) {
          const boat = m.boats[m.localSlots[k]];
          levels.push(
            this.state === 'countdown'
              ? 0.18 + 0.08 * Math.sin(m.t * 9)
              : clamp(Math.abs(boat.speed) / topSpeedOf(boat.easyDriving), 0, 1),
          );
        }
      }
    } catch (e) {
      reportError('updateAudio', e);
      levels.length = 0;
    }
    this.sfx.setEngines(levels);
  }

  /** Draw one camera into one split-screen rectangle. */
  private drawViewport(scene: THREE.Scene, camera: THREE.Camera, vp: Viewport): void {
    const r = this.renderer;
    const y = this.height - vp.y - vp.height; // WebGL's origin is bottom-left
    r.setViewport(vp.x, y, vp.width, vp.height);
    r.setScissor(vp.x, y, vp.width, vp.height);
    r.setScissorTest(true);
    r.render(scene, camera);
  }

  /** Draw the scene: full screen (menu, results) or one viewport per human on this screen. */
  private drawFrame(): void {
    const r = this.renderer;
    try {
      r.info.reset();
      r.setScissorTest(false);
      r.clear(); // paints the divider color everywhere; viewports draw over it

      const view = this.view;
      if (view && this.state !== 'menu') {
        // A guest: its view's scene through its own chase camera (or the orbit camera on the results screen).
        r.shadowMap.needsUpdate = true;
        if (this.state === 'results') {
          r.setViewport(0, 0, this.width, this.height);
          r.render(view.scene, this.orbit.camera);
        } else if (this.viewports[0]) {
          this.drawViewport(view.scene, view.camera, this.viewports[0]);
          r.setScissorTest(false);
        }
        return;
      }

      const live = this.state === 'menu' ? this.attract : this.match;
      if (!live) return;
      r.shadowMap.needsUpdate = true; // the first viewport refreshes shadows, the second reuses them

      if (this.state === 'menu' || this.state === 'results') {
        r.setViewport(0, 0, this.width, this.height);
        r.render(live.scene, this.orbit.camera);
        return;
      }
      // Viewport k shows local slot k (offline that is boat k; online it is your own boat).
      const slots = live.localSlots;
      for (let k = 0; k < slots.length; k++) {
        const vp = this.viewports[k];
        const cam = live.cams[slots[k]];
        if (vp && cam) this.drawViewport(live.scene, cam.camera, vp);
      }
      r.setScissorTest(false);
    } catch (e) {
      reportError('render', e);
    }
  }

  // ───────────────────────────── sizing and stats ─────────────────────────────

  /** Match the canvas to the window, and recompute the split-screen rectangles. */
  private layout(): void {
    const w = Math.max(1, this.root.clientWidth || window.innerWidth);
    const h = Math.max(1, this.root.clientHeight || window.innerHeight);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false); // CSS already sizes the canvas to fill #app
    this.viewports = computeViewports(w, h, this.localCount());
    if (this.match) {
      const slots = this.match.localSlots;
      for (let k = 0; k < slots.length; k++) {
        const vp = this.viewports[k];
        const cam = this.match.cams[slots[k]];
        if (vp && cam) cam.setAspect(vp.width / vp.height);
      }
    }
    if (this.view) {
      try {
        this.view.setViewport(this.viewports[0]);
      } catch (e) {
        reportError('view.setViewport', e);
      }
    }
    this.orbit.setAspect(w / h);
    this.syncTouch();
  }

  private trackFps(raw: number): void {
    if (raw <= 0 || raw > 1) return; // ignore hitches and the first frame
    this.fpsFrames++;
    this.fpsTime += raw;
    if (this.fpsTime < 0.5) return;
    this.fps = this.fpsFrames / this.fpsTime;
    this.fpsFrames = 0;
    this.fpsTime = 0;
    if (this.fpsEl) {
      this.fpsEl.textContent = `${Math.round(this.fps)} fps | ${this.renderer.info.render.calls} calls | ${this.pixelRatio}x`;
    }
    // A slow machine? Quietly use fewer pixels (never goes back up, so it cannot flip-flop).
    // Only count while the tab is visible AND focused: a hidden or background tab runs slowly
    // for reasons that have nothing to do with the machine, and must never lower the resolution for good.
    const watching = document.visibilityState === 'visible' && document.hasFocus();
    if (watching && this.state === 'playing' && foam.timeScale <= 1 && this.fps < 40) this.slowSeconds += 0.5;
    else this.slowSeconds = 0;
    if (this.slowSeconds >= 3 && this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.5);
      this.slowSeconds = 0;
      this.layout();
    }
  }

  // ───────────────────────────── debug hooks ─────────────────────────────

  private hookDebug(): void {
    foam.snapshot = () => this.snapshot();
    foam.start = (opts) => this.startMatch({ ...defaultSetup(opts?.mode ?? 'battle'), ...opts });
    foam.menu = () => this.leaveOnline();
    foam.pause = () => this.pause();
    foam.resume = () => this.resume();
    // Online: `__foam.net` is a live read; `__foam.online` skips the menus (a default profile each).
    Object.defineProperty(foam, 'net', { configurable: true, enumerable: true, get: () => this.netInfo() });
    foam.online = {
      host: (name) => this.hostGame({ ...defaultPlayer(0), name: name ?? 'Host' }).then((code) => {
        this.showLobby();
        return code;
      }),
      join: (code, name) => this.joinGame(code, { ...defaultPlayer(1), name: name ?? 'Guest' }).then(() => this.showLobby()),
      start: (opts) => this.startOnlineMatch({ ...defaultSetup(opts?.mode ?? 'battle'), ...opts, online: null }),
      leave: () => this.leaveOnline(),
    };
    (foam as unknown as { app: unknown }).app = this; // console poking only
    foam.bench = (n = 60) => {
      const gl = this.renderer.getContext();
      const px = new Uint8Array(4);
      let stepMs = 0;
      let drawMs = 0;
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        this.fixedStep();
        const t1 = performance.now();
        this.drawFrame();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // wait for the GPU
        drawMs += performance.now() - t1;
        stepMs += t1 - t0;
      }
      return { stepMs: round(stepMs / n, 2), drawMs: round(drawMs / n, 2) };
    };
  }

  private snapshot(): FoamSnapshot {
    const m = this.match;
    const info = this.renderer.info;
    const snap: FoamSnapshot = {
      state: this.state,
      t: m ? round(m.t, 3) : 0,
      fps: round(this.fps, 1),
      mode: m ? m.setup.mode : null,
      boats: [],
      darts: 0,
      hits: m ? m.hits : 0,
      errors: foam.errors.slice(),
      timeLeft: null,
      raceTime: null,
      balloons: null,
      teams: null,
      sharks: null,
      sharkRules: null,
      humans: [],
      fallbacks: foam.fallbacks.slice(),
      touchActive: this.input.touchActive === true,
      muted: this.sfx.muted === true,
      render: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
    };
    if (!m) {
      if (this.view) this.guestSnapshot(snap, this.view);
      return snap;
    }
    try {
      snap.darts = m.darts.activeCount;
      snap.timeLeft = m.mode.timeLeft();
      snap.raceTime = m.mode.raceTime();
      snap.balloons = m.mode.balloonCount();
      snap.teams = m.mode.teams();
      const mega = m.sharks.mega;
      snap.sharks = {
        waveLeft: m.sharks.waveLeft,
        mega: mega ? { health: mega.health, maxHealth: mega.maxHealth } : null,
        count: m.sharks.targets.length,
      };
      snap.sharkRules = m.mode.sharkHud();
      for (const p of m.players) {
        snap.humans.push({
          slot: p.slot,
          hits: p.hits,
          tagsOnOtherHuman: p.tagsOnOtherHuman,
          timesTagged: p.timesTagged,
          balloons: p.balloons,
          boostSeconds: round(p.boostSeconds, 1),
          pickups: p.pickups,
          honks: p.honks,
          rescues: p.rescues,
          sharkTags: p.sharkTags,
          sharkBumps: p.sharkBumps,
        });
      }
      for (const b of m.boats) {
        const race = m.mode.raceInfo(b.id);
        snap.boats.push({
          id: b.id,
          name: b.name,
          x: round(b.position.x, 2),
          z: round(b.position.z, 2),
          heading: round(b.heading, 3),
          speed: round(b.speed, 2),
          score: m.mode.scoreOf(b.id),
          ammo: b.ammo,
          stunned: b.stunned,
          boost: round(b.boost, 2),
          shielded: b.shielded,
          team: b.team,
          easy: b.easyDriving,
          powerUp: b.powerUp ? b.powerUp.kind : null,
          lap: race ? race.lap : null,
          gate: race ? race.checkpoint : null,
          finished: race ? race.finished : null,
        });
      }
    } catch (e) {
      reportError('snapshot', e);
    }
    return snap;
  }

  /**
   * A guest has no Match, so `__foam.snapshot()` describes what this device is DRAWING, taken from its own
   * HUD data: every boat's drawn pose and score, the clock, teams, balloons and the shark rules. (Speed is
   * unknown here, and ammo, boost and the power-up are only known for this player's own boat.)
   */
  private guestSnapshot(snap: FoamSnapshot, view: GuestView): void {
    try {
      const hs = view.hudState(this.viewports[0]);
      snap.mode = hs.mode;
      snap.timeLeft = hs.timeLeft;
      snap.raceTime = hs.raceTime;
      snap.balloons = hs.balloons;
      snap.teams = hs.teams;
      snap.sharkRules = hs.sharks;
      const me = hs.players[0] ?? null;
      for (const b of hs.map.boats) {
        const row = hs.scoreboard.find((r) => r.id === b.id);
        const mine = me && me.boatId === b.id ? me : null;
        snap.boats.push({
          id: b.id,
          name: row?.name ?? '',
          x: round(b.x, 2),
          z: round(b.z, 2),
          heading: round(b.heading, 3),
          speed: 0,
          score: row?.score ?? 0,
          ammo: mine ? mine.ammo : 0,
          stunned: false,
          boost: mine ? round(mine.boost, 2) : 0,
          shielded: mine ? mine.shielded : false,
          team: b.team,
          easy: mine ? mine.easyDriving : false,
          powerUp: mine && mine.powerUp ? mine.powerUp.kind : null,
          lap: mine && mine.race ? mine.race.lap : null,
          gate: mine && mine.race ? mine.race.checkpoint : null,
          finished: mine && mine.race ? mine.race.finished : null,
        });
      }
    } catch (e) {
      reportError('snapshot', e);
    }
  }
}

/** Last-resort message if the game cannot start at all (usually: no WebGL). */
function showFatal(err: unknown): void {
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;padding:24px;text-align:center;color:#fff;font:700 24px system-ui,sans-serif;background:#0b2a3a;z-index:2000';
  const msg = document.createElement('div');
  msg.textContent = 'Foam Fleet could not start. This game needs a browser with WebGL turned on.';
  const detail = document.createElement('div');
  detail.style.cssText = 'font:14px monospace;opacity:.7';
  detail.textContent = err instanceof Error ? err.message : String(err);
  box.append(msg, detail);
  (document.getElementById('app') ?? document.body).appendChild(box);
}

export function bootGame(): void {
  installErrorCapture();
  window.__foam = foam;
  try {
    new FoamApp().start();
  } catch (e) {
    reportError('boot', e);
    showFatal(e);
  }
}
