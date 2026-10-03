# What Beetle 2D builds today

The honest capability statement. Beetle's local model writes data, never game code: a design document for one of seven genres, or patch operations on an existing game. Sources: `apps/web/src/studio2d/spec/types.ts` (`GENRES`), `spec/kit.ts`, `world/*.ts`, `samples/scripts.ts`, `gen/ai.ts`.

## Genres

| Genre | Ask for it with | What the player does |
|---|---|---|
| platformer | "a platformer", "jump across cliffs" | runs and jumps, stomps patrolling enemies, collects pickups, reaches the flag; optional double jump and boss |
| runner | "an endless runner", "a game like Red Ball" | auto-runs with rising speed, jumps over gaps and enemies |
| top-down | "a dungeon crawler with keys and doors" | explores rooms, finds keys, opens doors, shoots at enemies, reaches the portal |
| arena | "a stickman fight", "survive the waves" | moves and shoots in an open arena against waves |
| puzzle | "a sliding block puzzle", "push crates onto plates" | pushes crates on a grid; every room is generated with a known solution |
| builder | "guide the marble into the basket" | places planks, springs and fans, then releases the ball |
| lane defense | "a tower defense", "plants against zombies" | spends a resource on producer, shooter and blocker units across lanes |

## Every game gets

- Procedural pixel sprites (with simple rigs for animated characters), tilesets and three-layer backgrounds from the theme (hero, enemy, pickup, setting, weather, palette).
- Generated sound effects and music cues.
- Several levels on a beat order (intro, teach, test, twist, finale), each one finished by the bot before it ships.
- A HUD, menus and saved progress per game.
- Plain-word changes: speed, jump height, double jump, enemy speed, weather, palette and other validated parameters.
- Export to a single offline HTML file; save to the in-browser library.

## Outside the genres

| Request | Result |
|---|---|
| A classic game with a shipped template (tetris, pong, space invaders, asteroids, whack-a-mole, memory pairs, racing, catching, 2048, snake, breakout, flappy) | the hand-written template plays, with words from the idea substituted into names |
| Anything else (chess, a fishing game, a rhythm game) | the closest genre, with a message that model-written game code is turned off on this machine |

## Not built

- Model-written game code (off by design).
- Multiplayer, phones, 3D.
- Generated images from an image model; all art is procedural.
- Cloud sync of the library.
