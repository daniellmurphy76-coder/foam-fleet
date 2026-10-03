/**
 * Foam Fleet: on-screen touch controls for the iPad.
 *
 * How it fits together (read top to bottom):
 *   1. AVAILABLE? - a touch device (or `?touch=1`) gets controls; anything else gets an inert object and
 *                   nothing is added to the page, so desktop play is untouched.
 *   2. THE OVERLAY - one `div.ff-touchui` inside #app: per player zone a floating stick (outer half) and
 *                   FIRE / BOOST / HONK / RESCUE buttons (inner bottom corner), plus Pause top-left.
 *   3. FINGERS    - window-level pointer events, routed to whichever control the finger landed on. Many
 *                   fingers at once; each finger owns at most one control; a finger that goes away for ANY
 *                   reason (up, cancel, lost capture, blur, tab hidden, controls hidden) lets go of it.
 *   4. SAMPLING   - input.ts calls `sample(slot)` once per controller update and merges the answer in like
 *                   one more keyboard layout (biggest axis wins, buttons OR together).
 *
 * "Active" means the last thing the player used was a finger. The first touch turns it on, a key press or
 * pad button turns it off again (input.ts calls `deactivate()`). While active, <html> has the class
 * `ff-touch` so the HUD and menus can move out of the thumbs' way.
 *
 * Steering convention (types.ts): steer +1 = turn RIGHT. Stick right = +1, stick up = throttle +1.
 */
import type { Viewport } from '../types';

// ───────────────────────────── Tunables ─────────────────────────────

/** Floating stick: how far (CSS px) the knob can travel from the middle of its base. */
const STICK_RADIUS = 64;
/** The stick reads full push at this fraction of its travel, so nobody has to stretch for full lock. */
const STICK_FULL = 0.9;
const STICK_DEADZONE = 0.12;
/** Pulling DOWN has to go further to count as brake/reverse, so a thumb that drifts down never stops the boat. */
const BRAKE_DEADZONE = 0.3;
/** Steering response: above 1 is gentler near the middle and still reaches full lock at the edge. */
const STEER_CURVE = 1.4;
/**
 * A tap that goes down and up between two frames would be missed if we only looked at "is it down right
 * now". We remember a tap for this many polls so it still counts once (same trick as the keyboard).
 */
const TAP_LIFE_POLLS = 4;
/** Where the stick waits when nobody is touching it: this far in from its outer edge, and up from the bottom. */
const STICK_REST_X = 150;
const STICK_REST_Y = 140;
/** Gap between the button cluster and the corner of its zone. */
const BUTTON_MARGIN = 10;
/** Pause button: visible size, gap to the screen corner, and how much bigger the touchable area is. */
const PAUSE_SIZE = 48;
const PAUSE_MARGIN = 12;
const PAUSE_HIT_PAD = 6;
/** A rect counts as touching a screen edge when it is this close (CSS px). */
const EDGE_EPS = 2;

// ───────────────────────────── Buttons ─────────────────────────────

type ButtonKind = 'fire' | 'boost' | 'honk' | 'rescue';

interface ButtonSpec {
  kind: ButtonKind;
  label: string;
  /** Inline SVG icon; it paints with the button's ink color. */
  icon: string;
  /** Visible diameter and touchable radius at full size (CSS px). */
  face: number;
  hit: number;
  /** Where its middle sits: `u` px in from the zone's inner edge, `v` px up from the bottom (full size). */
  u: number;
  v: number;
  color: string;
  dark: string;
  ink: string;
}

const ICON_FIRE =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"><circle cx="12" cy="12" r="7" fill="none" stroke-width="2.4"/>' +
  '<circle cx="12" cy="12" r="2.4" stroke="none"/><path d="M12 2.5v4.5M12 17v4.5M2.5 12H7M17 12h4.5" fill="none" stroke-width="2.4" stroke-linecap="round"/></svg>';
const ICON_BOOST =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"><path d="M13.5 2 4.5 13.5h6L9.5 22l9-11.5h-6z" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const ICON_HONK =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"><path d="M3 10v4h3.5l5.5 4V6L6.5 10z" stroke-width="1.2" stroke-linejoin="round"/>' +
  '<path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.6a8 8 0 0 1 0 10.8" fill="none" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_RESCUE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="8.6" stroke-width="3.2"/><circle cx="12" cy="12" r="3.4" stroke-width="2"/>' +
  '<path d="M5.8 5.8l3.8 3.8M18.2 5.8l-3.8 3.8M5.8 18.2l3.8-3.8M18.2 18.2l-3.8-3.8" stroke-width="2.6" stroke-linecap="round"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5.5" y="4" width="5" height="16" rx="1.4"/><rect x="13.5" y="4" width="5" height="16" rx="1.4"/></svg>';

/**
 * The cluster, hugging the inner bottom corner (mirrored for the right-hand player). Hit circles are
 * generous and do not overlap each other. FIRE sits where the thumb rests; BOOST is a short slide away.
 */
const BUTTONS: readonly ButtonSpec[] = [
  { kind: 'fire', label: 'FIRE', icon: ICON_FIRE, face: 104, hit: 64, u: 78, v: 78, color: '#ff8a1f', dark: '#b34d00', ink: '#06173d' },
  { kind: 'boost', label: 'BOOST', icon: ICON_BOOST, face: 80, hit: 48, u: 196, v: 62, color: '#ffd23f', dark: '#b38600', ink: '#06173d' },
  { kind: 'honk', label: 'HONK', icon: ICON_HONK, face: 56, hit: 34, u: 78, v: 180, color: '#e9f6ff', dark: '#6f93ad', ink: '#06173d' },
  { kind: 'rescue', label: 'RESCUE', icon: ICON_RESCUE, face: 56, hit: 34, u: 196, v: 148, color: '#d9261c', dark: '#7d130d', ink: '#ffffff' },
];

// ───────────────────────────── Public shape ─────────────────────────────

/** What one player's fingers are asking for this frame. The same object is reused every call. */
export interface TouchSample {
  steer: number;
  throttle: number;
  fire: boolean;
  boost: boolean;
  rescue: boolean;
  honk: boolean;
}

export interface TouchControls {
  /** True while fingers are the thing in use (drives `InputManager.touchActive`). */
  readonly active: boolean;
  /** A key or pad button was pressed: stop being "active" and let go of every control. */
  deactivate(): void;
  /** Same arguments as `InputManager.layoutTouch`. */
  layout(viewports: readonly Viewport[], humans: 1 | 2, visible: boolean): void;
  /** Once per frame. Ages quick taps and moves the knobs; returns true if Pause was tapped since last poll. */
  poll(): boolean;
  /** This slot's controls right now. Reading uses up a quick tap, like keyboard taps. */
  sample(slot: 0 | 1): TouchSample;
  dispose(): void;
}

const IDLE_SAMPLE: TouchSample = { steer: 0, throttle: 0, fire: false, boost: false, rescue: false, honk: false };

/** What a desktop gets: no overlay, no listeners, always zero. */
const INERT: TouchControls = {
  active: false,
  deactivate(): void {},
  layout(): void {},
  poll: () => false,
  sample: () => IDLE_SAMPLE,
  dispose(): void {},
};

// ───────────────────────────── Internals ─────────────────────────────

type CtlKind = 'stick' | ButtonKind | 'pause';

/** One thing a finger can hold. `x/y` is a circle's middle (buttons) or a rect's corner (stick, pause). */
interface Ctl {
  kind: CtlKind;
  zone: number;
  el: HTMLElement;
  /** The finger holding it, or -1. */
  pid: number;
  /** Did setPointerCapture work? (It cannot for hand-made test events.) */
  captured: boolean;
  /** Polls left on a quick tap. */
  pulse: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Touchable radius of a circle; 0 for rects. */
  r: number;
}

/** One player's side of the screen. */
interface Zone {
  el: HTMLElement;
  stickEl: HTMLElement;
  knobEl: HTMLElement;
  stick: Ctl;
  fire: Ctl;
  boost: Ctl;
  honk: Ctl;
  rescue: Ctl;
  /** The viewport rect this zone was last laid out for. */
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  /** Base centre now, resting spot, and knob offset from the base centre (CSS px). */
  cx: number;
  cy: number;
  restX: number;
  restY: number;
  kx: number;
  ky: number;
  steer: number;
  throttle: number;
  /** The knob moved since the last poll() and needs redrawing. */
  dirty: boolean;
  sample: TouchSample;
}

const CSS = `
.ff-touchui{position:absolute;inset:0;z-index:20;overflow:hidden;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .18s ease,visibility 0s linear .18s;font-family:"Fredoka",system-ui,sans-serif;font-weight:700;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;touch-action:none}
.ff-touchui.is-on{opacity:1;visibility:visible;transition:opacity .18s ease,visibility 0s}
.ff-touchui *{box-sizing:border-box;-webkit-user-select:none;user-select:none}
.ff-t-probe{position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.ff-t-zone{position:absolute;inset:0;pointer-events:none}
.ff-t-zone.is-off{display:none}
.ff-t-surface{position:absolute;pointer-events:auto;touch-action:none}
.ff-t-stick{position:absolute;left:-64px;top:-64px;width:128px;height:128px;opacity:.4;pointer-events:none;will-change:transform;transition:opacity .2s ease,transform .22s ease-out}
.ff-t-stick.is-live{opacity:1;transition:opacity .08s linear}
.ff-t-base{position:absolute;inset:0;border-radius:50%;background:rgba(255,255,255,.18);border:4px solid rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(11,42,91,.6),inset 0 0 0 2px rgba(11,42,91,.25)}
.ff-t-base i{position:absolute;width:0;height:0;border-style:solid;border-color:transparent;opacity:.85}
.ff-t-base .u{left:50%;top:9px;margin-left:-7px;border-width:0 7px 10px;border-bottom-color:#fff}
.ff-t-base .d{left:50%;bottom:9px;margin-left:-7px;border-width:10px 7px 0;border-top-color:#fff}
.ff-t-base .l{top:50%;left:9px;margin-top:-7px;border-width:7px 10px 7px 0;border-right-color:#fff}
.ff-t-base .r{top:50%;right:9px;margin-top:-7px;border-width:7px 0 7px 10px;border-left-color:#fff}
.ff-t-knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:#fff;border:4px solid #0b2a5b;box-shadow:0 4px 0 rgba(6,23,61,.5);will-change:transform;transition:transform .14s ease-out}
.ff-t-stick.is-live .ff-t-knob{transition:none}
.ff-t-btn{position:absolute;display:flex;align-items:center;justify-content:center;border-radius:50%;pointer-events:auto;touch-action:none;cursor:pointer;--c:#ff8a1f;--dk:#b34d00;--ink:#06173d}
.ff-t-face{width:var(--d);height:var(--d);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;border-radius:50%;background:var(--c);color:var(--ink);border:3px solid #0b2a5b;box-shadow:0 5px 0 var(--dk),0 8px 14px rgba(6,23,61,.28);opacity:.93;pointer-events:none;transition:transform .06s ease-out,filter .06s linear,box-shadow .06s linear}
.ff-t-btn.is-down .ff-t-face{transform:translateY(3px) scale(.92);filter:brightness(.8);box-shadow:0 2px 0 var(--dk),0 3px 6px rgba(6,23,61,.28);opacity:1}
.ff-t-face svg{width:calc(var(--d)*.4);height:calc(var(--d)*.4);pointer-events:none}
.ff-t-lbl{font-size:max(10px,calc(var(--d)*.15));line-height:1;letter-spacing:.02em;pointer-events:none}
.ff-t-pause{--c:#06173d;--dk:rgba(0,0,0,.55);--ink:#fff;border-radius:14px}
.ff-t-pause .ff-t-face{border-radius:14px;border-color:#fff}
.ff-t-pause svg{width:calc(var(--d)*.5);height:calc(var(--d)*.5)}
@media (prefers-reduced-motion:reduce){.ff-touchui,.ff-touchui *{transition:none!important}}
`;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Zero inside the dead zone, then rescaled so the edge of the dead zone is 0 and full push is 1. */
function axis(v: number, dz: number, curve: number): number {
  const a = Math.min(Math.abs(v), 1);
  if (a <= dz) return 0;
  let s = (a - dz) / (1 - dz);
  if (curve !== 1) s = Math.pow(s, curve);
  return v < 0 ? -s : s;
}

function px(n: number): string {
  return Math.round(n * 10) / 10 + 'px';
}

// ───────────────────────────── The controls ─────────────────────────────

export function createTouch(target: Window): TouchControls {
  // ---- is this a touch device? ----
  let forced = false;
  try {
    forced = new URLSearchParams(target.location.search).get('touch') === '1';
  } catch {
    /* odd embed: treat as not forced */
  }
  let capable = false;
  try {
    capable = target.navigator.maxTouchPoints > 0 && target.matchMedia('(any-pointer: coarse)').matches;
  } catch {
    /* no matchMedia: not a touch device */
  }
  if (!forced && !capable) return INERT;

  const doc = target.document;
  const html = doc.documentElement;
  const host = doc.getElementById('app') ?? doc.body;

  // ---- state ----
  let active = false;
  let visible = false;
  let zoneCount = 0;
  let pendingPause = false;
  let disposed = false;
  let lastW = -1;
  let lastH = -1;
  let insetTop = 0;
  let insetRight = 0;
  let insetBottom = 0;
  let insetLeft = 0;

  const all: Ctl[] = [];
  const zones: Zone[] = [];

  // ───────────── build the overlay ─────────────

  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);

  function div(cls: string, parent: HTMLElement): HTMLDivElement {
    const e = doc.createElement('div');
    e.className = cls;
    parent.appendChild(e);
    return e;
  }

  function addCtl(kind: CtlKind, zone: number, el: HTMLElement): Ctl {
    const c: Ctl = { kind, zone, el, pid: -1, captured: false, pulse: 0, x: 0, y: 0, w: 0, h: 0, r: 0 };
    el.dataset.ffId = String(all.length);
    el.dataset.ffCtl = kind;
    el.dataset.ffZone = String(zone);
    all.push(c);
    return c;
  }

  const root = div('ff-touchui', host);
  const probe = div('ff-t-probe', root);

  function makeButton(parent: HTMLElement, zone: number, spec: ButtonSpec): Ctl {
    const el = div('ff-t-btn ff-t-' + spec.kind, parent);
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', spec.kind);
    el.style.setProperty('--c', spec.color);
    el.style.setProperty('--dk', spec.dark);
    el.style.setProperty('--ink', spec.ink);
    const face = div('ff-t-face', el);
    face.innerHTML = spec.icon + '<span class="ff-t-lbl">' + spec.label + '</span>';
    return addCtl(spec.kind, zone, el);
  }

  for (let i = 0; i < 2; i++) {
    const el = div('ff-t-zone is-off', root);
    const surface = div('ff-t-surface', el);
    const stick = addCtl('stick', i, surface);
    const stickEl = div('ff-t-stick', el);
    const base = div('ff-t-base', stickEl);
    for (const dir of ['u', 'd', 'l', 'r']) base.appendChild(doc.createElement('i')).className = dir;
    const knobEl = div('ff-t-knob', stickEl);
    const buttons: Ctl[] = BUTTONS.map((spec) => makeButton(el, i, spec));
    zones.push({
      el,
      stickEl,
      knobEl,
      stick,
      fire: buttons[0],
      boost: buttons[1],
      honk: buttons[2],
      rescue: buttons[3],
      vx: 0,
      vy: 0,
      vw: 0,
      vh: 0,
      cx: 0,
      cy: 0,
      restX: 0,
      restY: 0,
      kx: 0,
      ky: 0,
      steer: 0,
      throttle: 0,
      dirty: false,
      sample: { steer: 0, throttle: 0, fire: false, boost: false, rescue: false, honk: false },
    });
  }

  // Pause is on top of everything, pinned to the corner of the whole screen.
  const pauseEl = div('ff-t-btn ff-t-pause', root);
  pauseEl.setAttribute('role', 'button');
  pauseEl.setAttribute('aria-label', 'pause');
  pauseEl.style.setProperty('--d', PAUSE_SIZE + 'px');
  div('ff-t-face', pauseEl).innerHTML = ICON_PAUSE;
  const pause = addCtl('pause', 0, pauseEl);

  // ───────────── placing things ─────────────

  function readInsets(): void {
    // `env(safe-area-inset-*)` only exists in CSS, so a zero-size probe carries it into numbers.
    const cs = target.getComputedStyle(probe);
    insetTop = parseFloat(cs.paddingTop) || 0;
    insetRight = parseFloat(cs.paddingRight) || 0;
    insetBottom = parseFloat(cs.paddingBottom) || 0;
    insetLeft = parseFloat(cs.paddingLeft) || 0;
  }

  function placeCircle(c: Ctl, cx: number, cy: number, r: number, d: number): void {
    c.x = cx;
    c.y = cy;
    c.r = r;
    const st = c.el.style;
    st.left = px(cx - r);
    st.top = px(cy - r);
    st.width = st.height = px(2 * r);
    st.setProperty('--d', px(d));
  }

  function placeRect(c: Ctl, x: number, y: number, w: number, h: number): void {
    c.x = x;
    c.y = y;
    c.w = w;
    c.h = h;
    const st = c.el.style;
    st.left = px(x);
    st.top = px(y);
    st.width = px(w);
    st.height = px(h);
  }

  function placeStick(z: Zone): void {
    z.stickEl.style.transform = 'translate3d(' + Math.round(z.cx) + 'px,' + Math.round(z.cy) + 'px,0)';
  }

  function placeKnob(z: Zone): void {
    z.knobEl.style.transform = 'translate3d(' + Math.round(z.kx) + 'px,' + Math.round(z.ky) + 'px,0)';
  }

  /** Put the resting stick in place with no glide (a layout change should not make it fly in from the corner). */
  function snapStick(z: Zone): void {
    const st = z.stickEl.style;
    st.transition = 'none';
    placeStick(z);
    placeKnob(z);
    void z.stickEl.offsetWidth; // flush, so the glide is off while the new spot is applied
    st.transition = '';
  }

  function placeZone(i: number, vp: Viewport, winW: number, winH: number): void {
    const z = zones[i];
    z.vx = vp.x;
    z.vy = vp.y;
    z.vw = vp.width;
    z.vh = vp.height;
    // Player 1 (and a lone player) steers on the left and has the buttons on the right; player 2 mirrors it.
    const stickLeft = i === 0;
    const atLeft = vp.x <= EDGE_EPS;
    const atRight = vp.x + vp.width >= winW - EDGE_EPS;
    const atBottom = vp.y + vp.height >= winH - EDGE_EPS;

    // The stick may be started anywhere in the zone's OUTER half.
    const half = vp.width / 2;
    placeRect(z.stick, stickLeft ? vp.x : vp.x + half, vp.y, half, vp.height);

    // Where the stick waits (a faint hint) when nobody is touching it.
    const outerInset = stickLeft ? (atLeft ? insetLeft : 0) : atRight ? insetRight : 0;
    const off = Math.max(STICK_RADIUS + 12, Math.min(STICK_REST_X, half - STICK_RADIUS - 8));
    z.restX = stickLeft ? vp.x + outerInset + off : vp.x + vp.width - outerInset - off;
    z.restY = vp.y + vp.height - (atBottom ? insetBottom : 0) - Math.min(STICK_REST_Y, vp.height / 2);
    if (z.stick.pid === -1) {
      z.cx = z.restX;
      z.cy = z.restY;
      z.kx = 0;
      z.ky = 0;
      snapStick(z);
    }

    // The button cluster, in the INNER bottom corner. Smaller zones shrink it a little (never below 86%,
    // which keeps the smallest button at the 48 px tap-target minimum).
    const s = clamp(Math.min(vp.width / 600, vp.height / 560), 0.86, 1);
    const hugRight = stickLeft;
    const edgeInset = hugRight ? (atRight ? insetRight : 0) : atLeft ? insetLeft : 0;
    const ax = hugRight ? vp.x + vp.width - BUTTON_MARGIN - edgeInset : vp.x + BUTTON_MARGIN + edgeInset;
    const ay = vp.y + vp.height - BUTTON_MARGIN - (atBottom ? insetBottom : 0);
    const cluster = [z.fire, z.boost, z.honk, z.rescue];
    for (let b = 0; b < BUTTONS.length; b++) {
      const spec = BUTTONS[b];
      const cx = hugRight ? ax - spec.u * s : ax + spec.u * s;
      placeCircle(cluster[b], cx, ay - spec.v * s, spec.hit * s, spec.face * s);
    }
  }

  function placePause(): void {
    const x = PAUSE_MARGIN + insetLeft;
    const y = PAUSE_MARGIN + insetTop;
    placeRect(pause, x - PAUSE_HIT_PAD, y - PAUSE_HIT_PAD, PAUSE_SIZE + 2 * PAUSE_HIT_PAD, PAUSE_SIZE + 2 * PAUSE_HIT_PAD);
  }

  // ───────────── stick ─────────────

  function startStick(z: Zone, x: number, y: number): void {
    z.cx = x;
    z.cy = y;
    z.kx = 0;
    z.ky = 0;
    z.steer = 0;
    z.throttle = 0;
    z.dirty = false;
    z.stickEl.classList.add('is-live');
    placeStick(z);
    placeKnob(z);
  }

  function moveStick(z: Zone, x: number, y: number): void {
    let dx = x - z.cx;
    let dy = y - z.cy;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      const k = STICK_RADIUS / len;
      dx *= k;
      dy *= k;
    }
    z.kx = dx;
    z.ky = dy;
    const full = STICK_RADIUS * STICK_FULL;
    z.steer = axis(dx / full, STICK_DEADZONE, STEER_CURVE);
    const up = -dy / full;
    z.throttle = axis(up, up >= 0 ? STICK_DEADZONE : BRAKE_DEADZONE, 1);
    z.dirty = true;
  }

  /** The finger is gone: zero the outputs and send the stick back to its faint resting spot. */
  function endStick(z: Zone): void {
    z.steer = 0;
    z.throttle = 0;
    z.kx = 0;
    z.ky = 0;
    z.cx = z.restX;
    z.cy = z.restY;
    z.dirty = false;
    z.stickEl.classList.remove('is-live');
    placeStick(z);
    placeKnob(z);
  }

  // ───────────── letting go ─────────────

  /** Let go of one control (whoever was holding it). A quick tap's memory (`pulse`) is kept on purpose. */
  function free(c: Ctl): void {
    if (c.pid === -1) return;
    if (c.captured) {
      try {
        c.el.releasePointerCapture(c.pid);
      } catch {
        /* the finger is already gone, which is the usual case */
      }
    }
    c.pid = -1;
    c.captured = false;
    if (c.kind === 'stick') endStick(zones[c.zone]);
    else c.el.classList.remove('is-down');
  }

  /** Everything off, nothing remembered: hidden, blurred, deactivated. */
  function releaseAll(): void {
    for (let i = 0; i < all.length; i++) {
      free(all[i]);
      all[i].pulse = 0;
    }
    pendingPause = false;
  }

  // ───────────── fingers ─────────────

  function ctlFromTarget(t: EventTarget | null): Ctl | null {
    if (!(t instanceof Element)) return null;
    const el = t.closest('[data-ff-id]');
    if (!el || !root.contains(el)) return null;
    return all[Number((el as HTMLElement).dataset.ffId)] ?? null;
  }

  function inRect(c: Ctl, x: number, y: number): boolean {
    return x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h;
  }

  /** Which control is under this point? Used when the event did not land on one of our elements. */
  function ctlFromPoint(x: number, y: number): Ctl | null {
    if (inRect(pause, x, y)) return pause;
    let best: Ctl | null = null;
    let bestScore = 1;
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      if (c.r <= 0 || c.zone >= zoneCount) continue;
      const dx = x - c.x;
      const dy = y - c.y;
      const score = (dx * dx + dy * dy) / (c.r * c.r); // 1 = right on the edge of the touchable circle
      if (score <= bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best) return best;
    for (let z = 0; z < zoneCount; z++) if (inRect(zones[z].stick, x, y)) return zones[z].stick;
    return null;
  }

  /** The finger holding this control was captured, and the page no longer has that capture: it is gone. */
  function isStale(c: Ctl): boolean {
    if (!c.captured) return false;
    try {
      return !c.el.hasPointerCapture(c.pid);
    } catch {
      return true;
    }
  }

  function grab(c: Ctl, e: PointerEvent): void {
    c.pid = e.pointerId;
    c.captured = false;
    try {
      c.el.setPointerCapture(e.pointerId);
      c.captured = true;
    } catch {
      /* hand-made events have no real finger to capture; the window-level listeners cover them */
    }
    if (c.kind === 'stick') {
      startStick(zones[c.zone], e.clientX, e.clientY);
    } else if (c.kind === 'pause') {
      pendingPause = true;
      c.el.classList.add('is-down');
    } else {
      c.pulse = TAP_LIFE_POLLS;
      c.el.classList.add('is-down');
    }
  }

  function setActive(on: boolean): void {
    if (on === active) return;
    active = on;
    html.classList.toggle('ff-touch', on);
    refresh();
  }

  /** Show or hide the overlay; a hidden overlay holds nothing. */
  function refresh(): void {
    const live = visible && active;
    root.classList.toggle('is-on', live);
    if (!live) releaseAll();
  }

  function onDown(e: PointerEvent): void {
    if (disposed) return;
    // The first finger switches touch on (with ?touch=1 any pointer does, so a mouse can test it).
    if (e.pointerType === 'touch' || forced) setActive(true);
    if (!visible || !active) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const c = ctlFromTarget(e.target) ?? ctlFromPoint(e.clientX, e.clientY);
    if (!c || c.zone >= zoneCount) return;
    // A second finger on a control that is already held is ignored, unless the first one has vanished.
    if (c.pid !== -1 && c.pid !== e.pointerId) {
      if (!isStale(c)) return;
      free(c);
    }
    // One finger, one control.
    for (let i = 0; i < all.length; i++) if (all[i] !== c && all[i].pid === e.pointerId) free(all[i]);
    grab(c, e);
    e.preventDefault();
  }

  function onMove(e: PointerEvent): void {
    for (let i = 0; i < zoneCount; i++) {
      const z = zones[i];
      if (z.stick.pid === e.pointerId) {
        moveStick(z, e.clientX, e.clientY);
        return;
      }
    }
  }

  function onEnd(e: PointerEvent): void {
    for (let i = 0; i < all.length; i++) if (all[i].pid === e.pointerId) free(all[i]);
  }

  function onAway(): void {
    releaseAll();
  }

  function onVisibility(): void {
    if (doc.visibilityState === 'hidden') releaseAll();
  }

  function onContextMenu(e: Event): void {
    e.preventDefault(); // a long press must never open a menu under the thumb
  }

  // Window level + capture phase: we see every finger first, whatever it landed on or whatever else
  // listens, and hand-made events work whether or not they bubble.
  const CAPTURE: AddEventListenerOptions = { capture: true };
  target.addEventListener('pointerdown', onDown, CAPTURE);
  target.addEventListener('pointermove', onMove, CAPTURE);
  target.addEventListener('pointerup', onEnd, CAPTURE);
  target.addEventListener('pointercancel', onEnd, CAPTURE);
  target.addEventListener('lostpointercapture', onEnd, CAPTURE);
  target.addEventListener('blur', onAway);
  doc.addEventListener('visibilitychange', onVisibility);
  root.addEventListener('contextmenu', onContextMenu);

  // ---- ?touch=1 starts switched on ----
  if (forced) setActive(true);

  // ───────────── reading it out ─────────────

  /** A button that is held down, or was tapped since last read. Reading uses the tap up. */
  function held(c: Ctl): boolean {
    const yes = c.pid !== -1 || c.pulse > 0;
    c.pulse = 0;
    return yes;
  }

  /** A button that only counts the moment it goes down (honk, rescue). */
  function tapped(c: Ctl): boolean {
    const yes = c.pulse > 0;
    c.pulse = 0;
    return yes;
  }

  return {
    get active(): boolean {
      return active;
    },

    deactivate(): void {
      setActive(false);
    },

    layout(viewports: readonly Viewport[], humans: 1 | 2, vis: boolean): void {
      if (disposed) return;
      const count = Math.max(0, Math.min(humans, viewports.length, 2));
      const w = target.innerWidth;
      const h = target.innerHeight;
      // The core may call this a lot; only touch the DOM when something actually moved.
      let same = count === zoneCount && w === lastW && h === lastH;
      for (let i = 0; same && i < count; i++) {
        const z = zones[i];
        const vp = viewports[i];
        same = z.vx === vp.x && z.vy === vp.y && z.vw === vp.width && z.vh === vp.height;
      }
      if (!same) {
        readInsets();
        zoneCount = count;
        lastW = w;
        lastH = h;
        for (let i = 0; i < zones.length; i++) {
          zones[i].el.classList.toggle('is-off', i >= count);
          if (i < count) placeZone(i, viewports[i], w, h);
        }
        placePause();
        // A zone that just went away must not keep a finger.
        for (let i = 0; i < all.length; i++) {
          if (all[i].zone >= count && all[i] !== pause) {
            free(all[i]);
            all[i].pulse = 0;
          }
        }
      }
      if (vis !== visible) {
        visible = vis;
        refresh();
      }
    },

    poll(): boolean {
      for (let i = 0; i < all.length; i++) if (all[i].pulse > 0) all[i].pulse--;
      for (let i = 0; i < zoneCount; i++) {
        const z = zones[i];
        if (z.dirty) {
          z.dirty = false;
          placeKnob(z);
        }
      }
      const tappedPause = pendingPause;
      pendingPause = false;
      return tappedPause;
    },

    sample(slot: 0 | 1): TouchSample {
      const z = zones[slot];
      const out = z.sample;
      const live = visible && active && slot < zoneCount;
      out.steer = live ? z.steer : 0;
      out.throttle = live ? z.throttle : 0;
      out.fire = held(z.fire) && live;
      out.boost = held(z.boost) && live;
      out.rescue = tapped(z.rescue) && live;
      out.honk = tapped(z.honk) && live;
      return out;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      target.removeEventListener('pointerdown', onDown, CAPTURE);
      target.removeEventListener('pointermove', onMove, CAPTURE);
      target.removeEventListener('pointerup', onEnd, CAPTURE);
      target.removeEventListener('pointercancel', onEnd, CAPTURE);
      target.removeEventListener('lostpointercapture', onEnd, CAPTURE);
      target.removeEventListener('blur', onAway);
      doc.removeEventListener('visibilitychange', onVisibility);
      releaseAll();
      html.classList.remove('ff-touch');
      root.remove();
      style.remove();
      active = false;
      visible = false;
    },
  };
}
