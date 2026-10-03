# Foam Fleet

Toy speedboats with foam-dart blasters, racing, battling, popping balloons and scaring off goofy cartoon sharks
around a tropical lagoon. 1 or 2 players on one computer (split screen), or 2 to 4 players on different devices
over the internet, plus computer boats.

## Start the game

```bash
npm install
npm run dev
```

Then open http://localhost:5180 in Chrome or Edge. Press **F11** for full screen.

### Open it on the web (iPad, any computer)

Play it at **https://daniellmurphy76-coder.github.io/foam-fleet/**

Every push to `main` builds the game and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`). Open the Pages address in Safari or Chrome; no install needed.

### On the iPad

1. Open the link above in **Safari**, with the iPad held sideways (landscape). Held upright, the game asks
   you to turn it.
2. For a full-screen game with no browser bars: tap **Share**, then **Add to Home Screen**, then **Add**.
   Open **Foam Fleet** from the Home Screen like any app.
3. Fingers only, no keyboard needed. The on-screen controls appear as soon as you touch the screen:
   - **Left thumb: steer.** Put a thumb anywhere on the left half and drag. Up goes, down brakes, left and right
     steer. The stick appears under your thumb.
   - **Right thumb: FIRE and BOOST.** The big orange button fires (hold it to keep firing) and the yellow one is
     a boost. The small **HONK** and **RESCUE** buttons sit just above them.
   - **II** (top left) pauses. Pause, results and every menu are plain taps.
   - Two players share the iPad: Player 1 on the left, Player 2 on the right, each with their own stick and
     buttons. Everything works with several fingers at once.
4. Sound starts after your first tap (Safari insists on that). The **Sound** button on the title screen turns
   it off.

A keyboard or Bluetooth gamepad still works exactly as on a computer. Pressing a key or a gamepad button hides
the touch layout, and touching the screen brings it back.

## Play online

Two to four people, one player on each device (a laptop and an iPad, or two houses), can play together in any
mode: Dart Battle, Buoy Race, Team Up, Balloon Pop or Boats vs. Sharks. Everybody opens the same game address
(see "Open it on the web" above). It needs the internet; no accounts, no chat.

1. **Host:** on the title screen tap **Play Online**, then **Host a game**. A four-letter code appears (for
   example **DUCK**). Read it out to your friends. The code never has an I, L or O, so it is easy to say.
2. **Everyone else:** tap **Play Online**, then **Join a game**, and type the code. Use the letters on the screen
   (touch, mouse or gamepad) or a keyboard. A link ending in `?join=DUCK` opens the Join screen with the code
   already typed.
3. **In the lobby:** everybody picks a name, boat color, boat and Easy Driving. The host picks the game, the
   computer boats and the length, and taps **Start!** once at least one friend has joined. A game that has
   started can't be joined, so wait for everybody first.
4. **Play:** each player drives their own boat on their own screen. After the match the host can tap
   **Rematch** or go back to the **Lobby**, where more friends can join.

Good to know:

- The game runs on the host's device and everyone else watches it live, so the host should have the faster
  device and keep the game window open and in front. Online games never pause when a window loses focus.
- The host's **Pause** pauses the game for everybody. A friend's **Pause** only asks "Leave the game?" while the
  game goes on. If a friend leaves, their boat stops and everybody sees "Sam left the game". If the host leaves,
  everybody goes back to the title screen.
- The first connection can take a few seconds. A wrong code answers "No game with that code. Check the letters!"
  after about five seconds. The free connection service (PeerJS) can occasionally be slow or busy: if a game
  will not connect, wait a moment and try again, or play on the same Wi-Fi.
- Every device uses its own keyboard, gamepad or touch controls, and its own sound settings, exactly as offline.

## Modes

- **Dart Battle**: tag other boats with foam darts. Every hit is a point. Most points when the clock runs out wins.
- **Buoy Race**: drive through the numbered gates in order. Hitting a boat makes it wobble and slow down.
- **Team Up**: you (and any friends) plus some helper boats play against the Pirate Pals. Darts pass through your
  own teammates. Every boat scores its own hits, and the team with the most hits when the clock runs out wins.
  A floating diamond over each boat shows its team.
- **Balloon Pop**: no computer boats. Pop all 30 balloons as fast as you can by shooting them or just driving
  through them. Gold balloons are worth 3 points. With two players, the most points wins.
- **Boats vs. Sharks**: everybody is on one team (you, a friend, and 0 to 3 helper boats) against the sharks.
  Five waves of sharks swim in from the edge of the lagoon (3, 5, 7, 9 and 11 sharks), then the big purple
  **MEGA SHARK** arrives wearing a captain's hat. Every dart that tags a shark scares it off and scores a point
  for the shooter. The MEGA SHARK takes 12 darts, and the dart that finishes it is worth 5 extra points. Every
  shark bump pops one of the team's 12 life rings (a MEGA SHARK bump pops 2, and a Shield soaks a bump up).
  Scare off the MEGA SHARK to win. Lose every ring and the sharks win this time. The setup screen has
  **Helper boats** (0 to 3) and **Shark speed** (Slow, Normal, Fast). There is no clock; the timer counts up.

**Sharks in every game.** Friendly cartoon sharks cruise the lagoon in every mode (3 in Dart Battle and Team Up,
2 in Buoy Race and Balloon Pop). Now and then one gets curious and chases a boat, and a bump makes the boat
wobble (nobody loses points outside Boats vs. Sharks). Dart one to send it on a comic flip and dive; it comes
back after a while. In Balloon Pop the sharks never chase or bump, they just swim around. The blaster's aim
assist locks onto a shark when no boat is in the way, and the reticle names it ("Shark" or "MEGA SHARK").

Grab the floating **?** crates for power-ups: **Triple Shot**, **Rapid Fire**, **Shield**, **Turbo**.

## Easy Driving

Every player has an **Easy Driving** switch on the setup screen, and it starts **ON**. The boat cruises by
itself, turns gently (no twitching, no drifting), steers itself away from islands and the lagoon edge, and glides
along a shore instead of bouncing off it. If it gets stuck for a few seconds it rescues itself. Switch it OFF
for the full-speed, do-it-yourself handling.

## Boat Garage, Trophy Shelf and mini-map

- **Boat Garage** (on each player's card in setup): pick a boat (Zippy, Tuggy, Twin or the **BoneBoat**, a boat
  built from a friendly shark skeleton), paint (solid, stripes, flames, dots, shark teeth), a hat, a flag, a
  horn (try "Test horn") and a color, with a live 3D preview. On the BoneBoat the paint colors the rib ends,
  the teeth tips and the glowing eyes.
- **Trophy Shelf** (title screen): 16 trophies per player name, like First Splat, Teamwork and Pop Star.
  Trophies you have not won yet show as grey silhouettes with how to earn them. The four shark trophies are
  **Shark Tamer** (tag 10 sharks in one game), **Shark Snack** (get bumped by a shark), **Mega Hero** (beat the
  MEGA SHARK in Boats vs. Sharks) and **Bone Captain** (play a game in the BoneBoat).
- **Mini-map**: a round radar in the corner of each player's view. Your boat is the big arrow, and the way you
  are facing is up. Sharks show as small dark-grey fins (the MEGA SHARK is bigger and purple).

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
- **Touch** (iPad): see "On the iPad" above.
- Hearing the music or engines twice? The Sound button only silences the page you click in, so another tab or
  window with the game open is still playing. Close the extra one (a tab with a speaker icon is the one making
  noise).

## Make it yours

- **`src/config.ts`** has every number that matters, written in plain English: boat speed, dart
  speed, how many darts a blaster holds, how long a battle lasts, how gentle Easy Driving is, how many
  balloons there are, how wobbly the bots' aim is, team names and colors, boat colors, and bot names. The
  `sharks` section sets how many sharks swim in each game, how fast, how often they chase, the size of each
  wave, the MEGA SHARK's health and the team's life rings. Change one, save, and the game reloads by itself.
- **`DESIGN.md`** is the full plan for how the game works, module by module (v1, the v2 upgrades, then v4:
  Sharks!).

| Folder | What lives there |
|---|---|
| `src/world/` | Water, sky, islands, the giant duck, race gates, power-up crates, balloons, rescue and team spawn spots |
| `src/entities/` | The boats: how they look (hulls, paint, hats, flags, the BoneBoat), drive, bob on waves, and shoot |
| `src/sharks/` | The sharks: how they look, swim, chase, bump, flip and dive, and the Boats vs. Sharks attack waves |
| `src/combat/`, `src/fx/` | Darts in flight, darts stuck to boats, splashes, balloon pops, shark-dive bubbles, honk notes |
| `src/ai/` | How computer boats think (and how helper boats fight sharks) |
| `src/input/` | Keyboard, gamepad and touch (the on-screen stick and buttons), and the Easy Driving helper |
| `src/ui/`, `src/audio/` | Menus, Boat Garage, Trophy Shelf, scoreboard, mini-map, sounds, music |
| `src/game/` | The game loop, battle / race / team / balloon / shark rules, cameras, split screen, rescue, trophies |

## Testing shortcuts

- `?quick=battle&humans=2&bots=3` skips the menu. `quick` can be `battle`, `race`, `team`, `practice`
  (Balloon Pop) or `sharks` (Boats vs. Sharks, where `bots` is the number of helper boats, 0 to 3, and
  `difficulty` is the shark speed). Also `difficulty=easy|normal|hard`, `duration=SECONDS`, `laps=N`.
- `&easy=0` or `&easy=1` turns Easy Driving off or on for every player (it defaults to on).
- `&nopause=1` stops the game pausing when the window loses focus. `&autopilot=1` lets the computer drive
  your boat, and `&timescale=4` fast-forwards.
- `?fps=1` shows the frame rate.
- `?touch=1` turns the on-screen touch controls on for any device (a mouse click then acts like a finger),
  so you can try the iPad layout on a computer. Add it to the address with the others, for example
  `?quick=battle&humans=2&touch=1`.
- `?mute=1` makes that page silent. The Sound button and the **M** key do nothing there, and nothing is saved,
  so the family's own Sound setting is never changed. Use it on every test page.
- Online testing: open two windows side by side (not two tabs in one window: a tab in the background runs slowly),
  both with `?mute=1`. In the first, run `await __foam.online.host()` in the console (it returns the code); in
  the second, `await __foam.online.join('DUCK')`, then `__foam.online.start({ mode: 'battle' })` in the first.
  `__foam.net` shows the role, code, slot, round-trip time and snapshot age, and `__foam.online.leave()` leaves.
  `?join=DUCK` opens the Join screen with the code typed in.
- In the browser console, `__foam.snapshot()` shows the game state (boats, teams, balloons left, the sharks and
  the Boats vs. Sharks wave and life rings, what each human has done so far), `__foam.timeScale = 4` fast-forwards, `__foam.autopilot = true` lets the computer
  drive your boat, and `__foam.start({ mode: 'team', bots: 3 })` starts a match.
