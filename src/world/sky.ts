/**
 * Sky, sun, light and fog: everything that makes it feel like a sunny day.
 *
 *  - The sky is a gradient painted on a canvas (blue on top, pale at the
 *    horizon, a glowing sun). three.js wraps it around the whole view as
 *    `scene.background`, and also uses it to light shiny things.
 *  - A warm DirectionalLight is the sun and casts the shadows.
 *  - A HemisphereLight fills in shade (blue from above, sandy bounce from below).
 *  - A few puffy low-poly clouds drift around.
 *  - Fog fades the far water into the horizon color.
 */
import * as THREE from 'three';
import { Bag, MeshBuilder, makeCanvas, mulberry32, placement, toyMaterial } from './util';

/** Where the sun is (unit vector pointing from the world toward the sun). Shared with the water shader. */
export const SUN_DIR = new THREE.Vector3(0.5, 0.65, 0.45).normalize();

export const SKY_COLORS = {
  zenith: 0x2278d8,
  high: 0x62bdf0,
  low: 0xaee3f7,
  /** Also the fog color, so the far water melts into the sky with no visible seam. */
  horizon: 0xcdeff9,
  sun: 0xfff1d6,
};

export const FOG_NEAR = 140;
export const FOG_FAR = 560;

const SKY_W = 1024;
const SKY_H = 512;
let skyCanvas: HTMLCanvasElement | null = null; // painted once, reused by every match

function paintSky(): HTMLCanvasElement | null {
  if (skyCanvas) return skyCanvas;
  const made = makeCanvas(SKY_W, SKY_H);
  if (!made) return null;
  const { canvas, ctx } = made;
  const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');

  // Top half: zenith (y = 0) down to the horizon (y = SKY_H / 2). Most of the color change is near the horizon.
  const g = ctx.createLinearGradient(0, 0, 0, SKY_H / 2);
  g.addColorStop(0, hex(SKY_COLORS.zenith));
  g.addColorStop(0.6, hex(SKY_COLORS.high));
  g.addColorStop(0.86, hex(SKY_COLORS.low));
  g.addColorStop(1, hex(SKY_COLORS.horizon));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SKY_W, SKY_H / 2);

  // Bottom half is never really seen (the water covers it); keep the horizon color so there is no dark band.
  const g2 = ctx.createLinearGradient(0, SKY_H / 2, 0, SKY_H);
  g2.addColorStop(0, hex(SKY_COLORS.horizon));
  g2.addColorStop(1, hex(0x9bdbe8));
  ctx.fillStyle = g2;
  ctx.fillRect(0, SKY_H / 2, SKY_W, SKY_H / 2);

  // The sun: a soft glow with a bright core. Equirect maps stretch things sideways at height, so squash to compensate.
  const elev = Math.asin(SUN_DIR.y);
  const sx = (Math.atan2(SUN_DIR.z, SUN_DIR.x) / (Math.PI * 2) + 0.5) * SKY_W;
  const sy = (1 - (elev / Math.PI + 0.5)) * SKY_H;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(1 / Math.cos(elev), 1);
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 78);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.13, 'rgba(255,252,235,1)');
  glow.addColorStop(0.2, 'rgba(255,246,205,0.55)');
  glow.addColorStop(0.55, 'rgba(255,240,200,0.14)');
  glow.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(-90, -90, 180, 180);
  ctx.restore();

  skyCanvas = canvas;
  return canvas;
}

/** One puffy cloud: a few squashed icospheres, white on top and pale blue underneath. */
function cloudGeometry(rand: () => number): THREE.BufferGeometry {
  const white = new THREE.Color(0xffffff);
  const shade = new THREE.Color(0xe4eff9);
  const blob = new THREE.IcosahedronGeometry(1, 1);
  const b = new MeshBuilder();
  const n = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) - 0.5; // -0.5..0.5 across the cloud
    const size = (7 - Math.abs(t) * 7) * (0.8 + rand() * 0.5) + 2.5; // biggest in the middle
    b.add(blob, {
      matrix: placement(t * 30 + (rand() - 0.5) * 4, (rand() - 0.2) * 2, (rand() - 0.5) * 6, 0, rand() * 6, 0, size, size * 0.62, size * 0.85),
      colorFn: (_cx, _cy, _cz, ny) => (ny > 0.15 ? white : shade),
    });
  }
  blob.dispose();
  return b.build() as THREE.BufferGeometry;
}

interface Cloud {
  mesh: THREE.Mesh;
  angle: number;
  radius: number;
  speed: number;
}

export interface Sky {
  update(t: number, dt: number): void;
  dispose(): void;
}

export function createSky(scene: THREE.Scene, root: THREE.Group, bag: Bag, arenaRadius: number): Sky {
  // --- Sky picture: background + a soft glow of light for shiny materials ---
  const canvas = paintSky();
  let skyTexture: THREE.CanvasTexture | null = null;
  if (canvas) {
    skyTexture = bag.add(new THREE.CanvasTexture(canvas));
    skyTexture.mapping = THREE.EquirectangularReflectionMapping;
    skyTexture.colorSpace = THREE.SRGBColorSpace;
    scene.background = skyTexture;
    scene.environment = skyTexture;
    scene.environmentIntensity = 0.45;
  } else {
    scene.background = new THREE.Color(SKY_COLORS.horizon);
  }

  // --- Fog: far water fades into the horizon color ---
  const fog = new THREE.Fog(SKY_COLORS.horizon, FOG_NEAR, FOG_FAR);
  scene.fog = fog;

  // --- Lights ---
  const hemi = new THREE.HemisphereLight(0xcfeaff, 0xf0dcae, 0.95);
  hemi.name = 'sky-light';
  root.add(hemi);

  const sun = new THREE.DirectionalLight(SKY_COLORS.sun, 2.7);
  sun.name = 'sun';
  sun.position.copy(SUN_DIR).multiplyScalar(300);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const half = arenaRadius + 14; // the shadow box covers the whole arena
  const cam = sun.shadow.camera;
  cam.left = -half;
  cam.right = half;
  cam.top = half;
  cam.bottom = -half;
  cam.near = 60;
  cam.far = 640;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0004; // stops "shadow acne" speckles
  sun.shadow.normalBias = 0.06;
  root.add(sun, sun.target);
  bag.add(sun); // DirectionalLight.dispose() frees its shadow map

  // --- Clouds ---
  const rand = mulberry32(2024);
  const cloudMat = bag.add(toyMaterial({ roughness: 1 }));
  const geos = [cloudGeometry(rand), cloudGeometry(rand), cloudGeometry(rand)];
  geos.forEach((g) => bag.add(g));
  const clouds: Cloud[] = [];
  for (let i = 0; i < 9; i++) {
    const mesh = new THREE.Mesh(geos[i % geos.length], cloudMat);
    const s = 0.9 + rand() * 1.1;
    mesh.scale.setScalar(s);
    mesh.rotation.y = rand() * Math.PI * 2;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const cloud: Cloud = {
      mesh,
      angle: (i / 9) * Math.PI * 2 + rand() * 0.5,
      radius: 190 + rand() * 170,
      speed: 0.004 + rand() * 0.006,
    };
    mesh.position.set(Math.cos(cloud.angle) * cloud.radius, 85 + rand() * 45, Math.sin(cloud.angle) * cloud.radius);
    root.add(mesh);
    clouds.push(cloud);
  }

  return {
    update(_t: number, dt: number): void {
      for (const c of clouds) {
        c.angle += c.speed * dt;
        c.mesh.position.x = Math.cos(c.angle) * c.radius;
        c.mesh.position.z = Math.sin(c.angle) * c.radius;
      }
    },
    dispose(): void {
      // Only undo what we set, in case someone replaced it.
      if (scene.fog === fog) scene.fog = null;
      if (skyTexture) {
        if (scene.background === skyTexture) scene.background = null;
        if (scene.environment === skyTexture) scene.environment = null;
      } else {
        scene.background = null;
      }
      scene.environmentIntensity = 1;
    },
  };
}
