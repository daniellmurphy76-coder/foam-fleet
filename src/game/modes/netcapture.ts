/**
 * Online host: turn everything the match says out loud into events for the guests.
 *
 * The host's Match makes sounds, effects, announcements and feed lines the usual way. In an online match its hud,
 * sfx and fx are these thin wrappers: each call still plays on this device (for the players who sit here) and is
 * also written down as a NetEvent, so the guests can play the same thing on their own devices.
 *
 * Darts and sharks are NOT given the wrapped fx. Their own splashes and bursts are played again by the guest's own
 * DartSystem and Sharks (from the stick/deflect/kill events and the shark snapshots), so sending them as fx events
 * would play them twice.
 */
import type * as THREE from 'three';
import type { Boat, Effects, Hud, HudState, HornId, MatchResult, MenuInput, Sfx, WorldQuery } from '../../types';
import type { NetEvent } from '../../net/protocol';

/** A guest skips a sound that came from more than this far from its own boat (DESIGN.md: 70 m). */
const HEAR_RANGE = 70;
/** Never keep more than this many unsent events (nothing is draining them: a bug, not a game). */
const MAX_BUFFERED = 4000;

const NO_EVENTS: readonly NetEvent[] = [];
const NO_ARGS: (number | string)[] = [];

/** What the wrappers need to know about the match they belong to. */
export interface TapSite {
  /** The viewport of human `slot` on this device, or -1 when that player sits at another device. */
  viewportOf(slot: number): number;
  /** Is a boat played on THIS device within `range` meters of (x, z)? */
  nearLocal(x: number, z: number, range: number): boolean;
}

/** The events written down since the host last asked for them. */
export class EventTap {
  private list: NetEvent[] = [];

  push(e: NetEvent): void {
    if (this.list.length < MAX_BUFFERED) this.list.push(e);
  }

  /** Everything since the last call, oldest first. Do not change the returned array. */
  take(): readonly NetEvent[] {
    if (this.list.length === 0) return NO_EVENTS;
    const out = this.list;
    this.list = [];
    return out;
  }
}

// ───────────────────────────── sound ─────────────────────────────

/**
 * Sound. A sound with a place (`from(x, z).fire()`) is played here only if a boat on this device is within earshot,
 * and is sent with its place so each guest can do the same. A sound without one plays everywhere.
 */
export class TapSfx implements Sfx {
  private aimed = false;
  private ax = 0;
  private az = 0;

  constructor(private readonly raw: Sfx, private readonly tap: EventTap, private readonly site: TapSite) {}

  /** Aim the NEXT sound at a spot in the lagoon (that sound uses it up). */
  from(x: number, z: number): Sfx {
    this.aimed = true;
    this.ax = x;
    this.az = z;
    return this;
  }

  /**
   * Write the sound down for the guests, use up the aim, and say whether THIS device should play it too (a sound
   * with a place only if a boat here is within earshot).
   */
  private play(m: string, a: (number | string)[] = NO_ARGS): boolean {
    const here = !this.aimed || this.site.nearLocal(this.ax, this.az, HEAR_RANGE);
    this.tap.push(this.aimed ? { k: 'sfx', m, a, at: [this.ax, this.az] } : { k: 'sfx', m, a });
    this.aimed = false;
    return here;
  }

  fire(): void { if (this.play('fire')) this.raw.fire(); }
  hit(): void { if (this.play('hit')) this.raw.hit(); }
  shieldBlock(): void { if (this.play('shieldBlock')) this.raw.shieldBlock(); }
  splash(volume?: number): void {
    if (this.play('splash', volume === undefined ? NO_ARGS : [volume])) this.raw.splash(volume);
  }
  bump(strength: number): void { if (this.play('bump', [strength])) this.raw.bump(strength); }
  pickup(): void { if (this.play('pickup')) this.raw.pickup(); }
  boost(): void { if (this.play('boost')) this.raw.boost(); }
  checkpoint(): void { if (this.play('checkpoint')) this.raw.checkpoint(); }
  lap(): void { if (this.play('lap')) this.raw.lap(); }
  countdown(n: number): void { if (this.play('countdown', [n])) this.raw.countdown(n); }
  go(): void { if (this.play('go')) this.raw.go(); }
  victory(): void { if (this.play('victory')) this.raw.victory(); }
  pop(): void { if (this.play('pop')) this.raw.pop(); }
  honk(horn: HornId): void { if (this.play('honk', [horn])) this.raw.honk(horn); }
  rescue(): void { if (this.play('rescue')) this.raw.rescue(); }
  sharkBump(): void { if (this.play('sharkBump')) this.raw.sharkBump(); }
  sharkDive(): void { if (this.play('sharkDive')) this.raw.sharkDive(); }
  waveStart(): void { if (this.play('waveStart')) this.raw.waveStart(); }
  megaRoar(): void { if (this.play('megaRoar')) this.raw.megaRoar(); }
  defeat(): void { if (this.play('defeat')) this.raw.defeat(); }

  // This device only: its own trophy fanfare and menu clicks, the engine hum and the music switches.
  trophy(): void { this.raw.trophy(); }
  uiMove(): void { this.raw.uiMove(); }
  uiSelect(): void { this.raw.uiSelect(); }
  unlock(): void { this.raw.unlock(); }
  setEngines(levels: number[]): void { this.raw.setEngines(levels); }
  setMusic(on: boolean): void { this.raw.setMusic(on); }
  setMuted(muted: boolean): void { this.raw.setMuted(muted); }
  get muted(): boolean { return this.raw.muted; }
}

// ───────────────────────────── effects ─────────────────────────────

/** Effects the match itself makes (splashes, sparkles, balloon confetti...). Wake, update and cleanup are not events. */
export class TapFx implements Effects {
  constructor(private readonly raw: Effects, private readonly tap: EventTap) {}

  splash(p: THREE.Vector3, size: number): void {
    this.raw.splash(p, size);
    this.tap.push({ k: 'fx', m: 'splash', p: [p.x, p.y, p.z], a: size });
  }

  hitBurst(p: THREE.Vector3, color: number): void {
    this.raw.hitBurst(p, color);
    this.tap.push({ k: 'fx', m: 'hitBurst', p: [p.x, p.y, p.z], a: color });
  }

  sparkle(p: THREE.Vector3, color: number): void {
    this.raw.sparkle(p, color);
    this.tap.push({ k: 'fx', m: 'sparkle', p: [p.x, p.y, p.z], a: color });
  }

  bubbles(p: THREE.Vector3): void {
    this.raw.bubbles(p);
    this.tap.push({ k: 'fx', m: 'bubbles', p: [p.x, p.y, p.z] });
  }

  pop(p: THREE.Vector3, color: number): void {
    this.raw.pop(p, color);
    this.tap.push({ k: 'fx', m: 'pop', p: [p.x, p.y, p.z], a: color });
  }

  notes(p: THREE.Vector3, color: number): void {
    this.raw.notes(p, color);
    this.tap.push({ k: 'fx', m: 'notes', p: [p.x, p.y, p.z], a: color });
  }

  wake(boat: Boat): void { this.raw.wake(boat); }
  update(dt: number, t: number, world: WorldQuery): void { this.raw.update(dt, t, world); }
  clear(): void { this.raw.clear(); }
  dispose(): void { this.raw.dispose(); }
}

// ───────────────────────────── HUD ─────────────────────────────

/**
 * The HUD, from the match's point of view. Everything the match addresses to a player ("viewport" arguments) is
 * given as a HUMAN SLOT: if that player is on this device it goes to their viewport, if not it becomes an event
 * for their device. Feed lines and announcements for everybody do both.
 */
export class TapHud implements Hud {
  constructor(private readonly raw: Hud, private readonly tap: EventTap, private readonly site: TapSite) {}

  announce(text: string, opts?: { sub?: string; ms?: number; viewport?: number }): void {
    const slot = opts?.viewport;
    if (slot === undefined) {
      this.raw.announce(text, opts);
      this.tap.push(announcement(text, opts));
      return;
    }
    const vp = this.site.viewportOf(slot);
    if (vp >= 0) {
      this.raw.announce(text, vp === slot ? opts : { sub: opts?.sub, ms: opts?.ms, viewport: vp });
    } else if (slot >= 0) {
      const e = announcement(text, opts);
      e.to = slot;
      this.tap.push(e);
    }
  }

  hint(text: string, slot: number, ms?: number): void {
    const vp = this.site.viewportOf(slot);
    if (vp >= 0) this.raw.hint(text, vp, ms);
  }

  feed(text: string, color?: number): void {
    this.raw.feed(text, color);
    this.tap.push(color === undefined ? { k: 'feed', text } : { k: 'feed', text, color });
  }

  show(): void { this.raw.show(); }
  hide(): void { this.raw.hide(); }
  update(state: HudState): void { this.raw.update(state); }
  showPause(onResume: () => void, onQuit: () => void, opts?: { title?: string; resumeLabel?: string; quitLabel?: string }): void {
    this.raw.showPause(onResume, onQuit, opts);
  }
  hidePause(): void { this.raw.hidePause(); }
  showResults(
    result: MatchResult,
    onRematch: (() => void) | null,
    onMenu: () => void,
    opts?: { waiting?: string; menuLabel?: string; lost?: boolean },
  ): void {
    this.raw.showResults(result, onRematch, onMenu, opts);
  }
  setNetStatus(text: string | null): void { this.raw.setNetStatus(text); }
  hideResults(): void { this.raw.hideResults(); }
  handleMenuInput(input: MenuInput): void { this.raw.handleMenuInput(input); }
}

/** An announce event with only the fields that were given (the wire format has no `undefined`). */
function announcement(text: string, opts?: { sub?: string; ms?: number }): Extract<NetEvent, { k: 'announce' }> {
  const e: Extract<NetEvent, { k: 'announce' }> = { k: 'announce', text };
  if (opts?.sub !== undefined) e.sub = opts.sub;
  if (opts?.ms !== undefined) e.ms = opts.ms;
  return e;
}
