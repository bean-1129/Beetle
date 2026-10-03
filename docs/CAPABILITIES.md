# What Beetle builds today

Written 2026-10-03 15:31 CDT. This is the honest capability statement: what the engine's mechanic library contains, what a request outside it turns into, and what is not built yet. Beetle never writes game code from a prompt. The local model picks from the library below, fills the parameters, and when the request asks for something the library does not have, it builds the closest playable game and says so in the title or summary.

Contract sources: `GAME_MODES`, `BIOMES`, `TERRAINS`, `DECORATION_TYPES` and `STREAMING` in packages/contracts/src/limits.ts; controller buttons in packages/contracts/src/protocol.ts; patch ops in packages/contracts/src/patch.ts. Measured mapping quality is in docs/RESULTS.md "Game modes from one prompt" (out-of-library requests table).

## What Beetle builds today

| Mechanic | How to ask for it | What the player does |
|---|---|---|
| Relic hunt (`relic_hunt`) | "a relic hunt", "find the crystals and open the temple" | Walks the world, collects relics, brings them to the gate; the gate opens once enough relics are held |
| Time trial (`time_trial`) | "against a two minute clock", "a 60 second time trial" | The relic hunt against a timer; the round is lost when the clock runs out |
| King of the hill (`king_of_the_hill`) | "king of the hill, hold ten seconds", "tag", "capture the flag" | Reaches the hill zone and stays in it; the first player to hold it for the set time wins |
| Checkpoint race (`checkpoint_race`) | "a race through three checkpoints", "a racing game" | Runs through the checkpoints, in order by default, then the gate |
| Survival (`survival`) | "the flood is coming", "rising lava", "zombie survival" | Grabs a relic and reaches the gate while the water or lava rises; bridges go under once it passes them |
| Five biomes | "snowy", "desert", "at night", "volcanic", "a garden" (snow is frost, sand is desert, dark is night, lava is volcanic) | Plays the same rules under a different look: garden, volcanic, frost, desert, night |
| Two terrains | "floating islands over lava" for islands; "one big valley", "rolling hills", "a continuous landscape" for ground | Islands: platforms over water or lava, crossed by bridges, with a fall if you step off. Ground: one landmass, zones are plateaus joined by paths, nothing to fall into, the player slides along plateau edges |
| Eleven decoration types | "a temple to the north", "a dense forest", "ruins and statues" | Sees and walks around scenery: tree, rock, lantern, pillar, bush, shrine, tower, ruin, crystal, mushroom, statue. Decorations are scenery, not opponents |
| Movement | "fast players", "slow the players down" (speed 3 to 7 m/s) | Walks with the stick, holds sprint to run (1.35x), holds the precision button to walk at half speed |
| Pings and emotes | Always on, no request needed | Drops a team beacon on the shared screen (shown for 3 s) or waves (1.5 s) |
| Streaming world | Always on unless the director unticks "Grow the world as players explore" | Walks toward an edge with nothing beyond it; one or two more zones are built ahead and joined to the world without a reset |
| Live validated edits | Type any change while people play: "turn the water into lava", "make it a 60 second time trial", "add a bridge to the north" | Keeps playing; positions, collected relics and score survive; an edit that would break the game is refused and repaired before anyone sees it |
| **Beetle 2D (studio at `/2d`, genres from `GENRES` in apps/web/src/studio2d/spec/types.ts, entities in spec/kit.ts, levels in world/*.ts)** | Pick "2D game" on the landing page or open `/2d` and type a sentence | Plays a 2D game in the browser studio; not measured yet (docs/RESULTS.md has no 2D run) |
| 2D platformer (`platformer`) | "a cave platformer with bats", "like Mario" | Runs and jumps across chunk-stitched levels with moving, crumbling and spring platforms, spikes, checkpoints, breakable blocks, walkers, flyers, turrets and a boss; collects seeds and gems, reaches the goal; lives |
| 2D runner (`runner`) | "an endless runner", "run and jump over gaps" | Runs through stitched chunks, jumps gaps and hazards; distance and score; lives |
| 2D top-down adventure (`top-down`) | "a dungeon crawl", "explore rooms and find the key" | Walks rooms and corridors (space partitioning, wave function collapse interiors), avoids chasing enemies, turrets and timed spikes, finds the key, opens the door, reaches the portal; health |
| 2D arena shooter (`arena`) | "a twin-stick arena", "survive the swarm" | Fights enemies from spawner nests and a boss in an arena; wins when all are defeated; health and timer |
| 2D puzzle (`puzzle`) | "a crate pushing puzzle", "sokoban with keys" | Pushes crates onto pressure plates to open gates, uses keys on locked doors; every room is generated backwards from its solution and checked by an exact solver |
| 2D physics builder (`builder`) | "build a bridge to the goal", "place planks and fans" | Places planks, springs, fans and blocks within a parts budget to get to the goal; each level is proven solvable by simulating the real engine |
| 2D lane defense (`defense`) | "defend the lawn", "plants against zombies" | Places producers, shooters and blockers on lanes against waves that march left; loses if one reaches the base; currency and waves |
| 2D scripted games (outside the seven genres) | "Tetris", "Pong", "snake", "a rhythm game" | Well-known ideas start from hand-written Studio2D Script templates (block drop, paddle duel, invaders, asteroids, whack-a-mole, memory pairs, highway racer, catcher, 2048, snake, breakout; samples/scripts.ts); otherwise the local model writes the game in Studio2D Script. The code is statically checked, smoke-tested in a sandboxed frame with no network and repaired on error; this is the one place Beetle writes game code from a prompt |
| 2D changes in words and export | "make the jumps higher", "add a boss"; the export button | A natural-language patch is planned, validated and applied to the spec; the game exports as one HTML file with art inlined and the network blocked |

## What it maps instead

When a request needs something the library does not have, Beetle builds the closest playable mechanic and the title or summary says what it became in plain words. Measured on 7 out-of-library requests: 5 committed, 2 failed on geometry, and the title named the mapping in most but not all cases (docs/RESULTS.md "Out-of-library requests").

| Request type | What you get | Why |
|---|---|---|
| Shooting ("shoot walking trees", "a shooter") | A relic hunt in a dense forest where the trees are scenery; the title says it is a relic hunt | There is no projectile, aim or hit mechanic; collecting is the closest action the engine has |
| Enemies, monsters, zombies | Survival: reach the gate while the hazard rises; zombies, if named, are the theme, not moving opponents | There are no AI-driven characters; the rising hazard is the engine's only threat |
| Combat, fighting, stickman fights | King of the hill: hold the zone longer than the other player | There is no health, damage or attack; contesting a zone is the closest two-player conflict |
| First-person view | The shared third-person view on one display, followed by a cinematic camera that frames both players | The display is one shared screen for two players and phones are controllers; there is no per-player camera |
| Vehicles, racing cars, karts | A checkpoint race on foot, with sprint | There is no vehicle physics or mount |
| Building, crafting, placing blocks | A world the designer edits live from the director panel; players do not build | Players have no place or build input; only validated director edits change the world |
| Inventories, items, power-ups | Relics as the only carried items | Relics are the only inventory the engine tracks |
| Platformers ("like Mario", "like Red Ball") | A time trial or checkpoint race across islands or ground | There is no jump; height changes are plateaus and paths, and the challenge is route and clock |
| Tower defense, strategy, card games | King of the hill on the closest map | There are no units or turns; observed once as a king of the hill that then failed on geometry (docs/RESULTS.md O2) |

## Roadmap, in order of value (none of these is done)

1. Enemies and simple combat: moving opponents with a health rule, so "shoot walking trees" and "zombie survival" can mean what they say. Not done.
2. Per-player views: a split or per-phone camera, so a first-person or over-the-shoulder request has a real answer. Not done.
3. Vehicles: a mount with its own movement rule for racing requests. Not done.

## Status of the terrain types at the time of writing

The `terrain` field (`islands` or `ground`, absent means `islands`), the `set_terrain` patch op and the ground movement rule (plateau edges block and the player slides) are in the tree at 15:31 CDT. The ground renderer and the model prompt that chooses terrain from the brief are owned by the web and agent owners; no ground world is measured in docs/RESULTS.md yet. See docs/ARCHITECTURE.md "Terrain types".
