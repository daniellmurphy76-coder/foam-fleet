import type { Sfx } from '../types';

/**
 * Synthesized sound effects and music (Web Audio, no asset files).
 *
 * How to read this file:
 *  - `tone()` plays one pitched beep (an oscillator with a volume envelope).
 *  - `noise()` plays a burst of filtered static (splashes, whooshes, thwips).
 *  - Each sound below (fire, hit, ...) is just a few of those stacked together.
 *  - Everything is a quiet no-op until `unlock()` has run (browsers need a click first).
 */

const MUTE_KEY = 'foamfleet.muted';
const MASTER_VOLUME = 0.75;
const MUSIC_VOLUME = 0.2; // the music is meant to sit way back behind the action
const MAX_VOICES = 36; // never stack more than this many sounds at once
const STEP = 0.25; // music: one eighth note at 120 bpm
const LOOKAHEAD = 0.4; // music: schedule this many seconds ahead
const TICK_MS = 80; // music: how often the scheduler wakes up

// Music in C major, one bar = 8 eighth-note steps, 8 bars, loops forever.
// Chords: C, Am, F, G, C, Am, F, G (bass roots below). 0 = rest.
const BASS_ROOTS = [48, 45, 41, 43, 48, 45, 41, 43];
const LEAD: readonly number[] = [
  76, 0, 79, 0, 81, 79, 76, 0, //  bar 1 (C)
  76, 0, 81, 0, 79, 76, 74, 0, //  bar 2 (Am)
  77, 0, 81, 0, 79, 77, 76, 0, //  bar 3 (F)
  74, 0, 79, 0, 83, 79, 74, 0, //  bar 4 (G)
  76, 0, 79, 0, 84, 0, 81, 79, //  bar 5 (C)
  81, 0, 79, 76, 0, 74, 76, 0, //  bar 6 (Am)
  77, 0, 76, 74, 72, 0, 74, 76, //  bar 7 (F)
  79, 0, 83, 79, 74, 0, 71, 0, //  bar 8 (G)
];

const mtof = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

interface Graph {
  ctx: AudioContext;
  master: GainNode; // mute lives here
  sfx: GainNode; // all one-shot sounds
  music: GainNode;
  engineBus: GainNode;
  noise: AudioBuffer; // two seconds of white noise, reused by every noise()
}

interface Engine {
  o1: OscillatorNode; // sawtooth
  o2: OscillatorNode; // detuned square
  lfo: OscillatorNode; // tiny putt-putt wobble
  lp: BiquadFilterNode;
  amp: GainNode;
  lfoDepth: GainNode;
  pan: StereoPannerNode;
  level: number; // smoothed 0..1
  vol: number; // smoothed volume
  lastF: number;
  lastV: number;
  lastPan: number;
}

interface ToneOpts {
  type?: OscillatorType;
  f0: number;
  /** Glide to this pitch over the note (cartoon bonks and boings). */
  f1?: number;
  dur: number;
  vol: number;
  attack?: number;
  lowpass?: number;
  /** Absolute audio-clock time; default is "right now". */
  when?: number;
  bus?: AudioNode;
}

interface NoiseOpts {
  dur: number;
  vol: number;
  type: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  attack?: number;
  when?: number;
  bus?: AudioNode;
}

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(m: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function createSfx(): Sfx {
  let g: Graph | null = null;
  let muted = readMuted();
  let musicOn = true;
  let voices = 0;

  // music scheduler state
  let musicTimer = 0;
  let nextStepTime = 0;
  let step = 0;

  // engine state (preallocated so setEngines() does not allocate each frame)
  const engines: Array<Engine | null> = [null, null];
  let lastEngineMs = 0;

  const lastAt = new Map<string, number>(); // rate limiting, keyed by sound name

  // ───────────── building blocks ─────────────

  function tone(a: Graph, o: ToneOpts): void {
    const ctx = a.ctx;
    const t0 = o.when ?? ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 !== undefined && o.f1 !== o.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + o.dur);
    }
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(Math.max(0.0002, o.vol), t0 + (o.attack ?? 0.006));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    let filter: BiquadFilterNode | null = null;
    if (o.lowpass) {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = o.lowpass;
      osc.connect(filter);
      filter.connect(amp);
    } else {
      osc.connect(amp);
    }
    amp.connect(o.bus ?? a.sfx);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
    voices++;
    osc.onended = () => {
      voices--;
      osc.disconnect();
      if (filter) filter.disconnect();
      amp.disconnect();
    };
  }

  function noise(a: Graph, o: NoiseOpts): void {
    const ctx = a.ctx;
    const t0 = o.when ?? ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = a.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.Q.value = o.q ?? 0.7;
    filter.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 !== undefined && o.f1 !== o.f0) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(10, o.f1), t0 + o.dur);
    }
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(Math.max(0.0002, o.vol), t0 + (o.attack ?? 0.004));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(filter);
    filter.connect(amp);
    amp.connect(o.bus ?? a.sfx);
    // start somewhere random in the noise buffer so every burst sounds a little different
    const offset = Math.random() * Math.max(0, a.noise.duration - o.dur - 0.1);
    src.start(t0, offset);
    src.stop(t0 + o.dur + 0.05);
    voices++;
    src.onended = () => {
      voices--;
      src.disconnect();
      filter.disconnect();
      amp.disconnect();
    };
  }

  /** Run a sound if audio is ready, not muted, not too soon after the same sound, and never throw. */
  function play(key: string, minGapSec: number, make: (a: Graph) => void): void {
    const a = g;
    if (!a || muted || a.ctx.state !== 'running') return;
    try {
      const now = a.ctx.currentTime;
      const last = lastAt.get(key);
      if (last !== undefined && now - last < minGapSec) return;
      lastAt.set(key, now);
      if (voices >= MAX_VOICES) return;
      make(a);
    } catch {
      /* a sound is never worth crashing the game over */
    }
  }

  // ───────────── the sounds ─────────────

  // Foam dart "thwip": a quick airy puff plus a short falling pop. Pitch wobbles a touch each shot.
  function makeFire(a: Graph): void {
    const r = 0.94 + Math.random() * 0.12;
    noise(a, { dur: 0.09, vol: 0.26, type: 'bandpass', f0: 2600 * r, f1: 900 * r, q: 1.2, attack: 0.003 });
    tone(a, { type: 'triangle', f0: 620 * r, f1: 160 * r, dur: 0.1, vol: 0.3 });
    tone(a, { f0: 1500 * r, f1: 600 * r, dur: 0.05, vol: 0.1 });
  }

  // Cartoon "bonk": a wooden thunk that drops in pitch, with a squeaky overtone.
  function makeHit(a: Graph): void {
    tone(a, { type: 'triangle', f0: 340, f1: 120, dur: 0.2, vol: 0.5, attack: 0.002 });
    tone(a, { f0: 820, f1: 300, dur: 0.12, vol: 0.22, attack: 0.002 });
    noise(a, { dur: 0.04, vol: 0.18, type: 'lowpass', f0: 2500, f1: 600 });
  }

  // "Boing": a bouncy sine that springs up and wobbles back down.
  function makeBoing(a: Graph): void {
    const ctx = a.ctx;
    const t0 = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(200, t0);
    osc.frequency.exponentialRampToValueAtTime(620, t0 + 0.09);
    osc.frequency.exponentialRampToValueAtTime(240, t0 + 0.42);
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 24;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 34;
    wobble.connect(wobbleDepth);
    wobbleDepth.connect(osc.frequency);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(0.38, t0 + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    osc.connect(amp);
    amp.connect(a.sfx);
    osc.start(t0);
    wobble.start(t0);
    osc.stop(t0 + 0.5);
    wobble.stop(t0 + 0.5);
    voices++;
    osc.onended = () => {
      voices--;
      osc.disconnect();
      wobble.disconnect();
      wobbleDepth.disconnect();
      amp.disconnect();
    };
  }

  let splashVolume = 1;
  function makeSplash(a: Graph): void {
    const v = splashVolume;
    noise(a, { dur: 0.28, vol: 0.26 * v, type: 'bandpass', f0: 1800, f1: 500, q: 0.8, attack: 0.01 });
    noise(a, { dur: 0.4, vol: 0.18 * v, type: 'lowpass', f0: 900, f1: 250, attack: 0.02 });
  }

  let bumpStrength = 0.5;
  function makeBump(a: Graph): void {
    const s = bumpStrength;
    tone(a, { f0: 140, f1: 48, dur: 0.16 + 0.1 * s, vol: 0.55 * s, attack: 0.002 });
    noise(a, { dur: 0.08, vol: 0.25 * s, type: 'lowpass', f0: 900, f1: 200 });
  }

  // Rising sparkle: C E G C, quick and cheerful.
  function makePickup(a: Graph): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    const t = a.ctx.currentTime + 0.005;
    for (let i = 0; i < notes.length; i++) {
      tone(a, { type: 'triangle', f0: notes[i], dur: 0.24, vol: 0.26, when: t + i * 0.065 });
      tone(a, { f0: notes[i] * 2, dur: 0.14, vol: 0.07, when: t + i * 0.065 });
    }
  }

  // Whoosh: a rising, then fading wash of air with a low rocket rumble underneath.
  function makeBoost(a: Graph): void {
    noise(a, { dur: 0.6, vol: 0.3, type: 'bandpass', f0: 400, f1: 2600, q: 0.9, attack: 0.18 });
    tone(a, { type: 'sawtooth', f0: 90, f1: 280, dur: 0.5, vol: 0.1, attack: 0.15, lowpass: 600 });
  }

  // A little glass bell: one pitch plus a quiet inharmonic overtone.
  function bell(a: Graph, f: number, when: number, dur: number, vol: number): void {
    tone(a, { f0: f, dur, vol, attack: 0.003, when });
    tone(a, { f0: f * 2.76, dur: dur * 0.5, vol: vol * 0.25, attack: 0.003, when });
  }
  function makeCheckpoint(a: Graph): void {
    bell(a, 1046.5, a.ctx.currentTime + 0.005, 0.5, 0.3);
  }
  function makeLap(a: Graph): void {
    const t = a.ctx.currentTime + 0.005;
    bell(a, 1046.5, t, 0.4, 0.28);
    bell(a, 1568, t + 0.13, 0.7, 0.3);
  }

  let countdownFreq = 440;
  let countdownDur = 0.2;
  function makeBeep(a: Graph): void {
    tone(a, { f0: countdownFreq, dur: countdownDur, vol: 0.3, attack: 0.01 });
    tone(a, { type: 'triangle', f0: countdownFreq * 2, dur: countdownDur * 0.8, vol: 0.08, attack: 0.01 });
  }

  // "Da da da DAAA, ta-da!" in C major, with a bright brass-ish saw.
  function makeVictory(a: Graph): void {
    const t = a.ctx.currentTime + 0.01;
    const notes: Array<[number, number, number]> = [
      // frequency, start, length
      [392.0, 0.0, 0.12],
      [392.0, 0.14, 0.12],
      [392.0, 0.28, 0.12],
      [523.25, 0.42, 0.3],
      [659.25, 0.78, 0.16],
      [783.99, 0.94, 0.16],
      [1046.5, 1.1, 0.95],
    ];
    for (const [f, start, len] of notes) {
      tone(a, { type: 'sawtooth', f0: f, dur: len, vol: 0.16, attack: 0.012, lowpass: 2200, when: t + start });
      tone(a, { type: 'triangle', f0: f, dur: len, vol: 0.12, attack: 0.012, when: t + start });
    }
    // the last chord fills out underneath
    for (const f of [523.25, 659.25, 783.99]) {
      tone(a, { type: 'triangle', f0: f, dur: 0.95, vol: 0.1, attack: 0.02, when: t + 1.1 });
    }
  }

  function makeUiMove(a: Graph): void {
    tone(a, { type: 'triangle', f0: 700, f1: 760, dur: 0.045, vol: 0.09, attack: 0.002 });
  }
  function makeUiSelect(a: Graph): void {
    tone(a, { f0: 520, f1: 860, dur: 0.1, vol: 0.2, attack: 0.004 });
    tone(a, { type: 'triangle', f0: 1040, dur: 0.08, vol: 0.07, attack: 0.004 });
  }

  // ───────────── music ─────────────

  function playStep(a: Graph, s64: number, when: number): void {
    const bar = (s64 >> 3) & 7;
    const s = s64 & 7;
    const root = BASS_ROOTS[bar];
    // bouncy "oom-pah" bass: root, fifth, root, fifth
    if (s % 2 === 0) {
      const note = s === 2 || s === 6 ? root + 7 : root;
      tone(a, { type: 'triangle', f0: mtof(note), dur: 0.34, vol: 0.55, attack: 0.008, lowpass: 700, bus: a.music, when });
    }
    // soft kick on beats 1 and 3, tiny shaker on the off-beats
    if (s === 0 || s === 4) {
      tone(a, { f0: 130, f1: 48, dur: 0.17, vol: 0.45, attack: 0.002, bus: a.music, when });
    }
    if (s % 2 === 1) {
      noise(a, { dur: 0.04, vol: 0.06, type: 'highpass', f0: 6500, bus: a.music, when });
    }
    // plucky lead
    const lead = LEAD[s64];
    if (lead) {
      const f = mtof(lead);
      tone(a, { type: 'square', f0: f, dur: 0.26, vol: 0.2, attack: 0.004, lowpass: 2600, bus: a.music, when });
      tone(a, { type: 'triangle', f0: f * 2, dur: 0.16, vol: 0.13, attack: 0.003, bus: a.music, when });
    }
  }

  function musicTick(): void {
    const a = g;
    if (!a || a.ctx.state !== 'running') return;
    try {
      const now = a.ctx.currentTime;
      // If we fell far behind (tab was asleep), restart the beat instead of playing a burst of old notes.
      if (nextStepTime < now - 0.25) nextStepTime = now + 0.05;
      while (nextStepTime < now + LOOKAHEAD) {
        if (!muted) playStep(a, step, nextStepTime);
        nextStepTime += STEP;
        step = (step + 1) & 63;
      }
    } catch {
      /* ignore */
    }
  }

  function startMusic(): void {
    if (!g || musicTimer) return;
    nextStepTime = g.ctx.currentTime + 0.1;
    step = 0;
    musicTimer = window.setInterval(musicTick, TICK_MS);
  }

  function stopMusic(): void {
    if (musicTimer) {
      window.clearInterval(musicTimer);
      musicTimer = 0;
    }
  }

  function applyMusic(): void {
    const a = g;
    if (!a) return;
    a.music.gain.setTargetAtTime(musicOn ? MUSIC_VOLUME : 0, a.ctx.currentTime, 0.15);
    if (musicOn) startMusic();
    else stopMusic();
  }

  // ───────────── engines ─────────────

  function makeEngine(a: Graph): Engine {
    const ctx = a.ctx;
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    const mix2 = ctx.createGain();
    mix2.gain.value = 0.45;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.8;
    lp.frequency.value = 300;
    const amp = ctx.createGain();
    amp.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 10;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    o1.connect(lp);
    o2.connect(mix2);
    mix2.connect(lp);
    lp.connect(amp);
    amp.connect(pan);
    pan.connect(a.engineBus);
    lfo.connect(lfoDepth);
    lfoDepth.connect(amp.gain);
    o1.start();
    o2.start();
    lfo.start();
    return { o1, o2, lfo, lp, amp, lfoDepth, pan, level: 0, vol: 0, lastF: 0, lastV: -1, lastPan: 0 };
  }

  function killEngine(e: Engine): void {
    try {
      e.o1.stop();
      e.o2.stop();
      e.lfo.stop();
    } catch {
      /* already stopped */
    }
    e.o1.disconnect();
    e.o2.disconnect();
    e.lfo.disconnect();
    e.lp.disconnect();
    e.amp.disconnect();
    e.lfoDepth.disconnect();
    e.pan.disconnect();
  }

  // ───────────── public API ─────────────

  function unlock(): void {
    try {
      if (g) {
        if (g.ctx.state !== 'running') void g.ctx.resume().catch(() => undefined);
        return;
      }
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();

      const master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_VOLUME;
      const comp = ctx.createDynamicsCompressor(); // keeps loud pile-ups from clipping
      comp.threshold.value = -16;
      comp.knee.value = 18;
      comp.ratio.value = 5;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      comp.connect(master);
      master.connect(ctx.destination);

      const sfx = ctx.createGain();
      const music = ctx.createGain();
      music.gain.value = 0;
      const engineBus = ctx.createGain();
      sfx.connect(comp);
      music.connect(comp);
      engineBus.connect(comp);

      const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      g = { ctx, master, sfx, music, engineBus, noise: noiseBuf };
      void ctx.resume().catch(() => undefined);
      applyMusic();

      // Be polite: go silent when the tab is hidden.
      document.addEventListener('visibilitychange', () => {
        const a = g;
        if (!a) return;
        if (document.hidden) void a.ctx.suspend().catch(() => undefined);
        else void a.ctx.resume().catch(() => undefined);
      });
    } catch {
      g = null; // audio is optional; the game carries on silently
    }
  }

  function setEngines(levels: number[]): void {
    const a = g;
    if (!a) return;
    const n = muted || a.ctx.state !== 'running' ? 0 : Math.min(levels.length, 2);
    if (n === 0 && engines[0] === null && engines[1] === null) return; // nothing to do, nothing allocated

    const nowMs = performance.now();
    const dt = Math.min(0.1, (nowMs - lastEngineMs) / 1000);
    lastEngineMs = nowMs;
    const k = 1 - Math.exp(-dt * 9); // smoothing, frame-rate independent

    for (let i = 0; i < 2; i++) {
      const want = i < n ? clamp(levels[i], 0, 1) : -1; // -1 = fade this engine out
      let e = engines[i];
      if (want < 0 && !e) continue;
      if (!e) {
        e = makeEngine(a);
        engines[i] = e;
      }
      if (want >= 0) e.level += (want - e.level) * k;
      const targetVol = want >= 0 ? 0.02 + 0.085 * e.level : 0;
      e.vol += (targetVol - e.vol) * k;
      if (want < 0 && e.vol < 0.0008) {
        killEngine(e);
        engines[i] = null;
        continue;
      }
      // Only touch the audio params when something moved enough to hear.
      const f = (46 + 82 * e.level) * (i === 1 ? 1.122 : 1);
      if (Math.abs(f - e.lastF) > 0.25) {
        e.o1.frequency.value = f;
        e.o2.frequency.value = f * 1.007;
        e.lp.frequency.value = 260 + 900 * e.level;
        e.lfo.frequency.value = 8 + 16 * e.level;
        e.lastF = f;
      }
      if (Math.abs(e.vol - e.lastV) > 0.0008) {
        e.amp.gain.value = e.vol;
        e.lfoDepth.gain.value = e.vol * 0.3;
        e.lastV = e.vol;
      }
      const pan = n === 2 ? (i === 0 ? -0.4 : 0.4) : 0;
      if (pan !== e.lastPan) {
        e.pan.pan.value = pan;
        e.lastPan = pan;
      }
    }
  }

  function setMuted(m: boolean): void {
    muted = m;
    writeMuted(m);
    const a = g;
    if (!a) return;
    try {
      a.master.gain.setTargetAtTime(m ? 0 : MASTER_VOLUME, a.ctx.currentTime, 0.02);
    } catch {
      /* ignore */
    }
  }

  function setMusic(on: boolean): void {
    musicOn = on;
    try {
      applyMusic();
    } catch {
      /* ignore */
    }
  }

  return {
    unlock,
    fire: () => play('fire', 0.035, makeFire),
    hit: () => play('hit', 0.04, makeHit),
    shieldBlock: () => play('shield', 0.1, makeBoing),
    splash: (volume = 1) => {
      splashVolume = clamp(volume, 0, 1.5);
      play('splash', 0.05, makeSplash);
    },
    bump: (strength: number) => {
      bumpStrength = clamp(strength / 12, 0.15, 1);
      play('bump', 0.08, makeBump);
    },
    pickup: () => play('pickup', 0.1, makePickup),
    boost: () => play('boost', 0.3, makeBoost),
    checkpoint: () => play('checkpoint', 0.15, makeCheckpoint),
    lap: () => play('lap', 0.4, makeLap),
    countdown: (n: number) => {
      countdownFreq = 440;
      countdownDur = 0.2 + (n <= 1 ? 0.05 : 0); // the "1" hangs on a hair longer
      play('countdown', 0.3, makeBeep);
    },
    go: () => {
      countdownFreq = 880;
      countdownDur = 0.5;
      play('go', 0.5, makeBeep);
    },
    victory: () => play('victory', 1.5, makeVictory),
    uiMove: () => play('uiMove', 0.03, makeUiMove),
    uiSelect: () => play('uiSelect', 0.06, makeUiSelect),
    setEngines,
    setMusic,
    setMuted,
    get muted(): boolean {
      return muted;
    },
  };
}
