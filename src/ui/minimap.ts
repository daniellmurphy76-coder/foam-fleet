import type { MapBoat, MapState, ModeId, Obstacle, PlayerHud } from '../types';
import { CONFIG } from '../config';
import { clamp, cssColor, el } from './dom';

/**
 * One round radar for one player's viewport (Canvas 2D).
 *
 * The whole lagoon always fits in the circle and is turned so the way the camera faces is UP.
 * Islands never change, so they are painted once onto a hidden canvas (cached by the `obstacles`
 * array identity) and that picture is just turned and stamped each time. Everything that moves
 * (boats, sharks, crates, balloons, race gates) is drawn fresh, but only ~20 times a second.
 */

const DRAW_EVERY_MS = 46; // ~20 Hz; a redraw is skipped if the last one was this recent
const TAU = Math.PI * 2;

const WATER = 'rgba(8, 54, 108, 0.8)';
const SAND = '#f3d58b';
const SAND_EDGE = '#b98a3e';
const NAVY = '#06173d';
const RIM = 3; // white edge around the radar, in CSS px
const SUN = '#ffd23f';
const ORANGE = '#ff8a1f';
const SHARK_GREY = '#59647a'; // dark enough to read on the blue water, with a white edge
const MEGA_PURPLE = '#a465ff';

export interface Minimap {
  /** The element to put in the page (made round by CSS). */
  readonly canvas: HTMLCanvasElement;
  /** Set the on-screen size in CSS px. Cheap when nothing changed. */
  resize(cssPx: number): void;
  /** Redraw if enough time has passed since the last draw (otherwise does nothing). */
  draw(map: MapState, p: PlayerHud, mode: ModeId, nowMs: number): void;
  /** Make the very next draw() happen (use after the HUD is shown again). */
  invalidate(): void;
  dispose(): void;
}

/** A navigation-style arrow pointing straight up, `len` px long, centered on (0, 0). */
function arrowPath(ctx: CanvasRenderingContext2D, len: number): void {
  ctx.beginPath();
  ctx.moveTo(0, -len * 0.62);
  ctx.lineTo(len * 0.5, len * 0.5);
  ctx.lineTo(0, len * 0.2);
  ctx.lineTo(-len * 0.5, len * 0.5);
  ctx.closePath();
}

/** A little shark fin: a triangle with its point straight up (the way the shark swims), `len` px tall, centered on (0, 0). */
function finPath(ctx: CanvasRenderingContext2D, len: number): void {
  ctx.beginPath();
  ctx.moveTo(0, -len * 0.6);
  ctx.lineTo(len * 0.42, len * 0.45);
  ctx.lineTo(-len * 0.42, len * 0.45);
  ctx.closePath();
}

export function createMinimap(): Minimap {
  const canvas = el('canvas', 'ff-map');
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');

  let size = 0; // CSS px
  let dpr = 1;
  let px = 0; // backing-store px
  let lastDraw = -Infinity;

  // the cached picture of water + islands + arena edge, in world orientation
  let layer: HTMLCanvasElement | null = null;
  let layerObstacles: readonly Obstacle[] | null = null;
  let layerRadius = NaN;

  function resize(cssPx: number): void {
    const d = Math.max(1, Math.round(cssPx));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (d === size && ratio === dpr) return;
    size = d;
    dpr = ratio;
    px = Math.max(1, Math.round(d * ratio));
    canvas.width = px; // also clears the canvas
    canvas.height = px;
    canvas.style.width = d + 'px';
    canvas.style.height = d + 'px';
    layer = null; // the cached picture is the wrong size now
    lastDraw = -Infinity;
  }

  /** Radius (CSS px) the arena edge ring is drawn at; world meters are scaled to fit it. */
  function ringRadius(): number {
    return size / 2 - RIM - 3.5;
  }

  function buildLayer(map: MapState): void {
    const img = layer ?? document.createElement('canvas');
    img.width = px;
    img.height = px;
    layer = img;
    layerObstacles = map.obstacles;
    layerRadius = map.arenaRadius;
    const c = img.getContext('2d');
    if (!c) return;
    const half = size / 2;
    const ringR = ringRadius();
    const s = ringR / Math.max(1, map.arenaRadius);
    c.setTransform(dpr, 0, 0, dpr, half * dpr, half * dpr); // origin = middle of the radar

    // water
    c.beginPath();
    c.arc(0, 0, half - RIM / 2, 0, TAU);
    c.fillStyle = WATER;
    c.fill();

    // islands (world x/z used directly as canvas x/y; drawImage() turns the whole picture later)
    c.lineWidth = 1.3;
    c.strokeStyle = SAND_EDGE;
    c.fillStyle = SAND;
    for (const o of map.obstacles) {
      c.beginPath();
      c.arc(o.x * s, o.z * s, Math.max(2, o.radius * s), 0, TAU);
      c.fill();
      c.stroke();
    }

    // arena edge: a ring of red and white buoys
    c.lineWidth = 3;
    c.strokeStyle = '#ffffff';
    c.setLineDash([]);
    c.beginPath();
    c.arc(0, 0, ringR, 0, TAU);
    c.stroke();
    c.strokeStyle = '#ff3b30';
    c.setLineDash([3.2, 6.4]);
    c.beginPath();
    c.arc(0, 0, ringR, 0, TAU);
    c.stroke();
    c.setLineDash([]);

    // white rim around the whole radar
    c.lineWidth = RIM;
    c.strokeStyle = '#ffffff';
    c.beginPath();
    c.arc(0, 0, half - RIM / 2, 0, TAU);
    c.stroke();
  }

  function drawBoat(
    c: CanvasRenderingContext2D,
    b: MapBoat,
    x: number,
    y: number,
    ang: number,
    len: number,
    ringColor: number | null,
  ): void {
    c.save();
    c.translate(x, y);
    if (ringColor !== null) {
      c.lineWidth = 2.2;
      c.strokeStyle = cssColor(ringColor);
      c.beginPath();
      c.arc(0, 0, len * 0.82, 0, TAU);
      c.stroke();
    }
    c.rotate(ang);
    arrowPath(c, len);
    c.lineJoin = 'round';
    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    c.fillStyle = cssColor(b.color);
    c.stroke();
    c.fill();
    c.restore();
  }

  function draw(map: MapState, p: PlayerHud, mode: ModeId, nowMs: number): void {
    if (!ctx || size === 0) return;
    if (nowMs - lastDraw < DRAW_EVERY_MS) return;
    lastDraw = nowMs;
    if (layer === null || layerObstacles !== map.obstacles || layerRadius !== map.arenaRadius) buildLayer(map);

    const half = size / 2;
    const s = ringRadius() / Math.max(1, map.arenaRadius);
    const hv = p.viewHeading;
    const cosH = Math.cos(hv);
    const sinH = Math.sin(hv);
    // world (x, z) -> radar px with "the camera's forward" pointing up:
    //   right = (-cos h, sin h), forward = (sin h, cos h)
    //   px = half + (x * -cos h + z * sin h) * s,  py = half - (x * sin h + z * cos h) * s

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // water, islands, edge ring: the cached picture, turned to match the camera
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(hv + Math.PI);
    if (layer) ctx.drawImage(layer, -half, -half, size, size);
    ctx.restore();

    // race gates: short bars across the track; the next one pulses
    const gates = map.gates;
    if (gates.length > 0) {
      const pulse = 0.5 + 0.5 * Math.sin((nowMs / 1000) * TAU * 1.8);
      for (let i = 0; i < gates.length; i++) {
        const g = gates[i];
        const gx = half + (-g.position.x * cosH + g.position.z * sinH) * s;
        const gy = half - (g.position.x * sinH + g.position.z * cosH) * s;
        const w = Math.max(8, g.radius * 2 * s);
        const next = i === p.nextGate;
        ctx.save();
        ctx.translate(gx, gy);
        ctx.rotate(hv - g.heading);
        if (next) {
          const grow = 2 + 4 * pulse;
          ctx.globalAlpha = 0.35 + 0.35 * pulse;
          ctx.fillStyle = SUN;
          ctx.fillRect(-w / 2 - grow, -3.5 - grow, w + grow * 2, 7 + grow * 2);
          ctx.globalAlpha = 1;
          ctx.fillStyle = ORANGE;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.6;
          ctx.fillRect(-w / 2 - 1, -3, w + 2, 6);
          ctx.strokeRect(-w / 2 - 1, -3, w + 2, 6);
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = NAVY;
          ctx.lineWidth = 1;
          ctx.fillRect(-w / 2, -1.8, w, 3.6);
          ctx.strokeRect(-w / 2, -1.8, w, 3.6);
        }
        ctx.restore();
      }
    }

    // balloons (Balloon Pop): small pink dots, bigger gold ones worth 3
    const balloons = map.balloons;
    if (balloons.length > 0) {
      for (let pass = 0; pass < 2; pass++) {
        const gold = pass === 1;
        const r = gold ? 4 : 2.6;
        ctx.beginPath();
        for (let i = 0; i < balloons.length; i++) {
          const b = balloons[i];
          if (b.gold !== gold) continue;
          const bx = half + (-b.x * cosH + b.z * sinH) * s;
          const by = half - (b.x * sinH + b.z * cosH) * s;
          ctx.moveTo(bx + r, by);
          ctx.arc(bx, by, r, 0, TAU);
        }
        ctx.fillStyle = gold ? '#ffc400' : '#ff5d73';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = gold ? 1.7 : 1.1;
        ctx.fill();
        ctx.stroke();
      }
    }

    // power-up crates: yellow dots with a dark edge
    const pickups = map.pickups;
    if (pickups.length > 0) {
      ctx.beginPath();
      for (let i = 0; i < pickups.length; i++) {
        const q = pickups[i];
        const qx = half + (-q.x * cosH + q.z * sinH) * s;
        const qy = half - (q.x * sinH + q.z * cosH) * s;
        ctx.moveTo(qx + 3.2, qy);
        ctx.arc(qx, qy, 3.2, 0, TAU);
      }
      ctx.fillStyle = '#ffe14a';
      ctx.strokeStyle = NAVY;
      ctx.lineWidth = 1.6;
      ctx.fill();
      ctx.stroke();
    }

    // sharks (every mode): small dark-grey fins pointing the way they swim; the MEGA SHARK is big and purple.
    // Under the boats, so a boat is never hidden by one.
    const sharks = map.sharks; // (an older game core may not send any)
    if (sharks && sharks.length > 0) {
      const fin = clamp(size * 0.065, 7, 11);
      ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        const megaPass = pass === 1; // MEGA last, so it is never covered
        for (let i = 0; i < sharks.length; i++) {
          const sh = sharks[i];
          if (sh.mega !== megaPass) continue;
          const sx = half + (-sh.x * cosH + sh.z * sinH) * s;
          const sy = half - (sh.x * sinH + sh.z * cosH) * s;
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(hv - sh.heading); // 0 = pointing up the radar
          finPath(ctx, megaPass ? fin * 2 : fin);
          ctx.lineWidth = megaPass ? 2.4 : 1.4;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
          ctx.fillStyle = megaPass ? MEGA_PURPLE : SHARK_GREY;
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // boats: computer boats first, other humans over them, you on top
    const own = clamp(size * 0.12, 12, 20);
    const boats = map.boats;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < boats.length; i++) {
        const b = boats[i];
        const mine = b.id === p.boatId;
        if (pass === 0 ? mine || b.isHuman : pass === 1 ? mine || !b.isHuman : !mine) continue;
        const bx = half + (-b.x * cosH + b.z * sinH) * s;
        const by = half - (b.x * sinH + b.z * cosH) * s;
        const ang = hv - b.heading; // 0 = pointing up the radar
        if (mine) {
          // you: a big arrow with a thick white outline
          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(ang);
          arrowPath(ctx, own);
          ctx.lineJoin = 'round';
          ctx.lineWidth = 4;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = NAVY;
          ctx.stroke();
          ctx.fillStyle = cssColor(b.color);
          ctx.fill();
          ctx.restore();
        } else {
          const mate = mode === 'team' && b.team === p.team;
          const ringColor = mate ? (CONFIG.team.colors[b.team] ?? 0xffffff) : null;
          drawBoat(ctx, b, bx, by, ang, own * (b.isHuman ? 0.78 : 0.58), ringColor);
        }
      }
    }
  }

  function invalidate(): void {
    lastDraw = -Infinity;
  }

  function dispose(): void {
    if (layer) {
      layer.width = 0; // lets the browser free the picture right away
      layer.height = 0;
      layer = null;
    }
    layerObstacles = null;
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  }

  return { canvas, resize, draw, invalidate, dispose };
}
