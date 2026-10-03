import type { HornId, Sfx } from '../types';

/**
 * Synthesized sound effects and music (Web Audio, no asset files).
 *
 * How to read this file:
 *  - `tone()` plays one pitched beep (an oscillator with a volume envelope).
 *  - `noise()` plays a burst of filtered static (splashes, whooshes, thwips).
 *  - Each sound below (fire, hit, ...) is just a few of those stacked together.
 *  - Everything is a quiet no-op until `unlock()` has run (browsers need a click or a tap first).
 *
 * One game page = one AudioContext = one master gain, and mute turns that gain to zero, so "Sound: Off"
 * silences every sound this page can make. A sound that survives it is another copy of the game running
 * somewhere else (another tab, or a test browser). Two things below keep copies in step: the mute choice is
 * shared between tabs of the same browser, and a page opened with `?mute=1` is silent and never saves anything.
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
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

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
  /**
   * 0..1: stay at full volume for this share of the note before fading (horns need a steady "BEEEP";
   * without it a note starts fading right away, like a plucked string).
   */
  hold?: number;
  /** Absolute audio-clock time; default is "right now". */
  when?: number;
  bus?: AudioNode;
}

/** The shortest gap between two honks of the same horn (the long foghorn can't be spammed). */
const HORN_GAP: Record<HornId, number> = { beep: 0.12, duck: 0.2, foghorn: 0.5, clown: 0.25 };

/** A richer note than `tone()`: a filter that can "wah", a pitch wobble and a volume rattle (growls, trombones). */
interface VoiceOpts {
  type: OscillatorType;
  f0: number;
  /** Glide to this pitch over the note. */
  f1?: number;
  dur: number;
  vol: number;
  attack?: number;
  /** 0..1: share of the note held at full volume before it fades (default 0.7). */
  hold?: number;
  /** Low-pass cutoff. With `lp1` it opens up to lp1 about 40% into the note, then closes again: "wah". */
  lp0: number;
  lp1?: number;
  /** Pitch wobble: rate (Hz) and depth (Hz either side). */
  vibHz?: number;
  vibDepth?: number;
  /** Volume rattle: rate (Hz) and depth (0..1). */
  tremHz?: number;
  tremDepth?: number;
  when?: number;
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

/** `?mute=1`: the silent test mode. Quiet for this page load only; the sound buttons cannot undo it. */
function readForcedMute(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('mute') === '1';
  } catch {
    return false;
  }
}

/** Safari also reports 'interrupted' (a call, Siri, switching apps), which the DOM typings leave out. */
function stateOf(ctx: AudioContext): string {
  return ctx.state as string;
}

/** Any of these counts as "the player touched the game" for browsers that keep sound locked until then. */
const GESTURE_EVENTS = ['touchend', 'pointerup', 'click', 'keydown'];

export function createSfx(): Sfx {
  let g: Graph | null = null;
  const forcedMute = readForcedMute();
  let muted = forcedMute || readMuted();
  let musicOn = true;
  let voices = 0;
  let lifecycleWatched = false;

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
    const attack = o.attack ?? 0.006;
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(Math.max(0.0002, o.vol), t0 + attack);
    if (o.hold) amp.gain.setValueAtTime(Math.max(0.0002, o.vol), t0 + Math.max(attack, o.dur * o.hold));
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

  function voice(a: Graph, o: VoiceOpts): void {
    const ctx = a.ctx;
    const t0 = o.when ?? ctx.currentTime + 0.005;
    const t1 = t0 + o.dur;
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 !== undefined && o.f1 !== o.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t1);
    }
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2; // a little resonance makes the wah talk
    filter.frequency.setValueAtTime(o.lp0, t0);
    if (o.lp1 !== undefined) {
      filter.frequency.linearRampToValueAtTime(o.lp1, t0 + o.dur * 0.4);
      filter.frequency.linearRampToValueAtTime(o.lp0, t1);
    }
    const amp = ctx.createGain();
    const attack = o.attack ?? 0.02;
    const peak = Math.max(0.0002, o.vol);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(peak, t0 + attack);
    amp.gain.setValueAtTime(peak, t0 + Math.max(attack, o.dur * clamp(o.hold ?? 0.7, 0, 0.95)));
    amp.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(filter);
    filter.connect(amp);

    const extras: AudioNode[] = []; // everything we must disconnect afterwards
    const lfos: OscillatorNode[] = [];
    if (o.vibHz && o.vibDepth) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = o.vibHz;
      const depth = ctx.createGain();
      depth.gain.value = o.vibDepth;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfos.push(lfo);
      extras.push(lfo, depth);
    }
    let out: AudioNode = amp;
    if (o.tremHz && o.tremDepth) {
      // volume = (1 - depth) + depth * lfo, so it wobbles between 1 - 2*depth and 1 and is never negative
      const trem = ctx.createGain();
      trem.gain.value = 1 - o.tremDepth;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = o.tremHz;
      const depth = ctx.createGain();
      depth.gain.value = o.tremDepth;
      lfo.connect(depth);
      depth.connect(trem.gain);
      amp.connect(trem);
      out = trem;
      lfos.push(lfo);
      extras.push(lfo, depth, trem);
    }
    out.connect(a.sfx);
    for (const l of lfos) {
      l.start(t0);
      l.stop(t1 + 0.05);
    }
    osc.start(t0);
    osc.stop(t1 + 0.05);
    voices++;
    osc.onended = () => {
      voices--;
      osc.disconnect();
      filter.disconnect();
      amp.disconnect();
      for (const n of extras) n.disconnect();
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

  // Balloon "pop": a crisp click-burst plus a quick falling blip. Each pop is pitched a little differently,
  // so a bunch of balloons doesn't sound like a machine.
  function makePop(a: Graph): void {
    const r = 0.88 + Math.random() * 0.28;
    noise(a, { dur: 0.07, vol: 0.4, type: 'highpass', f0: 1800 * r, f1: 5200, q: 0.7, attack: 0.001 });
    tone(a, { f0: 1100 * r, f1: 200 * r, dur: 0.09, vol: 0.38, attack: 0.001 });
    tone(a, { type: 'triangle', f0: 260 * r, f1: 90, dur: 0.07, vol: 0.2, attack: 0.001 });
  }

  // Horns (the one chosen in the Boat Garage). Each is a few steady notes, so they use `hold`.
  let hornKind: HornId = 'beep';

  // "Beep beep!": two bright car-horn toots, a major third apart so it sounds friendly.
  function makeHornBeep(a: Graph): void {
    const t = a.ctx.currentTime + 0.005;
    for (let i = 0; i < 2; i++) {
      const when = t + i * 0.16;
      tone(a, { type: 'square', f0: 523.25, dur: 0.12, vol: 0.15, attack: 0.005, lowpass: 2400, hold: 0.7, when });
      tone(a, { type: 'square', f0: 659.25, dur: 0.12, vol: 0.12, attack: 0.005, lowpass: 2400, hold: 0.7, when });
    }
  }

  // "Quack quack!": a nasal buzz that slides down, with a tiny click on the front of each quack.
  function makeHornDuck(a: Graph): void {
    const t = a.ctx.currentTime + 0.005;
    for (let i = 0; i < 2; i++) {
      const when = t + i * 0.2;
      const r = i === 0 ? 1 : 0.9; // the second quack is a little lower
      tone(a, { type: 'sawtooth', f0: 560 * r, f1: 330 * r, dur: 0.17, vol: 0.22, attack: 0.01, lowpass: 1500, hold: 0.5, when });
      tone(a, { type: 'square', f0: 1120 * r, f1: 700 * r, dur: 0.15, vol: 0.06, attack: 0.01, lowpass: 2600, hold: 0.4, when });
      noise(a, { dur: 0.05, vol: 0.12, type: 'bandpass', f0: 1800, f1: 1100, q: 1.4, attack: 0.002, when });
    }
  }

  // "BRAAAAP": a big ship's foghorn. Two low buzzes a hair apart wobble against each other, plus a fifth.
  function makeHornFog(a: Graph): void {
    const t = a.ctx.currentTime + 0.005;
    tone(a, { type: 'sawtooth', f0: 98, f1: 90, dur: 1.0, vol: 0.3, attack: 0.07, lowpass: 520, hold: 0.7, when: t });
    tone(a, { type: 'sawtooth', f0: 100.5, f1: 92, dur: 1.0, vol: 0.26, attack: 0.07, lowpass: 520, hold: 0.7, when: t });
    tone(a, { type: 'square', f0: 147, f1: 135, dur: 0.95, vol: 0.1, attack: 0.09, lowpass: 600, hold: 0.7, when: t });
    noise(a, { dur: 0.9, vol: 0.05, type: 'lowpass', f0: 400, f1: 250, attack: 0.1, when: t });
  }

  // "HOOONK-eek!": a rubber-bulb honk that bends up, then a squeaky little tail.
  function makeHornClown(a: Graph): void {
    const t = a.ctx.currentTime + 0.005;
    tone(a, { type: 'sawtooth', f0: 300, f1: 370, dur: 0.26, vol: 0.2, attack: 0.012, lowpass: 1400, hold: 0.6, when: t });
    tone(a, { type: 'square', f0: 304, f1: 374, dur: 0.26, vol: 0.12, attack: 0.012, lowpass: 1400, hold: 0.6, when: t });
    tone(a, { f0: 880, f1: 1560, dur: 0.14, vol: 0.18, attack: 0.008, hold: 0.5, when: t + 0.24 });
    tone(a, { type: 'triangle', f0: 1760, f1: 3000, dur: 0.1, vol: 0.05, attack: 0.008, when: t + 0.24 });
  }

  function makeHonk(a: Graph): void {
    switch (hornKind) {
      case 'duck': makeHornDuck(a); break;
      case 'foghorn': makeHornFog(a); break;
      case 'clown': makeHornClown(a); break;
      default: makeHornBeep(a); // 'beep', and anything unexpected from an old save
    }
  }

  // Rescue: a bubbly "bloop" up and a whoosh, then a splash and a little sparkle as the boat lands.
  function makeRescue(a: Graph): void {
    const t = a.ctx.currentTime + 0.005;
    tone(a, { f0: 260, f1: 1100, dur: 0.22, vol: 0.28, attack: 0.01, hold: 0.5, when: t });
    noise(a, { dur: 0.4, vol: 0.2, type: 'bandpass', f0: 500, f1: 3000, q: 0.9, attack: 0.1, when: t });
    noise(a, { dur: 0.3, vol: 0.2, type: 'lowpass', f0: 1200, f1: 300, attack: 0.01, when: t + 0.25 });
    const notes = [1318.5, 1568, 2093, 2637];
    for (let i = 0; i < notes.length; i++) bell(a, notes[i], t + 0.26 + i * 0.07, 0.35, 0.14);
  }

  // Trophy fanfare: a quick rising run (G C E G), then a held, sparkling C chord. All C major, so it sits
  // nicely on top of the end of the victory tune that plays just before it.
  function makeTrophy(a: Graph): void {
    const t = a.ctx.currentTime + 0.01;
    const run = [783.99, 1046.5, 1318.5, 1568];
    for (let i = 0; i < run.length; i++) {
      const when = t + i * 0.1;
      tone(a, { type: 'sawtooth', f0: run[i], dur: 0.16, vol: 0.1, attack: 0.008, lowpass: 3000, hold: 0.5, when });
      tone(a, { type: 'triangle', f0: run[i], dur: 0.16, vol: 0.14, attack: 0.008, hold: 0.5, when });
    }
    const end = t + 0.46;
    for (const f of [1046.5, 1318.5, 1568, 2093]) {
      tone(a, { type: 'triangle', f0: f, dur: 0.9, vol: 0.11, attack: 0.012, when: end });
    }
    bell(a, 2093, end + 0.05, 0.9, 0.12);
    bell(a, 3136, end + 0.16, 0.7, 0.1);
    bell(a, 2637, end + 0.27, 0.8, 0.1);
  }

  // ───────────── sharks (friendly, never scary) ─────────────

  // Shark bump: a thud from the big snout, then two quick cartoon clacks of teeth, "clack-clack!".
  function makeSharkBump(a: Graph): void {
    const t = a.ctx.currentTime + 0.005;
    const r = rand(0.93, 1.07);
    tone(a, { f0: 150, f1: 46, dur: 0.26, vol: 0.5, attack: 0.002, when: t });
    noise(a, { dur: 0.09, vol: 0.22, type: 'lowpass', f0: 800, f1: 180, when: t });
    for (let i = 0; i < 2; i++) {
      const when = t + 0.05 + i * 0.12;
      const k = i === 0 ? 1 : 0.86; // the second clack is a little lower
      noise(a, { dur: 0.04, vol: 0.34, type: 'bandpass', f0: 3200 * r * k, f1: 1400, q: 1.6, attack: 0.001, when });
      tone(a, { type: 'square', f0: 680 * r * k, f1: 300, dur: 0.06, vol: 0.12, attack: 0.001, lowpass: 2200, when });
      tone(a, { type: 'triangle', f0: 260 * r * k, f1: 120, dur: 0.08, vol: 0.28, attack: 0.001, when });
    }
  }

  // Shark dive: a big splash, then "bloop, bloop, bloop" bubbles that wander down, ending in a sinking "gloop".
  function makeSharkDive(a: Graph): void {
    const t = a.ctx.currentTime + 0.005;
    noise(a, { dur: 0.32, vol: 0.28, type: 'bandpass', f0: 1900, f1: 450, q: 0.8, attack: 0.01, when: t });
    noise(a, { dur: 0.45, vol: 0.2, type: 'lowpass', f0: 1000, f1: 220, attack: 0.02, when: t });
    const starts = [0.14, 0.26, 0.37, 0.49];
    for (let i = 0; i < starts.length; i++) {
      const base = 560 * Math.pow(0.82, i) * rand(0.92, 1.08);
      tone(a, { f0: base, f1: base * 2.1, dur: 0.09 + i * 0.01, vol: 0.2, attack: 0.008, when: t + starts[i] });
      tone(a, { type: 'triangle', f0: base * 2, f1: base * 4.2, dur: 0.06, vol: 0.05, attack: 0.008, when: t + starts[i] });
    }
    tone(a, { f0: 430, f1: 130, dur: 0.3, vol: 0.28, attack: 0.01, hold: 0.4, when: t + 0.6 });
  }

  // A ship's bell: a clear strike with a glassy overtone, and a low body tone underneath it.
  function shipBell(a: Graph, when: number, f: number, vol: number): void {
    tone(a, { f0: f, dur: 1.1, vol, attack: 0.002, when });
    tone(a, { f0: f * 2.76, dur: 0.6, vol: vol * 0.3, attack: 0.002, when });
    tone(a, { f0: f * 0.5, dur: 0.8, vol: vol * 0.4, attack: 0.002, when });
  }

  // Wave start: "ding-ding!" on the ship's bell, then a short, goofy "duun-dun, duun-dun" shark sting.
  function makeWaveStart(a: Graph): void {
    const t = a.ctx.currentTime + 0.01;
    shipBell(a, t, 880, 0.26);
    shipBell(a, t + 0.26, 880, 0.26);
    const sting: Array<[number, number, number]> = [
      // frequency, start, length (E and F, a half step apart: the classic two-note creep)
      [164.8, 0.4, 0.26],
      [174.6, 0.68, 0.2],
      [164.8, 0.98, 0.26],
      [174.6, 1.26, 0.3],
    ];
    for (const [f, start, len] of sting) {
      tone(a, { type: 'sawtooth', f0: f, dur: len, vol: 0.16, attack: 0.02, lowpass: 800, hold: 0.6, when: t + start });
      tone(a, { type: 'triangle', f0: f, dur: len, vol: 0.2, attack: 0.02, hold: 0.6, when: t + start });
    }
  }

  // MEGA roar: a big wobbly growl that slides down, then a goofy two-part squeak, "eek-eek!".
  function makeMegaRoar(a: Graph): void {
    const t = a.ctx.currentTime + 0.01;
    voice(a, { type: 'sawtooth', f0: 150, f1: 58, dur: 1.2, vol: 0.34, attack: 0.1, hold: 0.55, lp0: 700, vibHz: 13, vibDepth: 20, tremHz: 32, tremDepth: 0.4, when: t });
    voice(a, { type: 'square', f0: 225, f1: 87, dur: 1.15, vol: 0.1, attack: 0.1, hold: 0.55, lp0: 600, vibHz: 11, vibDepth: 24, when: t });
    noise(a, { dur: 1.0, vol: 0.14, type: 'bandpass', f0: 500, f1: 140, q: 0.9, attack: 0.1, when: t });
    tone(a, { f0: 1000, f1: 2200, dur: 0.13, vol: 0.24, attack: 0.008, hold: 0.6, when: t + 1.18 });
    tone(a, { f0: 1900, f1: 1100, dur: 0.12, vol: 0.2, attack: 0.008, hold: 0.5, when: t + 1.34 });
  }

  // The sharks won: a friendly sad trombone, "wah, wah, wah, waaaah" (the last note droops, with a wobble).
  function makeDefeat(a: Graph): void {
    const t = a.ctx.currentTime + 0.01;
    const wah: Array<[number, number, number]> = [
      [311.1, 0, 0.3],
      [293.7, 0.36, 0.3],
      [277.2, 0.72, 0.3],
    ];
    for (const [f, start, len] of wah) {
      voice(a, { type: 'sawtooth', f0: f, dur: len, vol: 0.2, attack: 0.04, hold: 0.7, lp0: 500, lp1: 1500, when: t + start });
      voice(a, { type: 'triangle', f0: f, dur: len, vol: 0.14, attack: 0.04, hold: 0.7, lp0: 1200, when: t + start });
    }
    voice(a, { type: 'sawtooth', f0: 261.6, f1: 207.7, dur: 1.1, vol: 0.2, attack: 0.05, hold: 0.7, lp0: 450, lp1: 1700, vibHz: 5.5, vibDepth: 5, when: t + 1.08 });
    voice(a, { type: 'triangle', f0: 261.6, f1: 207.7, dur: 1.1, vol: 0.14, attack: 0.05, hold: 0.7, lp0: 1200, vibHz: 5.5, vibDepth: 5, when: t + 1.08 });
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

  /**
   * Wake the audio context if it is asleep. Safari only allows this inside a tap or key press, so the
   * gesture handlers call it directly (no awaiting first). A refused resume is fine: the next tap tries again.
   */
  function resumeNow(): void {
    const a = g;
    if (!a) return;
    try {
      const s = stateOf(a.ctx);
      if (s === 'running' || s === 'closed') return;
      void a.ctx.resume().catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  /** Go quiet when the page is hidden, and wake up when it comes back (iPad app switcher, locked screen). */
  function onVisibility(): void {
    const a = g;
    if (!a) return;
    try {
      if (document.hidden) {
        if (stateOf(a.ctx) === 'running') void a.ctx.suspend().catch(() => undefined);
      } else {
        resumeNow();
      }
    } catch {
      /* ignore */
    }
  }

  function watchLifecycle(ctx: AudioContext): void {
    if (lifecycleWatched) return;
    lifecycleWatched = true;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onVisibility); // coming back from the back/forward cache
    // iOS drops the context to 'interrupted' or 'suspended' on its own; try to wake it right away.
    ctx.addEventListener('statechange', () => {
      if (!document.hidden) resumeNow();
    });
  }

  function unlock(): void {
    if (g) {
      resumeNow();
      return;
    }
    let ctx: AudioContext | null = null;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();

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
    } catch {
      // Audio is optional; the game carries on silently. Close the half-built context so a retry on the
      // next tap never leaves two of them alive (two contexts would mean doubled sound that mute can't reach).
      g = null;
      if (ctx) void ctx.close().catch(() => undefined);
      return;
    }
    try {
      resumeNow(); // we are inside the tap or key press that called us: this is the moment iOS allows it
      // Older iOS opens the speakers only once something has actually played inside a gesture: one silent sample.
      const prime = ctx.createBufferSource();
      prime.buffer = ctx.createBuffer(1, 1, 22050);
      prime.connect(ctx.destination);
      prime.start(0);
      applyMusic();
      watchLifecycle(ctx);
    } catch {
      /* the graph is built; a failed extra just means a slower start */
    }
  }

  /**
   * Listen document-wide (capture phase, so nothing can swallow it) for the first tap or key press, and keep
   * listening: the handler is a one-line check once the context is running, and it is what wakes the sound up
   * again after iOS interrupts it.
   */
  function installGestureUnlock(): void {
    try {
      const onGesture = (): void => {
        if (g && stateOf(g.ctx) === 'running') return;
        unlock();
      };
      for (const type of GESTURE_EVENTS) document.addEventListener(type, onGesture, { capture: true, passive: true });
      // One mute choice for every copy of the game open in this browser (a second tab, a test window).
      window.addEventListener('storage', (e) => {
        if (forcedMute || e.key !== MUTE_KEY) return;
        if (e.newValue !== '1' && e.newValue !== '0') return; // a cleared or removed key says nothing about what the player wants
        applyMuted(e.newValue === '1');
      });
    } catch {
      /* no document (should not happen in a browser): unlock() is still callable by hand */
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

  /** Apply a mute choice to this page (no saving: callers decide that). */
  function applyMuted(m: boolean): void {
    muted = m;
    const a = g;
    if (!a) return;
    try {
      a.master.gain.setTargetAtTime(m ? 0 : MASTER_VOLUME, a.ctx.currentTime, 0.02);
    } catch {
      /* ignore */
    }
  }

  function setMuted(m: boolean): void {
    if (forcedMute) return; // a ?mute=1 page stays silent and never saves anything
    applyMuted(m);
    writeMuted(m);
  }

  function setMusic(on: boolean): void {
    musicOn = on;
    try {
      applyMusic();
    } catch {
      /* ignore */
    }
  }

  installGestureUnlock();

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
    pop: () => play('pop', 0.03, makePop),
    honk: (horn: HornId) => {
      hornKind = horn;
      play('honk-' + horn, HORN_GAP[horn] ?? 0.15, makeHonk);
    },
    rescue: () => play('rescue', 0.5, makeRescue),
    trophy: () => play('trophy', 0.6, makeTrophy),
    sharkBump: () => play('sharkBump', 0.15, makeSharkBump),
    sharkDive: () => play('sharkDive', 0.12, makeSharkDive),
    waveStart: () => play('waveStart', 1.0, makeWaveStart),
    megaRoar: () => play('megaRoar', 1.5, makeMegaRoar),
    defeat: () => play('defeat', 2.0, makeDefeat), // the game core and the results screen may both ask: the second is dropped
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
