/** Small math and text helpers shared by the game-core files. */
import { CONFIG } from '../config';

/** A boat's top (non-boost) speed in m/s. Easy Driving boats are a little slower. */
export function topSpeedOf(easyDriving: boolean): number {
  return CONFIG.boat.maxSpeed * (easyDriving ? CONFIG.easyDriving.speedScale : 1);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap an angle into [-PI, PI]. */
export function wrapPi(a: number): number {
  const twoPi = Math.PI * 2;
  let r = (a + Math.PI) % twoPi;
  if (r < 0) r += twoPi;
  return r - Math.PI;
}

/**
 * Frame-rate independent smoothing: move `cur` toward `target`.
 * A bigger `lambda` means a snappier follow. Works the same at 30 or 144 fps.
 */
export function damp(cur: number, target: number, lambda: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

/** Same as `damp`, but takes the short way around the circle. */
export function dampAngle(cur: number, target: number, lambda: number, dt: number): number {
  return cur + wrapPi(target - cur) * (1 - Math.exp(-lambda * dt));
}

/** 83.27 seconds -> "1:23.3" */
export function formatTime(sec: number): string {
  const tenths = Math.max(0, Math.round(sec * 10));
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th" */
export function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}
