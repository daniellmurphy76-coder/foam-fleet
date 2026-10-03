# Foam Fleet: design spec (v1)

A 3D arcade game a dad and his son build together: toy speedboats with foam-dart
blasters compete in a sunny tropical lagoon. Browser game, Three.js + TypeScript + Vite.
Two modes, 1–2 local players (split screen) plus computer boats.

**Working title.** "Foam Fleet". The family may rename it later. In-game text says "foam darts";
never use the word "Nerf" anywhere in the game (trademark).

## Feel targets (what makes it fun)

- **Instant fun.** Title screen → playing in under 10 seconds. Big chunky buttons.
- **Arcade handling.** Boats are zippy and forgiving: quick acceleration, tight turns, a little drift,
  and they bob and tilt on the waves. Boost feels like a rocket.
- **Juicy hits.** A hit is never ambiguous: dart sticks into the target boat, the boat wobbles and
  flashes, a burst of foam confetti pops, a "bonk" sound plays, the shooter's camera gets a tiny kick, a
  feed message appears ("Sam tagged Salty Sal!"). Darts that miss make a little splash.
- **Kid-friendly.** Nothing violent: no sinking, no damage, no "kill". Words: tag, splat, bonk, soak.
  Aim assist is generous. Bots on "easy" are genuinely beatable by a 7-year-old.
- **Readable.** Big HUD text, high contrast, color matches each player's boat.

## Art direction

Bright, cartoony, low-poly, flat-shaded toy look. Sunny midday, clear turquoise water fading to deeper blue
offshore, white foam on wave crests and around islands. Sandy islands with chunky palm trees, grey rocks,
a striped lighthouse, and one giant floating rubber duck landmark. Boats look like bathtub toy speedboats:
rounded hull in the player color, white trim, a chunky orange-and-blue foam blaster on top. Darts are
blue foam bodies with orange rounded tips. Use `MeshStandardMaterial` / `MeshToonMaterial` with
`flatShading` where it helps; no texture files (procedural only; canvas textures are fine).

## Conventions

See the header of `src/types.ts`: meters/seconds, Y up, water rest y = 0, heading convention
(`forward = (sin h, 0, cos h)`, `object.rotation.y = heading`, steer +1 = right = heading decreases).
All tunables live in `src/config.ts` (`CONFIG`). Read values from there; module-private constants that a
kid would never tweak go at the top of your own file.

## Ownership (parallel build: stay in your lane)

Several builders work at the same time. **Only create or edit files inside your own directories.** Never
edit `src/types.ts`, `src/config.ts`, `index.html`, `package.json`, or another module's files. If a
contract in `types.ts` is wrong or missing something, work around it inside your module and report it.

| Module | Owns | Exports (signatures already stubbed; keep them exactly) |
|---|---|---|
| World | `src/world/**` | `createWorld(scene, mode): World`, `createPickups(scene, world, mode): Pickups` |
| Boat | `src/entities/**` | `createBoat(init): Boat`, `resolveBoatCollisions(boats): BumpEvent[]` |
| Combat & FX | `src/combat/**`, `src/fx/**` | `createDartSystem(scene, fx): DartSystem`, `createEffects(scene): Effects` |
| Input & AI | `src/input/**`, `src/ai/**` | `createInput(window): InputManager`, `createBotController(difficulty, seed): Controller` |
| UI & Audio | `src/ui/**`, `src/audio/**` | `createHud(root, sfx): Hud`, `createMenu(root, sfx): Menu`, `createSfx(): Sfx` |
| Game core | `src/main.ts`, `src/game/**` | the app: renderer, loop, modes, cameras, split screen |

Definition of done for every module: `npx tsc --noEmit` reports **no errors in your files** (other
modules may still be stubs: that is expected), no `any` escapes in exported surfaces, no console errors
at runtime, and everything you allocate is released in `dispose()`/`clear()`. Plain TypeScript; the only
runtime dependency is `three` (addons under `three/examples/jsm/...` are allowed).

Performance budget: 60 fps on an ordinary laptop with 2 split-screen viewports, 8 boats, ~60 darts in
the air, and particles. Pool and reuse objects; no per-frame allocations in hot loops (reuse scratch
`Vector3`s); prefer `InstancedMesh` / `Points` for many small things.

---

## World (`src/world/**`)

**Water.** A large plane (cover at least `arenaRadius * 2.6`, enough to reach the horizon/fog) with a custom
`ShaderMaterial` or `onBeforeCompile`-patched material: a sum of 3–4 gentle directional sine/Gerstner waves
(max combined amplitude ~0.35 m, wavelengths 8–40 m), turquoise shallow color near islands, deeper blue
offshore, fresnel sky reflection tint, sun glint, foam on crests and a foam ring around each island.
`waveHeight(x, z, t)` and `waveNormal(...)` on the CPU must use **exactly** the same wave parameters as
the shader (share one constants table). Water does not need to receive shadows. Fog matches the horizon.

**Sky and light.** Bright gradient sky dome (or `three/examples/jsm/objects/Sky.js`), warm
`DirectionalLight` sun with shadows covering the arena (2048 map, tuned bias), plus `HemisphereLight`.
Set `scene.fog` and `scene.background` / environment so it reads as a sunny day.

**Islands and props.** Hand-placed layout (deterministic, no randomness at runtime unless seeded) inside
`CONFIG.arena.radius`: 4–6 sandy islands of varied size with palm trees, a few rock clusters, a
lighthouse island, and a giant rubber duck that bobs on the waves. Every solid thing gets an `Obstacle`
circle. Leave open water lanes; boats must be able to circle the whole arena. Mark the arena edge with a
ring of floating red/white buoys (visual only; the boat module enforces the edge using `arenaRadius`).

**Race course.** 8–10 checkpoint gates forming a fun loop through the islands (wide sweeping turns plus
one tight chicane), all within the arena, gates at least 25 m apart, gate `radius` ~9 m, and no obstacle
blocking the straight line between consecutive gates. checkpoints[0] = start/finish with a checkered
banner. Gates are two tall buoys plus an arch/banner showing the gate number. Visible only when created
for `'race'` (data always populated).

**Spawns.** `spawnPoints(count, 'battle')`: evenly spread on a ring at ~55% of arena radius, facing the
center, not overlapping obstacles. `spawnPoints(count, 'race')`: a 2-wide grid behind checkpoints[0],
4 m apart side-to-side and 6 m back per row, facing `checkpoints[0].heading`.

**Pickups** (`createPickups`). Floating crates with a big "?" (canvas texture) that bob on `waveHeight`
and spin. Up to `CONFIG.powerUps.maxActive` at hand-placed open-water spots (battle: spread around;
race: on the racing line near gates). Collected when a boat's XZ distance < boat radius + 1.5. Random kind
from `triple | rapid | shield | turbo` (race mode: no `rapid`). Respawn after `CONFIG.powerUps.respawnSec`.
`positions` lists only available crates. Return `PickupEvent`s; the game core applies them.

## Boat (`src/entities/**`)

**Mesh.** Three hull `style`s (0 sleek speedboat, 1 chunky tug, 2 catamaran) from primitives/extruded
shapes, bow toward local +Z, waterline at local y = 0, ~4.5 m long. Hull in `init.color`, white trim, a
windshield, a seated captain figure (simple capsule + head, wearing a hat in the boat color), and a big
foam blaster turret on top (orange + blue). Turret visibly rotates toward `aimTargetId` (clamped to the
aim cone) and recoils when firing. Cast shadows.

**Physics** (`update`). Arcade model in the boat's local frame: throttle accelerates toward max speed
(`CONFIG.boat`), drag when idle, reverse slower. Turn rate scales with speed (can still pivot slowly when
nearly stopped); a bit of lateral slip/drift that damps quickly. Boost (held + meter > 0) raises max
speed and acceleration, drains the meter; meter recharges when not boosting. Stunned: thrust x0.35 and a
wobble. Bob: set `position.y` from `waveHeight`; pitch/roll from `waveNormal` plus banking into turns and
nose-up under acceleration (smoothed). Keep inside the arena: soft push back near `arenaRadius`. Collide
with world `obstacles` as circles: push out and reflect velocity with damping (no getting stuck).

**Blaster.** Magazine `CONFIG.blaster.magazine`, `cooldown` between shots, full reload of `reloadTime`
starting automatically when empty; trickle reload (+1 dart every `trickleReload` s) after 1 s of not
firing. Power-ups: `triple` = 3-dart spread, `rapid` = half cooldown and no ammo use, `shield` = absorbs
the next hit (visible translucent bubble; `onHit` returns false and pops it), `turbo` = full boost +
unlimited boost for `durationSec`. Timed ones count down in `update`.

**Aim assist.** Each `update`, pick the nearest other boat within `aimAssistRange` whose bearing is within
`aimAssistDeg` of forward → `aimTargetId`. `tryFire` aims darts at that target's predicted position
(lead by distance/dartSpeed, aim slightly high to cancel gravity drop); otherwise straight ahead with a
slight upward angle. Muzzle origin = turret barrel tip in world space. Each dart spawn has
`speed = CONFIG.blaster.dartSpeed` plus the boat's forward speed component.

**Hits.** `onHit`: if shielded, pop shield and return false. Else knockback impulse along the dart
direction (`CONFIG.boat.knockback`), stun timer, a quick white flash on the hull, a spin wobble; return
true. **Collisions** (`resolveBoatCollisions`): circle overlap → separate equally, exchange velocity along
the normal with restitution ~0.6, emit `BumpEvent` when closing speed > 1.5 m/s.

## Combat & FX (`src/combat/**`, `src/fx/**`)

**Darts.** Pooled (e.g. 128) dart meshes or `InstancedMesh` (blue foam cylinder body, orange rounded tip,
~0.45 m long so they read at distance; a faint trail is welcome). Ballistic flight with
`CONFIG.blaster.dartGravity`; orient along velocity. Collide by swept segment vs each boat's sphere
(`hitCenter`, `hitRadius`) so fast darts can't tunnel; ignore the owner. On hit call
`target.onHit(dir, stunSeconds)`: if true, attach the dart to `target.object` at the hit point
(pointing inward, use `Object3D.attach` semantics) for `CONFIG.blaster.stuckDartLife` s, then fade/remove;
`fx.hitBurst` in the target color. If false (shield), deflect the dart away with a spin and let it fall.
Hitting an island obstacle (XZ inside circle, y < 3) → dart drops; hitting water (`y < waveHeight`) →
`fx.splash` small + report in `waterSplashes`. Expire after `dartLife`. Darts stuck to a boat must not
collide again. `clear()` removes all darts including stuck ones.

**Effects.** GPU-cheap particles (pooled `Points` with a custom shader for size/alpha, or `InstancedMesh`
of tiny low-poly shapes): `splash` (white droplets arcing up and falling, sized by `size`), `hitBurst`
(colorful foam confetti + a few star shapes popping outward, ~0.6 s), `sparkle` (gold twinkles for
pickups), `wake` (spray at the stern and white foam blobs left behind that sit on the water via
`waveHeight`, spread outward and fade; rate and size scale with |speed|; extra spray while boosting).
Particles that touch water stop/fade. Must handle 8 boats of wake continuously within budget.

## Input & AI (`src/input/**`, `src/ai/**`)

**Keyboard.** Scheme A: W/S throttle, A/D steer, Space fire, Left Shift boost. Scheme B: Arrow keys,
Enter fire, Right Shift boost (use `KeyboardEvent.code`). Track held keys; clear all on window blur.
`preventDefault` for game keys so arrows/space don't scroll. Analog smoothing: keyboard steer ramps to
±1 over ~0.12 s.

**Gamepads** (standard mapping, `navigator.getGamepads()` polled in `poll()`). Left stick X = steer
(deadzone 0.15, rescaled), RT = throttle, LT = reverse (if no triggers, left stick Y), A or RB = fire, B or
X or LB = boost, Start = pause, Back/View = mute. Dpad + left stick + A/B navigate menus (edge-triggered
with ~0.25 s auto-repeat for held directions).

**Slot assignment** `humanController(slot, humans)`: 1 player: slot 0 = scheme A **and** scheme B **and**
any gamepad (merge: biggest magnitude wins). 2 players: 0 gamepads → slot 0 = A, slot 1 = B; exactly 1
gamepad → slot 0 = A, slot 1 = B + gamepad 0; 2+ gamepads → slot 0 = A + gamepad 0, slot 1 = B +
gamepad 1. Resolve every frame so plugging in a pad mid-match works. `menu`: arrows/WASD/Enter/Space/
Escape/Backspace from any keyboard and any pad; `pause` = Escape, P or Start; `mute` = M or Back. When
the focused DOM element is a text input, keyboard menu nav and game keys are ignored (except Enter and
Escape).

**Bots** (`createBotController`). Steering behaviors with a little personality from `seed` (aggression,
preferred range, wobble). Battle: pick a target (nearest, mild preference for whoever leads the score,
re-evaluate every 2–4 s), circle-strafe at preferred range, fire when the target is within ~10° of the
nose and in range, grab a nearby pickup sometimes, boost to close gaps or escape after being hit. Race:
steer toward a point blended between `nextCheckpoint` and `followingCheckpoint` (racing line), throttle
down for sharp turns, boost on straights, take pot-shots at boats ahead. Always: obstacle avoidance via
look-ahead probes against `world.obstacles` and the arena edge, and unstick logic (if speed ~0 for 1.5 s,
reverse and turn). Difficulty: easy = slow reactions (0.5 s), wide aim error, 75% throttle, rarely boosts;
normal = 0.25 s, moderate aim; hard = 0.1 s, sharp aim, full throttle, smart boost. Output must be
smooth (no steering jitter).

## UI & Audio (`src/ui/**`, `src/audio/**`)

Plain DOM + CSS (put styles in `src/ui/styles.css`, imported from your TS). Font: "Fredoka" (already
linked in `index.html`), fallback `system-ui, sans-serif`. Bright, rounded, chunky, high contrast
(white text with a dark outline/shadow over the 3D view). Roots `#hud` and `#menu` have
`pointer-events: none`; set `pointer-events: auto` on interactive elements only.

**Menu** (`createMenu`). Title screen: big "FOAM FLEET" logo text, a "Play" button, a short controls card
(keyboard schemes A/B + gamepad). Setup screen with large toggle buttons: Players 1 / 2; Mode Dart Battle /
Buoy Race (one-line explanation each); Bots 0–5 (cap so humans + bots ≤ `CONFIG.match.maxBoats`);
Bot skill Easy / Normal / Hard; per-player name text field (default "Player 1"/"Player 2", max 12 chars)
and color swatches from `CONFIG.colors` (players can't pick the same color); Battle length 2 / 3 / 5 min
or Race laps 1 / 3 / 5. Big "Start!" button. Fully usable with mouse, keyboard (via `update(input)`
focus navigation) and gamepad. Remember the last setup in `localStorage` (wrap in try/catch). Call
`sfx.uiMove/uiSelect` on navigation. Call `sfx.unlock()` on the first click/keypress.

**HUD** (`createHud`). Lay out one panel per `viewports[i]` (absolutely positioned to the viewport
rect). Per player: name in their color, score (battle) or position "2nd" + lap "Lap 2/3" + "Gate 4/9"
(race), ammo as dart icons with a reload ring, boost bar, power-up badge with countdown, shield icon,
center reticle that turns red and shows the locked target's name, and a direction arrow near the top
(rotated by `arrow`) pointing to the next gate. Global: big timer top-center (battle, turns red under
10 s) or race clock, compact live scoreboard (top-right of the whole screen, all boats, humans
highlighted), event feed (bottom-center, last 4, fade out). `announce` = big bouncy centered text
(per-viewport or global). Pause overlay (Resume / Quit to menu) and Results overlay (podium for top 3,
full table, title, "Rematch" and "Menu" buttons), both navigable via `handleMenuInput` and mouse.
`update` runs every frame: only touch the DOM when a value changed.

**Audio** (`createSfx`). Web Audio only, all synthesized (oscillators, filtered noise, envelopes), no
files. fire = punchy foam "thwip"; hit = cartoon "bonk"; shieldBlock = "boing"; splash = noise burst;
bump = thud scaled by strength; pickup = rising arpeggio; boost = whoosh; checkpoint = ding; lap = double
ding; countdown = beep (n = 3, 2, 1); go = higher beep; victory = short fanfare; ui sounds = soft clicks.
Engines: one detuned saw/square pair per human through a lowpass, pitch and volume follow level.
Music: a cheerful, simple procedural loop (bass + plucky lead, sunny major key, ~120 bpm), quiet,
toggleable. Master gain with mute (`setMuted`, persisted in `localStorage`). Every method must be a safe
no-op before `unlock()` and never throw. Rate-limit identical sounds (e.g. max one splash per 50 ms).

## Game core (`src/main.ts`, `src/game/**`)

**Boot.** `WebGLRenderer` (antialias, `ACESFilmicToneMapping`, sRGB output, PCF shadows (three r186 removed PCFSoftShadowMap), pixel
ratio capped at 2) appended to `#app` (insert before `#hud`). Create `Sfx`, `InputManager`, `Hud`
(`#hud`), `Menu` (`#menu`). State machine: `menu → countdown → playing ⇄ paused → results → (rematch |
menu)`. Fixed-step simulation (60 Hz, accumulate, max 5 steps/frame) with rendering every animation frame.

**Match setup.** New `THREE.Scene` per match (dispose the old one fully: world, pickups, darts, fx,
boats). Boats: humans first (ids 0..humans-1, names/colors from setup) then bots (names from
`CONFIG.botNames`, colors from `CONFIG.colors` not used by humans, style = id % 3). Controllers: humans
via `input.humanController(slot, humans)`, bots via `createBotController(difficulty, id)`.

**Per step.** Build each boat's `ControllerContext` (race: next/following checkpoint from that boat's
progress; pickups positions) → controls (zeroed during countdown, except you may rev engines) →
`boat.update` → `resolveBoatCollisions` (bump sfx/splash) → if `controls.fire`: `tryFire` → spawn darts +
`sfx.fire()` (only for human boats or boats near a human, to avoid noise) → `darts.update` → apply hits
via mode rules (battle: +`pointsPerHit` to the shooter, feed text, `hud.announce('SPLAT!', {viewport})`
for the human shooter, rumble the target human, camera kick) → `pickups.update` → `boat.applyPowerUp`,
`sfx.pickup`, `fx.sparkle`, feed → `fx.wake(boat)` for each boat → `fx.update` → `world.update`.

**Modes** (`src/game/modes/battle.ts`, `race.ts` with a small shared interface). Battle: timer from setup,
score by hits, ranking by score (ties: fewer hits taken), results at time 0, "30 SECONDS LEFT!" and a
10-second countdown beep. Race: per-boat progress `{lap, next, finished, finishTime}`; must pass gates in
order (passing = XZ distance < gate radius); boats start before gate 0, so the first pass of gate 0 starts
lap 1; passing gate 0 after all others completes a lap; "FINAL LAP!" announcement; ranking by (finished
first by time, then lap, then gate index, then distance to next gate); hits only stun
(`CONFIG.race.stunSeconds`); the race ends 20 s after the first human finishes, or when all humans
finish, or when all boats finish; unfinished boats get "DNF". Wrong-way detection: if a human heads away
from the next gate for 2 s, announce "WRONG WAY!" in their viewport.

**Cameras and split screen.** One `PerspectiveCamera` per human (`CONFIG.camera`). Chase cam: behind and
above the boat, smoothed with frame-rate-independent damping, looks at a point ahead; widen FOV slightly
with speed (more when boosting); small shake on hits taken and a kick on firing. Never let the camera
dip below the water surface. 2 players: side-by-side vertical split via `setViewport` + `setScissor`
(handle resize; each camera aspect = half width / height); a thin divider. Results screen: slow orbit
around the winner.

**HUD wiring.** Build `HudState` every frame (viewports in CSS px, per player stats from their boat,
`arrow` = angle from the player's camera-forward to the next gate (race) projected on XZ, null in
battle), scoreboard sorted by the mode.
Countdown: `announce('3')`, `'2'`, `'1'`, `'GO!'` with `sfx.countdown/go`. Engines: `sfx.setEngines`
with each human's |speed| / maxSpeed. Pause on `input.menu.pause` or window blur (only while playing);
`input.menu.mute` toggles `sfx.setMuted`. During pause/results route `input.menu` to
`hud.handleMenuInput`; during menu route it to `menu.update`.

**Debug and test hooks** (keep them; the orchestrator uses them to verify the game). URL params:
`?quick=battle|race&humans=1|2&bots=N&difficulty=easy|normal|hard` skips the menu and starts
immediately (countdown still runs). `window.__foam` exposes:
`{ state: string; timeScale: number; autopilot: boolean; snapshot(): object; }` where `timeScale`
multiplies simulation speed (e.g. 8 to fast-forward), `autopilot = true` makes human slots use normal
bot controllers, and `snapshot()` returns `{ state, t, fps, mode, boats: [{id, name, x, z, heading,
speed, score, ammo, stunned}], darts: number, hits: number, errors: string[] }` (collect
`window.onerror`/unhandled rejections into `errors`). A small FPS readout appears when `?fps=1`.

---

# v2: Easy Driving + five upgrades

Playtest feedback: **the kid had a hard time driving the boat.** v2 fixes that first, then adds five
upgrades: Team Up mode, Balloon Pop practice mode, a mini-map, the Boat Garage (with a honk button), and
a Trophy Shelf. Contracts in `src/types.ts` and knobs in `src/config.ts` are already updated; the stubs
`src/world/balloons.ts` and `src/ui/trophies.ts` are new. `npx tsc --noEmit` currently fails in every
module on purpose: each error sits in the module that must adapt to the new contracts.

## Easy Driving (the fix)

A per-player toggle in setup, **default ON**. Three layers:

1. **Boat physics** (`src/entities`, when `init.easyDriving`): top speed and boost speed x
   `CONFIG.easyDriving.speedScale`, acceleration x0.85; turn rate x `turnScale` and the yaw rate eases toward
   its target over ~0.25 s (no twitch); no drift (very high grip); dart knockback x `knockbackScale`, stun
   wobble/spin x0.3 and stun thrust x0.6 (instead of x0.35). **Shore sliding:** hitting an island or the arena
   edge never bounces the boat backward. Remove the inward part of the velocity, keep ~85% of the sideways
   part, and gently turn the nose toward whichever shoreline tangent is closest to the current heading, so the
   boat glides along the coast and never gets wedged nose-in.
2. **Driving assist** (`src/input`, inside the human controller, when `ctx.self.easyDriving`):
   - **Auto-cruise:** with no throttle input the boat cruises at `cruiseThrottle`. Go = full speed. Back =
     brake, then reverse.
   - **Steering:** the keyboard steering ramp lengthens to 0.22 s.
   - **Bumper rails:** probe ahead along the velocity/forward direction for max(12 m, speed x 1.2 s) against
     `world.obstacles` (+3 m margin) and the arena edge (radius - 6 m). The probe functions in
     `src/ai/steering.ts` already do this for bots, so reuse them. When a hit is predicted, add a steering
     correction toward the side with more clearance: `assist = bumperStrength x urgency` (urgency 0..1 rises
     as the predicted impact gets closer). Combine as `clamp(player x (1 - 0.5 x urgency) + assist)`. If
     urgency > 0.8 and the obstacle is under 6 m away, cap throttle at 0.4.
   - **Gamepad:** apply a squared response curve to stick steering for fine control near center (all players).
3. **Game core** (`src/game`):
   - **Rescue:** applies to every human. Act on the press of `controls.rescue`, with `CONFIG.rescue.cooldownSec`
     between uses: `spot = world.safeSpot(x, z, heading)` → `boat.teleport(spot)` → big `fx.splash` + `fx.sparkle`
     + `sfx.rescue()` + `hud.announce('RESCUED!', {viewport})`. Race progress is kept.
   - **Auto-rescue:** for Easy Driving humans stuck for `autoRescueSec`. Stuck = |speed| < 1.5 m/s while the
     throttle intent is > 0.3, or touching an obstacle.
   - **Stuck hint:** normal-driving humans stuck for 2 s get `hud.hint('Stuck? Press R!')`, worded for their
     scheme via `input.schemeOf`.
   - **Camera:** Easy Driving players use `CONFIG.camera.easy` and smoother yaw follow.
   - **Coach hints:** at GO, a scheme-aware "Steer with A and D, Space to shoot!" ("Left stick to steer, A to
     shoot!" on a gamepad). After 12 s with no shots: "Press SPACE to shoot!". After 3 s parked without
     Easy Driving: "Hold W to go!". At most one hint per player per 8 s, and each hint at most twice per match.

**New buttons:**

| Action | Player 1 | Player 2 | Gamepad |
|---|---|---|---|
| Rescue | R | `/` (Slash) | Y |
| Honk | Q | ` ' ` (next to Enter) | X |

Gamepad boost is now B or LB only (X became honk). In a 1-player game every scheme merges, as before.

## Team Up (`mode: 'team'`)

- **Teams:** `total = humans + bots`. Team 0 = the humans plus `allies = max(0, ceil(total / 2) - humans)`
  helper bots. Team 1 = the remaining bots.
- **Spawns:** `world.teamSpawnPoints(a, b)`. Team names and colors come from `CONFIG.team`. Each boat gets
  `marker` = its team color, so a small diamond floats above it.
- **Darts** pass through teammates. Aim assist and bots never target teammates. Teammates still bump.
- **Scoring:** each boat scores its own hits; the team score is the sum. The timer is `durationSec`.
- **Results:** "Splash Squad wins!" or "It's a tie!"; rows ranked by own hits; `result.teams` filled.
- **Bots:** allies prefer opponents near a human (protect your buddy). Nobody fires when a teammate is in the
  line of fire within 25 m.

## Balloon Pop (`mode: 'practice'`)

- **Setup:** no bots (`bots` forced to 0). `CONFIG.practice.balloons` balloons float around the lagoon, and
  every `goldEvery`-th one is gold (worth 3).
- **Popping:** pop one with a dart (`darts.update(..., balloons.targets)` → `targetHits` →
  `balloons.pop(id, ownerId)`) or by driving through it (`balloons.update` returns ram pops). Ramming is the
  point: a kid who can't aim yet still pops balloons.
- **Clock:** counts up (`raceTime`). The match ends when every balloon is popped. Results show each player's
  points and the time; with 2 players the most points wins (ties allowed). Pickups stay on.
- **Feedback:** each pop triggers `fx.pop` + `sfx.pop()`, plus a feed line for gold balloons.
- **Balloons** (`src/world/balloons.ts`): deterministic spots in open water (>= 6 m from obstacles, inside
  arena - 15 m), in clusters of 1–3 along driving lanes.
  - Look: shiny bright spheres (gold = metallic gold) with a knot and a curly string down to a small float.
  - Motion: they bob on `waveHeight` and sway.
  - Size: the balloon center sits ~1.6 m above the water, so darts AND passing boats hit it. Dart radius ~0.9.
  - Ram rule: popped when a boat's XZ distance < boat.radius + 1.0.
  - Popped balloons hide (`alive = false`); they don't respawn.

## Mini-map (HUD)

- **Placement:** one circular radar per viewport, bottom-right of that viewport. Diameter = min(22% of viewport
  height, 180 px), minimum 110 px.
- **Orientation:** heading-up, rotated by `players[i].viewHeading`.
- **Contents** (from `HudState.map`):
  - the arena edge ring and sand-colored islands;
  - the player's own boat as a big arrow in their color with a white outline;
  - other boats as small arrows (humans larger, teammates ringed in the team color);
  - power-up crates as yellow dots;
  - race gates as short bars, with `players[i].nextGate` pulsing;
  - balloons as dots (gold larger).
- **Drawing:** Canvas 2D at <= 20 Hz. Cache the static island layer by the `obstacles` array identity.

## Boat Garage

- **Where:** reached from each player's card in setup.
- **Preview:** a live 3D preview in its own small `WebGLRenderer` and scene: `createBoat({... look})` from
  `src/entities/boat.ts`, spinning slowly on a calm turntable. Dispose it all on close.
- **Pickers:**
  - Boat: Zippy / Tuggy / Twin = hull 0 / 1 / 2
  - Paint: solid / stripes / flames / dots / shark teeth
  - Hat: captain / pirate / crown / cowboy / propeller beanie / none
  - Flag on a little mast: none / star / heart / skull / lightning / smile
  - Horn: beep / duck / foghorn / clown, with a "Test horn" button
  - Color swatches
- **Boat module:** must render every option clearly: the pattern on the hull, the hat on the captain, the flag
  on a mast at the stern. In Team Up, the flag cloth takes the team color.
- **Bots** get deterministic looks seeded by id.

## Trophy Shelf

- **Data:** `src/ui/trophies.ts` exports `TROPHIES` (about 12; kid-readable name, how-to sentence, one emoji)
  and `awardTrophies(stats)`. It saves per player name in localStorage (key `foamfleet.trophies`, in
  try/catch) and returns only first-time awards.
- **Who calls what:** the core builds `PlayerMatchStats` for each human, calls `awardTrophies`, and puts the
  awards in `MatchResult.awards`. The results screen celebrates them (bounce-in + `sfx.trophy()`).
- **Shelf screen:** on the title screen, it shows every trophy per saved player: earned ones in color, missing
  ones as grey silhouettes with the how-to sentence.
- **Suggested set:**
  - First Splat (tag any boat)
  - Sharpshooter (10 hits in one Dart Battle)
  - Gotcha! (tag the other player)
  - Champion (win a Dart Battle)
  - Finish Line (finish a race)
  - Race Winner (win a race)
  - Teamwork (win Team Up)
  - Balloon Buster (10 balloon points in one game)
  - Pop Star (pop every balloon)
  - Rocket Boat (10 s of boost in one match)
  - Honk Honk (honk 10 times in one match)
  - Treasure Hunter (3 power-ups in one match)

## Ownership for the v2 wave (same rules as before: stay in your lane)

| Builder | Owns | v2 work |
|---|---|---|
| Boat | `src/entities/**` | Easy Driving physics + shore sliding, `team`/`easyDriving`/`teleport`, `BoatLook` rendering (hulls, patterns, hats, flag mast, team flag color), team marker diamond, aim assist skips teammates |
| World | `src/world/**` | `safeSpot`, `teamSpawnPoints`, `balloons.ts`, `'team'`/`'practice'` behave like battle for world + pickups |
| Combat & FX | `src/combat/**`, `src/fx/**` | darts skip teammates, `targets` → `targetHits`, `fx.pop`, `fx.notes` |
| Input & AI | `src/input/**`, `src/ai/**` | rescue/honk buttons, `schemeOf`, Easy Driving assist, gamepad curve, team-aware bots |
| Menu | `src/ui/menu.ts`, `src/ui/garage.ts` (new), `src/ui/trophies.ts`, `src/ui/styles.css`, `src/ui/dom.ts` | 4 modes, Easy Driving toggle, Garage, Trophy Shelf screen, trophy logic, setup persistence with defaults for old saves |
| HUD & Audio | `src/ui/hud.ts`, `src/ui/minimap.ts` (new), `src/ui/hud.css` (new, imported by hud.ts), `src/audio/**` | mini-map, team banner, balloon counters, `hint`, Easy badge, trophy celebration on results; new sounds (pop, 4 horns, rescue, trophy) |
| Game core | `src/main.ts`, `src/game/**` | Team Up + Balloon Pop modes, rescue/auto-rescue/hints/honk, easy camera, stats + `awardTrophies`, new `HudState`/`MatchResult` fields, `sanitizeSetup` for new modes/fields, quick params `?quick=team|practice&easy=0|1`, snapshot adds `balloons` + `teams` |

The HUD builder must not edit `styles.css` or `dom.ts` (the Menu builder owns them); put new HUD styles in
`hud.css`. Only the Game core edits `src/game/**`, including fallbacks and debug.
