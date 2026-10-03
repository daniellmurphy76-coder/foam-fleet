/**
 * Tiny DOM helpers shared by the menu and the HUD.
 * (Plain DOM, no framework: `el('div', 'class', 'text')` just builds an element.)
 */
import type { Sfx } from '../types';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A chunky button that keyboard/gamepad navigation can land on (`data-nav`). */
export function button(label: string, className: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.setAttribute('data-nav', '');
  return b;
}

/** Turn a snippet of our own static SVG art into a node (never pass user text in here). */
export function svgNode(markup: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as SVGSVGElement;
}

/** 0xRRGGBB number -> '#rrggbb' */
export function cssColor(c: number): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

export function ordinal(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return n + 'th';
  switch (n % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

/** A friendly color name for screen readers and tooltips (works even if CONFIG.colors changes). */
export function colorName(c: number): string {
  const r = ((c >> 16) & 255) / 255;
  const g = ((c >> 8) & 255) / 255;
  const b = (c & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.08) return max > 0.8 ? 'White' : max < 0.25 ? 'Black' : 'Grey';
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  if (h < 15 || h >= 345) return 'Red';
  if (h < 40) return 'Orange';
  if (h < 65) return 'Yellow';
  if (h < 160) return 'Green';
  if (h < 195) return 'Turquoise';
  if (h < 255) return 'Blue';
  if (h < 300) return 'Purple';
  return 'Pink';
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** `?name=1` in the page address (the test switches: `touch=1`, `mute=1`). */
function urlFlag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).get(name) === '1';
  } catch {
    return false;
  }
}

/**
 * A touch device (iPad, phone, touchscreen laptop), or `?touch=1` to pretend on any device.
 * Same test the input module uses, so the menu and the touch controls always agree.
 */
export function touchAvailable(): boolean {
  if (urlFlag('touch')) return true;
  try {
    return navigator.maxTouchPoints > 0 && window.matchMedia('(any-pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** `?mute=1`: silent test mode. The game keeps quiet for that page load and the sound buttons do nothing. */
export function silentTestMode(): boolean {
  return urlFlag('mute');
}

// localStorage can throw (private windows, blocked cookies), so always go through these.
export function storeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* fine: the game just forgets this next time */
  }
}

// ───────────── setup-screen building blocks (menu + garage) ─────────────

export interface SegItem<T> {
  value: T;
  label: string;
  sub?: string;
  /** A little emoji (text) or a prebuilt static SVG node, shown above the label. */
  icon?: string | Node;
}
export interface Seg<T> {
  row: HTMLElement;
  buttons: HTMLButtonElement[];
  select(v: T): void;
}

/**
 * A row of big toggle buttons where exactly one is selected.
 * `quiet` skips the click sound, for rows that play a sound of their own (like the horn picker).
 */
export function makeSeg<T>(
  sfx: Sfx,
  ariaLabel: string,
  items: SegItem<T>[],
  onPick: (v: T) => void,
  quiet = false,
): Seg<T> {
  const row = el('div', 'ff-row ff-seg');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', ariaLabel);
  const buttons = items.map((it) => {
    const b = button(it.label, 'ff-btn ff-seg-btn');
    if (it.icon !== undefined) {
      const ico = el('span', 'ff-seg-ico');
      if (typeof it.icon === 'string') {
        ico.textContent = it.icon;
        ico.setAttribute('aria-hidden', 'true');
      } else {
        ico.append(it.icon);
      }
      b.prepend(ico);
    }
    if (it.sub) b.append(el('span', 'ff-seg-sub', it.sub));
    b.addEventListener('click', () => {
      if (!quiet) sfx.uiSelect();
      onPick(it.value);
    });
    row.append(b);
    return b;
  });
  return {
    row,
    buttons,
    select(v: T) {
      items.forEach((it, i) => buttons[i].setAttribute('aria-pressed', String(it.value === v)));
    },
  };
}

/** A labelled group of controls. */
export function field(title: string, ...content: HTMLElement[]): { box: HTMLElement; label: HTMLElement } {
  const box = el('div', 'ff-field');
  const label = el('div', 'ff-label', title);
  box.append(label, ...content);
  return { box, label };
}

export interface Swatches {
  row: HTMLElement;
  buttons: HTMLButtonElement[];
  /** Show which color is picked; `takenBy` returns a tag like "P2" for a color the other player has, else null. */
  sync(selected: number, takenBy: (c: number) => string | null): void;
}

/** A row of round paint-color buttons. */
export function makeSwatches(
  sfx: Sfx,
  ariaLabel: string,
  colors: readonly number[],
  onPick: (c: number) => void,
): Swatches {
  const row = el('div', 'ff-row ff-swatches');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', ariaLabel);
  const buttons = colors.map((c) => {
    const s = el('button', 'ff-swatch');
    s.type = 'button';
    s.setAttribute('data-nav', '');
    s.style.setProperty('--c', cssColor(c));
    const nm = colorName(c);
    s.setAttribute('aria-label', nm);
    s.title = nm;
    s.addEventListener('click', () => {
      if (s.disabled) return;
      sfx.uiSelect();
      onPick(c);
    });
    row.append(s);
    return s;
  });
  return {
    row,
    buttons,
    sync(selected, takenBy) {
      buttons.forEach((s, j) => {
        const c = colors[j];
        const mine = selected === c;
        const taken = takenBy(c);
        s.setAttribute('aria-pressed', String(mine));
        s.disabled = taken !== null && !mine;
        if (taken !== null) s.dataset.taken = taken;
        else delete s.dataset.taken;
      });
    },
  };
}

// ───────────── audio unlock ─────────────
// Browsers only allow sound after a click, a key press or a tap, so listen for the first one.
// iPad Safari counts the END of a touch (not its start), so pointerup, touchend and click are listed too.
const unlockInstalled = new WeakSet<Sfx>();
const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
export function installUnlock(sfx: Sfx): void {
  if (unlockInstalled.has(sfx)) return;
  unlockInstalled.add(sfx);
  const go = (): void => sfx.unlock(); // safe to call over and over
  for (const type of UNLOCK_EVENTS) window.addEventListener(type, go, { capture: true, passive: true });
}

// ───────────── keyboard / gamepad focus navigation ─────────────
// Screens are made of ".ff-row" containers; each row holds focusable "[data-nav]" items.
// Up/down moves between rows, left/right moves inside a row.

export function isNavigable(node: HTMLElement): boolean {
  return !(node as HTMLButtonElement).disabled && !node.closest('[hidden]');
}

export function collectRows(scope: ParentNode): HTMLElement[][] {
  const rows: HTMLElement[][] = [];
  scope.querySelectorAll<HTMLElement>('.ff-row').forEach((row) => {
    const items = Array.from(row.querySelectorAll<HTMLElement>('[data-nav]')).filter(isNavigable);
    if (items.length > 0) rows.push(items);
  });
  return rows;
}

/** Where focus should go after a d-pad press. Rows wrap around; columns do not. */
export function stepFocus(
  rows: HTMLElement[][],
  from: Element | null,
  dx: number,
  dy: number,
): HTMLElement | null {
  if (rows.length === 0) return null;
  let r = -1;
  let c = -1;
  for (let i = 0; i < rows.length && r < 0; i++) {
    const j = rows[i].indexOf(from as HTMLElement);
    if (j >= 0) {
      r = i;
      c = j;
    }
  }
  if (r < 0) return rows[0][0];
  if (dy !== 0) {
    const nr = (r + dy + rows.length) % rows.length;
    const here = rows[r].length;
    const there = rows[nr].length;
    // Land on the option that is already selected; otherwise keep roughly the same column.
    const selected = rows[nr].findIndex((n) => n.getAttribute('aria-pressed') === 'true');
    c = selected >= 0 ? selected : here <= 1 ? 0 : Math.round((c / (here - 1)) * (there - 1));
    r = nr;
  }
  if (dx !== 0) c = clamp(c + dx, 0, rows[r].length - 1);
  return rows[r][c];
}

/**
 * Enter/Space on a focused button would make the browser "click" it, but the game's
 * input module already reports those keys through MenuInput. Without this guard a
 * single key press would activate the button twice. Arrow keys are blocked so the
 * page doesn't scroll. Typing in a text box is never touched.
 */
export function guardActivationKeys(isActive: () => boolean): void {
  const stop = (e: KeyboardEvent): void => {
    if (!isActive()) return;
    if (e.key !== 'Enter' && e.key !== ' ' && !e.key.startsWith('Arrow')) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    e.preventDefault();
  };
  window.addEventListener('keydown', stop, true);
  window.addEventListener('keyup', stop, true);
}
