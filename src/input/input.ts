/**
 * Foam Fleet: keyboard + gamepad input for up to two players.
 *
 * How it fits together (read top to bottom):
 *   1. KEYBOARD   - key events set "held" flags. Two layouts: A (WASD) and B (arrows).
 *   2. GAMEPADS   - every frame `poll()` reads the pads and turns them into plain numbers.
 *   3. SLOTS      - `humanController(slot, humans)` decides which keyboard layout and
 *                   which pad belong to which player, fresh every frame (so you can plug
 *                   in a pad in the middle of a match).
 *   4. MENU       - one-frame "button went down" flags for the menus and pause screen.
 *   5. ASSIST     - for Easy Driving boats the human controller also runs assist.ts
 *                   (auto-cruise and bumper rails) on top of what the player pressed.
 *
 * Buttons:  layout A = W/S/A/D, Space fire, Left Shift boost, R rescue, Q honk.
 *           layout B = arrows, Enter fire, Right Shift boost, / rescue, ' (quote) honk.
 *           pad      = stick/RT/LT drive, A or RB fire, B or LB boost, Y rescue, X honk.
 * Rescue and honk are plain "held" flags; the game core acts on the moment they go down.
 *
 * Steering convention (from types.ts): steer +1 = turn RIGHT. Right on a stick, D, or the
 * Right Arrow is therefore +1.
 */
import type { BoatControls, Controller, ControllerContext, InputManager, MenuInput } from '../types';
import { EasyAssist } from './assist';

// ───────────────────────────── Tunables ─────────────────────────────

/** Keyboard steering takes this long to ramp from 0 to full lock (and back). */
const KEY_STEER_RAMP_SEC = 0.12;
/** Easy Driving boats get a lazier ramp, so a mashed key is a gentle turn instead of a twitch. */
const EASY_STEER_RAMP_SEC = 0.22;
/** Flipping straight from left to right ramps this many times faster, so it feels snappy. */
const KEY_STEER_FLIP_BOOST = 2;
/** Ignore tiny stick wobble; everything past this is rescaled so it still reaches 1. */
const STICK_DEADZONE = 0.15;
const TRIGGER_DEADZONE = 0.05;
/** A stick counts as "pushed" for the purpose of "which device is this player using?" past this. */
const STICK_ACTIVE = 0.5;
/** A stick counts as "pushed" in a menu past ON, and stays pushed until it drops below OFF. */
const STICK_MENU_ON = 0.6;
const STICK_MENU_OFF = 0.35;
/** Held menu direction: first repeat after FIRST ms, then one every REPEAT ms. */
const MENU_REPEAT_FIRST_MS = 400;
const MENU_REPEAT_MS = 250;
/** More pads than this are ignored (the game only ever needs two). */
const MAX_PADS = 4;
/**
 * A key tapped and released between two frames would be missed if we only looked at
 * "is it down right now". We remember a tap for this many polls so it still counts once.
 */
const TAP_LIFE_POLLS = 4;

// ───────────────────────────── Menu button bits ─────────────────────────────

const M_UP = 1;
const M_DOWN = 2;
const M_LEFT = 4;
const M_RIGHT = 8;
const M_CONFIRM = 16;
const M_BACK = 32;
const M_PAUSE = 64;
const M_MUTE = 128;
/** Only directions auto-repeat when a key is held; confirm/back/pause/mute must not. */
const M_DIRECTIONS = M_UP | M_DOWN | M_LEFT | M_RIGHT;
const DIR_BITS: readonly number[] = [M_UP, M_DOWN, M_LEFT, M_RIGHT];

// ───────────────────────────── Keyboard table ─────────────────────────────

/** Which player layout a key belongs to (for "what is this player driving with?"). */
const G_NONE = 0;
const G_A = 1;
const G_B = 2;

/** Every key we care about (KeyboardEvent.code), which menu buttons it presses, and its layout. */
const KEY_TABLE: ReadonlyArray<readonly [code: string, menuBits: number, group: number]> = [
  ['KeyW', M_UP, G_A],
  ['KeyS', M_DOWN, G_A],
  ['KeyA', M_LEFT, G_A],
  ['KeyD', M_RIGHT, G_A],
  ['Space', M_CONFIRM, G_A],
  ['ShiftLeft', 0, G_A],
  ['KeyR', 0, G_A],
  ['KeyQ', 0, G_A],
  ['ArrowUp', M_UP, G_B],
  ['ArrowDown', M_DOWN, G_B],
  ['ArrowLeft', M_LEFT, G_B],
  ['ArrowRight', M_RIGHT, G_B],
  ['Enter', M_CONFIRM, G_B],
  ['ShiftRight', 0, G_B],
  ['Slash', 0, G_B],
  ['Quote', 0, G_B],
  ['NumpadEnter', M_CONFIRM, G_B],
  ['Escape', M_BACK | M_PAUSE, G_NONE],
  ['Backspace', M_BACK, G_NONE],
  ['KeyP', M_PAUSE, G_NONE],
  ['KeyM', M_MUTE, G_NONE],
];

function keyIndex(code: string): number {
  return KEY_TABLE.findIndex((row) => row[0] === code);
}

const K_W = keyIndex('KeyW');
const K_S = keyIndex('KeyS');
const K_A = keyIndex('KeyA');
const K_D = keyIndex('KeyD');
const K_SPACE = keyIndex('Space');
const K_LSHIFT = keyIndex('ShiftLeft');
const K_R = keyIndex('KeyR');
const K_Q = keyIndex('KeyQ');
const K_UP = keyIndex('ArrowUp');
const K_DOWN = keyIndex('ArrowDown');
const K_LEFT = keyIndex('ArrowLeft');
const K_RIGHT = keyIndex('ArrowRight');
const K_ENTER = keyIndex('Enter');
const K_RSHIFT = keyIndex('ShiftRight');
const K_SLASH = keyIndex('Slash');
const K_QUOTE = keyIndex('Quote');
const K_NUMENTER = keyIndex('NumpadEnter');
const K_ESCAPE = keyIndex('Escape');

/** One player's keys, as indexes into KEY_TABLE. `fireAlt` of -1 means "no second fire key". */
interface Scheme {
  up: number;
  down: number;
  left: number;
  right: number;
  fire: number;
  fireAlt: number;
  boost: number;
  rescue: number;
  honk: number;
}

const SCHEME_A: Scheme = { up: K_W, down: K_S, left: K_A, right: K_D, fire: K_SPACE, fireAlt: -1, boost: K_LSHIFT, rescue: K_R, honk: K_Q };
const SCHEME_B: Scheme = {
  up: K_UP,
  down: K_DOWN,
  left: K_LEFT,
  right: K_RIGHT,
  fire: K_ENTER,
  fireAlt: K_NUMENTER,
  boost: K_RSHIFT,
  rescue: K_SLASH,
  honk: K_QUOTE,
};

// ───────────────────────────── Small helpers ─────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Whichever number is further from zero (used to merge keyboard + pad). */
function biggest(a: number, b: number): number {
  return Math.abs(b) > Math.abs(a) ? b : a;
}

/** Zero inside the deadzone, then rescaled so the edge of the deadzone is 0 and full push is 1. */
function deadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  const scaled = (a - dz) / (1 - dz);
  return v < 0 ? -(scaled > 1 ? 1 : scaled) : scaled > 1 ? 1 : scaled;
}

/** Is the focused element something you type words into? Then game keys must leave it alone. */
function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    // Checkboxes, radios, buttons and sliders are not text entry.
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'range' && type !== 'color' && type !== 'file' && type !== 'reset';
  }
  return (el as HTMLElement).isContentEditable === true;
}

// ───────────────────────────── Gamepad reading ─────────────────────────────

/** What one pad is asking for this frame, already cleaned up. */
interface PadSnapshot {
  steer: number;
  throttle: number;
  fire: boolean;
  boost: boolean;
  rescue: boolean;
  honk: boolean;
}

/** Remembers what a pad's menu buttons did last frame so we can spot the moment they go down. */
interface PadMenuMemory {
  buttons: number;
  dirHeld: Uint8Array;
  dirNextAt: Float64Array;
}

/** Standard-mapping button numbers. */
const PAD_A = 0;
const PAD_B = 1;
const PAD_X = 2;
const PAD_Y = 3;
const PAD_LB = 4;
const PAD_RB = 5;
const PAD_LT = 6;
const PAD_RT = 7;
const PAD_BACK = 8;
const PAD_START = 9;
const PAD_DPAD_UP = 12;
const PAD_DPAD_DOWN = 13;
const PAD_DPAD_LEFT = 14;
const PAD_DPAD_RIGHT = 15;

function padButton(gp: Gamepad, i: number): boolean {
  const b = gp.buttons[i];
  return b !== undefined && (b.pressed || b.value > 0.5);
}

/** Analog trigger 0..1 (digital triggers read as 0 or 1). */
function padTrigger(gp: Gamepad, i: number): number {
  const b = gp.buttons[i];
  if (b === undefined) return 0;
  const v = b.pressed && b.value < 0.5 ? 1 : b.value;
  return deadzone(v, TRIGGER_DEADZONE);
}

function padAxis(gp: Gamepad, i: number): number {
  const v = gp.axes[i];
  return v === undefined || Number.isNaN(v) ? 0 : v;
}

/** Is anything on this pad being pressed or pushed right now? (Used to tell which device a player is using.) */
function padTouched(gp: Gamepad, rawX: number, rawY: number): boolean {
  if (Math.abs(rawX) > STICK_ACTIVE || Math.abs(rawY) > STICK_ACTIVE) return true;
  for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i].pressed) return true;
  return false;
}

/** Skip odd devices that show up as "gamepads" (some mice, headsets) but have no real controls. */
function looksLikeGamepad(gp: Gamepad): boolean {
  return gp.connected && gp.buttons.length >= 4 && gp.axes.length >= 2;
}

// ───────────────────────────── The input manager ─────────────────────────────

export function createInput(target: Window): InputManager {
  const doc = target.document;
  const nav = target.navigator;
  const clock = target.performance;

  // ---- keyboard state ----
  const held = new Uint8Array(KEY_TABLE.length); // 1 while a key is down
  const tapped = new Uint8Array(KEY_TABLE.length); // >0 for a few polls after a quick tap
  const keyByCode = new Map<string, number>();
  KEY_TABLE.forEach((row, i) => keyByCode.set(row[0], i));
  let pendingMenu = 0; // menu buttons pressed since the last poll()
  // When each keyboard layout (G_A, G_B) was last touched, for schemeOf(). -1 = never.
  const keyActiveAt = new Float64Array(3).fill(-1);

  // ---- gamepad state (rebuilt every poll) ----
  let padCount = 0;
  const pads: PadSnapshot[] = [];
  const padMemory: PadMenuMemory[] = [];
  for (let i = 0; i < MAX_PADS; i++) {
    pads.push({ steer: 0, throttle: 0, fire: false, boost: false, rescue: false, honk: false });
    padMemory.push({ buttons: 0, dirHeld: new Uint8Array(4), dirNextAt: new Float64Array(4) });
  }
  const padActiveAt = new Float64Array(MAX_PADS).fill(-1); // when each pad was last touched
  const dirAsserted = new Uint8Array(4); // scratch, reused every frame

  // ---- what the game reads ----
  const menu: MenuInput = { up: false, down: false, left: false, right: false, confirm: false, back: false, pause: false, mute: false };
  let disposed = false;

  // ───────────── keyboard events ─────────────

  function clearKeys(): void {
    held.fill(0);
    tapped.fill(0);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (disposed) return;
    const i = keyByCode.get(e.code);
    if (i === undefined) return;
    // Browser shortcuts (Ctrl+R, Alt+Left...) are not for us.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const typing = isTextEntry(doc.activeElement);
    // While typing a name, only Enter and Escape reach the game (as menu buttons).
    if (typing && i !== K_ENTER && i !== K_NUMENTER && i !== K_ESCAPE) return;
    // Stop arrows/space from scrolling the page and Enter/Space from "clicking" a focused button.
    if (!typing) e.preventDefault();

    const bits = KEY_TABLE[i][1];
    // Holding a key makes the OS send repeats: directions may use them, other buttons must not.
    pendingMenu |= e.repeat ? bits & M_DIRECTIONS : bits;

    if (typing) return;
    held[i] = 1;
    if (!e.repeat) tapped[i] = TAP_LIFE_POLLS;
    const group = KEY_TABLE[i][2];
    if (group !== G_NONE) keyActiveAt[group] = clock.now();
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (disposed) return;
    const i = keyByCode.get(e.code);
    if (i === undefined) return;
    // Always let go, even while typing, so a key can never get "stuck down".
    held[i] = 0;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !isTextEntry(doc.activeElement)) e.preventDefault();
  }

  function onBlur(): void {
    clearKeys();
  }

  function onVisibility(): void {
    if (doc.visibilityState === 'hidden') clearKeys();
  }

  // Capture phase so nothing else on the page can swallow our keys first.
  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('keyup', onKeyUp, true);
  target.addEventListener('blur', onBlur);

  doc.addEventListener('visibilitychange', onVisibility);

  /** Is this key down right now (or tapped since last time)? Reading a tap uses it up. */
  function keyDown(i: number): boolean {
    if (i < 0) return false;
    const yes = held[i] === 1 || tapped[i] > 0;
    tapped[i] = 0;
    return yes;
  }

  function keyAxis(positive: number, negative: number): number {
    return (keyDown(positive) ? 1 : 0) - (keyDown(negative) ? 1 : 0);
  }

  // ───────────── gamepads ─────────────

  function getPadList(): ArrayLike<Gamepad | null> | null {
    try {
      return typeof nav.getGamepads === 'function' ? nav.getGamepads() : null;
    } catch {
      return null; // insecure page or blocked by the browser: just no pads
    }
  }

  /** Read one pad into pads[n] and return the menu buttons that went down on it this frame. */
  function readPad(gp: Gamepad, n: number, now: number): number {
    const snap = pads[n];
    const mem = padMemory[n];
    const rawX = padAxis(gp, 0);
    const rawY = padAxis(gp, 1);

    // --- driving ---
    // Squared response: gentle near the center for fine control, still full lock at the edge.
    // (The d-pad is digital, so it skips the curve and always means full lock.)
    let steer = deadzone(rawX, STICK_DEADZONE);
    steer *= Math.abs(steer);
    const dpadSteer = (padButton(gp, PAD_DPAD_RIGHT) ? 1 : 0) - (padButton(gp, PAD_DPAD_LEFT) ? 1 : 0);
    steer = biggest(steer, dpadSteer);

    // RT = gas, LT = reverse. A pad without triggers uses the stick: up = go.
    let throttle = padTrigger(gp, PAD_RT) - padTrigger(gp, PAD_LT);
    if (throttle === 0 && (gp.buttons.length < 8 || gp.mapping !== 'standard')) {
      throttle = -deadzone(rawY, STICK_DEADZONE);
    }
    snap.steer = steer;
    snap.throttle = clamp(throttle, -1, 1);
    snap.fire = padButton(gp, PAD_A) || padButton(gp, PAD_RB);
    snap.boost = padButton(gp, PAD_B) || padButton(gp, PAD_LB);
    snap.rescue = padButton(gp, PAD_Y);
    snap.honk = padButton(gp, PAD_X);
    if (padTouched(gp, rawX, rawY)) padActiveAt[n] = now;

    // --- menus: A/B/Start/Back fire once per press ---
    let bits = 0;
    const nowButtons =
      (padButton(gp, PAD_A) ? M_CONFIRM : 0) |
      (padButton(gp, PAD_B) ? M_BACK : 0) |
      (padButton(gp, PAD_START) ? M_PAUSE : 0) |
      (padButton(gp, PAD_BACK) ? M_MUTE : 0);
    bits |= nowButtons & ~mem.buttons;
    mem.buttons = nowButtons;

    // --- menus: d-pad + stick directions, with auto-repeat while held ---
    // The stick only counts along its stronger axis, so a diagonal doesn't press two buttons.
    const horizontal = Math.abs(rawX) >= Math.abs(rawY);
    for (let d = 0; d < 4; d++) {
      const threshold = mem.dirHeld[d] === 1 ? STICK_MENU_OFF : STICK_MENU_ON;
      let on = false;
      if (d === 0) on = padButton(gp, PAD_DPAD_UP) || (!horizontal && rawY < -threshold);
      else if (d === 1) on = padButton(gp, PAD_DPAD_DOWN) || (!horizontal && rawY > threshold);
      else if (d === 2) on = padButton(gp, PAD_DPAD_LEFT) || (horizontal && rawX < -threshold);
      else on = padButton(gp, PAD_DPAD_RIGHT) || (horizontal && rawX > threshold);
      dirAsserted[d] = on ? 1 : 0;
    }
    for (let d = 0; d < 4; d++) {
      if (dirAsserted[d] === 0) {
        mem.dirHeld[d] = 0;
      } else if (mem.dirHeld[d] === 0) {
        mem.dirHeld[d] = 1;
        mem.dirNextAt[d] = now + MENU_REPEAT_FIRST_MS;
        bits |= DIR_BITS[d];
      } else if (now >= mem.dirNextAt[d]) {
        mem.dirNextAt[d] = now + MENU_REPEAT_MS;
        bits |= DIR_BITS[d];
      }
    }
    return bits;
  }

  function resetPadSlot(n: number): void {
    const snap = pads[n];
    snap.steer = 0;
    snap.throttle = 0;
    snap.fire = false;
    snap.boost = false;
    snap.rescue = false;
    snap.honk = false;
    padActiveAt[n] = -1;
    const mem = padMemory[n];
    mem.buttons = 0;
    mem.dirHeld.fill(0);
  }

  /** Reads every connected pad. Returns the menu buttons that went down on any of them. */
  function readPads(now: number): number {
    const list = getPadList();
    let bits = 0;
    let count = 0;
    if (list) {
      for (let i = 0; i < list.length && count < MAX_PADS; i++) {
        const gp = list[i];
        if (!gp || !looksLikeGamepad(gp)) continue;
        bits |= readPad(gp, count, now);
        count++;
      }
    }
    for (let n = count; n < MAX_PADS; n++) resetPadSlot(n);
    padCount = count;
    return bits;
  }

  // ───────────── slot assignment ─────────────

  /** Which devices does a player use? Filled by resolveSlot(). */
  interface Assignment {
    useA: boolean;
    useB: boolean;
    /** Pads padFrom .. padTo-1 (in connection order) belong to this player. */
    padFrom: number;
    padTo: number;
  }

  /**
   * The rules from the spec, in one place:
   *  - 1 player: keyboard A + keyboard B + every pad, merged.
   *  - 2 players, no pads: slot 0 = A, slot 1 = B.
   *  - 2 players, 1 pad:   slot 0 = A, slot 1 = B + pad 0.
   *  - 2 players, 2+ pads: slot 0 = A + pad 0, slot 1 = B + pad 1.
   */
  function resolveSlot(slot: 0 | 1, humans: 1 | 2, available: number, out: Assignment): void {
    if (humans === 1) {
      out.useA = true;
      out.useB = true;
      out.padFrom = 0;
      out.padTo = available;
      return;
    }
    out.useA = slot === 0;
    out.useB = slot === 1;
    out.padFrom = 0;
    out.padTo = 0;
    if (available >= 2) {
      out.padFrom = slot;
      out.padTo = slot + 1;
    } else if (available === 1 && slot === 1) {
      out.padFrom = 0;
      out.padTo = 1;
    }
  }

  const controllers: Controller[] = [];
  function makeHumanController(slot: 0 | 1, humans: 1 | 2): Controller {
    const out: BoatControls = { throttle: 0, steer: 0, fire: false, boost: false, rescue: false, honk: false };
    const asg: Assignment = { useA: false, useB: false, padFrom: 0, padTo: 0 };
    const assist = new EasyAssist();
    let rampA = 0; // smoothed keyboard steer per layout
    let rampB = 0;

    /** Move `current` toward the key target, taking `seconds` for a full swing from 0 to lock. */
    function ramp(current: number, wanted: number, dt: number, seconds: number): number {
      let rate = 1 / seconds;
      if (wanted * current < 0) rate *= KEY_STEER_FLIP_BOOST;
      const step = rate * dt;
      if (wanted > current) return Math.min(wanted, current + step);
      return Math.max(wanted, current - step);
    }

    return {
      kind: 'human',
      update(ctx: ControllerContext, dt: number): BoatControls {
        resolveSlot(slot, humans, padCount, asg);
        const easy = ctx.self.easyDriving;
        const rampSec = easy ? EASY_STEER_RAMP_SEC : KEY_STEER_RAMP_SEC;
        let steer = 0;
        let throttle = 0;
        let fire = false;
        let boost = false;
        let rescue = false;
        let honk = false;

        if (asg.useA) {
          rampA = ramp(rampA, keyAxis(SCHEME_A.right, SCHEME_A.left), dt, rampSec);
          steer = biggest(steer, rampA);
          throttle = biggest(throttle, keyAxis(SCHEME_A.up, SCHEME_A.down));
          fire = fire || keyDown(SCHEME_A.fire);
          boost = boost || keyDown(SCHEME_A.boost);
          rescue = rescue || keyDown(SCHEME_A.rescue);
          honk = honk || keyDown(SCHEME_A.honk);
        } else {
          rampA = 0;
        }
        if (asg.useB) {
          rampB = ramp(rampB, keyAxis(SCHEME_B.right, SCHEME_B.left), dt, rampSec);
          steer = biggest(steer, rampB);
          throttle = biggest(throttle, keyAxis(SCHEME_B.up, SCHEME_B.down));
          fire = fire || keyDown(SCHEME_B.fire) || keyDown(SCHEME_B.fireAlt);
          boost = boost || keyDown(SCHEME_B.boost);
          rescue = rescue || keyDown(SCHEME_B.rescue);
          honk = honk || keyDown(SCHEME_B.honk);
        } else {
          rampB = 0;
        }
        for (let n = asg.padFrom; n < asg.padTo; n++) {
          const p = pads[n];
          steer = biggest(steer, p.steer);
          throttle = biggest(throttle, p.throttle);
          fire = fire || p.fire;
          boost = boost || p.boost;
          rescue = rescue || p.rescue;
          honk = honk || p.honk;
        }

        steer = clamp(steer, -1, 1);
        throttle = clamp(throttle, -1, 1);
        if (easy) {
          // Auto-cruise + bumper rails sit on top of whatever the player asked for.
          assist.update(ctx.self, ctx.world, steer, throttle, dt);
          steer = assist.steer;
          throttle = assist.throttle;
          if (assist.braking) boost = false; // no rocket start right at a shoreline
        } else {
          assist.reset();
        }

        out.steer = steer;
        out.throttle = throttle;
        out.fire = fire;
        out.boost = boost;
        out.rescue = rescue;
        out.honk = honk;
        return out;
      },
    };
  }

  // ───────────── rumble ─────────────

  /** Older Firefox/Safari expose rumble as `hapticActuators` with a `pulse` method. */
  interface LegacyHaptics {
    hapticActuators?: ReadonlyArray<{ pulse?: (value: number, durationMs: number) => Promise<boolean> }>;
  }

  function rumblePad(gp: Gamepad, strength: number, ms: number): void {
    try {
      const actuator = gp.vibrationActuator;
      if (actuator && typeof actuator.playEffect === 'function') {
        const result = actuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration: ms,
          weakMagnitude: strength * 0.7,
          strongMagnitude: strength,
        });
        Promise.resolve(result).catch(() => undefined);
        return;
      }
      const legacy = (gp as unknown as LegacyHaptics).hapticActuators;
      const pulse = legacy?.[0]?.pulse;
      if (typeof pulse === 'function') {
        Promise.resolve(pulse.call(legacy?.[0], strength, ms)).catch(() => undefined);
      }
    } catch {
      // Rumble is a bonus; never let it break the game.
    }
  }

  // ───────────── the public object ─────────────

  const rumbleAsg: Assignment = { useA: false, useB: false, padFrom: 0, padTo: 0 };
  const schemeAsg: Assignment = { useA: false, useB: false, padFrom: 0, padTo: 0 };

  return {
    menu,

    poll(): void {
      if (disposed) return;
      const bits = pendingMenu | readPads(clock.now());
      pendingMenu = 0;
      menu.up = (bits & M_UP) !== 0;
      menu.down = (bits & M_DOWN) !== 0;
      menu.left = (bits & M_LEFT) !== 0;
      menu.right = (bits & M_RIGHT) !== 0;
      menu.confirm = (bits & M_CONFIRM) !== 0;
      menu.back = (bits & M_BACK) !== 0;
      menu.pause = (bits & M_PAUSE) !== 0;
      menu.mute = (bits & M_MUTE) !== 0;
      // Age out quick taps nobody picked up (e.g. Space pressed on a menu button).
      for (let i = 0; i < tapped.length; i++) if (tapped[i] > 0) tapped[i]--;
    },

    humanController(slot: 0 | 1, humans: 1 | 2): Controller {
      // One controller object per (slot, humans) pair, reused forever, so the game can call
      // this every frame without allocating. Devices are re-resolved inside update().
      const key = slot * 2 + (humans - 1);
      let c = controllers[key];
      if (!c) {
        c = makeHumanController(slot, humans);
        controllers[key] = c;
      }
      return c;
    },

    schemeOf(slot: 0 | 1, humans: 1 | 2): 'keysA' | 'keysB' | 'gamepad' {
      // Whichever device this player touched most recently, out of the ones they own right now.
      resolveSlot(slot, humans, padCount, schemeAsg);
      let bestAt = -1;
      let best: 'keysA' | 'keysB' | 'gamepad' | null = null;
      if (schemeAsg.useA && keyActiveAt[G_A] > bestAt) {
        bestAt = keyActiveAt[G_A];
        best = 'keysA';
      }
      if (schemeAsg.useB && keyActiveAt[G_B] > bestAt) {
        bestAt = keyActiveAt[G_B];
        best = 'keysB';
      }
      for (let n = schemeAsg.padFrom; n < schemeAsg.padTo; n++) {
        if (padActiveAt[n] > bestAt) {
          bestAt = padActiveAt[n];
          best = 'gamepad';
        }
      }
      if (best !== null) return best;
      // Nothing touched yet. Browsers only show a pad after a button press, so a pad that is
      // here is a pad somebody is holding; otherwise fall back to this slot's keyboard layout.
      if (schemeAsg.padTo > schemeAsg.padFrom) return 'gamepad';
      return schemeAsg.useB && !schemeAsg.useA ? 'keysB' : 'keysA';
    },

    gamepadCount(): number {
      return padCount;
    },

    rumble(slot: 0 | 1, humans: 1 | 2, strength: number, ms: number): void {
      if (disposed) return;
      const list = getPadList();
      if (!list) return;
      const s = clamp(strength, 0, 1);
      const duration = clamp(ms, 0, 2000);
      if (s <= 0 || duration <= 0) return;
      // Count the pads right now (rumble is rare, so a fresh look is fine) and use the same
      // slot rules as driving, so the right pad buzzes.
      let available = 0;
      for (let i = 0; i < list.length && available < MAX_PADS; i++) {
        const gp = list[i];
        if (gp && looksLikeGamepad(gp)) available++;
      }
      resolveSlot(slot, humans, available, rumbleAsg);
      let n = 0;
      for (let i = 0; i < list.length && n < MAX_PADS; i++) {
        const gp = list[i];
        if (!gp || !looksLikeGamepad(gp)) continue;
        if (n >= rumbleAsg.padFrom && n < rumbleAsg.padTo) rumblePad(gp, s, duration);
        n++;
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      target.removeEventListener('keydown', onKeyDown, true);
      target.removeEventListener('keyup', onKeyUp, true);
      target.removeEventListener('blur', onBlur);

      doc.removeEventListener('visibilitychange', onVisibility);
      clearKeys();
      pendingMenu = 0;
      padCount = 0;
      keyActiveAt.fill(-1);
      padActiveAt.fill(-1);
      controllers.length = 0;
      menu.up = menu.down = menu.left = menu.right = false;
      menu.confirm = menu.back = menu.pause = menu.mute = false;
    },
  };
}
