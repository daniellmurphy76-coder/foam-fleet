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

---

# v3: iPad — touch controls + iPad polish

The game is live on GitHub Pages and the son plays on a 2026 iPad (Safari, landscape, ~1180x820 or
1366x1024 CSS px, devicePixelRatio 2). He needs to play with fingers only. A Bluetooth gamepad and the
keyboard must keep working exactly as before. Contract change in `src/types.ts`: `InputManager` gains
`touchActive`, `layoutTouch(viewports, humans, visible)`, and `schemeOf` can return `'touch'`.

## Shared rules

- **When touch is on.** Touch controls are "available" on a touch device (`navigator.maxTouchPoints > 0`
  and `matchMedia('(any-pointer: coarse)')`) or with `?touch=1` (forces them on any device for testing).
  `touchActive` becomes true on the first `pointerdown` with `pointerType === 'touch'` (or immediately with
  `?touch=1`). It becomes false when a game key or gamepad button is pressed, and true again on the next
  touch.
- **CSS hook.** While `touchActive`, `<html>` has the class `ff-touch`. Other modules adapt their layout with
  `html.ff-touch ...` CSS rules.
- **Visibility.** Touch controls show only during countdown and play (`layoutTouch(..., visible)` from the
  core). Hidden in menus, pause and results, which are tapped like normal buttons.
- **Safe areas.** Respect `env(safe-area-inset-*)` everywhere near screen edges.
- **Ergonomics.**
  - Thumb zones are the bottom-left and bottom-right corners of each player's control zone, about the bottom
    55% of the height.
  - HUD elements must not sit in those zones while `ff-touch` is on.
  - Minimum tap target 48 px; FIRE about 104 px.

## Touch controls (`src/input/**`, new `src/input/touch.ts`)

- **Overlay.** A DOM overlay owned by the input module: one root `div.ff-touchui` appended to `#app`,
  `z-index` above `#hud`, `pointer-events: none` except on its controls. Use Pointer Events with
  `setPointerCapture`, multi-touch (several fingers at once), and `touch-action: none` on control surfaces.
  No per-frame allocation.
- **One zone per human viewport** (the rects from `layoutTouch`).
  - 1 player: the zone is the whole screen.
  - 2 players: the left half is Player 1 and the right half is Player 2.
- **Floating joystick** in each zone's OUTER half: P1 / 1-player = left side of the zone, P2 = right side.
  - A finger landing anywhere in that area spawns the stick base under it (radius ~64 px) with a knob that
    follows the finger (clamped to the base radius).
  - On release it fades to a faint resting hint at its default position.
  - Output: `steer = x` (dead zone 0.12, rescaled, gentle curve) and `throttle = -y` (up = go, down =
    brake/reverse).
  - With Easy Driving the stick's up/down still works: the human-controller assist already turns
    "no throttle" into cruise, so pass the stick's throttle through unchanged.
- **Buttons** in each zone's INNER bottom corner (toward the screen middle in 2-player):
  - big round **FIRE** (orange, hold = keep firing);
  - **BOOST** (hold);
  - small **HONK** and **RESCUE** (each a tap pulse lasting one controller update, like keyboard taps).
  - Labels with simple icons. Pressed state = darker + scale 0.92.
- **Pause** button (48 px, "II") pinned top-left of the whole screen (safe area), only while visible. A tap
  sets the `menu.pause` edge.
- **Merging.** Touch merges into the slot's controls exactly like an extra scheme (largest magnitude wins for
  axes; OR for buttons).
  - `schemeOf` returns `'touch'` for a slot while touch is active.
  - 1 player: touch feeds slot 0.
- **Robustness.** Any lost pointer (pointercancel, lostpointercapture, blur, visibility hidden,
  `layoutTouch(..., false)`) releases its control so nothing gets stuck.

## HUD & Audio (`src/ui/hud.ts`, `src/ui/hud.css`, `src/ui/minimap.ts`, `src/audio/**`)

- **Layout under `html.ff-touch`:**
  - Move each viewport's bottom-left cluster (Easy badge, power-up badge, ammo, boost) up to sit under the
    name/score panel (top-left of the viewport).
  - Move the mini-map from bottom-right to the top-right of the viewport, below the global scoreboard in
    1-player. In 2-player the global scoreboard is top-right of the whole screen, so P2's map goes below it
    and P1's map sits top-right of P1's viewport. Shrink it to min(18% of viewport height, 140 px) if needed.
  - Nudge Player 1's name panel right by 60 px so it clears the Pause button.
  - Keep hints and the feed out of the thumb zones: hints go just above the vertical middle.
  - Nothing in the HUD may overlap the bottom 55% corners of a viewport.
- **Audio on iOS.** Make `unlock()` reliable: call `ctx.resume()` inside the gesture. Also listen once,
  document-wide, for `touchend`, `pointerup`, `click` and `keydown` (capture phase) to unlock. Re-resume when
  the context reports `interrupted` or `suspended` after the app returns from the background
  (`visibilitychange`).

## Menu (`src/ui/menu.ts`, `garage.ts`, `trophies.ts`, `styles.css`, `dom.ts`)

- **Controls card.** On a touch device the title-screen card shows a "Touch" card ("Left thumb: steer.
  Right thumb: FIRE and BOOST. II = pause") first, plus the keyboard/gamepad cards (a gamepad can still
  be paired).
- **Scrolling.** Screens that can overflow scroll with a finger: `touch-action: pan-y` and
  `-webkit-overflow-scrolling: touch` on them. The page itself never scrolls or bounces.
- **Taps.** All tap targets are at least 48 px. Use `touch-action: manipulation` on buttons, so there is no
  double-tap zoom or 300 ms delay.
- **Text fields.** Name inputs use font-size of at least 16 px (smaller makes iOS zoom in). Add
  `autocapitalize="words"`, `autocorrect="off"` and `enterkeyhint="done"`. Text inside inputs stays
  selectable even though the page disables selection.
- **Garage.** Drag (finger or mouse) on the 3D preview spins the boat; let go and it resumes its slow spin.

## Game core (`src/main.ts`, `src/game/**`)

- **When to call `input.layoutTouch(viewports, humans, visible)`:** on every state change and resize, with
  visible = (state is countdown or playing). Same viewports as the HUD.
- **Hints** for the `'touch'` scheme: "Drag the stick to steer. Tap FIRE to shoot!"; stuck hint "Stuck?
  Tap RESCUE!"; no-shots hint "Tap FIRE to shoot!"; parked hint "Push the stick up to go!".
- **Pause.** Pause when `document.visibilityState === 'hidden'` (the iPad app switcher), as for window
  blur today.
- **Audio.** Call `sfx.unlock()` on the first `pointerup`/`touchend` anywhere (in addition to the audio
  module's own listener).
- Keep `fallbacks.ts` in step with the new InputManager members.
- **Silent test mode:** `?mute=1` mutes all game sound for that page load only. Call `sfx.setMuted(true)`
  at boot and make the in-game mute toggle a no-op while the flag is set, but do NOT persist it. This exists
  because the orchestrator's hidden test browser plays sound on the family's speakers.

## Shell (`index.html`, `public/**`, `scripts/**`)

- **Viewport meta:** `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no,
  viewport-fit=cover`.
- **Page CSS** (in index.html):
  - `html, body { overscroll-behavior: none; -webkit-user-select: none; user-select: none;
    -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; touch-action: none; }`
  - `input, textarea { -webkit-user-select: text; user-select: text; }`
  - The canvas also gets `touch-action: none`. Menus override touch-action locally for scrolling.
- **No pinch zoom:** a tiny inline script calls `preventDefault` on `gesturestart`/`gesturechange`, and on
  `dblclick`.
- **Rotate screen:** a static `#rotate` overlay shown only by
  `@media (orientation: portrait) and (any-pointer: coarse)`. Full screen, the page background color, a big
  rotating-iPad emoji or SVG and the text "Turn your iPad sideways to play!" in Fredoka. Above everything.
- **Home screen:**
  - `public/manifest.webmanifest`: name "Foam Fleet", short_name "Foam Fleet", `display: "fullscreen"`,
    `orientation: "landscape"`, `start_url: "./"`, `scope: "./"`, background/theme colors from the game's sky
    and water, and icons 192 and 512 (+ 512 maskable).
  - Link it, and add `apple-touch-icon` 180x180, `apple-mobile-web-app-capable` /
    `mobile-web-app-capable` = yes, `apple-mobile-web-app-status-bar-style` = black-translucent,
    `apple-mobile-web-app-title`, and `theme-color`.
  - All paths relative (the site lives under `/foam-fleet/`).
- **Icons:** `scripts/make_icons.py` (Python 3 + Pillow, already installed; no new npm dependencies) draws
  the icon procedurally with 4x supersampling into `public/icons/`.
  - Sizes: icon-180.png, icon-192.png, icon-512.png and icon-512-maskable.png (content inside the central
    80% safe zone).
  - Design, matching `public/favicon.svg`: turquoise water circle, a red toy speedboat with a white cabin and
    an orange/blue foam blaster, white wave line. Bright and readable at 60 px.
  - Commit the PNGs (CI does not run the script).

## Verification the orchestrator will run

- `?touch=1` at 1180x820 and 1366x1024, 1 and 2 players:
  - controls and HUD placement don't collide;
  - synthetic multi-touch PointerEvents drive steer/throttle/fire/boost/honk/rescue/pause;
  - releasing every finger zeroes the controls.
- Portrait shows the rotate overlay.
- Keyboard and gamepad still work; `touchActive` flips back on a key press.

---

# v4: Sharks! (the son's ideas)

The son asked for three things:
1. a new game, **Boats vs. Sharks**;
2. a new boat, the shark-skeleton **BoneBoat**;
3. **sharks in the water in every game**.

Contracts in `src/types.ts` are updated (`ModeId 'sharks'`, `SHARK_ID_BASE`, `AimTarget`, `Sharks`, `SharkBump`,
`SharkTag`, `SharkHud`, `ControllerContext.sharks`, `Boat.update/tryFire aimTargets`, `Effects.bubbles`, new
`Sfx` methods, `MapState.sharks`, `HudState.sharks`, new `PlayerMatchStats` fields). Knobs live in
`CONFIG.sharks`, and the new stub is `src/sharks/sharks.ts`.

**Tone:** cartoon sharks, never scary.
- Big friendly eyes, a goofy toothy grin, rounded shapes, slate-blue with a white belly.
- No blood, no "eat", no "kill". Words: bump, chomp (a silly sound), splash, dive, scare off, tag.
- A shark that gets darted does a comic flip and dives away with bubbles. The MEGA SHARK is a big
  purple-grey goofball with a little captain's hat and a scar-free grin.

## Sharks module (`src/sharks/**`, new; `createSharks(scene, world, mode, fx, skill)`)

**Models.** Low-poly, flat-shaded, pooled. Up to 16 normal sharks plus 1 MEGA (x3 size).
- Body about 3.2 m long, with dorsal fin, tail fin, pectoral fins, eyes and teeth.
- Tail-wag swim animation.
- Only the dorsal fin (plus a faint V of spray) shows while cruising; the body sits about 0.7 m under the
  surface, following `waveHeight`.
- While chasing, the shark rides higher (back and fin out).

**Bump.** A quick lunge, half out of the water with the jaw open, then a splash.
- Detected when the shark's nose is within `boat.radius + 1.2` (MEGA: + 3) of a boat.
- Call `boat.onHit(dir, CONFIG.sharks.bumpStun)` and return a `SharkBump` (blocked = the onHit result
  was false).
- The bumping shark then turns away and won't bump anyone for 4 s.

**Dart hit** (`hit()`).
- Normal shark: a comic flip, `fx.bubbles` and `fx.splash`, then it dives, sinks out of sight in about 1 s,
  and leaves. In ambient modes it reappears near the arena edge after `returnSec`.
- MEGA SHARK: -1 health, a flash, a short shake; defeated at 0 (big flip, giant splash).
- Return a `SharkTag`.

**Brains.** Steering with look-ahead obstacle avoidance against `world.obstacles` and the arena edge (reuse
the probe helpers in `src/ai/steering.ts`; read-only import is fine). Sharks never beach on islands and never
cross obstacle circles.
- **Ambient modes** (battle/race/team/practice; count = `CONFIG.sharks.ambient[mode]`):
  - Cruise lazy loops through open water at `cruiseSpeed`.
  - Every ~`chaseEverySec` (randomized per shark), a shark may chase the nearest boat within 45 m at
    `chaseSpeed` for up to `chaseSec`. Then it gives up and swims off.
  - Never more than one chaser per boat.
  - Practice (Balloon Pop): sharks never chase or bump; they just cruise and look cool.
- **'sharks' mode:**
  - `spawnWave(count, false)` brings sharks in from evenly spread points on the arena edge, all
    targeting boats: each picks the nearest boat (spread out, at most 2 per boat), re-picks every 3 s, and
    chases at `chaseSpeed * speedBySkill[skill]`, with small personality differences.
  - `spawnWave(1, true)` brings the MEGA SHARK: slower (0.8x), relentless, bump reach + 3 m. Its bump calls
    onHit once like any shark (`SharkBump.mega` = true); the core decides the bigger consequences.
  - `waveLeft` counts wave sharks not yet tagged.
- **targets** (`AimTarget[]`): live hittable sharks only (not diving, not off-screen, not returning).
  - `id = SHARK_ID_BASE + index`.
  - `position` = a hit-sphere center at the body (y about 0.3).
  - `radius` 1.6 (MEGA 4.5).
  - `velocity` = the current velocity.
  - `name` "Shark" or "MEGA SHARK".
  - Reuse the arrays and objects (no per-frame allocation).
- **mapDots:** every visible shark.
- **dispose():** frees everything.

## BoneBoat (`src/entities/**`): hull 3

A boat built from a giant **shark skeleton**, bone-white with slightly warm ivory shading.
- **Body:**
  - a skull at the bow: snout, big empty eye sockets glowing in the player color, an open jaw with a row of
    pointy teeth, top and bottom;
  - a spine along the centerline;
  - 5–6 curved rib pairs forming the hull sides (thin, with gaps you can see water through; a floor plate
    inside so it reads as a boat);
  - a bony dorsal fin behind the cockpit;
  - a bony forked tail fin at the stern;
  - a hint of pectoral-fin bones near the waterline.
- **Fittings:** the captain seat, captain (with hat) and blaster sit on the spine/floor like the other hulls.
  The flag mast goes on the tail.
- **Paint patterns:** on BoneBoat they tint the rib ends/teeth tips and the eye glow, so the player color and
  pattern still read.
- **Fit:** same size, waterline, collision radius and hit radius as the other hulls. It must look great in
  the Garage turntable AND from the chase camera.
- **Aim assist:** `update()`/`tryFire()` get optional `aimTargets` (sharks). Lock rule: the nearest BOAT
  (other team) in the cone wins; if none, the nearest aim target in the cone. `aimTargetId` can then be a
  shark id (>= SHARK_ID_BASE). The turret tracks it, and `tryFire` leads it with its velocity like a boat.

## Boats vs. Sharks rules (`src/game/**`, mode `'sharks'`)

- **Teams and spawns:** humans + `setup.bots` helper boats (0..3, default `CONFIG.sharks.defaultHelpers`)
  are all team 0. No enemy boats. Spawn on the battle ring.
- **Waves:** `CONFIG.sharks.waves` = 5 waves, then the MEGA SHARK round.
  - Before each wave: `hud.announce('WAVE n', {sub: 'Here come the sharks!'})` + `sfx.waveStart()`.
  - MEGA round: `announce('MEGA SHARK!')` + `sfx.megaRoar()`.
  - The next wave starts `waveBreakSec` after the last wave shark leaves.
- **Life rings:** the team starts with `CONFIG.sharks.lifeRings`. Every non-blocked shark bump pops one
  (MEGA bump pops 2).
  - Feed: "Splash! A shark bumped Sam" (playful).
  - Each bump: `sfx.sharkBump()`, `fx.splash`, and a rumble for a human.
- **Scoring:** each dart tag on a shark = 1 point to the shooter (MEGA hits = 1 each, the final MEGA hit +5).
  - Feed: "Sam scared off a shark!"
  - Each tag: `sfx.sharkDive()`.
- **End:** WIN when the MEGA SHARK is defeated: title "You beat the sharks!", `sfx.victory()`, confetti.
  LOSE when the rings hit 0: title "The sharks win this time!", `sfx.defeat()`. Results rows show each
  boat's shark tags; stats include sharkTags, sharkBumps, megaDefeated, hull.
- **HUD:** `HudState.sharks` filled every frame (`wave`, `waves`, `sharksLeft`, `rings`, `maxRings`, `mega`,
  `betweenWaves`). `timeLeft` is null; `raceTime` counts up.

## Sharks in every game (`src/game/**`)

- **Setup:** every match creates the sharks system after the world (`createSharks(scene, world, mode, fx,
  setup.botDifficulty)`). Each step, call `sharks.update` after the boats move and before darts. Shark bumps:
  `sfx.sharkBump()`, `fx.splash`, a feed line ("A shark bumped Salty Sal!"), stats.sharkBumps, rumble. No
  points lost outside 'sharks' mode.
- **Darts:** pass `sharks.targets` to `darts.update` as targets. In Balloon Pop, concatenate with
  `balloons.targets` in one reused array.
- **Routing hits:** `targetHits` with id >= SHARK_ID_BASE go to `sharks.hit(id, ownerId, dir)`; others go to
  balloons. A shark tag outside 'sharks' mode scores nothing but plays `sfx.sharkDive()` with a feed line
  "Sam scared off a shark!", and counts stats.sharkTags.
- **Aim:** pass `sharks.targets` as `aimTargets` to `boat.update`/`tryFire`, and as `ctx.sharks` to
  controllers. The reticle's `lockedTarget` shows the AimTarget's name when `aimTargetId >= SHARK_ID_BASE`.
- **Map:** `HudState.map.sharks` = `sharks.mapDots`.
- **Setup and test params:** `sanitizeSetup` accepts 'sharks' (bots = helpers 0..3, clamp). `?quick=sharks`
  works.
- **Bot looks:** bot hulls are chosen from 0..3 (BoneBoat included).

## Bots (`src/ai/**`)

- **'sharks' mode:** bots are helpers.
  - Each bot targets the shark closest to any human (protect the players), else the nearest shark.
  - It circles at a safe range (15–25 m), fires when the shark is in its nose cone, and boosts away from a
    shark about to bump it.
  - The MEGA SHARK gets focus fire from everyone.
- **Other modes:** if a shark is chasing a bot (within 20 m behind or closing), the bot may turn and dart
  it (normal difficulty and up). Otherwise bots ignore sharks.
- **Steering:** steer around sharks like moving obstacles only when very close.

## Menu (`src/ui/menu.ts`, `garage.ts`, `trophies.ts`, `styles.css`, `dom.ts`)

- **Mode card:** a 5th card, **Boats vs. Sharks** 🦈 ("Team up! Scare off 5 waves of sharks, then the MEGA
  SHARK!"). Options: Players 1/2; Helper boats 0–3 (default 2); Shark speed = the existing bot-skill buttons,
  relabeled "Shark speed: Slow / Normal / Fast" for this mode. No battle length.
- **Garage:** the Boat picker adds **BoneBoat** (hull 3) with a bone/skull icon.
- **Trophies:** 4 new.
  - "Shark Tamer" (tag 10 sharks in one game)
  - "Shark Snack" (get bumped by a shark: a funny one)
  - "Mega Hero" (beat the MEGA SHARK)
  - "Bone Captain" (play a game in the BoneBoat)

## HUD, FX & Audio (`src/ui/hud.ts`, `hud.css`, `minimap.ts`, `src/fx/**`, `src/audio/**`)

- **Boats vs. Sharks banner** (top center, replacing the timer): "Wave 2/5" (or "MEGA SHARK!"), sharks left
  with a little fin icon, and the team's life rings as a row of red-and-white ring icons (popped rings
  greyed out).
- **MEGA health bar:** under the banner, a wide chunky bar while the MEGA SHARK is out.
- **Between waves:** a gentle "Get ready…" countdown text.
- **Touch layout:** the banner must not collide with the touch layout's top-left/right stacks (see the v3
  rules).
- **Mini-map:** sharks are small dark-grey fin triangles pointing along their heading; MEGA is bigger and
  purple.
- **FX:** `fx.bubbles(position)`: a column of rising bubbles that pop at the surface over ~1 s (pooled).
- **Audio** (synthesized like the rest, friendly not scary):
  - `sharkBump` = cartoon chomp (two quick clacks) + thud;
  - `sharkDive` = splash + bubbly blorp;
  - `waveStart` = ship's bell ding-ding;
  - `megaRoar` = big silly cartoon roar (wobbly low growl, sliding down, then a goofy squeak);
  - `defeat` = friendly wah-wah trombone.
  - The two-note "duun-dun, duun-dun" shark theme sting plays on `waveStart` (optional, short).

---

# v5: Online multiplayer

**Goal.** Dad on a laptop and the kid on an iPad (2–4 devices, one player each) play together in any of the
five modes, at the same live URL, from the same house or different houses. No accounts, no chat.

**Decisions.**
- PeerJS free public signaling, then direct WebRTC data channels.
- One player per device; local split screen stays as it is for offline play.
- All five modes online.

**Contracts.**
- `src/net/protocol.ts`: wire format, constants and transport interfaces.
- `src/net/session.ts`: HostSession, GuestSession and GuestView, as the app sees them.
- New net hooks in `src/types.ts`:
  - `BoatNetState` and `Boat.netState/applyNetState/netFire/netHit`;
  - `DartSystem.spawn` now returns an id, plus `spawnNet/netStick/netDeflect/netKill`, and
    `DartHit.dartId/tip/quat`;
  - `Sharks.netState/applyNetState` (opaque `SharkNetState`);
  - `Pickups` `crateIndex` + `netState/applyNetState`;
  - `Balloons.netState/applyNetState`;
  - `MatchSetup.online` (`OnlineRoster`);
  - `Hud.showResults` (null rematch) + `setNetStatus`;
  - `Menu.setOnlineHooks/showOnline/updateLobby`, `OnlineMenuHooks`, `LobbyState`.

**Stubs:** `src/net/transport.ts`, `src/net/host.ts`, `src/net/guest.ts`. **Dependency:** `peerjs` is installed.

## How it works (everyone read this)

**Host-authoritative.** The host device runs the real Match exactly as today, with the host player in slot 0.
Guests are slots 1..3.
- **Guests don't simulate.** Each guest builds a render-only GuestView: the same world (it is deterministic),
  puppet boats from the host's exact `BoatInit`s, sharks, crates, balloons, fx and darts.
- **Snapshots.** The host sends a `NetSnapshot` every 3rd fixed step (20 Hz) on the fast channel, and
  one-shot `NetEvent`s on the reliable channel.
- **Controls.** Guests send their controls at 30 Hz on the fast channel, with running press counters so taps
  are never lost.

**Interpolation (GuestView).**
- Keep a buffer of snapshots stamped with host time `t`. Estimate host time smoothly from arrivals.
- Draw other boats and sharks at `hostNow - INTERP_DELAY`, interpolating position, VELOCITY and heading
  (with angle wrap).
- Draw THIS player's boat from the newest snapshot extrapolated by its velocity, capped at
  `MAX_EXTRAPOLATE`, so steering feels responsive.
- Snap (no tween) when a boat's `epoch` changes.

**Events.** Each `NetEvent` is replayed once on the guest, in order.
- `fire` → `darts.spawnNet(id, spawn, age = hostNow - eventT)`. The guest's DartSystem flies darts
  cosmetically: `update(dt, t, [], world, 0, [])` means no boat/target collisions locally, while islands and
  water work locally.
- `stick` / `deflect` / `kill` resolve a dart exactly as the host did.
- `hit` → `boat.netHit`.
- `sfx`, `fx`, `announce`, `feed`, `hint`, `cam`, `rumble` call this device's own sfx/fx/hud/camera/input,
  filtered by `to` and `at`.

**Hidden from guests.** Host-internal fx made inside darts.update and sharks.update are NOT sent as fx
events: the guest's DartSystem (netStick/netDeflect/netKill) and Sharks (applyNetState phase transitions)
play their own versions. Only Match/Player-level sfx/fx/hud calls are captured as events.

**Stats and trophies.** The host computes PlayerMatchStats for every human, but awards trophies only for its
local player. Each guest receives its own stats in `HostResults` and awards its own trophies on its device.

**Connection.**
- Kid-friendly errors everywhere.
- A dropped guest's boat just stops (controls time out) and the feed says "Sam left the game".
- If the host leaves, guests get "The host left the game" and return to the title screen.
- No auto-pause on blur during online play. The host's pause pauses everyone; a guest's Pause opens a local
  "Leave the game?" overlay while the game keeps running.

## Transport (`src/net/transport.ts`, may add `src/net/codes.ts`)

Implement `openHost()` and `joinHost(code, hello)` (contracts in protocol.ts) with PeerJS.
- **Loading:** `await import('peerjs')`, so offline players never download it. Use the default public cloud
  server and its default STUN.
- **Room ids:** `PEER_PREFIX + code`, where `code` is CODE_LENGTH random letters from CODE_ALPHABET. On
  `unavailable-id`, retry with a new code (up to 5 times).
- **Channels:** two DataConnections per guest. "rel" is reliable, used for `send`; "fast" is unreliable, used
  for `sendFast`, with fallback to rel until fast opens.
- **Health:** ping/pong every 1 s gives a smoothed `rttMs`. No message for `LINK_TIMEOUT` = disconnect.
- **Join:** `joinHost` resolves after both channels open and the hello is sent. It rejects with kid-friendly
  messages:
  - "Couldn't reach the game server. Check the internet and try again."
  - "No game with that code. Check the letters!"
  - "Couldn't connect to that game. Try again, or play on the same Wi-Fi."
  - Each with a ~10 s timeout.
- **Cleanup:** `close()` ends everything; guests get `onClose('The host left the game')`.
- **Codes:** typed codes are case-insensitive, and characters outside CODE_ALPHABET are rejected.

## Entities net hooks (`src/entities/**`, `src/combat/**`, `src/sharks/**`, `src/world/pickups.ts`, `src/world/balloons.ts`)

Implement every new net member exactly as documented in types.ts.

**Boat.**
- `netState()` reads the real physics state.
- `applyNetState` writes position x/z, heading, velocity, inSteer, boosting, shielded (re-trigger the shield
  appear animation on a rising edge), powerUp, stunned (keep a local wobble timer), aimTargetId, ammo/reload/
  boost getters and the epoch.
- It then runs ONLY the visual parts (wave sampling for y/pitch/roll, animate: flames, shield, turret easing
  toward the lock, flag, propeller, eye glow, marker, wobble), with no physics and no aim picking.
- Velocity is supplied every frame (interpolated), so the accel-based nose pitch stays smooth.
- `netFire` = recoil + muzzle flash. `netHit(blocked, stun)` = flash + wobble, or the shield pop. Visual only.

**Darts.**
- Every dart gets a match-unique id; `spawn` returns it.
- DartHit/DartTargetHit carry `dartId`; a stuck hit carries the boat-LOCAL `tip` + `quat` right after
  attach.
- `spawnNet(id, spawn, age)` advances the new dart by `age` seconds of flight.
- `netStick(id, boat, tip, quat)` puts dart `id` (or a fresh one if it is unknown or already gone) stuck on
  `boat` at that pose, with the hit burst in the boat color.
- `netDeflect` = shield sparkle + tumble. `netKill` = small puff + remove.
- Fix the stale-trail quirk: clear trails when the last flying dart ends.

**Sharks.**
- `netState()` = a flat number array: per active slot, the phase/mode/wave flags, x, z, heading, speed,
  turn rate, appear, and sequence progress; plus MEGA health/max and waveLeft.
- `applyNetState(prev, next, alpha, t, dt)` interpolates positions/headings and sets phases, initializing
  the captured start values locally on phase changes (FLIP/LUNGE/DIVE), then runs only the render half
  (writePose, targets, mapDots).
- Splashes and bubbles at phase transitions play locally. No AI and no bumps.

**Pickups.**
- PickupEvent gets `crateIndex`.
- `netState()` = live bitmask. `applyNetState(mask, t, dt)` animates without collecting and forces live/gone
  with the pop-in/pop-away animations.

**Balloons.**
- `netState()` = alive words. `applyNetState(mask, t, dt)` animates (no magnet, no pops) and hides/shows to
  match.

**Rule:** a guest never passes real/puppet boats into update() calls that could hit, bump, collect or pop.

## Host (`src/game/match.ts`, `players.ts`, `modes/*.ts`, `setup.ts`, `cameras.ts` if needed, `src/net/host.ts`)

**Online roster in Match.**
- When `setup.online` is set, `humanCount = online.players.length` (2..4). Boat ids 0..n-1 are the humans,
  using `online.players[i]` for name, color, look and Easy Driving. Bots follow.
- Add `readonly localSlots: readonly number[]`: the boat ids played on THIS device. Local play: [0] or [0,1].
  Online host: [localSlot] = [0].
- Everything per-viewport (HUD players, cameras rendered, touch, rumble, hints, `announce` viewport,
  `input.humanController(localIndex, localCount)`, `schemeOf`) uses LOCAL slots. Everything per-human for
  rules (race finish/grace, practice, shark rings, stats) uses all humans.
- Keep `cams` indexed by human slot. Remote slots may have cameras that are never drawn; their kick/shake/
  snap become events.
- Fix every `slotOf` / viewport use accordingly, e.g. shark rings must cost a ring for ANY human, not only
  local ones. Add `isHumanBoat(id)` vs `viewportOf(id)` where needed.

**Net hooks on Match** (the design is yours; host.ts is the only other user).
- Remote humans are driven by a RemoteController (Controller kind 'human') fed from GuestControls:
  - copy values;
  - convert press-counter increases into fire/rescue/honk presses held for one step;
  - after `CONTROLS_TIMEOUT` with no packet, return zero controls.
- **Event capture:** every Match/Player/mode-level sfx, fx, hud.announce/feed/hint, camera kick/shake/snap and
  rumble becomes a NetEvent (with `to` = human slot when it is for one player, and `at` for positional
  sounds), while still playing locally for local slots.
  - Wrap the services, but give darts/sharks the RAW fx (see "How it works").
  - Fire → `fire` event with dart ids.
  - Dart hits → `stick`/`deflect` + `hit` events; target hits → `kill`.
- **Hints for remote players** go as `hint` events with an id; the guest words them for its own controls.
- **`netSnapshot(seq)`** builds a NetSnapshot: `boats[i].netState()`, sharks/pickups/balloons netState, and
  NetHud from the mode (scores, ranking, timeLeft/raceTime, race info, next gates, teams, balloons, sharks
  HUD).
- **`result()`** awards trophies for LOCAL humans only. Add `statsFor(slot)` so host.ts can send each guest
  its stats.

**`createHostSession(profile)`** (host.ts) implements HostSession.
- **Lobby:**
  - slot 0 = host; guests take the lowest free slot; max `MAX_ONLINE_PLAYERS`;
  - reject with kid-friendly reasons when the room is full, a match is running, or the version differs;
  - make every player's color unique by moving duplicates to free CONFIG colors;
  - keep names ≤ 12 chars, non-empty and unique (append 2, 3, ...).
- **Mirroring:** broadcast `lobby` on any change. `setProfile`/`setSettings` update and rebroadcast.
- **`buildSetup(settings)`** = settings (mode, bots, skill, length, laps) + `online.players` from the lobby,
  `humans` 1, `players` [host], `localSlot` 0. Clamp bots so humans + bots ≤ maxBoats.
- **`beginMatch(match)`** installs the RemoteControllers and event capture, then sends each guest `start`
  with its own localSlot + the BoatInit list.
- **`afterStep`** sends `snap` every SNAPSHOT_EVERY_STEPS, and flushes buffered events as one `ev` per step
  (or per snapshot) to each guest, routing `to`.
- **`setState`, `sendResults`, `emit`, `close`** as documented.
- **Disconnects:** a guest leaving the lobby is just removed. Mid-match, its controller goes idle and
  `onPlayerLeft(name)` fires.

## Guest (`src/net/guest.ts`, new `src/net/guestView.ts`)

**`joinGuestSession(code, profile)`** implements GuestSession.
- Calls `joinHost` and waits for `welcome` (resolves) or `reject` (rejects with the reason, kid-friendly).
- Exposes lobby updates, marking `isYou`.
- `onStart` / `onState` / `onResults`: on results, call `awardTrophies([stats])` itself and put the awards in
  `result.awards`.
- `onClosed`, `setProfile` (sends `profile`), `close()` (sends `bye`).

**`createView(setup, services)`** builds the GuestView: a THREE.Scene, `createWorld(scene, mode)`, puppets
from `start.inits` (`createBoat`, added to the scene), `createSharks` (mode, its fx, skill from setup) driven
only by applyNetState, `createPickups`, `createBalloons` (practice only), `createEffects`, `createDartSystem`,
and a `ChaseCamera` (from src/game/cameras.ts) on its own boat.

**`update(dt)`:**
1. Run `input.humanController(0, 1).update(ctx, dt)` with a ctx whose `self` is the puppet own boat and whose
   world is the real world (Easy Driving assist works). Copy the output, count rising edges into press
   counters, and send GuestControls at CONTROLS_HZ.
2. Advance the host-time estimate.
3. Apply due events.
4. Interpolate snapshots → `boat.applyNetState` per boat (own boat extrapolated), sharks/pickups/balloons
   `applyNetState`.
5. `darts.update(dt, t, [], world, 0, [])`, `fx.wake` per boat, `fx.update`, `world.update(t, dt)`, camera
   update.

**`hudState(vp)`:** HudState for the one local player.
- PlayerHud from its puppet boat getters + NetHud (score, rank, race, nextGate → arrow from its camera,
  lockedTarget name: boat name, or shark target name for ids ≥ SHARK_ID_BASE).
- Scoreboard from NetHud ranking/scores + inits; teams/balloons/sharks from NetHud.
- MapState from puppets, sharks.mapDots, crate positions, balloons and world.

**Other:** `engineLevel()` from own speed; `boatObject(id)`; `dispose()` frees everything.

## Lobby UI + HUD (`src/ui/menu.ts`, `styles.css`, `dom.ts`, `hud.ts`, `hud.css`)

**Title screen.** A big **Play Online** button (only after `setOnlineHooks`).

**Online screen.** Two big cards: **Host a game** ("Start a game and share the code") and **Join a game**
("Type the code from the other screen").

**Join screen.**
- 4 big letter slots plus an on-screen letter keypad (CODE_ALPHABET, Delete, Join). It works by touch,
  mouse, keyboard typing and gamepad.
- Prefilled by `showOnline('join', code)`.
- Shows `join()` errors in a friendly box.

**Lobby.**
- The room code, BIG, for the host to read out ("Code: DUCK"), plus a hint "On the other device: Play
  Online → Join → type DUCK".
- The player list with color, name, a boat icon, "(you)" and "(host)".
- This player's own card: name, color swatches, Easy Driving, Boat Garage. Changes call `hooks.profile`.
- **Host:** the game settings (mode cards, computer boats/helpers, skill/shark speed, battle length or race
  laps, the same controls as setup; changes call `hooks.settings`), and a big **Start!** that is enabled with
  2+ players (calls `hooks.start(setup)`).
- **Guest:** the settings read-only plus "Waiting for the host to start...".
- A **Leave** button calls `hooks.leave()`.
- `updateLobby(state)` refreshes everything.
- The menu stays usable by keyboard, gamepad and touch, and keeps the v3 touch rules.

**HUD.**
- `showResults` with `onRematch === null` shows `opts.waiting` (e.g. "Waiting for the host...") instead of
  Rematch, and `opts.menuLabel` on the Menu button.
- `setNetStatus(text)` shows a small pill under the Pause button area (top-left, safe-area aware, not
  overlapping the v3 touch layout).

## App (`src/game/app.ts`, `src/main.ts`, `src/game/fallbacks.ts`, `guard.ts`, `debug.ts`, `modules.ts`)

**Hooks.** Implement OnlineMenuHooks and call `menu.setOnlineHooks` at boot.
- `host`: `createHostSession`, then the lobby.
- `join`: `joinGuestSession`.
- `settings` / `profile`: forward to the session.
- `start`: `session.buildSetup` → `startMatch(setup)` → `session.beginMatch(match)`.
- `leave`: close the session and return to the title.
- Push `session.onLobby` to `menu.updateLobby`.

**Online host loop.**
- Call `session.afterStep(match)` after every fixed step.
- `setState` on every state change.
- Emit countdown/GO events (`emit`).
- `sendResults` at finish.
- Rematch reuses `startMatch` + `beginMatch`. Menu → `setState('lobby')` and back to the lobby screen.
- No blur auto-pause; host pause/resume mirrors.

**Viewports.** Use `match.localSlots` (not humanCount) for viewports, HUD players, cameras drawn, and touch
layout.

**Guest app.**
- On `onStart`: dispose any view, `createView`, state countdown, `hud.show()`, `layoutTouch` with one
  viewport.
- Each frame in countdown/playing/results: `view.update(dt)`, render `view.scene` with `view.camera` in one
  full viewport, `hud.update(view.hudState(vp))`, `sfx.setEngines([view.engineLevel()])`.
- `onState` mirrors countdown/playing/paused (a "Paused by the host" announce) and results.
- `onResults`: `hud.showResults(result, null, leave, { waiting: 'Waiting for the host...', menuLabel: 'Leave' })`
  plus victory/defeat sound, with an orbit camera around `view.boatObject(winnerId)`.
- `state 'lobby'` → back to the lobby screen.
- `onClosed` → title screen with the reason shown.
- A guest's Pause opens `hud.showPause(resume, leave)` without stopping anything.

**Other.**
- `?join=CODE` opens `menu.showOnline('join', CODE)` at boot.
- `hud.setNetStatus` shows e.g. "Online · DUCK · 3 players" / "Reconnecting...".
- Keep all debug hooks. Add `__foam.net = { role, code, slot, rttMs, snapshotAgeMs, players }` for testing.
- Keep fallbacks/guard in step with the new Menu/Hud/types members.

## As built (where the code differs from, or adds to, the text above)

- **Transport.**
  - `GuestPing` carries an optional `rtt` (the guest's own smoothed round trip), which is how the host's
    `PeerLink.rttMs` gets a value. Ping, pong and bye never reach `onMessage`; a guest `bye` becomes
    `onDisconnect`, a host `bye` becomes `onClose(reason)`.
  - `onDisconnect` fires only for remote-caused ends, never after the host itself closed the link.
  - PeerJS 1.5.5 makes the "fast" channel unordered but still retransmitting, so late and out-of-order
    snapshots are normal and the guest drops stale ones by `t`.
  - `joinHost` resolves once "rel" is open and "fast" is open or 3 s have passed (then `sendFast` uses rel).
  - A wrong code takes about 5 s to fail (the cloud server's own expiry).
- **Slots.** A guest's slot IS its boat id, so slots never have gaps. When a guest leaves the lobby (or a
  rematch is built after a leaver), the guests above move down and the host re-sends `welcome` with the new
  slot before the next `lobby`/`start`. A guest who leaves mid-match stays on the water, parked, until the next
  match is built.
- **`viewport` inside the Match is a human SLOT.** Everything the Match, its players and its modes hand to
  `hud.announce/hint` as `viewport` is a human slot. Online, the `TapHud` wrapper (`modes/netcapture.ts`)
  turns it into a local viewport or an event with `to`; offline the raw Hud is used and slot == viewport.
  `Match.sfxAt(x, z)` aims a sound at a place (`at` on the event). A Shark bump sends a `hit` event too.
- **Hud extras.** `showPause(..., opts?: { title, resumeLabel, quitLabel })` (a guest's "Leave the game?") and
  `showResults(..., opts?: { waiting, menuLabel, lost })` are in the `Hud` type.
- **Session extras.** `GuestSession` also has `rttMs` and `snapshotAgeMs` (-1 before the first snapshot), and
  `HostSession` has `rttMs` (the slowest guest); the app reads them for `__foam.net`. `GuestView` also has
  `pushSnapshot/pushEvents/noteState` (used by guest.ts only), so the app must keep the view `createView`
  returned.
- **Pause and blur online.** The host's Pause mirrors `state` to the guests; a guest's Pause only opens the
  "Leave the game?" box (its touch Pause button stays up while the host has paused). No blur auto-pause.
- **Not done:** no spectating or late join (a started game turns joiners away), no kick, no ready toggles, no
  "Reconnecting..." on the host, no client-side prediction beyond extrapolating the own boat by 0.15 s.

## Verification the orchestrator will run

Two browser tabs, both `?mute=1`: one hosts (`__foam`), one joins with the code. Check:
- the lobby syncs;
- a match starts on both;
- the guest's controls move its boat on the host;
- snapshots move everything on the guest;
- darts, hits, pops, sharks and results work in all 5 modes;
- the host leaving or the guest leaving is handled.
