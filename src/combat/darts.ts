import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Boat, DartHit, DartSpawn, DartSystem, DartUpdateResult, Effects, WorldQuery } from '../types';
import { DartTrails } from './trails';

/**
 * Foam darts in flight, stuck to boats, and bouncing off shields.
 *
 * Life of a dart:
 *   FLYING    -> flies in an arc. Each step we sweep a line from its old spot to its new spot and
 *                test it against every boat's hit sphere, so even a fast dart can't skip through.
 *      hits a boat  -> boat.onHit() decides:
 *           true  -> STUCK     the dart sticks into the boat's real surface and rides along with it
 *           false -> DEFLECTED shield! it boings away, spinning, and falls
 *      hits an island -> DROPPING -> LANDED   (falls to the ground and shrinks away)
 *      hits water     -> FLOATING             (little splash, bobs for a moment, shrinks away)
 *
 * Pooled: 128 dart meshes are built once and reused, so firing never allocates.
 */

const POOL_SIZE = 128;

// Dart size. The geometry is built to match these.
const DART_HALF_LENGTH = 0.225; // darts are 0.45 m long
const DART_RADIUS = 0.075;
/** How deep (m) the tip pushes into a boat's surface when it sticks. */
const EMBED_DEPTH = 0.09;

/** Biggest time step we simulate in one go (seconds). Longer frames are clamped. */
const MAX_STEP = 0.05;
/** Darts that hit an island below this height drop; higher ones fly over. */
const ISLAND_TOP = 3;
/** Darts shrink away over their last this-many seconds. */
const FADE_TIME = 0.3;
/** At most this many stuck darts per boat (the oldest shrinks away first). */
const MAX_STUCK_PER_BOAT = 14;

const FALL_GRAVITY = 14; // deflected/dropping darts fall faster than flying ones
const DEFLECT_LIFE = 1.8;
const FLOAT_TIME = 1.1;
const LAND_TIME = 0.5;
const SPLASH_SIZE = 0.5; // "small" splash for a dart hitting the water

/** The stuck-dart "boing": how long, how far (radians), how fast it quivers. */
const WOBBLE_TIME = 0.45;
const WOBBLE_ANGLE = 0.35;
const WOBBLE_RATE = 38;

/** Trails are this many seconds of flight long (about 2.4 m at normal dart speed). */
const TRAIL_SECONDS = 0.05;
const TRAIL_WIDTH = 0.12;
const TRAIL_ALPHA = 0.5;

/** Hull raycasts start this far before the hit sphere's edge so they begin outside the boat. */
const RAY_LEAD = 2.5;

const SHIELD_SPARKLE = 0x8fe8ff;

// Dart states.
const FLYING = 0;
const DEFLECTED = 1;
const DROPPING = 2;
const LANDED = 3;
const FLOATING = 4;
const STUCK = 5;

interface Dart {
  mesh: THREE.Mesh;
  state: number;
  ownerId: number;
  /** Seconds in the current state (or since firing, while flying). */
  age: number;
  /** The dart disappears when age reaches life. */
  life: number;
  /** Index in `live`, for O(1) removal. */
  slot: number;
  vel: THREE.Vector3;
  // DEFLECTED / DROPPING: tumbling.
  spinAxis: THREE.Vector3;
  spinRate: number;
  // STUCK: the boat it is stuck in, and the quiver animation.
  hostId: number;
  /** The embedded tip, in the boat's local space (the quiver pivots around it). */
  tip: THREE.Vector3;
  baseQuat: THREE.Quaternion;
  wobbleAxisAngle: number;
  settled: boolean;
}

// Scratch objects, reused so the hot paths allocate nothing.
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _hitDir = new THREE.Vector3();
const _entry = new THREE.Vector3();
const _surface = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _stick = new THREE.Vector3();
const _burst = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _splash = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _wobbleAxis = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const rayHits: THREE.Intersection[] = [];

const EMPTY_RESULT: DartUpdateResult = { hits: [], waterSplashes: [] };

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const byDistance = (a: THREE.Intersection, b: THREE.Intersection): number => a.distance - b.distance;

// ───────────────────────────── Dart look ─────────────────────────────

/**
 * One chunky foam dart as a single mesh: blue body, white band near the back, orange rounded tip.
 * Built as a faceted lathe (a profile spun around an axis) with colors painted per vertex,
 * so every dart is ONE draw call and shares one geometry.
 */
function buildDartGeometry(): THREE.BufferGeometry {
  const BODY = 0, BAND = 1, TIP = 2;
  const pts: THREE.Vector2[] = [];
  const part: number[] = [];
  // Profile points from the tail to the nose: (radius, distance along the dart).
  // A repeated point makes a hard color edge instead of a blend.
  const add = (r: number, y: number, p: number): void => {
    pts.push(new THREE.Vector2(r, y));
    part.push(p);
  };
  const R = DART_RADIUS;
  const H = DART_HALF_LENGTH;
  add(0, -H, BODY);
  add(R, -H, BODY); // flat back end
  add(R, -0.15, BODY);
  add(R, -0.15, BAND); // white band, slightly raised
  add(R * 1.17, -0.15, BAND);
  add(R * 1.17, -0.105, BAND);
  add(R, -0.105, BAND);
  add(R, -0.105, BODY);
  add(R, 0.045, BODY);
  add(R, 0.045, TIP); // orange tip: a rounded bullet nose
  const NOSE_STEPS = 6;
  for (let k = 1; k <= NOSE_STEPS; k++) {
    const phi = (k / NOSE_STEPS) * (Math.PI / 2);
    add(R * Math.cos(phi), 0.045 + (H - 0.045) * Math.sin(phi), TIP);
  }

  const RADIAL = 10;
  const geo = new THREE.LatheGeometry(pts, RADIAL);
  geo.rotateX(Math.PI / 2); // lathe axis is Y; make the nose point along +Z

  const palette = [new THREE.Color(0x2f7bff), new THREE.Color(0xffffff), new THREE.Color(0xff8a00)];
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const c = palette[part[v % pts.length]]; // lathe vertices are laid out ring by ring, `pts.length` per ring
    colors[v * 3] = c.r;
    colors[v * 3 + 1] = c.g;
    colors[v * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// ───────────────────────────── Collision helpers ─────────────────────────────

/**
 * Where does the segment p + s*d (s from 0 to 1) first enter the sphere (c, r)?
 * Returns s, or -1 for a miss. A start point already inside counts as s = 0.
 */
function segmentSphere(
  px: number, py: number, pz: number,
  dx: number, dy: number, dz: number,
  c: THREE.Vector3, r: number,
): number {
  const mx = px - c.x, my = py - c.y, mz = pz - c.z;
  const cc = mx * mx + my * my + mz * mz - r * r;
  if (cc <= 0) return 0;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-9) return -1;
  const b = mx * dx + my * dy + mz * dz;
  const disc = b * b - a * cc;
  if (disc < 0) return -1;
  const s = (-b - Math.sqrt(disc)) / a;
  return s >= 0 && s <= 1 ? s : -1;
}

/** Meshes a dart can stick into: visible, not another dart, not see-through (shield bubble). */
function isSolid(mesh: THREE.Mesh): boolean {
  const m = mesh.material;
  if (Array.isArray(m)) return true;
  return !(m.transparent && m.opacity < 0.5);
}

/** Raycast every solid mesh under `obj` (skipping hidden ones and darts already stuck there). */
function raycastSolids(obj: THREE.Object3D, out: THREE.Intersection[]): void {
  if (!obj.visible || obj.userData.foamDart === true) return;
  const mesh = obj as THREE.Mesh;
  if (mesh.isMesh === true && isSolid(mesh)) raycaster.intersectObject(mesh, false, out);
  const kids = obj.children;
  for (let i = 0; i < kids.length; i++) raycastSolids(kids[i], out);
}

/**
 * Find where a dart entering the boat's hit sphere at `entry` really touches the boat's hull.
 * The hit sphere is not the same shape as the boat (a bow can poke out of it, and in most
 * places the hull sits well inside it), so we ray-test the actual meshes. The ray starts a
 * little way OUTSIDE so it always meets the outer skin first: first along the dart's flight
 * line, then (if that missed or went too deep) straight toward the boat's middle.
 * On success the surface point is in `_surface` and the outward surface normal in `_normal`.
 */
function findSurface(boat: Boat, entry: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, radius: number): boolean {
  boat.object.updateWorldMatrix(true, true); // raycasting needs up-to-date world matrices
  for (let attempt = 0; attempt < 2; attempt++) {
    let far: number;
    if (attempt === 0) {
      _rayDir.copy(dir);
      _rayOrigin.copy(entry).addScaledVector(_rayDir, -RAY_LEAD);
      far = RAY_LEAD + radius * 1.2; // a hit much deeper than this was a graze past the boat, not a hit
    } else {
      _rayDir.copy(center).sub(entry);
      if (_rayDir.lengthSq() < 1e-6) return false;
      _rayDir.normalize();
      _rayOrigin.copy(center).addScaledVector(_rayDir, -(radius + RAY_LEAD));
      far = radius + RAY_LEAD + 0.5;
    }
    raycaster.set(_rayOrigin, _rayDir);
    raycaster.near = 0;
    raycaster.far = far;
    rayHits.length = 0;
    raycastSolids(boat.object, rayHits);
    if (rayHits.length === 0) continue;
    rayHits.sort(byDistance);
    const h = rayHits[0];
    _surface.copy(h.point);
    if (h.face) {
      _normal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      if (_normal.dot(_rayDir) > 0) _normal.negate(); // make it face the incoming dart
    } else {
      _normal.copy(_rayDir).negate();
    }
    rayHits.length = 0;
    return true;
  }
  rayHits.length = 0;
  return false;
}

// ───────────────────────────── The system ─────────────────────────────

export function createDartSystem(scene: THREE.Scene, fx: Effects): DartSystem {
  // All dart meshes live under one group; idle ones are just invisible.
  const root = new THREE.Group();
  root.name = 'foam-darts';
  scene.add(root);

  const geometry = buildDartGeometry();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.7,
    metalness: 0,
  });
  const trails = new DartTrails(POOL_SIZE);
  scene.add(trails.mesh);

  const free: Dart[] = [];
  const live: Dart[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.userData.foamDart = true; // lets hull raycasts ignore darts that are already stuck
    root.add(mesh);
    free.push({
      mesh,
      state: FLYING,
      ownerId: -1,
      age: 0,
      life: 0,
      slot: -1,
      vel: new THREE.Vector3(),
      spinAxis: new THREE.Vector3(0, 1, 0),
      spinRate: 0,
      hostId: -1,
      tip: new THREE.Vector3(),
      baseQuat: new THREE.Quaternion(),
      wobbleAxisAngle: 0,
      settled: true,
    });
  }

  // Boat hit spheres, cached once per update() so each dart doesn't call hitCenter() again.
  const centers: THREE.Vector3[] = [];
  const radii: number[] = [];
  let boatList: readonly Boat[] = [];
  let boatCount = 0;

  // Events from the current update(). Allocated lazily: a quiet frame allocates nothing.
  let pendingHits = null as DartHit[] | null;
  let pendingSplashes = null as THREE.Vector3[] | null;
  function resetEvents(): void {
    pendingHits = null;
    pendingSplashes = null;
  }

  function cacheBoats(boats: readonly Boat[]): void {
    boatList = boats;
    boatCount = boats.length;
    for (let i = 0; i < boatCount; i++) {
      if (!centers[i]) centers[i] = new THREE.Vector3();
      boats[i].hitCenter(centers[i]);
      radii[i] = boats[i].hitRadius;
    }
  }

  // ─── pool management ───

  function removeFromLive(d: Dart): void {
    const last = live.pop() as Dart;
    if (last !== d) {
      live[d.slot] = last;
      last.slot = d.slot;
    }
  }

  /** Return a dart to the pool (un-sticking it from its boat if needed). */
  function release(d: Dart): void {
    const m = d.mesh;
    if (m.parent !== root) root.add(m); // add() detaches it from the boat first
    m.visible = false;
    m.scale.setScalar(1);
    removeFromLive(d);
    free.push(d);
  }

  /** Get a dart for firing. If the pool is empty, recycle the least important live one. */
  function acquire(): Dart | null {
    const fresh = free.pop();
    if (fresh) return fresh;
    let victim: Dart | null = null;
    let best = -1;
    for (let i = 0; i < live.length; i++) {
      const d = live[i];
      if (d.state === FLYING) continue; // never steal a dart that is still on its way to something
      // Falling/floating bits first (they are boring), then the oldest stuck dart.
      const score = (d.state === STUCK ? 0 : 1000) + d.age;
      if (score > best) { best = score; victim = d; }
    }
    if (!victim) return null;
    release(victim);
    return free.pop() ?? null;
  }

  /** Make sure one boat never looks like a porcupine: shrink away its oldest dart when over the cap. */
  function enforceStuckCap(hostId: number, newest: Dart): void {
    let n = 0;
    let oldest: Dart | null = null;
    for (let i = 0; i < live.length; i++) {
      const d = live[i];
      if (d.state !== STUCK || d.hostId !== hostId) continue;
      n++;
      if (d !== newest && d.life - d.age > FADE_TIME && (oldest === null || d.age > oldest.age)) oldest = d;
    }
    if (n > MAX_STUCK_PER_BOAT && oldest) oldest.life = oldest.age + FADE_TIME;
  }

  // ─── hits ───

  /** The dart reached a boat's hit sphere at (ex, ey, ez). */
  function hitBoat(d: Dart, boat: Boat, center: THREE.Vector3, radius: number, ex: number, ey: number, ez: number, stun: number): void {
    const m = d.mesh;
    _entry.set(ex, ey, ez);
    const hit: DartHit = {
      ownerId: d.ownerId,
      targetId: boat.id,
      point: new THREE.Vector3(),
      direction: new THREE.Vector3().copy(d.vel).normalize(),
      blocked: false,
    };

    // The boat gets its own copy of the direction so nothing it does can disturb ours.
    const accepted = boat.onHit(_hitDir.copy(hit.direction), stun);

    if (accepted) {
      // Where does the dart really touch the hull? Fall back to a spot partway to the middle.
      if (!findSurface(boat, _entry, hit.direction, center, radius)) {
        _surface.copy(_entry).lerp(center, 0.5);
        _normal.copy(_entry).sub(center).normalize();
      }
      // Stick in mostly along its flight path, nudged to point more into the hull.
      _stick.copy(hit.direction).addScaledVector(_normal, -0.5).normalize();
      m.position.copy(_surface).addScaledVector(_stick, -(DART_HALF_LENGTH - EMBED_DEPTH));
      m.quaternion.setFromUnitVectors(Z_AXIS, _stick);
      m.scale.setScalar(1);

      // The signature trick: attach() re-parents the dart to the boat while keeping its
      // world position, so from now on it moves, bobs and turns with the boat.
      boat.object.attach(m);

      d.state = STUCK;
      d.age = 0;
      d.life = CONFIG.blaster.stuckDartLife;
      d.hostId = boat.id;
      d.settled = false;
      d.vel.set(0, 0, 0);
      d.baseQuat.copy(m.quaternion);
      d.tip.set(0, 0, DART_HALF_LENGTH).applyQuaternion(m.quaternion).add(m.position);
      d.wobbleAxisAngle = Math.random() * Math.PI * 2;
      enforceStuckCap(boat.id, d);

      hit.point.copy(_surface);
      _burst.copy(_surface).addScaledVector(_normal, 0.15); // a hair outside so the burst isn't buried
      fx.hitBurst(_burst, boat.color);
    } else {
      // Shield! Bounce off the bubble, lose most of the speed, spin and fall.
      _normal.copy(_entry).sub(center).normalize();
      d.vel.addScaledVector(_normal, -2 * d.vel.dot(_normal)).multiplyScalar(0.35);
      d.vel.x += rand(-1.5, 1.5);
      d.vel.y += rand(2.5, 4.5);
      d.vel.z += rand(-1.5, 1.5);
      m.position.copy(_entry).addScaledVector(_normal, 0.1);
      d.spinAxis.set(rand(-1, 1), rand(-1, 1), rand(-1, 1));
      if (d.spinAxis.lengthSq() < 1e-4) d.spinAxis.set(1, 0, 0);
      d.spinAxis.normalize();
      d.spinRate = rand(10, 18) * (Math.random() < 0.5 ? -1 : 1);
      d.state = DEFLECTED;
      d.age = 0;
      d.life = DEFLECT_LIFE;
      hit.blocked = true;
      hit.point.copy(_entry);
      fx.sparkle(_entry, SHIELD_SPARKLE);
    }
    (pendingHits ??= []).push(hit);
  }

  /** The dart reached the water at height `wy`: splash, report it, then let it float. */
  function hitWater(d: Dart, wy: number): void {
    const m = d.mesh;
    m.position.y = wy;
    _splash.set(m.position.x, wy, m.position.z);
    fx.splash(_splash, SPLASH_SIZE);
    (pendingSplashes ??= []).push(_splash.clone());

    // Foam darts float: lie nearly flat, pointing the way they were going.
    _dir.set(d.vel.x, 0, d.vel.z);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
    _dir.normalize();
    _dir.y = -0.15;
    _dir.normalize();
    m.quaternion.setFromUnitVectors(Z_AXIS, _dir);
    d.vel.set(0, 0, 0);
    d.state = FLOATING;
    d.age = 0;
    d.life = FLOAT_TIME;
  }

  // ─── per-state stepping ───

  /** Fly one step. Handles all the things a flying dart can run into. */
  function stepFlying(d: Dart, dt: number, t: number, world: WorldQuery, stun: number): void {
    const m = d.mesh;
    const v = d.vel;
    const pos = m.position;

    v.y -= CONFIG.blaster.dartGravity * dt;
    const dx = v.x * dt, dy = v.y * dt, dz = v.z * dt;
    const x0 = pos.x, y0 = pos.y, z0 = pos.z;

    // 1. Boats: sweep the whole path of this step against every hit sphere (never the owner's).
    let best = 2;
    let bi = -1;
    for (let i = 0; i < boatCount; i++) {
      if (boatList[i].id === d.ownerId) continue;
      const s = segmentSphere(x0, y0, z0, dx, dy, dz, centers[i], radii[i]);
      if (s >= 0 && s < best) { best = s; bi = i; }
    }
    if (bi >= 0) {
      hitBoat(d, boatList[bi], centers[bi], radii[bi], x0 + dx * best, y0 + dy * best, z0 + dz * best, stun);
      return;
    }

    pos.set(x0 + dx, y0 + dy, z0 + dz);

    // 2. Islands: inside an obstacle circle and low enough -> the dart drops.
    if (pos.y < ISLAND_TOP) {
      const obstacles = world.obstacles;
      for (let i = 0; i < obstacles.length; i++) {
        const o = obstacles[i];
        const ox = pos.x - o.x, oz = pos.z - o.z;
        if (ox * ox + oz * oz < o.radius * o.radius) {
          v.x *= 0.15;
          v.z *= 0.15;
          if (v.y > 0) v.y = 0;
          d.spinAxis.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
          d.spinRate = rand(6, 12);
          d.state = DROPPING;
          d.age = 0;
          d.life = 3;
          return;
        }
      }
    }

    // 3. Water.
    const wy = world.waveHeight(pos.x, pos.z, t);
    if (pos.y < wy) {
      hitWater(d, wy);
      return;
    }

    // Still flying: point along the velocity and leave a faint trail.
    const speed = v.length();
    if (speed > 1e-3) {
      _dir.copy(v).multiplyScalar(1 / speed);
      m.quaternion.setFromUnitVectors(Z_AXIS, _dir);
      addTrail(d, speed);
    }
  }

  function addTrail(d: Dart, speed: number): void {
    const tl = Math.min(TRAIL_SECONDS, d.age); // a brand-new dart has no trail yet
    if (tl < 0.005 || speed < 6) return;
    const v = d.vel;
    const p = d.mesh.position;
    const headBack = Math.min(DART_HALF_LENGTH / speed, tl); // start at the dart's tail end
    const fade = Math.min(1, (d.life - d.age) / FADE_TIME);
    trails.add(
      p.x - v.x * headBack, p.y - v.y * headBack, p.z - v.z * headBack,
      p.x - v.x * tl, p.y - v.y * tl, p.z - v.z * tl,
      TRAIL_ALPHA * fade, TRAIL_WIDTH,
    );
  }

  /** Deflected darts (bounced off a shield) and darts dropping onto an island. */
  function stepFalling(d: Dart, dt: number, t: number, world: WorldQuery): void {
    const m = d.mesh;
    const v = d.vel;
    const damp = Math.max(0, 1 - 0.8 * dt);
    v.x *= damp;
    v.z *= damp;
    v.y -= FALL_GRAVITY * dt;
    m.position.addScaledVector(v, dt);
    _q.setFromAxisAngle(d.spinAxis, d.spinRate * dt);
    m.quaternion.premultiply(_q); // tumble

    const wy = world.waveHeight(m.position.x, m.position.z, t);
    if (d.state === DEFLECTED) {
      if (m.position.y < wy) hitWater(d, wy);
    } else if (m.position.y <= wy + 0.12) {
      // Landed on the island: stop and shrink away.
      m.position.y = wy + 0.12;
      v.set(0, 0, 0);
      d.state = LANDED;
      d.age = 0;
      d.life = LAND_TIME;
    }
  }

  /** A stuck dart: quivers like an arrow in a target for a moment, then sits still. */
  function stepStuck(d: Dart): void {
    if (d.settled) return;
    const m = d.mesh;
    const w = d.age;
    if (w >= WOBBLE_TIME) {
      d.settled = true;
      m.quaternion.copy(d.baseQuat);
    } else {
      const angle = WOBBLE_ANGLE * Math.exp(-7 * w) * Math.sin(WOBBLE_RATE * w);
      _wobbleAxis.set(Math.cos(d.wobbleAxisAngle), Math.sin(d.wobbleAxisAngle), 0);
      _q.setFromAxisAngle(_wobbleAxis, angle);
      m.quaternion.copy(d.baseQuat).multiply(_q);
    }
    // Pivot around the embedded tip: the centre is the tip pulled back along the dart's own length.
    m.position.set(0, 0, -DART_HALF_LENGTH).applyQuaternion(m.quaternion).add(d.tip);
  }

  /** Advance one dart. Returns false when it is finished and should go back to the pool. */
  function stepDart(d: Dart, dt: number, t: number, world: WorldQuery, stun: number): boolean {
    d.age += dt;
    const m = d.mesh;
    const state = d.state;

    if (state === FLYING) {
      stepFlying(d, dt, t, world, stun);
    } else if (state === DEFLECTED || state === DROPPING) {
      stepFalling(d, dt, t, world);
    } else if (state === FLOATING) {
      // Bob on the waves.
      m.position.y = world.waveHeight(m.position.x, m.position.z, t) + 0.02;
    } else if (state === STUCK) {
      stepStuck(d);
    }

    const left = d.life - d.age; // (a state change above may have reset age and life)
    if (left <= 0) return false;
    if (left < FADE_TIME) {
      const k = left / FADE_TIME;
      m.scale.setScalar(k * k * (3 - 2 * k)); // shrink away
    }
    return true;
  }

  // ─── public API ───

  function spawn(s: DartSpawn): void {
    const d = acquire();
    if (!d) return;
    const m = d.mesh;
    _dir.copy(s.direction).normalize();
    m.position.copy(s.origin);
    m.quaternion.setFromUnitVectors(Z_AXIS, _dir);
    m.scale.setScalar(1);
    m.visible = true;
    d.vel.copy(_dir).multiplyScalar(s.speed);
    d.state = FLYING;
    d.ownerId = s.ownerId;
    d.age = 0;
    d.life = CONFIG.blaster.dartLife;
    d.slot = live.length;
    live.push(d);
  }

  function update(dt: number, t: number, boats: readonly Boat[], world: WorldQuery, stunSeconds: number): DartUpdateResult {
    if (live.length === 0) return EMPTY_RESULT;
    const step = dt > MAX_STEP ? MAX_STEP : dt < 0 ? 0 : dt;
    cacheBoats(boats);
    resetEvents();
    trails.begin();

    // Walk backwards so finished darts can be swapped out safely.
    for (let i = live.length - 1; i >= 0; i--) {
      const d = live[i];
      if (!stepDart(d, step, t, world, stunSeconds)) release(d);
    }

    trails.end();
    if (!pendingHits && !pendingSplashes) return EMPTY_RESULT;
    // Fresh arrays whenever something happened, so the caller may keep them.
    return { hits: pendingHits ?? [], waterSplashes: pendingSplashes ?? [] };
  }

  function clear(): void {
    while (live.length > 0) release(live[live.length - 1]);
    trails.clear();
    resetEvents();
  }

  function dispose(): void {
    clear();
    root.removeFromParent();
    trails.dispose();
    geometry.dispose();
    material.dispose();
  }

  return {
    spawn,
    update,
    get activeCount(): number {
      return live.length;
    },
    clear,
    dispose,
  };
}
