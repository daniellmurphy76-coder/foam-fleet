/**
 * Foam Fleet: game tuning knobs.
 *
 * Change a number, save the file, and the game reloads with your change.
 * Try making the darts faster, the boats zippier, or the battles longer!
 */
export const CONFIG = {
  arena: {
    /** How big the lagoon is (meters from the middle to the edge). */
    radius: 160,
  },

  boat: {
    /** Top speed going forward (meters per second). */
    maxSpeed: 22,
    /** Top speed in reverse. */
    reverseSpeed: 8,
    /** How fast the boat speeds up. */
    accel: 16,
    /** How quickly the boat slows down when you let go. */
    drag: 0.9,
    /** How fast the boat turns (radians per second at full steer). */
    turnRate: 2.3,
    /** Top speed while boosting. */
    boostSpeed: 34,
    /** How fast the boost meter empties while boosting (per second). */
    boostDrain: 0.45,
    /** How fast the boost meter refills (per second). */
    boostRecharge: 0.12,
    /** Bumping size for boats. */
    radius: 1.7,
    /** How big a target the boat is for darts. */
    hitRadius: 1.9,
    /** How hard a dart pushes a boat. */
    knockback: 5,
  },

  blaster: {
    /** Darts in a full blaster. */
    magazine: 6,
    /** Seconds between shots. */
    cooldown: 0.22,
    /** Seconds to reload an empty blaster. */
    reloadTime: 1.4,
    /** When you are not shooting, get one dart back every this many seconds. */
    trickleReload: 0.8,
    /** How fast darts fly (meters per second). */
    dartSpeed: 48,
    /** How much darts drop (foam darts are floaty). */
    dartGravity: 6,
    /** Seconds before a dart that hits nothing disappears. */
    dartLife: 2.6,
    /** Seconds a dart stays stuck to a boat it hit. */
    stuckDartLife: 6,
    /** Aim-assist cone, in degrees either side of straight ahead. */
    aimAssistDeg: 14,
    /** Aim-assist only locks on to boats closer than this. */
    aimAssistRange: 70,
    /** Angle between the three darts of a Triple Shot. */
    tripleSpreadDeg: 9,
  },

  powerUps: {
    /** How long Triple Shot and Rapid Fire last (seconds). */
    durationSec: 10,
    /** Seconds before a collected crate comes back. */
    respawnSec: 12,
    /** Most crates floating at once. */
    maxActive: 5,
  },

  battle: {
    /** Battle length in seconds (180 = 3 minutes). */
    durationSec: 180,
    /** Points for each dart hit. */
    pointsPerHit: 1,
    /** Seconds a hit boat is wobbly and slow. */
    stunSeconds: 0.6,
  },

  race: {
    laps: 3,
    /** Seconds a hit boat is wobbly and slow during a race (darts don't score here). */
    stunSeconds: 1.1,
    /** After the first player crosses the finish, how long everyone else gets to finish. */
    finishGraceSec: 60,
  },

  easyDriving: {
    /** Easy Driving top speed compared to normal (0.8 = 80%). */
    speedScale: 0.8,
    /** How much gentler Easy Driving steering is (0.65 = 65% of normal turning). */
    turnScale: 0.65,
    /** How fast the boat cruises by itself when you aren't pressing go (0 to 1). */
    cruiseThrottle: 0.7,
    /** How hard darts push an Easy Driving boat (0.4 = 40% of normal). */
    knockbackScale: 0.4,
    /** Bumper rails: how strongly the boat steers itself away from islands (0 to 1). */
    bumperStrength: 0.7,
    /** Stuck for this many seconds? The boat rescues itself. */
    autoRescueSec: 2.5,
  },

  rescue: {
    /** Seconds before you can use the rescue button again. */
    cooldownSec: 3,
  },

  team: {
    /** Team Up team names: the players' team first. */
    names: ['Splash Squad', 'Pirate Pals'],
    colors: [0x0a84ff, 0xff3b30],
  },

  practice: {
    /** How many balloons float around the lagoon in Balloon Pop. */
    balloons: 30,
    /** Every this-many-th balloon is gold and worth 3 points. */
    goldEvery: 5,
  },

  sharks: {
    /** How many sharks cruise around in each game (Boats vs. Sharks brings its own). */
    ambient: { battle: 3, race: 2, team: 3, practice: 2 },
    /** Swimming speed (meters per second) when cruising, and when chasing a boat. */
    cruiseSpeed: 5,
    chaseSpeed: 12,
    /** About how often (seconds) a cruising shark gets curious and chases a boat. */
    chaseEverySec: 18,
    /** Longest chase (seconds) before a shark gives up. */
    chaseSec: 6,
    /** How long a bumped boat wobbles (seconds). */
    bumpStun: 0.5,
    /** Seconds before a shark that got darted comes back. */
    returnSec: 10,
    /** Boats vs. Sharks: how many sharks in each wave. After the last wave comes the MEGA SHARK. */
    waves: [3, 5, 7, 9, 11],
    /** Darts it takes to beat the MEGA SHARK. */
    megaHealth: 12,
    /** Life rings your team starts with. Each shark bump pops one. */
    lifeRings: 12,
    /** Seconds of rest between waves. */
    waveBreakSec: 4,
    /** Shark speed for each bot skill setting. */
    speedBySkill: { easy: 0.8, normal: 1, hard: 1.15 },
    /** Helper boats on your team in Boats vs. Sharks. */
    defaultHelpers: 2,
  },

  bots: {
    /**
     * How wobbly the computer boats' aim is, in degrees. Bigger = they miss more.
     * (Players always get full aim assist; this only makes the bots miss.)
     */
    aimErrorDeg: { easy: 8, normal: 6, hard: 3.5 },
  },

  match: {
    defaultBots: 3,
    /** Most boats on the water at once (humans + bots). */
    maxBoats: 8,
    countdownSec: 3,
  },

  camera: {
    distance: 11,
    height: 4.5,
    lookAhead: 7,
    fov: 65,
    /** Easy Driving camera: higher and farther back so you can see more. */
    easy: { distance: 13, height: 6.5, lookAhead: 9 },
  },

  /** Boat paint colors to pick from. */
  colors: [0xff3b30, 0x0a84ff, 0x30d158, 0xffd60a, 0xff9f0a, 0xbf5af2, 0xff6fae, 0x40e0d0],

  /** Names for computer-controlled boats. */
  botNames: [
    'Captain Barnacle',
    'Salty Sal',
    'Admiral Splash',
    'Bubbles',
    'Commodore Quack',
    'Rusty Anchor',
    'Gilly',
    'Sir Soggy',
  ],
};
