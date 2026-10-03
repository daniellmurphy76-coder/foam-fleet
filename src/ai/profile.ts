/**
 * Foam Fleet bots: how good each difficulty is, and how each bot's personality is rolled.
 *
 * Two layers, so bots feel different from each other AND get harder with the skill setting:
 *   Skill       = the difficulty level (same for every "easy" bot).
 *   Personality = rolled from the bot's `seed` (every bot is a little different).
 * Want easier bots? Make `reaction` bigger or `aimErrorDeg` wider in the table below.
 */
import type { BotDifficulty } from '../types';
import { lerp } from './steering';

const TWO_PI = Math.PI * 2;

/** A small, fast random number generator ("mulberry32"). Same seed = same sequence every time. */
export function makeRng(seed: number): () => number {
  const whole = Number.isFinite(seed) ? Math.floor(seed) : 0;
  // Scramble the seed so that seeds 0, 1, 2... give very different personalities.
  let a = Math.imul(whole ^ 0x9e3779b9, 0x85ebca6b) ^ 0xc2b2ae35;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Skill {
  /** Seconds before the bot "notices" what its target did (stale information = slower bot). */
  reaction: number;
  /** Aim wobble: how far off the nose can point, in degrees either side. */
  aimErrorDeg: number;
  /** Top throttle (0..1). Easy bots never go flat out. */
  throttleCap: number;
  /** Lowest throttle factor in a tight corner (1 = never slows down). */
  turnSlowFloor: number;
  /** Steering per radian of heading error. Bigger = twitchier. */
  steerGain: number;
  /** Fastest the wheel can swing, in steer-units per second. */
  steerSlew: number;
  /** 0..1: how well the bot leads a moving target. */
  predict: number;
  /** Multiplier on how far ahead it looks for rocks. */
  lookScale: number;
  /** Starts shooting when a boat is within this many degrees of the nose... */
  fireStartDeg: number;
  /** ...and keeps shooting until it drifts past this. */
  fireStopDeg: number;
  /** Will not shoot at boats farther than this (meters). */
  fireRange: number;
  /** Shoots in bursts: open for burstOn seconds, then quiet for burstOff seconds. burstOffMax 0 = never pauses. */
  burstOnMin: number;
  burstOnMax: number;
  burstOffMin: number;
  burstOffMax: number;
  /** Chance of dodging after being hit. */
  evadeChance: number;
  /** Chance of being willing to boost (to close a gap or run away). */
  boostChance: number;
  /** Boost meter needed to START boosting, and the level where it STOPS. */
  boostOn: number;
  boostOff: number;
  /** Race: only boost when the next gate is at least this far away. */
  raceBoostMinDist: number;
  /** How far away a power-up crate can be and still tempt this bot. */
  pickupRange: number;
  /** Multiplies the preferred fighting distance. */
  rangeScale: number;
  /** Multiplies the little side-to-side weave. */
  wobbleScale: number;
}

export const SKILLS: Readonly<Record<BotDifficulty, Skill>> = {
  easy: {
    reaction: 0.5,
    aimErrorDeg: 14,
    throttleCap: 0.75,
    turnSlowFloor: 0.5,
    steerGain: 1.7,
    steerSlew: 5,
    predict: 0.5,
    lookScale: 0.85,
    fireStartDeg: 8,
    fireStopDeg: 11,
    fireRange: 42,
    burstOnMin: 0.45,
    burstOnMax: 0.9,
    // Longer pauses between bursts: about 35% less shooting than before (open time 32% -> 21%).
    burstOffMin: 1.6,
    burstOffMax: 3.4,
    evadeChance: 0.4,
    boostChance: 0.15,
    boostOn: 0.8,
    boostOff: 0.3,
    raceBoostMinDist: 80,
    pickupRange: 28,
    rangeScale: 1.15,
    wobbleScale: 1.3,
  },
  normal: {
    reaction: 0.25,
    aimErrorDeg: 8,
    throttleCap: 0.9,
    turnSlowFloor: 0.62,
    steerGain: 2.2,
    steerSlew: 7,
    predict: 0.75,
    lookScale: 1,
    fireStartDeg: 8,
    fireStopDeg: 12,
    fireRange: 46,
    burstOnMin: 0.8,
    burstOnMax: 1.5,
    burstOffMin: 0.5,
    burstOffMax: 1.1,
    evadeChance: 0.8,
    boostChance: 0.55,
    boostOn: 0.5,
    boostOff: 0.15,
    raceBoostMinDist: 55,
    pickupRange: 36,
    rangeScale: 1,
    wobbleScale: 1,
  },
  hard: {
    reaction: 0.1,
    aimErrorDeg: 1.5,
    throttleCap: 1,
    turnSlowFloor: 0.8,
    steerGain: 2.6,
    steerSlew: 9,
    predict: 1,
    lookScale: 1.1,
    fireStartDeg: 10,
    fireStopDeg: 13,
    fireRange: 62,
    burstOnMin: 1,
    burstOnMax: 1,
    burstOffMin: 0,
    burstOffMax: 0,
    evadeChance: 1,
    boostChance: 1,
    boostOn: 0.3,
    boostOff: 0.08,
    raceBoostMinDist: 35,
    pickupRange: 46,
    rangeScale: 0.9,
    wobbleScale: 0.8,
  },
};

export interface Personality {
  /** 0..1: bold bots come in closer and boost more eagerly. */
  aggression: number;
  /** The distance (meters) this bot likes to fight at. */
  preferredRange: number;
  /** Side-to-side weave: size in degrees, speed in cycles per second, and where in the cycle it starts. */
  wobbleDeg: number;
  wobbleHz: number;
  wobblePhase: number;
  /** Which way it likes to swing around a target: -1 or +1. */
  strafe: number;
  /** 0..1: how likely it is to detour for a power-up crate. */
  greed: number;
  /** 0..1: how much it likes boost. */
  boostLove: number;
  /** -1..1: which side of a race gate this bot aims at (spreads the pack out). */
  lane: number;
  /** How far off the target's line it curves while closing in, in degrees. */
  engageOffsetDeg: number;
}

export function makePersonality(rng: () => number, skill: Skill): Personality {
  return {
    aggression: lerp(0.3, 1, rng()),
    preferredRange: lerp(16, 30, rng()) * skill.rangeScale,
    wobbleDeg: lerp(2.5, 6, rng()) * skill.wobbleScale,
    wobbleHz: lerp(0.35, 0.65, rng()),
    wobblePhase: rng() * TWO_PI,
    strafe: rng() < 0.5 ? -1 : 1,
    greed: lerp(0.25, 0.75, rng()),
    boostLove: lerp(0.4, 1, rng()),
    lane: lerp(-1, 1, rng()),
    engageOffsetDeg: lerp(20, 40, rng()),
  };
}
