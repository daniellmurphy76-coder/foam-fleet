# Foam Fleet

Toy speedboats with foam-dart blasters, racing and battling around a tropical lagoon.
1 or 2 players on one computer (split screen), plus computer boats.

## Start the game

```bash
npm install
npm run dev
```

Then open http://localhost:5180 in Chrome or Edge. Press **F11** for full screen.

## Modes

- **Dart Battle**: tag other boats with foam darts. Every hit is a point. Most points when the clock runs out wins.
- **Buoy Race**: drive through the numbered gates in order. Hitting a boat makes it wobble and slow down.

Grab the floating **?** crates for power-ups: **Triple Shot**, **Rapid Fire**, **Shield**, **Turbo**.

## Controls

| | Player 1 | Player 2 | Gamepad |
|---|---|---|---|
| Drive | W A S D | Arrow keys | Left stick + RT / LT |
| Fire | Space | Enter | A or RB |
| Boost | Left Shift | Right Shift | B or LB |
| Pause | Esc or P | Esc or P | Start |
| Mute | M | M | Back |

With one gamepad and two players, Player 2 gets the gamepad. With two gamepads, each player gets one.

## Make it yours

- **`src/config.ts`** has every number that matters, written in plain English: boat speed, dart
  speed, how many darts a blaster holds, how long a battle lasts, how wobbly the bots' aim is,
  boat colors, and bot names. Change one, save, and the game reloads by itself.
- **`DESIGN.md`** is the full plan for how the game works, module by module.

| Folder | What lives there |
|---|---|
| `src/world/` | Water, sky, islands, the giant duck, race gates, power-up crates |
| `src/entities/` | The boats: how they look, drive, bob on waves, and shoot |
| `src/combat/`, `src/fx/` | Darts in flight, darts stuck to boats, splashes, confetti |
| `src/ai/` | How computer boats think |
| `src/input/` | Keyboard and gamepad |
| `src/ui/`, `src/audio/` | Menus, scoreboard, sounds, music |
| `src/game/` | The game loop, battle and race rules, cameras, split screen |

## Testing shortcuts

- `?quick=battle&humans=2&bots=3` skips the menu (`quick=race` for a race; `difficulty=easy|normal|hard`).
- `?fps=1` shows the frame rate.
- In the browser console, `__foam.snapshot()` shows the game state, `__foam.timeScale = 4`
  fast-forwards, and `__foam.autopilot = true` lets the computer drive your boat.
