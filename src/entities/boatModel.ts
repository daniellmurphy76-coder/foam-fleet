/**
 * Foam Fleet: the toy-boat 3D model.
 *
 * Everything here is built from primitives at runtime (no model files). To keep the number of
 * draw calls low, all the static pieces that share a color are merged into ONE mesh
 * (see `Part`). Only the bits that move on their own (turret, captain's head, flame, shield,
 * flag, propeller, team marker) stay as separate objects, and `buildBoatRig` hands them to
 * boat.ts as handles.
 *
 * The look comes from a `BoatLook` (Boat Garage): the hull (boatStyles.ts; hull 3, the BoneBoat, is built
 * in boneBoat.ts), the paint pattern (boatPaint.ts, or tinted tips on the BoneBoat), the hat (boatHats.ts)
 * and the flag (boatFlags.ts). It works without a game
 * world: a freshly built rig is already in a nice resting pose.
 *
 * Local axes: +Z = bow (front), +Y = up, +X = the boat's LEFT. Waterline is y = 0.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { BoatLook } from '../types';
import { buildFlag, buildMarker } from './boatFlags';
import { extrude, limb, MaterialBag, Part, roundedRect, xf } from './boatGeo';
import { buildHat } from './boatHats';
import { buildPaint, type PaintJob } from './boatPaint';
import { planPoints, styleFor, type StyleSpec } from './boatStyles';
import { buildBoneHull } from './boneBoat';

export { FLAG_YAW, MARKER_HEIGHT } from './boatFlags';

// ───────────────────────────── what boat.ts gets back ─────────────────────────────

export interface BoatRig {
  /** Add this to the scene. Its position/rotation are driven by the boat. */
  root: THREE.Group;
  /** Paint material of the hull (also the hat band, gems and, on patterned boats, the deck). */
  hullMat: THREE.MeshStandardMaterial;
  /** Every paint material (hull + pattern decals): boat.ts pulses their emissive for the hit flash. */
  paintMats: THREE.MeshStandardMaterial[];
  /** Blue blaster parts; glows while Rapid Fire is active. */
  blasterGlowMat: THREE.MeshStandardMaterial;
  /** Turns left/right (local Y rotation) to follow the aim target. */
  turretYaw: THREE.Group;
  /** Tilts the barrel up/down (local X rotation, negative = muzzle up). */
  turretPitch: THREE.Group;
  /** Slides back along Z when the blaster fires. */
  turretRecoil: THREE.Group;
  /** Empty marker at the very tip of the barrel; its world position is where darts start. */
  muzzle: THREE.Object3D;
  muzzleFlash: THREE.Mesh;
  /** Two extra little barrels, shown during Triple Shot. */
  sideBarrels: THREE.Object3D;
  /** The captain's head: turns into corners. */
  head: THREE.Group;
  /** Spinning blades on the propeller beanie (null for every other hat). Spin it about Y. */
  propeller: THREE.Object3D | null;
  /** Engine flame; scale.z = length. Shown while boosting. */
  flame: THREE.Group;
  /** Pivot at the top of the stern mast; flutter it (rotation.y around `flagYaw`). Empty when the look has no flag. */
  flag: THREE.Group;
  /** True when there is a flag to flutter. */
  hasFlag: boolean;
  /** Floating team diamond (null when the boat has no marker). Bob it and spin it about Y. */
  marker: THREE.Group | null;
  /** BoneBoat only (else null): the soft glow around the skull's eyes. Pulse its opacity. */
  eyeHalo: THREE.MeshBasicMaterial | null;
  /** Holder for the translucent bubble: show/hide it and scale it (use SHIELD_SIZE for the base scale). */
  shield: THREE.Group;
  /** The bubble itself, inside `shield`. Spin it for a shimmer (spinning the group would spin the ellipsoid). */
  shieldSpin: THREE.Mesh;
  shieldMat: THREE.MeshStandardMaterial;
  /** Height above the waterline of the middle of the boat (for the dart hit sphere). */
  centerY: number;
  /** Free every geometry and material this rig made. */
  dispose(): void;
}

/** Size (half extents, meters) of the shield bubble that wraps the boat. */
export const SHIELD_SIZE = { x: 1.6, y: 1.7, z: 3.0 };

// ───────────────────────────── palette ─────────────────────────────

const TRIM = 0xf7f7f2; // white trim
const DECK = 0xf2dfae; // sandy deck boards
const GLASS = 0xbfeaff;
const VEST = 0xff9a1f; // the captain's life vest
const SHORTS = 0x2a64c8;
const DARK = 0x2b2f3a;
const BLASTER_ORANGE = 0xff7a1a;
const BLASTER_BLUE = 0x2f7bff;
const SKIN_TONES = [0xf7d2b0, 0xe8b48a, 0xc68b5c, 0x8d5a3a];

interface Parts {
  hull: Part;
  trim: Part;
  /** Sandy deck boards (plain "solid" paint). */
  deck: Part;
  /** Deck painted in the hull color (patterned paint). */
  paintDeck: Part;
  glass: Part;
  vest: Part;
  dark: Part;
  blue: Part;
  shorts: Part;
}

// ───────────────────────────── hull builders ─────────────────────────────

/** One-piece hull (styles 0 and 1): painted body, white stripe, white rim, deck. */
function buildMonoHull(s: StyleSpec, P: Parts, deck: Part): void {
  const B = s.bulge; // how much the bevel bulges the hull wall outward
  P.hull.add(extrude(new THREE.Shape(planPoints(s)), s.deckY, s.deckY + 0.5, B, B));
  // white stripe just proud of the painted wall
  P.trim.add(extrude(new THREE.Shape(planPoints(s)), 0.34, 0.12, 0.015, B + 0.02));
  // white rim (gunwale) around the edge of the deck
  const rim = new THREE.Shape(planPoints(s));
  rim.holes.push(new THREE.Path(planPoints(s, 0.14)));
  P.trim.add(extrude(rim, s.deckY + s.rimUp, s.rimUp + 0.1, 0.03, B + 0.015));
  // deck boards
  deck.add(extrude(new THREE.Shape(planPoints(s, 0.14)), s.deckY + 0.03, 0.06));
}

/** Catamaran hull (style 2): two pontoons, a deck across them, front and rear beams. */
function buildCatHull(s: StyleSpec, P: Parts, deck: Part): void {
  const B = s.bulge;
  for (const side of [-1, 1]) {
    const cx = side * s.hullX;
    P.hull.add(extrude(new THREE.Shape(planPoints(s, 0, cx)), 0.46, 0.96, B, B));
    P.trim.add(extrude(new THREE.Shape(planPoints(s, 0.12, cx)), 0.5, 0.06)); // white strip on top
    P.trim.add(extrude(new THREE.Shape(planPoints(s, 0, cx)), 0.3, 0.1, 0.012, B + 0.02)); // waterline stripe
  }
  deck.add(extrude(roundedRect(2.75, 3.1, 0.3, 0, -0.2), s.deckY, 0.12, 0.02, 0.02));
  P.trim.add(new THREE.BoxGeometry(2.0, 0.14, 0.2), xf(0, 0.5, 1.55)); // front beam
  P.trim.add(new THREE.BoxGeometry(2.0, 0.34, 0.14), xf(0, 0.55, -1.85)); // rear beam (motor sits here)
}

// ───────────────────────────── the big builder ─────────────────────────────

/**
 * Build one boat from its look. `markerColor` is the Team Up team color (a diamond floats over the
 * boat and the flag cloth takes this color), or null in free-for-all modes.
 */
export function buildBoatRig(look: BoatLook, color: number, id: number, markerColor: number | null): BoatRig {
  const s = styleFor(look.hull);
  const y = s.deckY;
  const bone = s.kind === 'bone'; // the BoneBoat has its own builder: no windshield, paint decals or sandy deck
  const lift = s.turretLift ?? 0;

  // Materials: every boat gets its own so colors and flashes never leak between boats.
  const mats = new MaterialBag();
  const hullMat = mats.std(color, { emissive: 0xffffff, emissiveIntensity: 0 }); // emissive = hit flash
  const trimMat = mats.std(TRIM);
  const deckMat = mats.std(DECK, { roughness: 0.8 });
  const glassMat = mats.std(GLASS, { transparent: true, opacity: 0.45, roughness: 0.1, depthWrite: false });
  const vestMat = mats.std(VEST);
  const shortsMat = mats.std(SHORTS);
  const darkMat = mats.std(DARK, { roughness: 0.7 });
  const orangeMat = mats.std(BLASTER_ORANGE);
  const blueMat = mats.std(BLASTER_BLUE, { emissive: BLASTER_BLUE, emissiveIntensity: 0 }); // glows for Rapid Fire
  const skinMat = mats.std(SKIN_TONES[((id % 4) + 4) % 4]);
  const flameOuterMat = mats.basic(0xff9d1c, { transparent: true, opacity: 0.9, depthWrite: false });
  const flameInnerMat = mats.basic(0xfff0a0, { transparent: true, opacity: 0.95, depthWrite: false });
  const flashMat = mats.basic(0xfff1b8, { transparent: true, opacity: 0.9, depthWrite: false });
  const shieldMat = mats.std(0x7fe9ff, {
    transparent: true, opacity: 0.28, roughness: 0.15, emissive: 0x2fb8ff, emissiveIntensity: 0.35,
    depthWrite: false, side: THREE.DoubleSide,
  });

  const P: Parts = {
    hull: new Part(), trim: new Part(), deck: new Part(), paintDeck: new Part(), glass: new Part(),
    vest: new Part(), dark: new Part(), blue: new Part(), shorts: new Part(),
  };

  // ── paint pattern (decides which deck we build; on the BoneBoat it tints the bone tips instead) ──
  const job: PaintJob = bone ? { paintDeck: false, decals: [], flash: [] } : buildPaint(s, look.pattern, color, mats);

  // ── hull ──
  const deckPart = job.paintDeck ? P.paintDeck : P.deck;
  if (s.kind === 'mono') buildMonoHull(s, P, deckPart);
  else if (s.kind === 'cat') buildCatHull(s, P, deckPart);
  const boneHull = bone ? buildBoneHull(s, look.pattern, color, hullMat, mats) : null;

  // ── dashboard, windshield, seat ──
  if (bone) {
    // no glass on a skeleton: just a bone post holding the steering wheel
    P.trim.add(new THREE.CylinderGeometry(0.035, 0.045, 0.5, 6), xf(0, y + 0.27, s.windZ - 0.3));
  } else {
    P.trim.add(new THREE.BoxGeometry(s.windW * 0.95, 0.28, 0.34), xf(0, y + 0.14, s.windZ - 0.12));
    P.glass.add(new THREE.BoxGeometry(s.windW, 0.44, 0.04), xf(0, y + 0.5, s.windZ + 0.1, -0.6));
    for (const sx of [-1, 1]) {
      P.trim.add(new THREE.BoxGeometry(0.05, 0.5, 0.06), xf(sx * (s.windW / 2), y + 0.5, s.windZ + 0.1, -0.6));
    }
  }
  P.trim.add(new THREE.BoxGeometry(0.74, 0.2, 0.5), xf(0, y + 0.1, s.seatZ)); // seat
  P.trim.add(new THREE.BoxGeometry(0.74, 0.55, 0.12), xf(0, y + 0.4, s.seatZ - 0.3, -0.15)); // backrest

  // ── captain: body in a life vest, shorts, arms to the steering wheel ──
  P.vest.add(new THREE.CapsuleGeometry(0.24, 0.3, 2, 8), xf(0, y + 0.62, s.seatZ));
  for (const sx of [-1, 1]) {
    P.shorts.add(new THREE.BoxGeometry(0.2, 0.2, 0.55), xf(sx * 0.14, y + 0.3, s.seatZ + 0.35)); // legs
    limb(
      P.vest,
      new THREE.Vector3(sx * 0.27, y + 0.82, s.seatZ),
      new THREE.Vector3(sx * 0.11, y + 0.66, s.windZ - 0.3),
      0.07,
    );
  }
  P.dark.add(new THREE.TorusGeometry(0.13, 0.028, 5, 10), xf(0, y + 0.66, s.windZ - 0.3, -0.9)); // steering wheel

  // ── tug: smokestack off to the side ──
  if (s.stack) {
    P.trim.add(new THREE.CylinderGeometry(0.16, 0.2, 0.8, 8), xf(0.65, y + 0.45, s.seatZ - 0.9));
    P.hull.add(new THREE.CylinderGeometry(0.21, 0.21, 0.18, 8), xf(0.65, y + 0.84, s.seatZ - 0.9));
    P.dark.add(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 8), xf(0.65, y + 0.95, s.seatZ - 0.9));
  }

  // ── outboard motor on the back ──
  P.dark.add(new THREE.BoxGeometry(0.4, 0.45, 0.42), xf(0, 0.5, s.motorZ)); // cowling
  P.dark.add(new THREE.BoxGeometry(0.14, 0.7, 0.2), xf(0, 0.0, s.motorZ)); // leg
  P.dark.add(new THREE.CylinderGeometry(0.1, 0.12, 0.16, 8), xf(0, 0.38, s.motorZ - 0.28, Math.PI / 2)); // exhaust nozzle

  // ── flag on its little stern mast (the pole goes into the trim mesh; the cloth is built below).
  //    On the BoneBoat the mast stands on the tail's stern bone. ──
  const flagBuild = buildFlag(look.flag, markerColor ?? color, s.mastX, s.mastZ, y, P.trim, mats);

  // ── the blaster's fixed base (on a short pedestal when the hull asks for a lift: the BoneBoat's skull is tall) ──
  P.blue.add(new THREE.CylinderGeometry(0.4, 0.46, 0.22, 10), xf(0, y + 0.11 + lift, s.turretZ));
  if (lift > 0) P.trim.add(new THREE.CylinderGeometry(0.27, 0.36, lift + 0.04, 8), xf(0, y + lift / 2, s.turretZ));

  // ───────── assemble the static meshes ─────────
  const root = new THREE.Group();
  root.rotation.order = 'YXZ'; // yaw first, then pitch, then roll (so tilting happens in the boat's own frame)

  const staticMesh = (part: Part, mat: THREE.Material, shadow = true, receive = false): void => {
    const m = part.mesh(mat, shadow);
    if (!m) return;
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false; // never moves relative to the boat
    m.updateMatrix();
    root.add(m);
  };
  staticMesh(P.hull, hullMat);
  staticMesh(P.trim, trimMat);
  staticMesh(P.deck, deckMat, true, true);
  staticMesh(P.paintDeck, hullMat, true, true);
  for (const d of job.decals) staticMesh(d.part, d.mat, false);
  if (boneHull) for (const m of boneHull.meshes) root.add(m);
  staticMesh(P.glass, glassMat, false);
  staticMesh(P.vest, vestMat);
  staticMesh(P.shorts, shortsMat);
  staticMesh(P.dark, darkMat);
  staticMesh(P.blue, blueMat);

  // ── captain's head (turns into corners) and hat ──
  const head = new THREE.Group();
  head.position.set(0, y + 1.0, s.seatZ + 0.02);
  const headPart = new Part();
  headPart.add(new THREE.SphereGeometry(0.27, 8, 6), xf(0, 0.22, 0));
  const headMesh = headPart.mesh(skinMat);
  const eyePart = new Part();
  for (const sx of [-1, 1]) eyePart.add(new THREE.SphereGeometry(0.045, 5, 4), xf(sx * 0.1, 0.22, 0.245));
  const eyeMesh = eyePart.mesh(darkMat, false);
  for (const m of [headMesh, eyeMesh]) if (m) head.add(m);
  const hat = buildHat(look.hat, hullMat, id, mats);
  for (const m of hat.meshes) head.add(m);
  if (hat.propeller) head.add(hat.propeller);
  root.add(head);

  // ── flag cloth ──
  root.add(flagBuild.group);

  // ── team marker ──
  const marker = markerColor !== null ? buildMarker(markerColor, mats) : null;
  if (marker) root.add(marker);

  // ── engine flame: two nested cones pointing backward (-Z), base at the exhaust ──
  const flame = new THREE.Group();
  flame.position.set(0, 0.38, s.motorZ - 0.38);
  const outerGeo = new THREE.ConeGeometry(0.2, 1.8, 7, 1, true);
  outerGeo.translate(0, 0.9, 0);
  outerGeo.rotateX(-Math.PI / 2); // tip now points toward -Z, base at the origin
  const innerGeo = new THREE.ConeGeometry(0.11, 1.1, 6, 1, true);
  innerGeo.translate(0, 0.55, 0);
  innerGeo.rotateX(-Math.PI / 2);
  flame.add(new THREE.Mesh(outerGeo, flameOuterMat), new THREE.Mesh(innerGeo, flameInnerMat));
  flame.visible = false;
  root.add(flame);

  // ───────── blaster turret ─────────
  const turret = new THREE.Group();
  turret.position.set(0, y + 0.22 + lift, s.turretZ);
  root.add(turret);
  const turretYaw = new THREE.Group();
  turret.add(turretYaw);

  // body (turns with the yaw)
  const yo = new Part();
  const yb = new Part();
  yo.add(new THREE.BoxGeometry(0.6, 0.42, 0.8), xf(0, 0.21, -0.1)); // chunky housing
  yb.add(new THREE.BoxGeometry(0.5, 0.1, 0.55), xf(0, 0.47, -0.12)); // top cap
  yb.add(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 8), xf(0, 0.76, -0.2)); // dart magazine
  yo.add(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 8), xf(0, 1.04, -0.2)); // magazine cap
  yb.add(new THREE.BoxGeometry(0.14, 0.34, 0.14), xf(0, 0.1, -0.56, 0.25)); // grip
  for (const m of [yo.mesh(orangeMat), yb.mesh(blueMat)]) if (m) turretYaw.add(m);

  // barrel assembly (tilts, then slides back on recoil)
  const turretPitch = new THREE.Group();
  turretPitch.position.set(0, 0.24, 0.25);
  turretYaw.add(turretPitch);
  const turretRecoil = new THREE.Group();
  turretPitch.add(turretRecoil);

  const po = new Part();
  const pb = new Part();
  const alongZ = Math.PI / 2;
  po.add(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 10), xf(0, 0, 0.25, alongZ)); // shroud
  pb.add(new THREE.CylinderGeometry(0.14, 0.14, 1.0, 8), xf(0, 0, 0.5, alongZ)); // barrel
  po.add(new THREE.CylinderGeometry(0.215, 0.215, 0.14, 10), xf(0, 0, 1.0, alongZ)); // muzzle ring
  pb.add(new THREE.BoxGeometry(0.05, 0.12, 0.05), xf(0, 0.26, 0.55)); // sight
  for (const m of [po.mesh(orangeMat), pb.mesh(blueMat)]) if (m) turretRecoil.add(m);

  // two extra barrels that appear for Triple Shot (splayed by the same angle as the darts)
  const spread = (CONFIG.blaster.tripleSpreadDeg * Math.PI) / 180;
  const sideB = new Part();
  const sideO = new Part();
  for (const sx of [-1, 1]) {
    sideB.add(new THREE.CylinderGeometry(0.1, 0.1, 0.8, 8), xf(sx * 0.32, -0.02, 0.55, alongZ, sx * spread));
    sideO.add(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 8), xf(sx * 0.32 + sx * Math.sin(spread) * 0.4, -0.02, 0.95, alongZ, sx * spread));
  }
  const sideBarrels = new THREE.Group();
  for (const m of [sideB.mesh(blueMat), sideO.mesh(orangeMat)]) if (m) sideBarrels.add(m);
  sideBarrels.visible = false;
  turretRecoil.add(sideBarrels);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 1.07);
  turretRecoil.add(muzzle);
  const muzzleFlash = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), flashMat);
  muzzleFlash.position.set(0, 0, 1.2);
  muzzleFlash.visible = false;
  turretRecoil.add(muzzleFlash);

  // ── shield bubble: a faceted ellipsoid that wraps the whole boat ──
  const shield = new THREE.Group();
  shield.scale.set(SHIELD_SIZE.x, SHIELD_SIZE.y, SHIELD_SIZE.z);
  shield.position.set(0, 0.75, 0);
  shield.visible = false;
  const shieldSpin = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), shieldMat);
  shield.add(shieldSpin);
  root.add(shield);

  return {
    root,
    hullMat,
    paintMats: [hullMat, ...(boneHull ? boneHull.flash : []), ...job.flash],
    blasterGlowMat: blueMat,
    turretYaw,
    turretPitch,
    turretRecoil,
    muzzle,
    muzzleFlash,
    sideBarrels,
    head,
    propeller: hat.propeller,
    flame,
    flag: flagBuild.group,
    hasFlag: flagBuild.hasFlag,
    marker,
    eyeHalo: boneHull ? boneHull.eyeHalo : null,
    shield,
    shieldSpin,
    shieldMat,
    centerY: 0.85,
    dispose(): void {
      root.removeFromParent();
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      mats.dispose();
    },
  };
}
