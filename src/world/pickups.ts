import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CONFIG } from '../config';
import type { Boat, ModeId, PickupEvent, Pickups, PowerUpKind, World } from '../types';
import { buildLayout } from './layout';
import { Bag, makeCanvas, mulberry32 } from './util';
import { waveHeight, waveNormal } from './waves';

/**
 * Floating power-up crates: gold boxes with a big "?" that bob on the waves and
 * spin. Drive into one to grab it; it grows back a few seconds later.
 *
 * Each crate has a pale beam of light above it and a foam ring around it so
 * you can spot it from across the lagoon.
 */

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
/** Collected when a boat is closer than (boat radius + this) on the XZ plane. */
const PICKUP_REACH = 1.5;
const CRATE_SIZE = 1.7;
const HOVER = 1.5; // how high the crate floats above the water
const POP_IN_SEC = 0.5;
const POP_OUT_SEC = 0.22;

const KINDS_BATTLE: readonly PowerUpKind[] = ['triple', 'rapid', 'shield', 'turbo'];
const KINDS_RACE: readonly PowerUpKind[] = ['triple', 'shield', 'turbo']; // rapid fire is useless when darts don't score

type CrateState = 'live' | 'popping' | 'gone';

interface Crate {
  group: THREE.Group;
  box: THREE.Mesh;
  ring: THREE.Mesh;
  beam: THREE.Mesh;
  /** Where the crate floats (the live Vector3 handed out in `positions`). y follows the bobbing. */
  pos: THREE.Vector3;
  /** Fixed water spot. */
  x: number;
  z: number;
  state: CrateState;
  /** Seconds since it popped in (live) or since it was grabbed (popping). */
  age: number;
  respawnAt: number;
  phase: number;
}

const easeOutBack = (p: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

/**
 * Where crates live. Race: just off the racing line between gates. Every other mode (battle,
 * Team Up, Balloon Pop): hand-placed spread around the lagoon.
 */
function crateSpots(world: World, mode: ModeId, wanted: number): { x: number; z: number }[] {
  if (mode !== 'race') {
    return buildLayout(world.arenaRadius).battleCrates.slice(0, wanted);
  }
  const gates = world.checkpoints;
  const n = gates.length;
  if (n < 2) return [];
  const mids: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = gates[i].position;
    const b = gates[(i + 1) % n].position;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const off = i % 2 === 0 ? 3 : -3; // wiggle side to side so the line isn't always dead centre
    mids.push({ x: (a.x + b.x) / 2 + (dz / len) * off, z: (a.z + b.z) / 2 - (dx / len) * off });
  }
  // Spread `wanted` crates evenly around the loop, starting after gate 1 so none sit on the start grid.
  const count = Math.min(wanted, n);
  const out: { x: number; z: number }[] = [];
  for (let k = 0; k < count; k++) out.push(mids[(1 + Math.round((k * n) / count)) % n]);
  return out;
}

function questionTexture(): THREE.CanvasTexture | null {
  const made = makeCanvas(256, 256);
  if (!made) return null;
  const { canvas, ctx } = made;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#ffcf3d');
  g.addColorStop(1, '#ff9d1c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  // A darker frame so the box has "edges" even though it is one flat color.
  ctx.lineWidth = 22;
  ctx.strokeStyle = '#d9730d';
  ctx.strokeRect(11, 11, 234, 234);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#ffe9a6';
  ctx.strokeRect(26, 26, 204, 204);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 190px "Fredoka", system-ui, sans-serif';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 22;
  ctx.strokeStyle = '#0b4a9e';
  ctx.strokeText('?', 128, 138);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('?', 128, 138);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Vertical fade for the light beam: opaque at the bottom, clear at the top. */
function beamTexture(): THREE.CanvasTexture | null {
  const made = makeCanvas(4, 64);
  if (!made) return null;
  const { canvas, ctx } = made;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(255,255,255,0.3)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Floating power-up crates. */
export function createPickups(scene: THREE.Scene, world: World, mode: ModeId): Pickups {
  const bag = new Bag();
  const root = new THREE.Group();
  root.name = 'pickups';
  scene.add(root);

  const rand = mulberry32(mode === 'race' ? 7 : 3);
  const kinds = mode === 'race' ? KINDS_RACE : KINDS_BATTLE;
  const wanted = Math.max(0, CONFIG.powerUps.maxActive);
  const spots = crateSpots(world, mode, wanted);

  // --- Shared pieces ---
  const boxGeo = bag.add(new RoundedBoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE, 3, 0.28));
  const qTex = questionTexture();
  if (qTex) bag.add(qTex);
  const boxMat = bag.add(
    new THREE.MeshStandardMaterial({
      map: qTex,
      color: qTex ? 0xffffff : 0xffb21c,
      roughness: 0.45,
      metalness: 0,
      // A little self-glow so crates stay readable in shadow and at a distance.
      emissive: 0xffffff,
      emissiveMap: qTex,
      emissiveIntensity: qTex ? 0.28 : 0,
    }),
  );
  const ringGeo = bag.add(new THREE.RingGeometry(1.5, 2.4, 28));
  ringGeo.rotateX(-Math.PI / 2); // lie flat on the water
  const ringMat = bag.add(
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }),
  );
  const beamGeo = bag.add(new THREE.CylinderGeometry(0.55, 1.0, 14, 12, 1, true));
  const bTex = beamTexture();
  if (bTex) bag.add(bTex);
  const beamMat = bag.add(
    new THREE.MeshBasicMaterial({
      map: bTex,
      color: 0xffe27a,
      transparent: true,
      opacity: bTex ? 1 : 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );

  // --- The crates ---
  const crates: Crate[] = spots.map((s, i) => {
    const group = new THREE.Group();
    group.name = `crate-${i}`;
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.y = HOVER;
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.12;
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.y = 7;
    group.add(box, ring, beam);
    group.position.set(s.x, 0, s.z);
    root.add(group);
    return {
      group,
      box,
      ring,
      beam,
      pos: new THREE.Vector3(s.x, HOVER, s.z),
      x: s.x,
      z: s.z,
      state: 'live' as CrateState,
      age: 0,
      respawnAt: 0,
      phase: rand() * TAU,
    };
  });

  const positions: THREE.Vector3[] = [];
  const rebuildPositions = (): void => {
    positions.length = 0;
    for (const c of crates) if (c.state === 'live') positions.push(c.pos);
  };
  rebuildPositions();

  // Handed back on the (common) frames when nothing was collected, so we do not allocate every frame.
  const NONE: PickupEvent[] = Object.freeze([]) as unknown as PickupEvent[];
  const normal = new THREE.Vector3();
  const tilt = new THREE.Quaternion();
  let lastT = 0;
  let disposed = false;

  const setVisible = (c: Crate, visible: boolean): void => {
    c.group.visible = visible;
  };
  crates.forEach((c) => setVisible(c, true));

  return {
    positions,

    update(t: number, dt: number, boats: readonly Boat[]): PickupEvent[] {
      lastT = t;
      if (disposed) return NONE;
      let events: PickupEvent[] | null = null;
      let changed = false;

      for (const c of crates) {
        if (c.state === 'gone') {
          if (t >= c.respawnAt) {
            c.state = 'live';
            c.age = 0;
            setVisible(c, true);
            changed = true;
          } else {
            continue;
          }
        }

        c.age += dt;
        const h = waveHeight(c.x, c.z, t);
        c.group.position.y = h;

        // Bob, spin and wobble (the box itself); the ring and beam stay put on the water.
        const bob = 0.22 * Math.sin(t * 2.3 + c.phase);
        c.box.position.y = HOVER + bob;
        c.box.rotation.set(0.14 * Math.sin(t * 1.9 + c.phase), c.box.rotation.y + dt * 1.7, 0.1 * Math.cos(t * 1.6 + c.phase));
        c.pos.y = h + HOVER + bob;

        // The ring lies on the surface: tip it to match the wave and pulse it.
        waveNormal(c.x, c.z, t, normal);
        tilt.setFromUnitVectors(UP, normal);
        c.ring.quaternion.copy(tilt);
        const pulse = 1 + 0.12 * Math.sin(t * 3 + c.phase);

        let boxScale: number;
        let fx: number;
        if (c.state === 'live') {
          const p = Math.min(1, c.age / POP_IN_SEC);
          boxScale = easeOutBack(p);
          fx = p;
        } else {
          // Quick "pop": swell, then shrink to nothing.
          const q = Math.min(1, c.age / POP_OUT_SEC);
          boxScale = q < 0.35 ? 1 + 0.4 * (q / 0.35) : 1.4 * (1 - (q - 0.35) / 0.65);
          fx = 1 - q;
          if (q >= 1) {
            c.state = 'gone';
            setVisible(c, false);
            continue;
          }
        }
        c.box.scale.setScalar(Math.max(0.0001, boxScale));
        c.ring.scale.setScalar(Math.max(0.0001, fx * pulse));
        c.beam.scale.set(Math.max(0.0001, fx), 1, Math.max(0.0001, fx));

        if (c.state !== 'live') continue;

        // Who is close enough? The nearest boat wins if two arrive in the same frame.
        let best: Boat | null = null;
        let bestD = Infinity;
        for (const boat of boats) {
          const dx = boat.position.x - c.x;
          const dz = boat.position.z - c.z;
          const reach = boat.radius + PICKUP_REACH;
          const d2 = dx * dx + dz * dz;
          if (d2 < reach * reach && d2 < bestD) {
            best = boat;
            bestD = d2;
          }
        }
        if (best) {
          const kind = kinds[Math.floor(rand() * kinds.length) % kinds.length];
          (events ??= []).push({ boatId: best.id, kind, position: c.pos.clone() });
          c.state = 'popping';
          c.age = 0;
          c.respawnAt = t + CONFIG.powerUps.respawnSec;
          changed = true;
        }
      }

      if (changed) rebuildPositions();
      return events ?? NONE;
    },

    /** Takes every crate off the water; they come back after the usual respawn time. */
    clear(): void {
      for (const c of crates) {
        c.state = 'gone';
        c.respawnAt = lastT + CONFIG.powerUps.respawnSec;
        setVisible(c, false);
      }
      rebuildPositions();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      positions.length = 0;
      bag.disposeAll();
    },
  };
}
