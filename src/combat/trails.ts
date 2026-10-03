import * as THREE from 'three';

/**
 * Faint streaks behind flying darts, so a kid can SEE where a fast dart went.
 *
 * One draw call for every trail. Each trail is a thin quad running from the dart (head) back
 * to a point a little way behind it (tail). The vertex shader turns the quad sideways toward
 * the camera, so it looks right from every angle and in both split-screen views.
 */

const VERT = /* glsl */ `
attribute vec3 aHead;
attribute vec3 aTail;
attribute vec2 aAlphaWidth;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vec3 h = (modelViewMatrix * vec4(aHead, 1.0)).xyz;
  vec3 t = (modelViewMatrix * vec4(aTail, 1.0)).xyz;
  // Sideways = perpendicular to both the streak and the line of sight.
  vec3 side = cross(t - h, h + t);
  float len = length(side);
  side = len > 1e-6 ? side / len : vec3(1.0, 0.0, 0.0);
  vec3 p = mix(h, t, position.y) + side * (position.x * aAlphaWidth.y * 0.5);
  vec4 mvPosition = vec4(p, 1.0);
  vUv = position.xy;
  vAlpha = aAlphaWidth.x;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  float across = 1.0 - abs(vUv.x);
  float along = 1.0 - vUv.y;                 // bright at the dart, gone at the tail
  float a = vAlpha * along * along * smoothstep(0.0, 0.6, across);
  if (a < 0.01) discard;
  gl_FragColor = vec4(0.92, 0.97, 1.0, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class DartTrails {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aHead: THREE.InstancedBufferAttribute;
  private readonly aTail: THREE.InstancedBufferAttribute;
  private readonly aAlphaWidth: THREE.InstancedBufferAttribute;
  private readonly head: Float32Array;
  private readonly tail: Float32Array;
  private readonly alphaWidth: Float32Array;
  private readonly capacity: number;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.geometry = new THREE.InstancedBufferGeometry();
    // x = -1..1 across the streak, y = 0 at the head .. 1 at the tail.
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.geometry.instanceCount = 0;

    this.aHead = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aTail = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aAlphaWidth = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.aHead.setUsage(THREE.DynamicDrawUsage);
    this.aTail.setUsage(THREE.DynamicDrawUsage);
    this.aAlphaWidth.setUsage(THREE.DynamicDrawUsage);
    this.head = this.aHead.array as Float32Array;
    this.tail = this.aTail.array as Float32Array;
    this.alphaWidth = this.aAlphaWidth.array as Float32Array;
    this.geometry.setAttribute('aHead', this.aHead);
    this.geometry.setAttribute('aTail', this.aTail);
    this.geometry.setAttribute('aAlphaWidth', this.aAlphaWidth);

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'dart-trails';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.mesh.visible = false;
  }

  /** Start a new frame's list of trails. */
  begin(): void {
    this.count = 0;
  }

  add(hx: number, hy: number, hz: number, tx: number, ty: number, tz: number, alpha: number, width: number): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    const p = i * 3;
    this.head[p] = hx; this.head[p + 1] = hy; this.head[p + 2] = hz;
    this.tail[p] = tx; this.tail[p + 1] = ty; this.tail[p + 2] = tz;
    this.alphaWidth[i * 2] = alpha;
    this.alphaWidth[i * 2 + 1] = width;
  }

  /** Send this frame's trails to the GPU. */
  end(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    this.flush(this.aHead);
    this.flush(this.aTail);
    this.flush(this.aAlphaWidth);
  }

  /** Upload only the trails that are alive this frame. */
  private flush(a: THREE.InstancedBufferAttribute): void {
    a.clearUpdateRanges();
    a.addUpdateRange(0, this.count * a.itemSize);
    a.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.clear();
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
