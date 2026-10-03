import * as THREE from 'three';
import type { Boat, BoatControls, BoatLook, FlagId, HatId, HornId, PatternId, Sfx, WorldQuery } from '../types';
import { createBoat } from '../entities/boat';
import { button, cssColor, el, field, makeSeg, makeSwatches, svgNode } from './dom';
import type { SegItem } from './dom';
import { CONFIG } from '../config';

/**
 * The Boat Garage: pick a hull, paint, hat, flag, horn and color while a live 3D copy of
 * the boat turns slowly on calm water. The menu opens it from each player's card.
 */

// ───────────── what you can pick ─────────────

interface Opt<T> {
  id: T;
  /** Short word on the button. */
  label: string;
  /** Emoji above the label (paint swatches draw their own picture instead). */
  icon: string;
  /** How the summary line says it ("Pirate hat"); the label if left out. */
  say?: string;
}

const HULLS: readonly Opt<number>[] = [
  { id: 0, label: 'Zippy', icon: '🚤' },
  { id: 1, label: 'Tuggy', icon: '🚢' },
  { id: 2, label: 'Twin', icon: '⛵' },
];
const PATTERNS: readonly Opt<PatternId>[] = [
  { id: 'solid', label: 'Solid', icon: '' },
  { id: 'stripes', label: 'Stripes', icon: '' },
  { id: 'flames', label: 'Flames', icon: '' },
  { id: 'dots', label: 'Dots', icon: '' },
  { id: 'shark', label: 'Shark teeth', icon: '' },
];
const HATS: readonly Opt<HatId>[] = [
  { id: 'captain', label: 'Captain', icon: '⚓', say: 'Captain hat' },
  { id: 'pirate', label: 'Pirate', icon: '🦜', say: 'Pirate hat' },
  { id: 'crown', label: 'Crown', icon: '👑' },
  { id: 'cowboy', label: 'Cowboy', icon: '🤠', say: 'Cowboy hat' },
  { id: 'propeller', label: 'Propeller', icon: '🧢', say: 'Propeller beanie' },
  { id: 'none', label: 'None', icon: '🚫', say: 'No hat' },
];
const FLAGS: readonly Opt<FlagId>[] = [
  { id: 'none', label: 'None', icon: '🚫', say: '' },
  { id: 'star', label: 'Star', icon: '⭐', say: 'Star flag' },
  { id: 'heart', label: 'Heart', icon: '💖', say: 'Heart flag' },
  { id: 'skull', label: 'Skull', icon: '💀', say: 'Skull flag' },
  { id: 'lightning', label: 'Lightning', icon: '⚡', say: 'Lightning flag' },
  { id: 'smile', label: 'Smile', icon: '😊', say: 'Smile flag' },
];
const HORNS: readonly Opt<HornId>[] = [
  { id: 'beep', label: 'Beep', icon: '🔔', say: 'Beep horn' },
  { id: 'duck', label: 'Duck', icon: '🦆', say: 'Duck horn' },
  { id: 'foghorn', label: 'Foghorn', icon: '📢' },
  { id: 'clown', label: 'Clown', icon: '🤡', say: 'Clown horn' },
];

/** A fresh look for player slot 0 or 1 (they start with different hulls so two boats are easy to tell apart). */
export function defaultLook(slot: number): BoatLook {
  return { hull: slot === 1 ? 1 : 0, pattern: 'solid', hat: 'captain', flag: 'none', horn: 'beep' };
}

function pick<T>(opts: readonly Opt<T>[], v: unknown, fallback: T): T {
  return opts.find((o) => o.id === v)?.id ?? fallback;
}

/** Never trust saved data: keep only the choices that still exist, and fill in anything missing from `base`. */
export function sanitizeLook(raw: unknown, base: BoatLook): BoatLook {
  if (!raw || typeof raw !== 'object') return { ...base };
  const r = raw as Record<string, unknown>;
  return {
    hull: pick(HULLS, r.hull, base.hull),
    pattern: pick(PATTERNS, r.pattern, base.pattern),
    hat: pick(HATS, r.hat, base.hat),
    flag: pick(FLAGS, r.flag, base.flag),
    horn: pick(HORNS, r.horn, base.horn),
  };
}

function items<T>(opts: readonly Opt<T>[]): SegItem<T>[] {
  return opts.map((o) => ({ value: o.id, label: o.label, icon: o.icon }));
}

/** "Zippy · Flames · Pirate hat · Duck horn": only the interesting parts, for the player card and the garage. */
export function describeLook(look: BoatLook): string {
  const say = <T>(opts: readonly Opt<T>[], id: T): string => {
    const o = opts.find((x) => x.id === id);
    return o ? (o.say ?? o.label) : '';
  };
  return [
    say(HULLS, look.hull),
    look.pattern === 'solid' ? '' : say(PATTERNS, look.pattern),
    say(HATS, look.hat),
    say(FLAGS, look.flag),
    say(HORNS, look.horn),
  ]
    .filter(Boolean)
    .join(' · ');
}

// ───────────── little pictures for the paint buttons ─────────────
// A tiny hull in the boat's color (--boat) with each pattern painted on.

const HULL_PATH = 'M4 7 H48 Q50 7 47 16 Q43 25 32 25 H17 Q7 25 5 15 Q4 10 4 7 Z';
function paintSvg(inside: string): string {
  return `<svg viewBox="0 0 52 28" aria-hidden="true">
  <path class="base" d="${HULL_PATH}" stroke="#06173d" stroke-width="2.5" stroke-linejoin="round"/>${inside}</svg>`;
}
const PAINT_ART: Record<PatternId, string> = {
  solid: paintSvg(''),
  stripes: paintSvg(
    '<g fill="#ffffff"><rect x="13" y="9.5" width="5" height="11"/><rect x="24" y="9.5" width="5" height="11"/><rect x="35" y="9.5" width="5" height="11"/></g>',
  ),
  flames: paintSvg(
    '<path d="M10 21 Q11 12 15 15 Q16 9 20 13 Q22 8 26 13 Q29 9 31 14 Q35 11 37 16 Q40 15 41 21 Z" fill="#ff8a1f" stroke="#06173d" stroke-width="1.4" stroke-linejoin="round"/>' +
      '<path d="M17 21 Q18 16 21 17 Q23 14 26 18 Q29 16 31 21 Z" fill="#ffd23f"/>',
  ),
  dots: paintSvg(
    '<g fill="#ffffff"><circle cx="12" cy="11.5" r="2.4"/><circle cx="21" cy="16" r="2.4"/><circle cx="30" cy="11.5" r="2.4"/><circle cx="39" cy="16" r="2.4"/><circle cx="24" cy="10" r="1.6"/></g>',
  ),
  shark: paintSvg(
    '<path d="M9 13 H43 L41 21 L37 14 L33 21 L29 14 L25 21 L21 14 L17 21 L13 14 L11 21 Z" fill="#ffffff" stroke="#06173d" stroke-width="1.4" stroke-linejoin="round"/>',
  ),
};

// ───────────── the live 3D preview ─────────────

interface Preview {
  /** Swap in a freshly built boat. Returns false if it could not be built. */
  setBoat(look: BoatLook, color: number): boolean;
  /** A little hop, for the "Test horn" button. */
  bounce(): void;
  dispose(): void;
}

const IDLE: BoatControls = { throttle: 0, steer: 0, fire: false, boost: false, rescue: false, honk: false };
const NO_BOATS: readonly Boat[] = [];
/** Flat, gentle water: a tiny bob so the boat feels alive, and the surface always points up. */
const CALM: WorldQuery = {
  waveHeight: (_x, _z, t) => Math.sin(t * 1.6) * 0.035,
  waveNormal: (_x, _z, _t, out) => out.set(0, 1, 0),
  obstacles: [],
  arenaRadius: 1000,
};
const STAGE_TARGET = new THREE.Vector3(0, 1.2, 0);
const STAGE_DIR = new THREE.Vector3(0.5, 0.36, 0.78).normalize();
const SPIN = 0.6; // radians per second

/** Throws if the browser cannot make a WebGL context; the caller shows a friendly fallback. */
function createPreview(host: HTMLElement, onLost: () => void): Preview {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'ff-gcanvas';
  host.append(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 4 / 3, 0.5, 80);

  // Same sunny light as the lagoon, so paint colors look the same in the garage and in the game.
  scene.add(new THREE.HemisphereLight(0xcfeaff, 0xf0dcae, 0.95));
  const sun = new THREE.DirectionalLight(0xfff2d9, 2.7);
  sun.position.set(6, 10, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  // A round patch of calm turquoise water with a white foam rim.
  const waterGeo = new THREE.CircleGeometry(5.2, 56);
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x38c8dc, roughness: 0.4, metalness: 0 });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.receiveShadow = true;
  const foamGeo = new THREE.RingGeometry(4.6, 5.2, 56);
  const foamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, toneMapped: false });
  const foam = new THREE.Mesh(foamGeo, foamMat);
  foam.rotation.x = -Math.PI / 2;
  foam.position.y = 0.01;
  scene.add(water, foam);

  // The boat sits on a turntable pivot so the boat's own transform stays untouched.
  const pivot = new THREE.Group();
  scene.add(pivot);

  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let boat: Boat | null = null;
  let spin = 0.5;
  let t = 0;
  let hop = 0;
  let last = performance.now();
  let raf = 0;
  let lost = false;
  let width = 0;
  let height = 0;

  function fit(): void {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 2 || h < 2 || (w === width && h === height)) return;
    width = w;
    height = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Back the camera off on narrow screens so the whole boat (and its flag) always fits.
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(11, 4.2 / (tanV * camera.aspect));
    camera.position.copy(STAGE_DIR).multiplyScalar(dist).add(STAGE_TARGET);
    camera.lookAt(STAGE_TARGET);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(fit);
  ro.observe(host);

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (lost || width === 0) {
      fit();
      return;
    }
    t += dt;
    spin += dt * (reduced ? SPIN * 0.2 : SPIN);
    pivot.rotation.y = spin;
    hop = Math.max(0, hop - dt * 3.2);
    pivot.scale.setScalar(1 + 0.07 * Math.sin(hop * Math.PI));
    boat?.update(IDLE, dt, t, CALM, NO_BOATS);
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  const onContextLost = (e: Event): void => {
    e.preventDefault();
    lost = true;
    onLost();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  function dropBoat(): void {
    if (!boat) return;
    pivot.remove(boat.object);
    boat.dispose();
    boat = null;
  }

  return {
    setBoat(look, color) {
      let next: Boat | null = null;
      try {
        next = createBoat({
          id: 0,
          name: 'Preview',
          color,
          isHuman: true,
          spawn: { x: 0, z: 0, heading: 0 },
          look: { ...look },
          team: 0,
          marker: null,
          easyDriving: true,
        });
        next.update(IDLE, 0.016, t, CALM, NO_BOATS); // settle into place before it is first drawn
      } catch {
        next?.dispose();
        next = null;
      }
      dropBoat();
      if (!next) return false;
      boat = next;
      pivot.add(boat.object);
      return true;
    },
    bounce() {
      hop = 1;
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dropBoat();
      scene.remove(pivot, water, foam, sun);
      sun.dispose();
      waterGeo.dispose();
      waterMat.dispose();
      foamGeo.dispose();
      foamMat.dispose();
      canvas.removeEventListener('webglcontextlost', onContextLost); // we are the ones losing it
      renderer.dispose();
      renderer.forceContextLoss(); // hand the WebGL context back right away
      canvas.remove();
    },
  };
}

// ───────────── the garage screen ─────────────

/** What the menu tells the garage when it opens. */
export interface GarageHost {
  /** Heading, e.g. "Sam's boat". */
  title: string;
  look: BoatLook;
  color: number;
  /** A tag like "P2" if the other player already has this paint color, else null. */
  takenBy(color: number): string | null;
  /** Called with a fresh copy after every change. */
  onLook(look: BoatLook): void;
  onColor(color: number): void;
}

export interface Garage {
  /** The whole screen (header, preview, pickers). The menu shows and hides it. */
  readonly el: HTMLElement;
  /** Start the 3D preview and fill in the pickers. Call `close()` when the screen goes away. */
  open(host: GarageHost, onDone: () => void): void;
  /** Stop and free the 3D preview. Safe to call any time. */
  close(): void;
  /** Put keyboard/gamepad focus on the first picker. */
  focusFirst(): void;
}

export function createGarage(sfx: Sfx): Garage {
  let host: GarageHost | null = null;
  let onDone: (() => void) | null = null;
  let look = defaultLook(0);
  let color: number = CONFIG.colors[0];
  let preview: Preview | null = null;

  const screen = el('section', 'ff-screen ff-garage');
  screen.hidden = true;

  // header: back + title
  const head = el('div', 'ff-setup-head');
  const backBtn = button('← Back', 'ff-btn');
  const backRow = el('div', 'ff-row');
  backRow.append(backBtn);
  head.append(backRow, el('h2', 'ff-setup-title ff-ol', 'Boat Garage'));

  // left: the live preview
  const stage = el('div', 'ff-gstage');
  const stageHost = el('div', 'ff-gview');
  const fallback = el('p', 'ff-gfallback', "The 3D preview can't open on this computer. Your choices still work in the game!");
  fallback.hidden = true;
  stage.append(stageHost, fallback);
  const nameTag = el('div', 'ff-gname');
  const summary = el('div', 'ff-gsummary');
  summary.setAttribute('aria-live', 'polite');
  stageHost.setAttribute('aria-hidden', 'true'); // the summary line says what the picture shows
  const left = el('div', 'ff-gleft');
  left.append(stage, nameTag, summary);

  // right: the pickers
  function change(patch: Partial<BoatLook>): void {
    look = { ...look, ...patch };
    host?.onLook({ ...look });
    refresh();
    if (Object.keys(patch).some((k) => k !== 'horn')) rebuild(); // a new horn changes the sound, not the boat
  }
  const hullSeg = makeSeg<number>(sfx, 'Boat', items(HULLS), (v) => change({ hull: v }));
  const paintSeg = makeSeg<PatternId>(
    sfx,
    'Paint',
    PATTERNS.map((o) => ({ value: o.id, label: o.label, icon: svgNode(PAINT_ART[o.id]) })),
    (v) => change({ pattern: v }),
  );
  const hatSeg = makeSeg<HatId>(sfx, 'Hat', items(HATS), (v) => change({ hat: v }));
  const flagSeg = makeSeg<FlagId>(sfx, 'Flag', items(FLAGS), (v) => change({ flag: v }));
  // Picking a horn plays it, instead of the usual click.
  const hornSeg = makeSeg<HornId>(
    sfx,
    'Horn',
    items(HORNS),
    (v) => {
      sfx.unlock();
      change({ horn: v });
      sfx.honk(v);
      preview?.bounce();
    },
    true,
  );
  // Lay each picker out this many buttons across; rows with a few big buttons get bigger words.
  const across = (seg: { row: HTMLElement }, n: number, roomy = false): void => {
    seg.row.style.setProperty('--n', String(n));
    seg.row.classList.toggle('ff-seg--roomy', roomy);
  };
  across(hullSeg, 3, true);
  across(paintSeg, 5);
  across(hatSeg, 6);
  across(flagSeg, 6);
  across(hornSeg, 4, true);
  const testBtn = button('📣 Test horn', 'ff-btn ff-btn--wide');
  const testRow = el('div', 'ff-row');
  testRow.append(testBtn);
  testBtn.addEventListener('click', () => {
    sfx.unlock();
    sfx.honk(look.horn);
    preview?.bounce();
  });
  const swatches = makeSwatches(sfx, 'Boat color', CONFIG.colors, (c) => {
    color = c;
    host?.onColor(c);
    refresh();
    rebuild();
  });

  const right = el('div', 'ff-gright');
  right.append(
    field('Boat', hullSeg.row).box,
    field('Paint', paintSeg.row).box,
    field('Hat', hatSeg.row).box,
    field('Flag', flagSeg.row).box,
    field('Horn', hornSeg.row, testRow).box,
    field('Color', swatches.row).box,
  );

  const card = el('div', 'ff-card ff-gbody');
  card.append(left, right);

  const doneBtn = button('All done!', 'ff-btn ff-btn--primary ff-btn--hero');
  const doneRow = el('div', 'ff-row ff-start-wrap');
  doneRow.append(doneBtn);

  screen.append(head, card, doneRow);

  function finish(): void {
    sfx.uiSelect();
    onDone?.();
  }
  backBtn.addEventListener('click', finish);
  doneBtn.addEventListener('click', finish);

  /** Make the pickers, name and summary match `look` and `color`. */
  function refresh(): void {
    hullSeg.select(look.hull);
    paintSeg.select(look.pattern);
    hatSeg.select(look.hat);
    flagSeg.select(look.flag);
    hornSeg.select(look.horn);
    swatches.sync(color, (c) => host?.takenBy(c) ?? null);
    screen.style.setProperty('--boat', cssColor(color));
    summary.textContent = describeLook(look);
  }

  /** Build the 3D boat for the current choices. */
  function rebuild(): void {
    if (!preview) return;
    fallback.hidden = preview.setBoat(look, color);
  }

  function open(h: GarageHost, done: () => void): void {
    close();
    host = h;
    onDone = done;
    look = { ...h.look };
    color = h.color;
    nameTag.textContent = h.title;
    refresh();
    try {
      preview = createPreview(stageHost, () => {
        fallback.hidden = false;
      });
      rebuild();
    } catch {
      preview = null;
      fallback.hidden = false; // no WebGL: the pickers still work
    }
  }

  function close(): void {
    preview?.dispose();
    preview = null;
    host = null;
    onDone = null;
  }

  return {
    el: screen,
    open,
    close,
    focusFirst() {
      (hullSeg.buttons[look.hull] ?? hullSeg.buttons[0]).focus({ preventScroll: true });
    },
  };
}
