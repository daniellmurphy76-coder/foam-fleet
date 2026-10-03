# Foam Fleet

Toy speedboats with foam-dart blasters, racing, battling and popping balloons around a tropical lagoon.
1 or 2 players on one computer (split screen), plus computer boats.

## Start the game

```bash
npm install
npm run dev
```

Then open http://localhost:5180 in Chrome or Edge. Press **F11** for full screen.

### Play online (iPad, any computer)

Play it at **https://daniellmurphy76-coder.github.io/foam-fleet/**

Every push to `main` builds the game and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`). Open the Pages address in Safari or Chrome; no install needed.

## Modes

- **Dart Battle**: tag other boats with foam darts. Every hit is a point. Most points when the clock runs out wins.
- **Buoy Race**: drive through the numbered gates in order. Hitting a boat makes it wobble and slow down.
- **Team Up**: you (and any friends) plus some helper boats play against the Pirate Pals. Darts pass through your
  own teammates. Every boat scores its own hits, and the team with the most hits when the clock runs out wins.
  A floating diamond over each boat shows its team.
- **Balloon Pop**: no computer boats. Pop all 30 balloons as fast as you can by shooting them or just driving
  through them. Gold balloons are worth 3 points. With two players, the most points wins.

Grab the floating **?** crates for power-ups: **Triple Shot**, **Rapid Fire**, **Shield**, **Turbo**.

## Easy Driving

Every player has an **Easy Driving** switch on the setup screen, and it starts **ON**. The boat cruises by
itself, turns gently (no twitching, no drifting), steers itself away from islands and the lagoon edge, and glides
along a shore instead of bouncing off it. If it gets stuck for a few seconds it rescues itself. Switch it OFF
for the full-speed, do-it-yourself handling.

## Boat Garage, Trophy Shelf and mini-map

- **Boat Garage** (on each player's card in setup): pick a boat (Zippy, Tuggy or Twin), paint (solid, stripes,
  flames, dots, shark teeth), a hat, a flag, a horn (try "Test horn") and a color, with a live 3D preview.
- **Trophy Shelf** (title screen): 12 trophies per player name, like First Splat, Teamwork and Pop Star.
  Trophies you have not won yet show as grey silhouettes with how to earn them.
- **Mini-map**: a round radar in the corner of each player's view. Your boat is the big arrow, and the way you
  are facing is up.

## Controls

| | Player 1 | Player 2 | Gamepad |
|---|---|---|---|
| Drive | W A S D | Arrow keys | Left stick + RT / LT |
| Fire | Space | Enter | A or RB |
| Boost | Left Shift | Right Shift | B or LB |
| Rescue (get unstuck) | R | / | Y |
| Honk | Q | ` ' ` (next to Enter) | X |
| Pause | Esc or P | Esc or P | Start |
| Mute | M | M | Back |

- In a 1-player game every control scheme works at once.
- With one gamepad and two players, Player 2 gets the gamepad. With two gamepads, each player gets one.
- **Rescue** lifts your boat to the nearest open water (3 second wait between uses). Your race progress,
  darts and power-ups are kept.
- With Easy Driving on, hold **W** (or RT, or the up arrow) to go faster than the cruise speed, and **S** to brake.

## Make it yours

- **`src/config.ts`** has every number that matters, written in plain English: boat speed, dart
  speed, how many darts a blaster holds, how long a battle lasts, how gentle Easy Driving is, how many
  balloons there are, how wobbly the bots' aim is, team names and colors, boat colors, and bot names. Change
  one, save, and the game reloads by itself.
- **`DESIGN.md`** is the full plan for how the game works, module by module (v1, then the v2 upgrades).

| Folder | What lives there |
|---|---|
| `src/world/` | Water, sky, islands, the giant duck, race gates, power-up crates, balloons, rescue and team spawn spots |
| `src/entities/` | The boats: how they look (hulls, paint, hats, flags), drive, bob on waves, and shoot |
| `src/combat/`, `src/fx/` | Darts in flight, darts stuck to boats, splashes, balloon pops, honk notes |
| `src/ai/` | How computer boats think |
| `src/input/` | Keyboard and gamepad, and the Easy Driving helper |
| `src/ui/`, `src/audio/` | Menus, Boat Garage, Trophy Shelf, scoreboard, mini-map, sounds, music |
| `src/game/` | The game loop, battle / race / team / balloon rules, cameras, split screen, rescue, trophies |

## Testing shortcuts

- `?quick=battle&humans=2&bots=3` skips the menu. `quick` can be `battle`, `race`, `team` or `practice`
  (Balloon Pop). Also `difficulty=easy|normal|hard`, `duration=SECONDS`, `laps=N`.
- `&easy=0` or `&easy=1` turns Easy Driving off or on for every player (it defaults to on).
- `&nopause=1` stops the game pausing when the window loses focus. `&autopilot=1` lets the computer drive
  your boat, and `&timescale=4` fast-forwards.
- `?fps=1` shows the frame rate.
- In the browser console, `__foam.snapshot()` shows the game state (boats, teams, balloons left, what each
  human has done so far), `__foam.timeScale = 4` fast-forwards, `__foam.autopilot = true` lets the computer
  drive your boat, and `__foam.start({ mode: 'team', bots: 3 })` starts a match.
