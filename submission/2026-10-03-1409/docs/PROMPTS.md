# Live run prompts

Fresh, non-fixture prompts for the live run record (`scripts/run-prompts.ts`, results in `docs/RESULTS.md` and `data/prompt-runs/`).
All prompts stay inside the supported capabilities: 4 to 8 circular islands, straight bridges, water or lava hazard,
decorations (tree, rock, lantern, pillar, bush, shrine), moving relics, retitling. No enemies, no jumping, no new mechanics.

They are deliberately different from the fixture world `garden5` (centre hub plus four compass islands, temple to the
north, water, one wide and one narrow route) and from the two demo prompts in the runbook
("Turn the water into lava and add a bridge to the northern island..." and "Remove the only bridge to the temple...").

"Expected validator behaviour" is what the world validator should do when the model produces the literal change asked for.
The model may do something else (for example combine the removal and the replacement in one patch, so no failure is
observed); the run record keeps whatever actually happened.

## Briefs (kind `brief`, sent with `authorizeNewWorld: true`)

| Id | Prompt | Expected validator behaviour |
|---|---|---|
| B1 | Four islands arranged in a diamond with water below. Both spawns on the west island, the gate on the east island, one relic each on the north, south and west islands. Bridge every island to its two ring neighbours so there are two ways round. Title it "Diamond Pond". | should pass (possible first-draft ISLAND_OVERLAP or BRIDGE_LENGTH, then repair) |
| B2 | A chain of six small islands running from the south-west corner to the north-east corner, each linked to the next by one bridge, lava below. Spawns on the first island, the gate on the last, relics on the second, fourth and fifth islands. A few rocks and bushes at the edges, never on the bridge mouths. Title it "Ember Chain". | should pass (possible first-draft BRIDGE_LENGTH if islands are spaced too far, then repair) |
| B3 | Seven islands in a ring around an empty centre with no island in the middle, water below. Each island is bridged only to its two ring neighbours. Spawns on the southern island, the gate on the northern island, three relics on three different islands spread around the ring. One shrine on each relic island. | should pass (possible first-draft ISLAND_OVERLAP on a tight ring, then repair) |
| B4 | Eight islands on a two by four grid, lava below, bridges forming a ladder: every island joined to its grid neighbours. Spawns on the bottom-left island, the gate on the top-right island, relics in three different grid cells away from the spawn. A pillar on each corner island. | should pass (possible first-draft ISLAND_OVERLAP, then repair) |
| B5 | Two separate starting islands far to the east and far to the west, one spawn on each, both bridged to a shared middle island that holds the gate. Three relics on three outlying islands to the north and south of the middle, each reachable by its own bridge. Water below and trees on the starting islands. | should pass (possible first-draft UNREACHABLE_RELIC if an outlying island is left unbridged, then repair) |
| B6 | Six islands with lava below. A main causeway of four islands running west to east joined by wide bridges, and two side islands hanging off the second and third causeway islands by narrow bridges. Spawns on the west end, the gate on the east end, relics on both side islands and on the third causeway island. Bushes and rocks away from the bridge mouths. Title it "Ember Causeway". | should pass (possible first-draft GATE_HIDES_RELIC if a relic is put behind the gate, then repair) |

## Edits (kind `edit`), applied in order on the running world

The live run starts the server with `BEETLE_START_WORLD=fixture`, so E1 is applied to `garden5` and each later edit sees
the result of the one before it. Expected codes are derived from the fixture geometry (east island at (24,0) r7, west at
(-24,0) r7, south at (0,-26) r7, temple at (0,28) r8, hub at (0,0) r9, gate at the mouth of the only temple bridge).

| Id | Prompt | Expected validator behaviour |
|---|---|---|
| E1 | Add a second route: a 3 metre wide bridge from the Orchard Island in the east straight to the Lantern Island in the south, and retitle the world "Orchard Loop". | should pass (bridge length about 21 m, no third island on the line) |
| E2 | Remove the narrow western bridge, but keep the Moon Relic collectable. | should initially fail with UNREACHABLE_RELIC (relic-west); repair adds a replacement crossing to the west island, for example from the south island |
| E3 | Move the Sun Relic onto the Temple Island, right beside the shrine. | should initially fail with GATE_HIDES_RELIC (the locked gate blocks the only temple bridge mouth); the repair has to put the relic on another island or the request fails honestly |
| E4 | Plant a ring of six bushes around the edge of the Hearth Island, well clear of the four bridge mouths, and add one lantern next to each spawn. | should pass (possible first-draft UNREACHABLE_RELIC or UNREACHABLE_SPAWN if a bush lands on a bridge mouth or a spawn, then repair) |
| E5 | Make the fall deadly: the hazard beneath the islands becomes lava. Rename the world "Ember Garden" to match. | should pass (set_hazard plus set_title; platforms untouched) |
| E6 | Add a straight bridge from the Orchard Island in the east directly across to the Mossy Island in the west. | should initially fail with BRIDGE_CROSSES_ISLAND (the line passes through the Hearth Island); a straight bridge cannot be routed around, so the honest outcome is a failed request or a repair that changes the plan |

## Running

```
export PATH=/home/dell/Beetle/.tools/node/bin:$PATH
npx tsx scripts/run-prompts.ts                      # all edits, then all briefs
npx tsx scripts/run-prompts.ts --only edits         # E1..E6
npx tsx scripts/run-prompts.ts --ids E1,E2,B1       # a subset, in the given order
npx tsx scripts/run-prompts.ts --prompt "..." --kind edit --repeat 3
```

The runner expects a running server (`BEETLE_SERVER_URL`, default `http://127.0.0.1:7700`) with a connected agent worker,
and the director token from `BEETLE_DIRECTOR_TOKEN` or `data/secrets.json`. Every attempt, including failures and
timeouts, is written to `data/prompt-runs/run-<unix ms>.json`.
