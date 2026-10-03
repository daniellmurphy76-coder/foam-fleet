/**
 * Foam Fleet: the captain's hats (captain, pirate, crown, cowboy, propeller beanie, none).
 *
 * Everything is in the HEAD's own space: origin = the neck, the head sphere (radius 0.27) is centered at
 * y = 0.22, +Z is the face. The caller adds the returned meshes to the head group so the hat turns with
 * the captain's head. Pieces that share a material are merged into one mesh.
 */
import * as THREE from 'three';
import type { HatId } from '../types';
import { MaterialBag, Part, xf } from './boatGeo';

const TRIM = 0xf7f7f2;
const DARK = 0x2b2f3a;
const HAIR = [0x3b2a20, 0x1c1c1c, 0xc9a24a, 0x8a4b22];

export interface HatBuild {
  /** Static pieces to add to the head group. */
  meshes: THREE.Mesh[];
  /** Spinning blades (propeller beanie only). Add it to the head group too; the boat spins it about Y. */
  propeller: THREE.Group | null;
}

export function buildHat(hat: HatId, hullMat: THREE.Material, id: number, mats: MaterialBag): HatBuild {
  const kit = new Map<THREE.Material, { part: Part; shadow: boolean }>();
  /** The merged part for a material (made on first use). */
  const P = (mat: THREE.Material, shadow = false): Part => {
    let e = kit.get(mat);
    if (!e) {
      e = { part: new Part(), shadow };
      kit.set(mat, e);
    }
    return e.part;
  };
  const gold = (): THREE.MeshStandardMaterial =>
    mats.std(0xffc61a, { roughness: 0.35, metalness: 0.35, emissive: 0x6a4300, emissiveIntensity: 0.35, side: THREE.DoubleSide });
  let propeller: THREE.Group | null = null;

  switch (hat) {
    case 'captain': {
      // White peaked cap with a band in the boat color, a dark visor and a gold badge.
      const white = mats.std(TRIM);
      const dark = mats.std(DARK, { roughness: 0.7 });
      const badge = gold();
      P(white, true).add(new THREE.CylinderGeometry(0.27, 0.3, 0.17, 12), xf(0, 0.4, 0));
      P(white, true).add(new THREE.CylinderGeometry(0.32, 0.27, 0.05, 12), xf(0, 0.505, 0));
      P(hullMat).add(new THREE.CylinderGeometry(0.31, 0.31, 0.07, 12), xf(0, 0.335, 0));
      P(dark).add(new THREE.BoxGeometry(0.4, 0.03, 0.22), xf(0, 0.31, 0.3, 0.2));
      P(badge).add(new THREE.BoxGeometry(0.11, 0.08, 0.03), xf(0, 0.4, 0.3));
      break;
    }
    case 'pirate': {
      // Black three-cornered hat with a little skull and crossbones.
      const black = mats.std(0x1d1d28, { roughness: 0.8 });
      const bone = mats.std(TRIM);
      P(black, true).add(new THREE.CylinderGeometry(0.44, 0.44, 0.07, 3), xf(0, 0.41, 0.02)); // one corner points at the face
      P(black, true).add(new THREE.SphereGeometry(0.27, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), xf(0, 0.44, 0, 0, 0, 0, 1, 0.7, 1));
      P(bone).add(new THREE.SphereGeometry(0.055, 6, 5), xf(0, 0.52, 0.255));
      for (const sx of [-1, 1]) P(bone).add(new THREE.BoxGeometry(0.2, 0.03, 0.03), xf(0, 0.465, 0.275, 0, 0, sx * 0.55));
      break;
    }
    case 'crown': {
      // Golden crown: a ring, five spikes, and gems in the boat color.
      const g = gold();
      P(g, true).add(new THREE.CylinderGeometry(0.27, 0.29, 0.11, 10, 1, true), xf(0, 0.41, 0));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const x = Math.sin(a) * 0.275;
        const z = Math.cos(a) * 0.275;
        P(g, true).add(new THREE.ConeGeometry(0.065, 0.2, 5), xf(x, 0.565, z));
        P(hullMat).add(new THREE.SphereGeometry(0.04, 6, 4), xf(x, 0.68, z));
      }
      P(hullMat).add(new THREE.SphereGeometry(0.05, 6, 4), xf(0, 0.41, 0.29));
      break;
    }
    case 'cowboy': {
      // Tan cowboy hat: wide brim with curled-up sides, a dented crown and a band in the boat color.
      const tan = mats.std(0xa8743f);
      const brown = mats.std(0x82552b);
      P(tan, true).add(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 14), xf(0, 0.34, 0.02, 0, 0, 0, 1, 1, 1.25));
      for (const sx of [-1, 1]) P(tan, true).add(new THREE.BoxGeometry(0.2, 0.03, 0.62), xf(sx * 0.4, 0.375, 0.02, 0, 0, sx * 0.38));
      P(tan, true).add(new THREE.CylinderGeometry(0.2, 0.25, 0.22, 10), xf(0, 0.455, 0));
      P(brown).add(new THREE.BoxGeometry(0.1, 0.03, 0.34), xf(0, 0.57, 0));
      P(hullMat).add(new THREE.CylinderGeometry(0.256, 0.256, 0.05, 10), xf(0, 0.375, 0));
      break;
    }
    case 'propeller': {
      // Beanie in quarters of boat color and white, a yellow button, and blades that spin.
      const white = mats.std(TRIM);
      const yellow = mats.std(0xffd60a);
      const dark = mats.std(DARK, { roughness: 0.7 });
      for (let i = 0; i < 4; i++) {
        P(i % 2 === 0 ? hullMat : white, true).add(
          new THREE.SphereGeometry(0.3, 2, 4, (i * Math.PI) / 2, Math.PI / 2, 0, Math.PI / 2),
          xf(0, 0.28, 0),
        );
      }
      P(yellow).add(new THREE.SphereGeometry(0.05, 6, 4), xf(0, 0.585, 0));
      P(dark).add(new THREE.CylinderGeometry(0.014, 0.014, 0.1, 5), xf(0, 0.63, 0));
      propeller = new THREE.Group();
      propeller.position.set(0, 0.69, 0);
      const bladeA = new Part();
      bladeA.add(new THREE.BoxGeometry(0.56, 0.014, 0.09));
      const bladeB = new Part();
      bladeB.add(new THREE.BoxGeometry(0.09, 0.014, 0.56));
      const a = bladeA.mesh(yellow, false);
      const b = bladeB.mesh(hullMat, false);
      if (a) propeller.add(a);
      if (b) propeller.add(b);
      break;
    }
    default: {
      // 'none': no hat, so give the captain a bit of hair (a cap of it on the back and top of the head).
      const hair = mats.std(HAIR[((id % 4) + 4) % 4]);
      P(hair, true).add(new THREE.SphereGeometry(0.285, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55), xf(0, 0.22, -0.06));
    }
  }

  const meshes: THREE.Mesh[] = [];
  for (const [mat, e] of kit) {
    const m = e.part.mesh(mat, e.shadow);
    if (m) meshes.push(m);
  }
  return { meshes, propeller };
}
