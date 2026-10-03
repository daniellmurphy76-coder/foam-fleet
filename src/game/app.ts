/**
 * The Foam Fleet app: renderer, state machine, main loop, split-screen drawing, HUD wiring.
 *
 *   menu -> countdown -> playing <-> paused -> results -> (rematch | menu)
 *
 * The simulation runs in fixed 1/60 s steps (so the game plays the same on any
 * computer); drawing happens once per animation frame.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { HudState, MatchSetup, MenuInput, PlayerHud, ScoreRow, Sfx, Hud, InputManager, Menu, Viewport } from '../types';
import { OrbitCamera, computeViewports } from './cameras';
import { foam, installErrorCapture, reportError, type FoamSnapshot } from './debug';
import {
  EMPTY_MENU, fallbackHud, fallbackInput, fallbackMenu, idleController, quietHud, quietSfx,
} from './fallbacks';
import { V2_METHODS, buildOrFallback, guard } from './guard';
import { Match, STEP } from './match';
import { createHud, createInput, createMenu, createSfx } from './modules';
import { defaultSetup, sanitizeSetup, setupFromQuery } from './setup';
import { clamp, topSpeedOf, wrapPi } from './util';

type AppState = 'menu' | 'countdown' | 'playing' | 'paused' | 'results';

/** Shows through the gap between the two split-screen halves. */
const DIVIDER_COLOR = 0x0b2a3a;
/** The lagoon that sails behind the title screen: no humans, six bots. */
const ATTRACT_SETUP: MatchSetup = {
  mode: 'battle', humans: 1, bots: 6, botDifficulty: 'normal', players: [], durationSec: 999999, laps: 1,
};

/** Find a layer div by id, or make one if index.html did not have it. */
function layer(root: HTMLElement, id: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    root.appendChild(el);
  }
  return el;
}

const round = (v: number, places: number): number => {
  const k = 10 ** places;
  return Math.round(v * k) / k;
};

class FoamApp {
  private state: AppState = 'menu';
  private readonly root: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly sfx: Sfx;
  private readonly input: InputManager;
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly orbit = new OrbitCamera();

  private match: Match | null = null;
  private attract: Match | null = null;
  private attractFocus = 0;
  private attractTimer = 0;
  private lastSetup: MatchSetup | null = null;

  private width = 1;
  private height = 1;
  private pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  private viewports: Viewport[] = [];

  private lastTime = 0;
  private lastRaf = 0;
  private acc = 0;
  private countdownT = 0;
  private countdownShown = -1;
  /** What a pause interrupted (the 3-2-1 or the match), so Resume carries on from the same place. */
  private pausedFrom: 'countdown' | 'playing' = 'playing';
  private readonly engineLevels: number[] = [];

  private fps = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private slowSeconds = 0;
  private fpsEl: HTMLElement | null = null;
  private noPause = false;

  constructor() {
    const params = new URLSearchParams(window.location.search);
    const root = document.getElementById('app') ?? document.body;
    this.root = root;
    const hudRoot = layer(root, 'hud');
    const menuRoot = layer(root, 'menu');

    // Renderer.
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(this.pixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    // (PCFSoftShadowMap was removed in three r18x; PCFShadowMap is the soft-edged one now.)
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // We refresh the shadow map once per frame ourselves, so split screen does not pay for it twice.
    renderer.shadowMap.autoUpdate = false;
    renderer.info.autoReset = false;
    renderer.setClearColor(DIVIDER_COLOR, 1);
    root.insertBefore(renderer.domElement, hudRoot.parentElement === root ? hudRoot : root.firstChild);
    this.renderer = renderer;

    // Services. Each is wrapped so a throwing module is logged instead of freezing the loop.
    // (?mute=1 is handled inside audio/sfx.ts: that page load is silent, the sound buttons and the M key do
    // nothing, and nothing is saved. The core only has to hand the same Sfx to everyone.)
    this.sfx = guard('sfx', buildOrFallback('createSfx', () => createSfx(), quietSfx), {}, V2_METHODS.sfx);
    this.input = guard(
      'input',
      buildOrFallback('createInput', () => createInput(window), fallbackInput),
      {
        humanController: () => idleController('human'),
        menu: () => EMPTY_MENU,
        gamepadCount: () => 0,
        schemeOf: () => 'keysA',
      },
      V2_METHODS.input,
    );
    this.hud = guard(
      'hud',
      buildOrFallback('createHud', () => createHud(hudRoot, this.sfx), () => fallbackHud(hudRoot)),
      {},
      V2_METHODS.hud,
    );
    this.menu = guard(
      'menu',
      buildOrFallback('createMenu', () => createMenu(menuRoot, this.sfx), () => fallbackMenu(menuRoot, defaultSetup)),
      { visible: () => false },
    );

    // URL switches (handy for testing; see debug.ts).
    this.noPause = params.get('nopause') === '1';
    if (params.get('autopilot') === '1') foam.autopilot = true;
    const scale = Number(params.get('timescale'));
    if (scale > 0) foam.timeScale = scale;
    if (params.get('fps') === '1') {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:8px;bottom:8px;z-index:1000;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.55);color:#fff;font:12px monospace;pointer-events:none';
      root.appendChild(el);
      this.fpsEl = el;
    }
  }

  start(): void {
    this.layout();
    window.addEventListener('resize', () => this.layout());
    // Alt-tabbing away pauses a live match. The iPad app switcher hides the page without a blur, so
    // a page that turns hidden pauses it too.
    window.addEventListener('blur', () => this.pauseIfAway());
    document.addEventListener('visibilitychange', () => {
      this.lastTime = performance.now();
      if (document.visibilityState === 'hidden') this.pauseIfAway();
    });

    // Browsers only allow sound after a click or key press. iOS only counts the END of a touch
    // (pointerup / touchend), so listen for those as well as the start.
    const unlock = (): void => {
      this.sfx.unlock();
      this.sfx.setMusic(true);
    };
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
      window.addEventListener(type, unlock, { once: true, capture: true, passive: true });
    }
    this.sfx.setMusic(true);

    this.hookDebug();

    const quick = setupFromQuery(new URLSearchParams(window.location.search));
    if (quick) this.startMatch(quick);
    else this.enterMenu();

    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
    // Hidden tabs stop animation frames; keep the simulation ticking slowly so test tools can still drive it.
    window.setInterval(() => {
      if (document.hidden && performance.now() - this.lastRaf > 300) this.tick(performance.now(), false);
    }, 250);
  }

  // ───────────────────────────── state changes ─────────────────────────────

  private setState(next: AppState): void {
    this.state = next;
    foam.state = next;
    this.syncTouch();
  }

  /** Leaving the page pauses a live match. (?nopause=1 and autopilot are test hooks that opt out.) */
  private pauseIfAway(): void {
    if (this.state === 'playing' && !this.noPause && !foam.autopilot) this.pause();
  }

  /**
   * Tell the touch controls where the human viewports are and whether to show: only during the countdown
   * and play. Runs on every state change and every resize. startMatch/enterMenu change state before they
   * rebuild the viewports, so a call that still sees the old viewport count waits for layout() to repeat it.
   */
  private syncTouch(): void {
    const m = this.match;
    const humans: 1 | 2 = m && this.state !== 'menu' && m.humanCount === 2 ? 2 : 1;
    if (this.viewports.length !== humans) return;
    this.input.layoutTouch(this.viewports, humans, this.state === 'countdown' || this.state === 'playing');
  }

  /** Back to the title screen (with the demo lagoon behind it). */
  private enterMenu(): void {
    this.hud.hidePause();
    this.hud.hideResults();
    this.hud.hide();
    this.sfx.setEngines([]);
    this.disposeMatch();
    if (!this.attract) {
      try {
        this.attract = new Match(ATTRACT_SETUP, { hud: quietHud(), sfx: quietSfx(), input: this.input }, true);
      } catch (e) {
        reportError('attract', e);
        this.attract = null;
      }
    }
    this.attractFocus = 0;
    this.attractTimer = 0;
    this.orbit.reset();
    this.acc = 0;
    this.setState('menu');
    this.layout();
    this.menu.show(this.lastSetup, (setup) => this.startMatch(setup));
  }

  private startMatch(raw: MatchSetup): void {
    const setup = sanitizeSetup(raw);
    this.lastSetup = setup;
    this.sfx.unlock();
    this.sfx.setMusic(true);
    this.menu.hide();
    this.hud.hidePause();
    this.hud.hideResults();
    this.disposeMatch();
    this.disposeAttract();

    let match: Match;
    try {
      match = new Match(setup, { hud: this.hud, sfx: this.sfx, input: this.input });
    } catch (e) {
      reportError('startMatch', e);
      this.enterMenu();
      return;
    }
    this.match = match;
    // Leave the 'menu' state BEFORE layout(): layout() only builds split-screen viewports (and sets each
    // camera's aspect) when it sees a live match, and 'menu' means "show the demo lagoon, one viewport".
    this.countdownT = 0;
    this.countdownShown = -1;
    this.acc = 0;
    this.setState('countdown');
    this.layout();
    this.hud.show();
  }

  /** (The touch Pause button is on screen during the countdown too, so a tap there has to work.) */
  private pause(): void {
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    this.pausedFrom = this.state;
    this.setState('paused');
    this.sfx.setEngines([]);
    this.hud.showPause(() => this.resume(), () => this.enterMenu());
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.hud.hidePause();
    this.setState(this.pausedFrom);
    this.acc = 0;
    this.lastTime = performance.now();
  }

  private finish(match: Match): void {
    this.setState('results');
    this.orbit.reset();
    this.sfx.setEngines([]);
    // Clear the per-player panels (reticle, ammo, boost, scoreboard) off the podium screen. hide() only
    // touches the live layer, so the results overlay shown right below is unaffected.
    this.hud.hide();
    this.hud.showResults(match.result(), () => this.startMatch(match.setup), () => this.enterMenu());
    // Boats vs. Sharks that the sharks won gets a friendly wah-wah instead of the fanfare.
    const lost = match.setup.mode === 'sharks' && !match.mode.outcome(match.boats[0]?.id ?? 0).won;
    if (lost) this.sfx.defeat();
    else this.sfx.victory();
  }

  private disposeMatch(): void {
    if (this.match) {
      this.match.dispose();
      this.match = null;
    }
    this.renderer.renderLists.dispose();
  }

  private disposeAttract(): void {
    if (this.attract) {
      this.attract.dispose();
      this.attract = null;
    }
  }

  // ───────────────────────────── the loop ─────────────────────────────

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    this.lastRaf = now;
    this.tick(now, true);
  };

  /** One pass of the app: read input, run simulation steps, then (if `draw`) cameras, HUD, sound and pixels. */
  private tick(now: number, draw: boolean): void {
    const raw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = clamp(raw > 0 ? raw : 0, 0, 0.1); // a long hitch should not make boats teleport
    try {
      if (draw) this.trackFps(raw);
      this.input.poll();
      const mi = this.input.menu;
      if (mi.mute) this.sfx.setMuted(!this.sfx.muted);
      this.routeInput(mi);
      this.simulate(dt);
    } catch (e) {
      reportError('frame', e);
    }
    if (draw) {
      this.updateCameras(dt);
      this.updateHud();
      this.updateAudio();
      this.drawFrame();
    }
  }

  /** Send this frame's menu buttons to whichever screen is in charge. */
  private routeInput(mi: MenuInput): void {
    switch (this.state) {
      case 'menu':
        this.menu.update(mi);
        break;
      case 'playing':
        if (mi.pause) this.pause();
        break;
      case 'paused':
        // Pause again = resume. (Escape is both "pause" and "back", so check pause first.)
        if (mi.pause) this.resume();
        else this.hud.handleMenuInput(mi);
        break;
      case 'results':
        this.hud.handleMenuInput(mi);
        break;
      case 'countdown':
        if (mi.pause) this.pause();
        break;
      default:
        break;
    }
  }

  /** Fixed-step simulation: accumulate real time, spend it in 1/60 s slices. */
  private simulate(dt: number): void {
    if (this.state === 'paused') {
      this.acc = 0;
      return;
    }
    const scale = Number.isFinite(foam.timeScale) ? clamp(Number(foam.timeScale), 0, 20) : 1;
    this.acc += dt * scale;
    // Normally at most 5 steps per frame; fast-forward earns more.
    const maxSteps = Math.max(5, Math.ceil(5 * scale));
    let steps = 0;
    while (this.acc >= STEP && steps < maxSteps && !this.isPaused()) {
      this.acc -= STEP;
      steps++;
      this.fixedStep();
    }
    if (steps >= maxSteps) this.acc = 0; // too far behind: drop the backlog instead of spiralling
  }

  /** (A method, not an inline comparison, because a step can change the state mid-loop.) */
  private isPaused(): boolean {
    return this.state === 'paused';
  }

  private fixedStep(): void {
    try {
      switch (this.state) {
        case 'menu':
          this.attract?.step(STEP, true, false);
          break;
        case 'countdown':
          this.countdownStep();
          break;
        case 'playing': {
          const m = this.match;
          if (!m) break;
          m.step(STEP, true, true);
          if (m.mode.over) this.finish(m);
          break;
        }
        case 'results':
          this.match?.step(STEP, false, false);
          break;
        default:
          break;
      }
    } catch (e) {
      reportError('step', e);
    }
  }

  /** 3, 2, 1, GO! The boats sit still (and rev) until GO. */
  private countdownStep(): void {
    const m = this.match;
    if (!m) return;
    const secs = Math.max(1, Math.round(CONFIG.match.countdownSec));
    const k = Math.floor(this.countdownT);
    if (k !== this.countdownShown && k < secs) {
      this.countdownShown = k;
      const n = secs - k;
      this.hud.announce(String(n), { ms: 900, sub: k === 0 ? this.countdownSub(m.setup.mode) : undefined });
      this.sfx.countdown(n);
    }
    m.step(STEP, false, false);
    this.countdownT += STEP;
    if (this.countdownT >= secs) {
      m.mode.begin();
      this.hud.announce('GO!', { ms: 900 });
      this.sfx.go();
      this.setState('playing');
    }
  }

  /** The line under the first countdown number. */
  private countdownSub(mode: MatchSetup['mode']): string {
    switch (mode) {
      case 'race': return 'Race through the gates!';
      case 'team': return `${CONFIG.team.names[0]} vs ${CONFIG.team.names[1]}!`;
      case 'practice': return 'Pop all the balloons!';
      case 'sharks': return 'Team up and scare off the sharks!';
      default: return 'Tag the other boats!';
    }
  }

  // ───────────────────────────── per-frame visuals ─────────────────────────────

  private updateCameras(dt: number): void {
    try {
      if (this.state === 'menu') {
        const m = this.attract;
        if (!m || m.boats.length === 0) return;
        this.attractTimer += dt;
        if (this.attractTimer > 12) {
          this.attractTimer = 0;
          this.attractFocus = (this.attractFocus + 1) % m.boats.length;
          this.orbit.reset();
        }
        this.orbit.update(dt, m.boats[this.attractFocus].position, m.world, m.t, 18, 7, 0.25);
      } else if (this.state === 'results') {
        const m = this.match;
        if (!m) return;
        const winner = m.mode.ranking[0] ?? m.boats[0];
        this.orbit.update(dt, winner.position, m.world, m.t, 14, 5, 0.4);
      } else if (this.state === 'countdown' || this.state === 'playing') {
        this.match?.updateCameras(dt);
      }
    } catch (e) {
      reportError('updateCameras', e);
    }
  }

  private updateHud(): void {
    const m = this.match;
    if (!m || this.state === 'menu') return;
    try {
      this.hud.update(this.buildHudState(m));
    } catch (e) {
      reportError('hudState', e);
    }
  }

  /** A fresh HudState every frame (small, and it keeps the HUD's "did anything change?" checks honest). */
  private buildHudState(m: Match): HudState {
    const mode = m.mode;
    const players: PlayerHud[] = [];
    for (let i = 0; i < m.humanCount; i++) {
      const boat = m.boats[i];
      // The arrow points from the camera's forward direction toward the next gate. Right = clockwise = positive.
      const gate = mode.gatePosition(i);
      const arrow = gate
        ? wrapPi(m.cams[i].viewHeading - Math.atan2(gate.x - boat.position.x, gate.z - boat.position.z))
        : null;
      const lockId = boat.aimTargetId;
      players.push({
        name: boat.name,
        color: boat.color,
        score: mode.scoreOf(i),
        ammo: boat.ammo,
        maxAmmo: boat.maxAmmo,
        reloading: boat.reloading,
        reloadProgress: boat.reloadProgress,
        boost: boat.boost,
        powerUp: boat.powerUp,
        shielded: boat.shielded,
        rank: mode.rankOf(i),
        race: mode.raceInfo(i),
        arrow,
        // A boat's name, or "Shark" / "MEGA SHARK" when the blaster is locked onto a shark (ids from SHARK_ID_BASE up).
        lockedTarget: lockId != null ? m.targetName(lockId) : null,
        boatId: boat.id,
        team: boat.team,
        viewHeading: m.cams[i].viewHeading,
        nextGate: mode.nextGate(i),
        easyDriving: boat.easyDriving,
      });
    }
    const scoreboard: ScoreRow[] = [];
    const ranking = mode.ranking;
    for (let i = 0; i < ranking.length; i++) {
      const b = ranking[i];
      scoreboard.push({ id: b.id, name: b.name, color: b.color, score: mode.scoreOf(b.id), isHuman: b.isHuman, team: b.team });
    }
    return {
      mode: mode.id,
      timeLeft: mode.timeLeft(),
      raceTime: mode.raceTime(),
      players,
      viewports: this.viewports,
      scoreboard,
      teams: mode.teams(),
      balloons: mode.balloonCount(),
      sharks: mode.sharkHud(),
      map: m.mapState(),
    };
  }

  /** Engine hum follows each human's speed (with a little rev during the countdown). */
  private updateAudio(): void {
    const levels = this.engineLevels;
    levels.length = 0;
    try {
      const m = this.match;
      if (m && (this.state === 'playing' || this.state === 'countdown')) {
        for (let i = 0; i < m.humanCount; i++) {
          levels.push(
            this.state === 'countdown'
              ? 0.18 + 0.08 * Math.sin(m.t * 9)
              : clamp(Math.abs(m.boats[i].speed) / topSpeedOf(m.boats[i].easyDriving), 0, 1),
          );
        }
      }
    } catch (e) {
      reportError('updateAudio', e);
      levels.length = 0;
    }
    this.sfx.setEngines(levels);
  }

  /** Draw the scene: full screen (menu, results) or one viewport per human. */
  private drawFrame(): void {
    const r = this.renderer;
    try {
      r.info.reset();
      r.setScissorTest(false);
      r.clear(); // paints the divider color everywhere; viewports draw over it
      const live = this.state === 'menu' ? this.attract : this.match;
      if (!live) return;
      r.shadowMap.needsUpdate = true; // the first viewport refreshes shadows, the second reuses them

      if (this.state === 'menu' || this.state === 'results') {
        r.setViewport(0, 0, this.width, this.height);
        r.render(live.scene, this.orbit.camera);
        return;
      }
      for (let i = 0; i < live.cams.length; i++) {
        const vp = this.viewports[i];
        if (!vp) continue;
        const y = this.height - vp.y - vp.height; // WebGL's origin is bottom-left
        r.setViewport(vp.x, y, vp.width, vp.height);
        r.setScissor(vp.x, y, vp.width, vp.height);
        r.setScissorTest(true);
        r.render(live.scene, live.cams[i].camera);
      }
      r.setScissorTest(false);
    } catch (e) {
      reportError('render', e);
    }
  }

  // ───────────────────────────── sizing and stats ─────────────────────────────

  /** Match the canvas to the window, and recompute the split-screen rectangles. */
  private layout(): void {
    const w = Math.max(1, this.root.clientWidth || window.innerWidth);
    const h = Math.max(1, this.root.clientHeight || window.innerHeight);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false); // CSS already sizes the canvas to fill #app
    const humans = this.match && this.state !== 'menu' ? this.match.humanCount : 1;
    this.viewports = computeViewports(w, h, humans);
    if (this.match) {
      for (let i = 0; i < this.match.cams.length; i++) {
        const vp = this.viewports[i];
        if (vp) this.match.cams[i].setAspect(vp.width / vp.height);
      }
    }
    this.orbit.setAspect(w / h);
    this.syncTouch();
  }

  private trackFps(raw: number): void {
    if (raw <= 0 || raw > 1) return; // ignore hitches and the first frame
    this.fpsFrames++;
    this.fpsTime += raw;
    if (this.fpsTime < 0.5) return;
    this.fps = this.fpsFrames / this.fpsTime;
    this.fpsFrames = 0;
    this.fpsTime = 0;
    if (this.fpsEl) {
      this.fpsEl.textContent = `${Math.round(this.fps)} fps | ${this.renderer.info.render.calls} calls | ${this.pixelRatio}x`;
    }
    // A slow machine? Quietly use fewer pixels (never goes back up, so it cannot flip-flop).
    // Only count while the tab is visible AND focused: a hidden or background tab runs slowly
    // for reasons that have nothing to do with the machine, and must never lower the resolution for good.
    const watching = document.visibilityState === 'visible' && document.hasFocus();
    if (watching && this.state === 'playing' && foam.timeScale <= 1 && this.fps < 40) this.slowSeconds += 0.5;
    else this.slowSeconds = 0;
    if (this.slowSeconds >= 3 && this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.5);
      this.slowSeconds = 0;
      this.layout();
    }
  }

  // ───────────────────────────── debug hooks ─────────────────────────────

  private hookDebug(): void {
    foam.snapshot = () => this.snapshot();
    foam.start = (opts) => this.startMatch({ ...defaultSetup(opts?.mode ?? 'battle'), ...opts });
    foam.menu = () => this.enterMenu();
    foam.pause = () => this.pause();
    foam.resume = () => this.resume();
    (foam as unknown as { app: unknown }).app = this; // console poking only
    foam.bench = (n = 60) => {
      const gl = this.renderer.getContext();
      const px = new Uint8Array(4);
      let stepMs = 0;
      let drawMs = 0;
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        this.fixedStep();
        const t1 = performance.now();
        this.drawFrame();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // wait for the GPU
        drawMs += performance.now() - t1;
        stepMs += t1 - t0;
      }
      return { stepMs: round(stepMs / n, 2), drawMs: round(drawMs / n, 2) };
    };
  }

  private snapshot(): FoamSnapshot {
    const m = this.match;
    const info = this.renderer.info;
    const snap: FoamSnapshot = {
      state: this.state,
      t: m ? round(m.t, 3) : 0,
      fps: round(this.fps, 1),
      mode: m ? m.setup.mode : null,
      boats: [],
      darts: 0,
      hits: m ? m.hits : 0,
      errors: foam.errors.slice(),
      timeLeft: null,
      raceTime: null,
      balloons: null,
      teams: null,
      sharks: null,
      sharkRules: null,
      humans: [],
      fallbacks: foam.fallbacks.slice(),
      touchActive: this.input.touchActive === true,
      muted: this.sfx.muted === true,
      render: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
    };
    if (!m) return snap;
    try {
      snap.darts = m.darts.activeCount;
      snap.timeLeft = m.mode.timeLeft();
      snap.raceTime = m.mode.raceTime();
      snap.balloons = m.mode.balloonCount();
      snap.teams = m.mode.teams();
      const mega = m.sharks.mega;
      snap.sharks = {
        waveLeft: m.sharks.waveLeft,
        mega: mega ? { health: mega.health, maxHealth: mega.maxHealth } : null,
        count: m.sharks.targets.length,
      };
      snap.sharkRules = m.mode.sharkHud();
      for (const p of m.players) {
        snap.humans.push({
          slot: p.slot,
          hits: p.hits,
          tagsOnOtherHuman: p.tagsOnOtherHuman,
          timesTagged: p.timesTagged,
          balloons: p.balloons,
          boostSeconds: round(p.boostSeconds, 1),
          pickups: p.pickups,
          honks: p.honks,
          rescues: p.rescues,
          sharkTags: p.sharkTags,
          sharkBumps: p.sharkBumps,
        });
      }
      for (const b of m.boats) {
        const race = m.mode.raceInfo(b.id);
        snap.boats.push({
          id: b.id,
          name: b.name,
          x: round(b.position.x, 2),
          z: round(b.position.z, 2),
          heading: round(b.heading, 3),
          speed: round(b.speed, 2),
          score: m.mode.scoreOf(b.id),
          ammo: b.ammo,
          stunned: b.stunned,
          boost: round(b.boost, 2),
          shielded: b.shielded,
          team: b.team,
          easy: b.easyDriving,
          powerUp: b.powerUp ? b.powerUp.kind : null,
          lap: race ? race.lap : null,
          gate: race ? race.checkpoint : null,
          finished: race ? race.finished : null,
        });
      }
    } catch (e) {
      reportError('snapshot', e);
    }
    return snap;
  }
}

/** Last-resort message if the game cannot start at all (usually: no WebGL). */
function showFatal(err: unknown): void {
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;padding:24px;text-align:center;color:#fff;font:700 24px system-ui,sans-serif;background:#0b2a3a;z-index:2000';
  const msg = document.createElement('div');
  msg.textContent = 'Foam Fleet could not start. This game needs a browser with WebGL turned on.';
  const detail = document.createElement('div');
  detail.style.cssText = 'font:14px monospace;opacity:.7';
  detail.textContent = err instanceof Error ? err.message : String(err);
  box.append(msg, detail);
  (document.getElementById('app') ?? document.body).appendChild(box);
}

export function bootGame(): void {
  installErrorCapture();
  window.__foam = foam;
  try {
    new FoamApp().start();
  } catch (e) {
    reportError('boot', e);
    showFatal(e);
  }
}
