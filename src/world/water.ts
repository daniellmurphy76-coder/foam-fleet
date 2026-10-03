/**
 * The lagoon water.
 *
 *  - A big flat grid, dense near the arena and stretched far out toward the
 *    horizon. The vertex shader lifts every vertex with the shared wave table.
 *  - The fragment shader works out a smooth wave normal from the same table,
 *    then adds: turquoise shallows near islands, deeper blue offshore, a sky
 *    reflection at grazing angles (fresnel), sun glints, white foam on wave
 *    crests, and washing foam rings around every island and rock.
 *  - "How far is the nearest beach?" comes from a small lookup picture (the
 *    shore texture) baked once from the map in layout.ts.
 *
 * Boats don't touch any of this: they ask waves.ts for the height and it
 * matches what this shader draws.
 */
import * as THREE from 'three';
import { shoreRadius, type Layout } from './layout';
import { FOG_FAR, SKY_COLORS, SUN_DIR } from './sky';
import { WAVE_GLSL } from './waves';
import type { Bag } from './util';

const SHORE_RES = 512; // texels per side
const SHORE_MAX = 40; // meters: the farthest distance the texture can store
const shoreCache = new Map<number, Uint8Array>(); // the baked bytes depend only on the map, so reuse them each match

/** For every spot in a square around the arena: meters to the nearest beach, scaled to 0..255. */
function bakeShore(layout: Layout, half: number): Uint8Array {
  const cached = shoreCache.get(layout.arenaRadius);
  if (cached) return cached;

  const data = new Uint8Array(SHORE_RES * SHORE_RES);
  const cell = (half * 2) / SHORE_RES;
  const islands = layout.islands;
  const rocks = layout.rocks;
  for (let j = 0; j < SHORE_RES; j++) {
    const z = -half + (j + 0.5) * cell;
    for (let i = 0; i < SHORE_RES; i++) {
      const x = -half + (i + 0.5) * cell;
      let d = SHORE_MAX;
      for (const isl of islands) {
        const dx = x - isl.x;
        const dz = z - isl.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > isl.r + SHORE_MAX) continue; // far away: skip the expensive part
        const e = dist - shoreRadius(isl, Math.atan2(dz, dx));
        if (e < d) d = e;
      }
      for (const rk of rocks) {
        const e = Math.hypot(x - rk.x, z - rk.z) - rk.r * 0.8;
        if (e < d) d = e;
      }
      data[j * SHORE_RES + i] = Math.round((Math.max(0, d) / SHORE_MAX) * 255);
    }
  }
  shoreCache.set(layout.arenaRadius, data);
  return data;
}

/**
 * One line of grid points, from -outer to +outer: evenly spaced (`step`) out to
 * `inner`, then spacing grows by `growth` each step. Dense where we look, cheap far away.
 */
function gridAxis(inner: number, step: number, growth: number, outer: number): number[] {
  const side = [0];
  let x = 0;
  let s = step;
  while (x < outer) {
    x = Math.min(x + s, outer);
    side.push(x);
    if (x > inner) s *= growth;
  }
  return [...side.slice(1).reverse().map((v) => -v), ...side];
}

const VERTEX = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
#include <fog_pars_vertex>
${WAVE_GLSL}
void main() {
  // The grid is already laid out in world meters on the XZ plane; just lift it with the waves.
  vec3 p = position;
  p.y = waveHeight(p.xz, uTime);
  vWorld = p;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uSky;
uniform vec3 uFoam;
uniform sampler2D uShore;
uniform float uShoreHalf;
uniform float uShoreMax;
uniform float uArena;
varying vec3 vWorld;
#include <fog_pars_fragment>
${WAVE_GLSL}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Smooth blobby noise, 0..1.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 p = vWorld.xz;

  // --- Surface normal: the shared wave table, plus tiny ripples that only change the shading ---
  vec3 N = waveNormal(p, uTime);
  float camDist = distance(cameraPosition, vWorld);
  float detail = 1.0 - smoothstep(120.0, 300.0, camDist); // ripples fade out with distance (cheaper, and fog hides them anyway)
  if (detail > 0.0) {
    vec2 rip = vec2(
      vnoise(p * 0.85 + vec2(uTime * 0.35, 0.0)),
      vnoise(p.yx * 0.95 - vec2(0.0, uTime * 0.30))
    ) - 0.5;
    N = normalize(vec3(N.x + rip.x * 0.16 * detail, N.y, N.z + rip.y * 0.16 * detail));
  }

  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDir);

  // --- Distance to the nearest beach (meters), from the shore texture ---
  vec2 suv = (p + uShoreHalf) / (2.0 * uShoreHalf);
  float sd = texture2D(uShore, suv).r * uShoreMax;

  // --- Base color: deeper the farther from the middle, turquoise near beaches ---
  float offshore = smoothstep(uArena * 0.3, uArena * 1.1, length(p));
  vec3 col = mix(uMid, uDeep, offshore);
  float shallow = 1.0 - smoothstep(0.0, 20.0, sd);
  col = mix(col, uShallow, shallow * 0.95);

  // A thin bright net of light on the sandy bottom (cheap "caustics")
  float c1 = sin(p.x * 0.9 + uTime * 0.8 + sin(p.y * 0.7 + uTime * 0.5) * 1.6);
  float c2 = sin(p.y * 1.1 - uTime * 0.7 + sin(p.x * 0.8 - uTime * 0.4) * 1.4);
  col += uShallow * pow(1.0 - abs(c1 * c2), 7.0) * 0.22 * shallow;

  // --- Simple light: brighter when facing the sun ---
  col *= 0.82 + 0.28 * max(dot(N, L), 0.0);

  // --- Sky reflection: strongest when looking along the water (fresnel) ---
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  col = mix(col, uSky, clamp(0.04 + 0.72 * fres, 0.0, 0.88));

  // --- Sun glints: a sharp hot spot plus a soft broad shimmer ---
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  col += uSunColor * (pow(nh, 320.0) * 2.2 + pow(nh, 30.0) * 0.12);

  // --- Foam ---
  vec2 pr = mat2(0.8, -0.6, 0.6, 0.8) * p; // turned a bit so the noise cells do not line up with the world axes
  float n1 = vnoise(pr * 0.55 + vec2(uTime * 0.18, -uTime * 0.12));
  float n2 = vnoise(pr.yx * 2.4 - vec2(uTime * 0.25, uTime * 0.20));
  float foamN = n1 * 0.45 + n2 * 0.55;

  // Crests: only the tallest waves, broken up by noise so it looks like patches of foam
  float height = waveHeight(p, uTime); // per pixel, so foam doesn't follow the mesh triangles
  float crest = smoothstep(0.17, 0.27, height + (foamN - 0.5) * 0.10);
  float crestFoam = crest * smoothstep(0.46, 0.54, foamN + 0.12);

  // Around islands: a solid line at the beach plus bands of foam washing in and out
  float wash = 0.5 + 0.5 * sin(sd * 1.1 - uTime * 1.6 + foamN * 5.0);
  float ring = 1.0 - smoothstep(0.6, 4.2 + 1.4 * foamN, sd);
  float edge = 1.0 - smoothstep(0.0, 1.1, sd);
  float shoreFoam = clamp(edge + ring * smoothstep(0.35, 0.85, wash) * 0.9, 0.0, 1.0);

  float foam = clamp(crestFoam + shoreFoam, 0.0, 1.0);
  col = mix(col, uFoam, foam * 0.92);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface Water {
  mesh: THREE.Mesh;
  update(t: number): void;
}

export function createWater(root: THREE.Group, bag: Bag, layout: Layout): Water {
  // --- Shore lookup texture ---
  const shoreHalf = layout.arenaRadius + 24;
  const shore = bag.add(new THREE.DataTexture(bakeShore(layout, shoreHalf), SHORE_RES, SHORE_RES, THREE.RedFormat, THREE.UnsignedByteType));
  shore.minFilter = THREE.LinearFilter;
  shore.magFilter = THREE.LinearFilter;
  shore.wrapS = THREE.ClampToEdgeWrapping;
  shore.wrapT = THREE.ClampToEdgeWrapping;
  shore.generateMipmaps = false;
  shore.needsUpdate = true;

  // --- Grid: 3.6 m cells across the arena, growing out to the horizon ---
  const reach = Math.max(layout.arenaRadius * 2.6, FOG_FAR * 1.25);
  const axis = gridAxis(layout.arenaRadius + 30, 3.6, 1.15, reach);
  const n = axis.length;
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      positions[k] = axis[i];
      positions[k + 1] = 0;
      positions[k + 2] = axis[j];
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let w = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Wound so the top face points up (+Y).
      indices[w++] = a;
      indices[w++] = c;
      indices[w++] = b;
      indices[w++] = b;
      indices[w++] = c;
      indices[w++] = d;
    }
  }
  const geometry = bag.add(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // --- Material ---
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color(SKY_COLORS.sun) },
      uShallow: { value: new THREE.Color(0x52e6d2) },
      uMid: { value: new THREE.Color(0x10a6dc) },
      uDeep: { value: new THREE.Color(0x0a5ab8) },
      uSky: { value: new THREE.Color(0xbfe8fb) },
      uFoam: { value: new THREE.Color(0xffffff) },
      uShoreHalf: { value: shoreHalf },
      uShoreMax: { value: SHORE_MAX },
      uArena: { value: layout.arenaRadius },
    },
  ]);
  // Added after merge(): merge() would clone the texture (a second GPU copy to clean up).
  uniforms.uShore = { value: shore };
  const material = bag.add(
    new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, fog: true }),
  );

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water';
  mesh.frustumCulled = false; // it is always under the camera, and its bounds change as it waves
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  root.add(mesh);

  const time = uniforms.uTime as THREE.IUniform<number>;
  return {
    mesh,
    update(t: number): void {
      time.value = t;
    },
  };
}
