/**
 * Cameras: a chase camera per human player, an orbit camera for the title screen and
 * the results screen, and the split-screen layout math.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Boat, Viewport, WorldQuery } from '../types';
import { reportError } from './debug';
import { clamp, damp, dampAngle, topSpeedOf } from './util';

const NEAR = 0.4;
/** Far enough for any sky dome the world builds. */
const FAR = 10000;
/** The camera never goes lower than this above the water surface. */
const MIN_ABOVE_WATER = 0.9;
/** CSS pixels of dark gap between the two split-screen halves. */
const SPLIT_GAP = 4;

/** Viewports in CSS pixels, origin top-left. One per human (side by side for two). */
export function computeViewports(width: number, height: number, players: number): Viewport[] {
  if (players < 2) return [{ x: 0, y: 0, width, height }];
  const half = Math.floor((width - SPLIT_GAP) / 2);
  return [
    { x: 0, y: 0, width: half, height },
    { x: width - half, y: 0, width: half, height },
  ];
}

/** Keep a camera out of the water and out of islands. Never throws. */
function keepClear(cam: THREE.Camera, world: WorldQuery, t: number): void {
  try {
    const p = cam.position;
    const obstacles = world.obstacles;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const min = o.radius + 0.8;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-6) {
        const k = min / Math.sqrt(d2);
        p.x = o.x + dx * k;
        p.z = o.z + dz * k;
      }
    }
    const floor = world.waveHeight(p.x, p.z, t) + MIN_ABOVE_WATER;
    if (p.y < floor) p.y = floor;
  } catch (e) {
    reportError('camera.keepClear', e);
    if (cam.position.y < MIN_ABOVE_WATER) cam.position.y = MIN_ABOVE_WATER;
  }
}

/** How fast the camera swings around behind the boat (bigger = snappier). Easy Driving is gentler. */
const YAW_FOLLOW = 5;
const YAW_FOLLOW_EASY = 3;

export class ChaseCamera {
  readonly camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 16 / 9, NEAR, FAR);
  /** The direction the camera faces, as a heading. The HUD arrow and the mini-map are measured from this. */
  viewHeading = 0;

  /** Easy Driving players get a higher, farther-back camera that follows turns more smoothly. */
  private readonly view: { distance: number; height: number; lookAhead: number };
  private readonly yawFollow: number;
  private readonly topSpeed: number;

  private heading = 0; // smoothed heading the camera swings around to
  private readonly pos = new THREE.Vector3(); // smoothed camera position
  private readonly look = new THREE.Vector3(); // smoothed point the camera looks at
  private fov: number = CONFIG.camera.fov;
  private boostK = 0; // 0..1, eases in when boosting
  private trauma = 0; // screen shake, 0..1
  private kickAmt = 0; // brief push-back when firing
  private shakeClock = 0;

  constructor(easyDriving = false) {
    this.view = easyDriving ? CONFIG.camera.easy : CONFIG.camera;
    this.yawFollow = easyDriving ? YAW_FOLLOW_EASY : YAW_FOLLOW;
    this.topSpeed = topSpeedOf(easyDriving);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect > 0 ? aspect : 1;
    this.camera.updateProjectionMatrix();
  }

  /** Little push-back when the player fires (or lands a hit). */
  kick(amount: number): void {
    this.kickAmt = Math.min(1.2, this.kickAmt + amount);
  }

  /** Screen shake, for being hit or bumped. 0.5 is a solid thump. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Jump straight to the right spot behind the boat (no smoothing). */
  snap(boat: Boat, world: WorldQuery, t: number): void {
    const cfg = this.view;
    this.heading = boat.heading;
    this.boostK = 0;
    this.fov = CONFIG.camera.fov;
    this.trauma = 0;
    this.kickAmt = 0;
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const bp = boat.position;
    this.pos.set(bp.x - sin * cfg.distance, bp.y * 0.5 + cfg.height, bp.z - cos * cfg.distance);
    this.look.set(bp.x + sin * cfg.lookAhead, bp.y * 0.5 + 1.2, bp.z + cos * cfg.lookAhead);
    this.apply(0, world, t);
  }

  /** Follow the boat. `dt` is real frame time, so the smoothing feels the same at any frame rate. */
  update(dt: number, boat: Boat, world: WorldQuery, t: number): void {
    const bp = boat.position;
    if (!Number.isFinite(bp.x + bp.y + bp.z)) return; // a broken boat must not blank the screen
    const cfg = this.view;

    const speed01 = clamp(Math.abs(boat.speed) / this.topSpeed, 0, 1);
    this.boostK = damp(this.boostK, boat.boosting ? 1 : 0, 6, dt);
    this.heading = dampAngle(this.heading, boat.heading, this.yawFollow, dt);

    // A touch further back when going fast.
    const dist = cfg.distance + 1.5 * speed01 + this.boostK;
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    this.pos.x = damp(this.pos.x, bp.x - sin * dist, 10, dt);
    this.pos.y = damp(this.pos.y, bp.y * 0.5 + cfg.height, 6, dt);
    this.pos.z = damp(this.pos.z, bp.z - cos * dist, 10, dt);
    this.look.x = damp(this.look.x, bp.x + sin * cfg.lookAhead, 12, dt);
    this.look.y = damp(this.look.y, bp.y * 0.5 + 1.2, 6, dt);
    this.look.z = damp(this.look.z, bp.z + cos * cfg.lookAhead, 12, dt);

    // Wider field of view = more speed. Boost adds a lot more.
    const targetFov = CONFIG.camera.fov + 6 * speed01 + 8 * this.boostK;
    this.fov = damp(this.fov, targetFov, 5, dt);
    this.apply(dt, world, t);
  }

  /** Turn the smoothed numbers into the actual camera transform, then add shake and kick. */
  private apply(dt: number, world: WorldQuery, t: number): void {
    const cam = this.camera;
    const fovNow = this.fov + this.kickAmt * 3; // a firing kick also punches the view out a hair
    if (Math.abs(cam.fov - fovNow) > 0.02) {
      cam.fov = fovNow;
      cam.updateProjectionMatrix();
    }
    cam.position.copy(this.pos);
    keepClear(cam, world, t);
    cam.lookAt(this.look);
    this.viewHeading = Math.atan2(this.look.x - cam.position.x, this.look.z - cam.position.z);

    if (this.trauma > 0.001 || this.kickAmt > 0.001) {
      this.shakeClock += dt;
      const s = this.trauma * this.trauma;
      const c = this.shakeClock;
      cam.rotateZ(Math.sin(c * 41.1) * 0.05 * s);
      cam.rotateX(Math.sin(c * 53.3 + 1.7) * 0.035 * s + this.kickAmt * 0.02);
      cam.rotateY(Math.sin(c * 47.0 + 0.6) * 0.035 * s);
      cam.translateZ(this.kickAmt * 0.8);
      this.trauma = Math.max(0, this.trauma - 1.8 * dt);
      this.kickAmt *= Math.exp(-12 * dt);
    }
  }
}

export type CameraOp = 'shake' | 'kick' | 'snap';

/**
 * The camera of an online player who sits at another device. It is never drawn or moved here: the kicks, shakes
 * and snaps the match would give it go to `send` instead (the host turns them into events), so that player's
 * own device plays them on its own camera.
 */
export class RemoteCamera extends ChaseCamera {
  constructor(easyDriving: boolean, private readonly send: (op: CameraOp, amount: number) => void) {
    super(easyDriving);
  }

  override kick(amount: number): void {
    this.send('kick', amount);
  }

  override shake(amount: number): void {
    this.send('shake', amount);
  }

  override snap(): void {
    this.send('snap', 0);
  }

  override update(): void {}
}

/** A slow cinematic orbit around a point (used behind the menu and on the results screen). */
export class OrbitCamera {
  readonly camera = new THREE.PerspectiveCamera(55, 16 / 9, NEAR, FAR);
  private angle = 0;
  private readonly focus = new THREE.Vector3();
  private ready = false;

  setAspect(aspect: number): void {
    this.camera.aspect = aspect > 0 ? aspect : 1;
    this.camera.updateProjectionMatrix();
  }

  /** Forget the old focus so the next update starts right on the new target. */
  reset(): void {
    this.ready = false;
  }

  update(dt: number, target: THREE.Vector3, world: WorldQuery, t: number, radius = 16, height = 6, speed = 0.35): void {
    if (!Number.isFinite(target.x + target.y + target.z)) return;
    if (!this.ready) {
      this.focus.copy(target);
      this.ready = true;
    } else {
      this.focus.x = damp(this.focus.x, target.x, 3, dt);
      this.focus.y = damp(this.focus.y, target.y, 3, dt);
      this.focus.z = damp(this.focus.z, target.z, 3, dt);
    }
    this.angle += speed * dt;
    const cam = this.camera;
    cam.position.set(
      this.focus.x + Math.sin(this.angle) * radius,
      this.focus.y + height,
      this.focus.z + Math.cos(this.angle) * radius,
    );
    keepClear(cam, world, t);
    cam.lookAt(this.focus.x, this.focus.y + 1.2, this.focus.z);
  }
}
