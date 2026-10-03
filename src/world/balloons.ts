import * as THREE from 'three';
import { CONFIG } from '../config';
import type { BalloonPop, Balloons, Boat, World } from '../types';
import { buildLayout } from './layout';
import { Bag, MeshBuilder, mulberry32, placement, toyMaterial } from './util';

/**
 * Balloon Pop targets: bunches of shiny balloons, each tied to a little float, scattered
 * along the driving lanes of the lagoon. Dart one, or just drive into it: ramming is the
 * point, so a kid who cannot aim yet still pops balloons.
 *
 * The balloon centers float about 1.6 m above the water. They bob on the waves and sway on
 * their strings. Every `goldEvery`-th balloon is gold and worth 3.
 *
 * To keep the GPU happy, all the balloons are drawn with a handful of InstancedMeshes
 * (bodies, knots, strings, floats), one draw call each.
 */

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

// ───────────────────────────── Where they float ─────────────────────────────

/** Height of a balloon's center above the water (high enough for darts and passing boats to hit). */
const CENTER_Y = 1.6;
/** Balloons stay this far from every island edge, and this far inside the arena edge. */
const SHORE_GAP = 6;
const EDGE_GAP = 15;
/** Nobody starts the game standing on a balloon (and crates keep a little room too). */
const SPAWN_GAP = 12;
const CRATE_GAP = 7;
/** No two balloons closer than this; clusters (bunches) start at least this far apart. */
const MIN_APART = 5;
const MIN_CLUSTER_GAP = 16;
/** Balloons in a bunch sit in a line along the lane, a little zigzag, so one straight pass rams them all. */
const CLUSTER_SPACING = 7;
const ZIGZAG = 1.5;
/** Possible bunch spots are sampled along each lane this often. */
const LANE_STEP = 12;
/** Open-water lanes besides the race loop: rings at these fractions of the arena radius. */
const LANE_RINGS = [0.33, 0.56, 0.8];
/** Each player gets a bunch about this far ahead of the start spot, so the first pop is quick. */
const FIRST_AHEAD = 25;
const FIRST_MIN = 18;
const FIRST_MAX = 55;

// ───────────────────────────── How they look and behave ─────────────────────────────

/** Dart hit radius (the DartTarget radius). The drawn balloon is a little smaller, so darts feel generous. */
const HIT_RADIUS = 0.9;
const GOLD_HIT_RADIUS = 1.0;
const BODY_RADIUS = 0.75;
const GOLD_BODY_RADIUS = 0.8;
/** Balloons are a little taller than wide. */
const STRETCH = 1.1;
const KNOT_HEIGHT = 0.24;
/** The string's eye on top of the float, above the water. */
const EYE_Y = 0.26;
const STRING_RADIUS = 0.03;
const CURL_RADIUS = 0.08;
const CURL_TURNS = 2.5;
/** A boat closer than (its radius + this) on the XZ plane pops the balloon. */
const RAM_REACH = 1.0;
/**
 * Magnet: a boat whose edge comes within this many meters of a balloon's float tugs the balloon
 * over on its string and pops it. Near misses still count, which keeps young drivers happy.
 */
const MAGNET_REACH = 5;
/** Seconds a tugged balloon takes to reach the boat. */
const MAGNET_SEC = 0.22;
/** How far a balloon swings on its string, and how much it bounces. */
const SWAY = 0.3;
const BOUNCE = 0.08;
/** Gold balloons breathe a little so they catch your eye. */
const GOLD_PULSE = 0.04;

const GOLD = 0xffc61a;
/** Bright toy colors (no yellow: that is for gold). */
const BALLOON_COLORS: readonly number[] = [0xff3b30, 0x0a84ff, 0x30d158, 0xff9f0a, 0xbf5af2, 0xff6fae, 0x40e0d0];

interface Pt {
  x: number;
  z: number;
}

/** A possible bunch spot on a lane, with the lane's direction there (unit vector). */
interface Anchor extends Pt {
  tx: number;
  tz: number;
  used: boolean;
}

/** A closed loop of straight lane pieces: calls `emit` every `step` meters along it. */
function walkLoop(
  loop: readonly Pt[],
  step: number,
  emit: (x: number, z: number, tx: number, tz: number) => void,
): void {
  let carry = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    let d = carry;
    while (d < len) {
      emit(a.x + ux * d, a.z + uz * d, ux, uz);
      d += step;
    }
    carry = d - len;
  }
}

function circleLoop(radius: number, points: number): Pt[] {
  return Array.from({ length: points }, (_, i) => {
    const a = (i / points) * TAU;
    return { x: Math.cos(a) * radius, z: Math.sin(a) * radius };
  });
}

/**
 * Picks `wanted` balloon spots, the same every time:
 *  1. Lanes = the race loop plus a few rings around the lagoon. Walk them and keep every
 *     sample that is in open water (clear of islands, the edge, start spots and crates).
 *  2. Each player gets a bunch just ahead of their start spot.
 *  3. Then keep adding the sample farthest from every bunch so far, so they spread evenly.
 *     A bunch is 1 to 3 balloons in a short line along the lane.
 *  4. If lanes run out (a tiny arena), top up with seeded random open-water spots.
 */
function balloonSpots(world: World, wanted: number, rand: () => number): Pt[] {
  const spots: Pt[] = [];
  if (wanted <= 0) return spots;

  const maxR = world.arenaRadius - EDGE_GAP;
  const obstacles = world.obstacles;
  const spawns = world.spawnPoints(2, 'practice');
  const crates = buildLayout(world.arenaRadius).battleCrates;

  const isOpen = (x: number, z: number): boolean => {
    if (Math.hypot(x, z) > maxR) return false;
    for (const o of obstacles) if (Math.hypot(x - o.x, z - o.z) < o.radius + SHORE_GAP) return false;
    for (const s of spawns) if (Math.hypot(x - s.x, z - s.z) < SPAWN_GAP) return false;
    for (const c of crates) if (Math.hypot(x - c.x, z - c.z) < CRATE_GAP) return false;
    return true;
  };
  const farFromSpots = (x: number, z: number): boolean => spots.every((s) => Math.hypot(s.x - x, s.z - z) >= MIN_APART);

  // 1) Lanes -> possible bunch spots.
  const loops: Pt[][] = [];
  if (world.checkpoints.length >= 3) loops.push(world.checkpoints.map((c) => ({ x: c.position.x, z: c.position.z })));
  for (const f of LANE_RINGS) loops.push(circleLoop(world.arenaRadius * f, 36));
  const cands: Anchor[] = [];
  for (const loop of loops) {
    walkLoop(loop, LANE_STEP, (x, z, tx, tz) => {
      if (isOpen(x, z)) cands.push({ x, z, tx, tz, used: false });
    });
  }

  // Lay a bunch of up to `wantK` balloons (fewer if some would not fit) along the lane at `a`.
  const anchors: Anchor[] = [];
  const addBunch = (a: Anchor, wantK: number, room: number): void => {
    for (let k = Math.min(wantK, room); k >= 1; k--) {
      const bunch: Pt[] = [];
      for (let i = 0; i < k; i++) {
        const along = (i - (k - 1) / 2) * CLUSTER_SPACING;
        const zig = k > 1 ? (i % 2 === 0 ? ZIGZAG : -ZIGZAG) : 0;
        const x = a.x + a.tx * along - a.tz * zig; // the lane's sideways direction is (-tz, tx)
        const z = a.z + a.tz * along + a.tx * zig;
        if (!isOpen(x, z) || !farFromSpots(x, z)) break;
        bunch.push({ x, z });
      }
      if (bunch.length === k) {
        spots.push(...bunch);
        anchors.push(a);
        return;
      }
    }
  };
  const rollSize = (): number => {
    const r = rand();
    return r < 0.25 ? 1 : r < 0.65 ? 2 : 3;
  };

  // 2) A full bunch ahead of each start spot.
  for (const s of spawns) {
    const aheadX = s.x + Math.sin(s.heading) * FIRST_AHEAD;
    const aheadZ = s.z + Math.cos(s.heading) * FIRST_AHEAD;
    let best: Anchor | null = null;
    let bestD = Infinity;
    for (const a of cands) {
      const fromSpawn = Math.hypot(a.x - s.x, a.z - s.z);
      if (a.used || fromSpawn < FIRST_MIN || fromSpawn > FIRST_MAX) continue;
      const d = Math.hypot(a.x - aheadX, a.z - aheadZ);
      if (d < bestD) {
        best = a;
        bestD = d;
      }
    }
    if (best) {
      best.used = true;
      addBunch(best, 3, wanted - spots.length);
    }
  }

  // 3) Farthest-first: always the unused sample that is farthest from every bunch so far.
  while (spots.length < wanted) {
    let best: Anchor | null = null;
    let bestD = MIN_CLUSTER_GAP;
    for (const a of cands) {
      if (a.used) continue;
      let d = Infinity;
      for (const c of anchors) d = Math.min(d, Math.hypot(a.x - c.x, a.z - c.z));
      if (d > bestD) {
        best = a;
        bestD = d;
      }
    }
    if (!best) break;
    best.used = true;
    addBunch(best, rollSize(), wanted - spots.length);
  }

  // 4) Top up with seeded random open-water spots (only needed if the lanes were too crowded).
  for (let tries = 0; spots.length < wanted && tries < 6000; tries++) {
    const ang = rand() * TAU;
    const rad = Math.sqrt(rand()) * maxR;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    if (isOpen(x, z) && farFromSpots(x, z)) spots.push({ x, z });
  }
  return spots;
}

/** The curly string: a loose spiral from y = 0 (the float) up to y = 1 (the knot), scaled to length per balloon. */
class CurlCurve extends THREE.Curve<THREE.Vector3> {
  constructor() {
    super(); // (Curve's own constructor is protected; this makes `new CurlCurve()` allowed)
  }

  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = t * TAU * CURL_TURNS;
    // Start and end on the center line so the string meets the float and the knot cleanly.
    const taper = Math.min(1, t * 6, (1 - t) * 6);
    return target.set(Math.cos(a) * CURL_RADIUS * taper, t, Math.sin(a) * CURL_RADIUS * taper);
  }
}

interface Balloon {
  // These four are the DartTarget the dart system reads.
  id: number;
  position: THREE.Vector3;
  radius: number;
  alive: boolean;
  /** Where the float sits on the water. */
  x: number;
  z: number;
  value: number;
  color: number;
  gold: boolean;
  /** Gives every balloon its own rhythm. */
  phase: number;
  bodyRadius: number;
  /** Which instanced mesh draws the body, and which instance. */
  body: THREE.InstancedMesh;
  bodyIndex: number;
  /** Magnet pull 0..1, and how far the balloon is currently tugged off its float (meters). */
  tug: number;
  pullX: number;
  pullZ: number;
}

/** Balloon Pop targets floating around the lagoon. */
export function createBalloons(scene: THREE.Scene, world: World): Balloons {
  const bag = new Bag();
  const root = new THREE.Group();
  root.name = 'balloons';
  scene.add(root);

  const rand = mulberry32(21);
  const spots = balloonSpots(world, Math.max(0, Math.floor(CONFIG.practice.balloons)), rand);
  const total = spots.length;

  const goldEvery = Math.floor(CONFIG.practice.goldEvery);
  const isGold = (i: number): boolean => goldEvery > 0 && (i + 1) % goldEvery === 0;
  let goldCount = 0;
  for (let i = 0; i < total; i++) if (isGold(i)) goldCount++;

  // --- Shared pieces ---
  const bodyGeo = bag.add(new THREE.SphereGeometry(1, 20, 14));
  const normalMat = bag.add(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0 }));
  const goldMat = bag.add(
    new THREE.MeshStandardMaterial({ color: GOLD, emissive: 0x6a4300, roughness: 0.28, metalness: 0.85 }),
  );

  const knotGeo = bag.add(new THREE.ConeGeometry(0.14, KNOT_HEIGHT, 8)); // point up, flares toward the string
  const knotMat = bag.add(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 }));

  const stringGeo = bag.add(new THREE.TubeGeometry(new CurlCurve(), 36, STRING_RADIUS, 5, false));
  const stringMat = bag.add(new THREE.MeshStandardMaterial({ color: 0xf6f1e4, roughness: 0.6, metalness: 0 }));

  // The float: an orange puck with a white band and a little ring on top for the string.
  const parts = new MeshBuilder();
  const puck = new THREE.CylinderGeometry(0.36, 0.44, 0.36, 12);
  const band = new THREE.CylinderGeometry(0.45, 0.45, 0.07, 12);
  const eye = new THREE.TorusGeometry(0.07, 0.025, 5, 8);
  parts.add(puck, { matrix: placement(0, 0.08, 0), color: 0xff8a1a });
  parts.add(band, { matrix: placement(0, 0.1, 0), color: 0xffffff });
  parts.add(eye, { matrix: placement(0, EYE_Y + 0.04, 0), color: 0xffffff });
  puck.dispose();
  band.dispose();
  eye.dispose();
  const floatGeo = bag.add(parts.build() as THREE.BufferGeometry);
  const floatMat = bag.add(toyMaterial());

  const makeInstanced = (
    name: string,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    count: number,
  ): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    mesh.name = name;
    mesh.count = count;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // instances are spread over the whole lagoon and move every frame
    root.add(mesh);
    bag.add(mesh);
    return mesh;
  };
  const normalBodies = makeInstanced('balloon-bodies', bodyGeo, normalMat, total - goldCount);
  const goldBodies = makeInstanced('balloon-gold-bodies', bodyGeo, goldMat, goldCount);
  const knots = makeInstanced('balloon-knots', knotGeo, knotMat, total);
  const strings = makeInstanced('balloon-strings', stringGeo, stringMat, total);
  const floats = makeInstanced('balloon-floats', floatGeo, floatMat, total);
  const meshes = [normalBodies, goldBodies, knots, strings, floats];

  // --- The balloons ---
  const tmpColor = new THREE.Color();
  let normalIndex = 0;
  let goldIndex = 0;
  const balloons: Balloon[] = spots.map((s, i) => {
    const gold = isGold(i);
    const color = gold ? GOLD : BALLOON_COLORS[i % BALLOON_COLORS.length];
    const body = gold ? goldBodies : normalBodies;
    const bodyIndex = gold ? goldIndex++ : normalIndex++;
    if (!gold) normalBodies.setColorAt(bodyIndex, tmpColor.setHex(color));
    knots.setColorAt(i, tmpColor.setHex(color));
    return {
      id: i,
      position: new THREE.Vector3(s.x, CENTER_Y, s.z),
      radius: gold ? GOLD_HIT_RADIUS : HIT_RADIUS,
      alive: true,
      x: s.x,
      z: s.z,
      value: gold ? 3 : 1,
      color,
      gold,
      phase: rand() * TAU,
      bodyRadius: gold ? GOLD_BODY_RADIUS : BODY_RADIUS,
      body,
      bodyIndex,
      tug: 0,
      pullX: 0,
      pullZ: 0,
    };
  });
  for (const m of [normalBodies, knots]) if (m.instanceColor) m.instanceColor.needsUpdate = true;

  let remaining = total;
  let disposed = false;

  // Scratch objects (no per-frame allocations).
  const axis = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const mat4 = new THREE.Matrix4();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const NONE: BalloonPop[] = Object.freeze([]) as unknown as BalloonPop[];

  const touch = (): void => {
    for (const m of meshes) m.instanceMatrix.needsUpdate = true;
  };

  /** Moves one balloon (and its knot, string and float) to where it belongs at time t. */
  const place = (b: Balloon, t: number): void => {
    const floatY = world.waveHeight(b.x, b.z, t);
    const swayX = SWAY * Math.sin(t * 0.85 + b.phase) + b.pullX;
    const swayZ = SWAY * Math.sin(t * 0.67 + b.phase * 1.7 + 1.3) + b.pullZ;
    const centerY = floatY + CENTER_Y + BOUNCE * Math.sin(t * 1.9 + b.phase);
    b.position.set(b.x + swayX, centerY, b.z + swayZ);

    // The balloon hangs from its float on a string: tilt the whole stack along that line.
    axis.set(swayX, centerY - (floatY + EYE_Y), swayZ);
    const len = axis.length();
    axis.multiplyScalar(1 / len);
    quat.setFromUnitVectors(UP, axis);

    const halfHeight = b.bodyRadius * STRETCH;
    const pulse = b.gold ? 1 + GOLD_PULSE * Math.sin(t * 4 + b.phase) : 1;
    const r = b.bodyRadius * pulse;
    b.body.setMatrixAt(b.bodyIndex, mat4.compose(b.position, quat, scale.set(r, r * STRETCH, r)));

    // The knot hangs under the balloon, its tip tucked into the body.
    pos.copy(b.position).addScaledVector(axis, -(halfHeight - 0.03 + KNOT_HEIGHT * 0.5));
    knots.setMatrixAt(b.id, mat4.compose(pos, quat, ONE));

    // The string runs from the float's eye up to the bottom of the knot.
    const stringLength = Math.max(0.12, len - halfHeight + 0.03 - KNOT_HEIGHT);
    pos.set(b.x, floatY + EYE_Y, b.z);
    strings.setMatrixAt(b.id, mat4.compose(pos, quat, scale.set(1, stringLength, 1)));

    floats.setMatrixAt(b.id, mat4.makeTranslation(b.x, floatY, b.z));
  };

  const hide = (b: Balloon): void => {
    b.body.setMatrixAt(b.bodyIndex, ZERO);
    knots.setMatrixAt(b.id, ZERO);
    strings.setMatrixAt(b.id, ZERO);
    floats.setMatrixAt(b.id, ZERO);
    touch(); // upload now: the game may stop calling update() once the last one is popped
  };

  const popBalloon = (b: Balloon, boatId: number): BalloonPop => {
    b.alive = false;
    remaining--;
    hide(b);
    return { targetId: b.id, boatId, position: b.position.clone(), value: b.value, color: b.color };
  };

  for (const b of balloons) place(b, 0);
  touch();

  return {
    targets: balloons,
    total,

    get remaining(): number {
      return remaining;
    },

    update(t: number, dt: number, boats: readonly Boat[]): BalloonPop[] {
      if (disposed || remaining === 0) return NONE;
      let pops: BalloonPop[] | null = null;
      for (const b of balloons) {
        if (!b.alive) continue;

        // Magnet: find the boat whose edge is nearest the float; a close one reels the balloon in.
        let near: Boat | null = null;
        let nearGap = Infinity;
        for (const boat of boats) {
          const gap = Math.hypot(boat.position.x - b.x, boat.position.z - b.z) - boat.radius;
          if (gap < nearGap) {
            nearGap = gap;
            near = boat;
          }
        }
        if (near && nearGap < MAGNET_REACH) {
          b.tug = Math.min(1, b.tug + dt / MAGNET_SEC);
          const k = b.tug * b.tug; // slow start, then a quick zip to the boat
          b.pullX = (near.position.x - b.x) * k;
          b.pullZ = (near.position.z - b.z) * k;
        } else if (b.tug > 0) {
          b.tug = Math.max(0, b.tug - dt / (MAGNET_SEC * 2));
          const keep = Math.exp(-8 * dt); // the boat got away: drift back over the float
          b.pullX *= keep;
          b.pullZ *= keep;
        }
        place(b, t);
        if (near && b.tug >= 1) {
          (pops ??= []).push(popBalloon(b, near.id));
          continue;
        }

        // Ramming: the nearest boat that is close enough pops it.
        let rammer: Boat | null = null;
        let rammerD = Infinity;
        for (const boat of boats) {
          const dx = boat.position.x - b.position.x;
          const dz = boat.position.z - b.position.z;
          const reach = boat.radius + RAM_REACH;
          const d2 = dx * dx + dz * dz;
          if (d2 < reach * reach && d2 < rammerD) {
            rammer = boat;
            rammerD = d2;
          }
        }
        if (rammer) (pops ??= []).push(popBalloon(b, rammer.id));
      }
      touch();
      return pops ?? NONE;
    },

    pop(targetId: number, boatId: number): BalloonPop | null {
      const b = balloons[targetId];
      if (!b || !b.alive) return null;
      return popBalloon(b, boatId);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      // The dart system may still hold `targets`: make sure nothing here can be hit any more.
      for (const b of balloons) b.alive = false;
      remaining = 0;
      scene.remove(root);
      bag.disposeAll();
    },
  };
}
