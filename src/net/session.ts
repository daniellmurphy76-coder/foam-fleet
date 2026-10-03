/**
 * The two sides of an online game, as the app (src/game/app.ts) sees them.
 *
 *  - HostSession (src/net/host.ts): owns the room, the lobby, the remote players' controllers, and turns the
 *    host's Match into snapshots + events for every guest.
 *  - GuestSession (src/net/guest.ts): talks to the host and builds a GuestView, a render-only copy of the
 *    match that shows the host's game and sends this device's controls.
 */
import type * as THREE from 'three';
import type { Match, MatchServices } from '../game/match';
import type { HudState, LobbyState, MatchResult, MatchSetup, PlayerSetup, Viewport } from '../types';
import type { NetAppState, NetEvent } from './protocol';

export interface HostSession {
  readonly role: 'host';
  readonly code: string;
  /** Current lobby (players: slot 0 = the host, then guests in join order). */
  readonly lobby: LobbyState;
  /** Called whenever the lobby changes (join, leave, profile change, settings). */
  onLobby: ((lobby: LobbyState) => void) | null;
  /** A guest dropped out mid-match (the app shows a feed line; their boat just stops). */
  onPlayerLeft: ((name: string) => void) | null;
  /** The host's own profile changed in the lobby (name, color, boat, Easy Driving). */
  setProfile(profile: PlayerSetup): void;
  /** The host picked game settings in the lobby (mirrored to guests). */
  setSettings(setup: MatchSetup): void;
  /** Build the online MatchSetup from the host's settings + the lobby players (online.localSlot = 0). */
  buildSetup(settings: MatchSetup): MatchSetup;
  /**
   * The app created an online Match from buildSetup() (first start or a rematch). The session plugs in the
   * remote players' controllers and event capture (see Match's net hooks) and tells every guest to start.
   */
  beginMatch(match: Match): void;
  /** After every fixed step of the online match: snapshot every SNAPSHOT_EVERY_STEPS steps, flush events. */
  afterStep(match: Match): void;
  /** Mirror the app's state to every guest. */
  setState(state: NetAppState): void;
  /** The match ended: send each guest the result and its own stats. */
  sendResults(match: Match): void;
  /** App-level happenings outside the Match (countdown "3, 2, 1, GO!", results sounds) for every guest. */
  emit(event: NetEvent): void;
  /** Close the room (guests are told the host left). */
  close(): void;
}

export interface GuestSession {
  readonly role: 'guest';
  readonly code: string;
  /** This device's player slot = its boat id. */
  readonly slot: number;
  readonly lobby: LobbyState;
  onLobby: ((lobby: LobbyState) => void) | null;
  /** The host started (or restarted) a match: build a GuestView with createView(setup). */
  onStart: ((setup: MatchSetup) => void) | null;
  onState: ((state: NetAppState) => void) | null;
  /**
   * The match ended. The session has already awarded THIS device's trophies from its own stats and put
   * them in result.awards. Show it with hud.showResults(result, null, leave, {waiting, menuLabel}).
   */
  onResults: ((result: MatchResult, winnerId: number, lost: boolean) => void) | null;
  /** The connection ended (host left / network gone): kid-friendly reason. */
  onClosed: ((reason: string) => void) | null;
  /** This player changed name/color/boat/Easy Driving in the lobby. */
  setProfile(profile: PlayerSetup): void;
  /** Build the render-only view for the match the host just started. */
  createView(setup: MatchSetup, services: MatchServices): GuestView;
  close(): void;
}

/** A render-only copy of the host's match on a guest device. */
export interface GuestView {
  readonly scene: THREE.Scene;
  /** This player's chase camera. */
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Every rendered frame: read this device's controls and send them (CONTROLS_HZ), apply events, place every
   * boat/shark/crate/balloon from the snapshots (interpolated; own boat extrapolated), animate water, fx and
   * darts, and move the chase camera.
   */
  update(dt: number): void;
  /** Viewport size changed (camera aspect). */
  setViewport(vp: Viewport): void;
  /** HUD for this device's one player (players = [you], viewports = [vp]). */
  hudState(vp: Viewport): HudState;
  /** 0..1 engine level for this player's boat (sfx.setEngines). */
  engineLevel(): number;
  /** The 3D object of boat `id` (results orbit camera), or null. */
  boatObject(id: number): THREE.Object3D | null;
  dispose(): void;
}
