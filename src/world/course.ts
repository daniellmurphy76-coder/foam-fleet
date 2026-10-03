/**
 * Race gates: two tall striped buoys with a banner between them.
 * Gate 0 is the start / finish line with a checkered banner; every other gate
 * shows its number on both sides, so you can read it coming and going.
 *
 * Each gate sits at `layout.gates[i]`, turned to face the way boats travel through it
 * (same heading convention as boats), and bobs gently on the waves.
 */
import * as THREE from 'three';
import type { Layout } from './layout';
import { Bag, MeshBuilder, makeCanvas, placement, toyMaterial } from './util';
import { waveHeight } from './waves';

export interface Course {
  update(t: number): void;
}

const FONT = '"Fredoka", system-ui, sans-serif';

/** A banner made of two quads back to back, so the picture reads correctly from either side. */
function bannerGeometry(w: number, h: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hh = h / 2;
  const z = 0.05;
  // front (faces +Z, the way boats travel) then back (faces -Z, mirrored positions so the picture isn't flipped)
  const pos = [
    -hw, -hh, z, hw, -hh, z, hw, hh, z, -hw, hh, z,
    hw, -hh, -z, -hw, -hh, -z, -hw, hh, -z, hw, hh, -z,
  ];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Blue sign with a big white number. */
function numberTexture(n: number): THREE.CanvasTexture | null {
  const made = makeCanvas(512, 240);
  if (!made) return null;
  const { canvas, ctx } = made;
  roundRect(ctx, 6, 6, 500, 228, 36);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  roundRect(ctx, 20, 20, 472, 200, 26);
  ctx.fillStyle = '#0b5cc0';
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffe27a';
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText('GATE', 256, 70);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#06306a';
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 150px ${FONT}`;
  ctx.strokeText(String(n), 256, 196);
  ctx.fillText(String(n), 256, 196);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Black and white checkered banner with START / FINISH on a patch in the middle. */
function finishTexture(): THREE.CanvasTexture | null {
  const made = makeCanvas(1024, 192);
  if (!made) return null;
  const { canvas, ctx } = made;
  const sq = 48;
  for (let y = 0; y < 192 / sq; y++) {
    for (let x = 0; x < 1024 / sq + 1; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#111111' : '#ffffff';
      ctx.fillRect(x * sq, y * sq, sq, sq);
    }
  }
  roundRect(ctx, 232, 28, 560, 136, 30);
  ctx.fillStyle = '#ffd23a';
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#111111';
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#111111';
  ctx.font = `bold 66px ${FONT}`;
  ctx.fillText('START / FINISH', 512, 100);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createCourse(root: THREE.Group, bag: Bag, layout: Layout): Course {
  const gates = new THREE.Group();
  gates.name = 'race-gates';
  root.add(gates);

  // Shared pole geometry for every gate: a float, a striped pole and a lamp on each side, plus a crossbar.
  const radius = layout.gates[0]?.radius ?? 9;
  const parts = new MeshBuilder();
  const float = new THREE.CylinderGeometry(1.25, 1.5, 1.5, 10);
  const stripe = new THREE.CylinderGeometry(0.38, 0.45, 2.4, 8);
  const lamp = new THREE.IcosahedronGeometry(0.65, 0);
  const bar = new THREE.BoxGeometry(1, 0.32, 0.32);
  for (const side of [-1, 1]) {
    const x = side * radius;
    parts.add(float, { matrix: placement(x, 0.1, 0), color: 0xff7a1a });
    for (let k = 0; k < 4; k++) {
      parts.add(stripe, { matrix: placement(x, 1.0 + 1.2 + k * 2.4, 0), color: k % 2 === 0 ? 0xffffff : 0xff7a1a });
    }
    parts.add(lamp, { matrix: placement(x, 11.0, 0), color: 0xffd23a });
  }
  parts.add(bar, { matrix: placement(0, 10.4, 0, 0, 0, 0, radius * 2, 1, 1), color: 0xffffff });
  float.dispose();
  stripe.dispose();
  lamp.dispose();
  bar.dispose();
  const poleGeo = bag.add(parts.build() as THREE.BufferGeometry);
  const poleMat = bag.add(toyMaterial());

  const signGeo = bag.add(bannerGeometry(7.6, 3.6));
  const finishGeo = bag.add(bannerGeometry(radius * 2 - 1.4, 3.0));

  const groups: { group: THREE.Group; x: number; z: number }[] = [];
  layout.gates.forEach((gate, i) => {
    const group = new THREE.Group();
    group.name = i === 0 ? 'gate-start-finish' : `gate-${i}`;
    group.position.set(gate.x, 0, gate.z);
    group.rotation.y = gate.heading;

    const poles = new THREE.Mesh(poleGeo, poleMat);
    poles.castShadow = true;
    poles.receiveShadow = true;
    group.add(poles);

    const tex = i === 0 ? finishTexture() : numberTexture(i);
    if (tex) {
      bag.add(tex);
      const mat = bag.add(new THREE.MeshBasicMaterial({ map: tex }));
      const banner = new THREE.Mesh(i === 0 ? finishGeo : signGeo, mat);
      banner.position.y = i === 0 ? 8.6 : 8.2;
      group.add(banner);
    }
    gates.add(group);
    groups.push({ group, x: gate.x, z: gate.z });
  });

  const updateBob = (t: number): void => {
    for (const g of groups) g.group.position.y = waveHeight(g.x, g.z, t) - 0.1;
  };
  updateBob(0);

  return { update: updateBob };
}
