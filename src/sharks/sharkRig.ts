import * as THREE from 'three';
import { HINGE1_Z, HINGE2_Z, JAW_Y, JAW_Z, MEGA_SCALE, buildSharkGeometries, buildSprayGeometry } from './sharkModel';
import type { SharkGeometries } from './sharkModel';

/**
 * Draws every shark with a handful of InstancedMeshes: the normal sharks share four (front, jaw, mid, tail),
 * the MEGA SHARK has its own four, and one more draws all the spray. Ten draw calls however many sharks
 * are swimming, and nothing is allocated per frame.
 *
 * Each frame the game calls begin(), add() once per visible shark, then end(). add() turns a plain pose
 * (position, tilt, tail wag, jaw angle) into the four piece matrices.
 */

/** How many normal sharks fit (the MEGA SHARK has a slot of its own). */
export const NORMAL_CAPACITY = 16;
/** A hit flash brightens the whole shark by this much (times the flash amount). */
const FLASH_BOOST = 1.7;

export interface SharkPose {
  /** The middle of the body. */
  x: number;
  y: number;
  z: number;
  /** Heading (the usual convention) and tilts in radians. Pitch: nose up is positive. Roll: positive leans to the shark's right. */
  yaw: number;
  pitch: number;
  roll: number;
  /** How far the body bends at the two hinges (radians about Y). */
  wag1: number;
  wag2: number;
  /** Jaw angle in radians: 0 shut, about 1 wide open. */
  jaw: number;
  /** 0..1 white-ish flash when hit. */
  flash: number;
  /** 0..1.5: size of the V of spray (0 hides it). */
  spray: number;
  /** The water surface under the shark, and how it tilts there (the spray lies on it). */
  waterY: number;
  waterPitch: number;
  waterRoll: number;
}

export interface SharkRig {
  begin(): void;
  add(mega: boolean, pose: SharkPose): void;
  end(): void;
  dispose(): void;
}

interface PieceSet {
  front: THREE.InstancedMesh;
  jaw: THREE.InstancedMesh;
  mid: THREE.InstancedMesh;
  tail: THREE.InstancedMesh;
  count: number;
  capacity: number;
}

export function createSharkRig(root: THREE.Object3D): SharkRig {
  const white = new THREE.Color(1, 1, 1);
  const tint = new THREE.Color();

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.72, metalness: 0 });
  const sprayMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const sprayGeometry = buildSprayGeometry();
  const geometries: THREE.BufferGeometry[] = [sprayGeometry];
  const meshes: THREE.InstancedMesh[] = [];

  const makeMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number, name: string, colored: boolean): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false; // sharks are spread over the whole lagoon and move every frame
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (colored) {
      // Give every instance a color up front, so the shader never has to be rebuilt later.
      for (let i = 0; i < capacity; i++) mesh.setColorAt(i, white);
      if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    root.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  const makeSet = (geo: SharkGeometries, capacity: number, name: string): PieceSet => {
    geometries.push(geo.front, geo.jaw, geo.mid, geo.tail);
    return {
      front: makeMesh(geo.front, material, capacity, `${name}-front`, true),
      jaw: makeMesh(geo.jaw, material, capacity, `${name}-jaw`, true),
      mid: makeMesh(geo.mid, material, capacity, `${name}-mid`, true),
      tail: makeMesh(geo.tail, material, capacity, `${name}-tail`, true),
      count: 0,
      capacity,
    };
  };

  const normal = makeSet(buildSharkGeometries(false), NORMAL_CAPACITY, 'shark');
  const big = makeSet(buildSharkGeometries(true), 1, 'mega-shark');
  const spray = makeMesh(sprayGeometry, sprayMaterial, NORMAL_CAPACITY + 1, 'shark-spray', false);
  spray.renderOrder = 11; // after the water, before the particle layers
  let sprayCount = 0;

  // Scratch objects, reused for every shark.
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  const mFront = new THREE.Matrix4();
  const mMid = new THREE.Matrix4();
  const mTail = new THREE.Matrix4();
  const mJaw = new THREE.Matrix4();
  const mSpray = new THREE.Matrix4();
  const hinge = new THREE.Matrix4();

  return {
    begin(): void {
      normal.count = 0;
      big.count = 0;
      sprayCount = 0;
    },

    add(mega: boolean, p: SharkPose): void {
      const set = mega ? big : normal;
      if (set.count >= set.capacity) return;
      const i = set.count++;
      const s = mega ? MEGA_SCALE : 1;

      // Body: yaw first, then pitch about the shark's own side-to-side axis, then roll. (Nose up is a negative turn about X.)
      euler.set(-p.pitch, p.yaw, p.roll, 'YXZ');
      quat.setFromEuler(euler);
      pos.set(p.x, p.y, p.z);
      scl.set(s, s, s);
      mFront.compose(pos, quat, scl);

      // Each hinge turns about Y at its own spot; the next piece hangs off the one before it.
      hinge.makeRotationY(p.wag1).setPosition(0, 0, HINGE1_Z);
      mMid.multiplyMatrices(mFront, hinge);
      hinge.makeRotationY(p.wag2).setPosition(0, 0, HINGE2_Z - HINGE1_Z);
      mTail.multiplyMatrices(mMid, hinge);
      // The jaw turns about X at the corner of the mouth: a positive angle drops the chin.
      hinge.makeRotationX(p.jaw).setPosition(0, JAW_Y, JAW_Z);
      mJaw.multiplyMatrices(mFront, hinge);

      set.front.setMatrixAt(i, mFront);
      set.mid.setMatrixAt(i, mMid);
      set.tail.setMatrixAt(i, mTail);
      set.jaw.setMatrixAt(i, mJaw);
      tint.setScalar(1 + p.flash * FLASH_BOOST);
      set.front.setColorAt(i, tint);
      set.mid.setColorAt(i, tint);
      set.tail.setColorAt(i, tint);
      set.jaw.setColorAt(i, tint);

      if (p.spray > 0.02) {
        // The V lies on the water: it follows the surface tilt, not the shark's own dives and flips.
        euler.set(-p.waterPitch, p.yaw, p.waterRoll, 'YXZ');
        quat.setFromEuler(euler);
        pos.set(p.x, p.waterY + 0.02, p.z);
        scl.setScalar(s * p.spray);
        mSpray.compose(pos, quat, scl);
        spray.setMatrixAt(sprayCount++, mSpray);
      }
    },

    end(): void {
      for (const set of [normal, big]) {
        const used = set.count > 0;
        for (const m of [set.front, set.jaw, set.mid, set.tail]) {
          m.count = set.count;
          m.visible = used;
          if (used) {
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
          }
        }
      }
      spray.count = sprayCount;
      spray.visible = sprayCount > 0;
      if (sprayCount > 0) spray.instanceMatrix.needsUpdate = true;
    },

    dispose(): void {
      for (const m of meshes) {
        root.remove(m);
        m.dispose(); // frees the instance buffers
      }
      meshes.length = 0;
      for (const g of geometries) g.dispose();
      geometries.length = 0;
      material.dispose();
      sprayMaterial.dispose();
    },
  };
}
