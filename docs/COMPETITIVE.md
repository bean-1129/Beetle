# Competitive framework: Beetle against one-prompt game generators

Written 2026-10-03 14:18 CDT; streaming row added and latency row updated 15:15 CDT, streaming row given its measurements 15:28 CDT, "Builds any genre" row added 15:31 CDT (docs/ACCEPTANCE.md, docs/RESULTS.md). This is a comparison framework, not a scorecard. The category column describes
"prompt in, game out" products in general terms; it names no vendor fact that could not be checked offline on this
machine. The user named Thrixel as an example of a one-prompt game builder; nothing specific about Thrixel is claimed
here because none of it can be verified offline. Beetle's column carries only what is verified in docs/RESULTS.md,
docs/ACCEPTANCE.md, docs/LATENCY.md and BUILD_STATUS.md; everything else is marked "not measured".

## The category

A one-prompt game generator takes a short description and returns a playable game. Typical shape of the category:

- Prompt in, game out, usually within a minute or a few minutes, usually as a web build.
- Typically cloud-hosted: the model and often the game run on the vendor's servers, so the prompt and the output leave
  the user's machine.
- Editing is a second prompt that produces a new build. There is typically no way to change the game while a play
  session is running without restarting that session.
- Validation of the generated game is typically whatever the model and the runtime catch; a game that cannot be
  finished is usually discovered by playing it.

Beetle adapts two things from this category on purpose: the one-prompt front door (any game request in plain words)
and instant playable output (the request becomes a world that people can join and play, not an asset pack or a
script). What Beetle adds is everything after the first build: live editing while people play, deterministic
validation and repair before anything is published, local-only inference, and phones as controllers for a shared
screen.

## Framework

| Column | One-prompt game generators (category) | Beetle (verified only) |
|---|---|---|
| One prompt to playable | Yes, this is the category's defining feature. Typical time: not verified offline. | Yes. Fresh brief to a committed, validated world: 14 s once on a quiet GPU in direct mode (docs/RESULTS.md run 3 stack); 26.2 / 26.5 / 27.7 s min / p50 / max warm when the first draft is valid (data/benchmarks, docs/MODEL_SELECTION.md 4.2); 33.4 s to v1 through real OpenClaw tool calls (docs/RESULTS.md 14:08 CDT). The 10 s target is not met. Any requested game is mapped onto the closest supported mode and biome and the agent names the mapping: measured on 18 briefs, the mode was sensible 18 of 18 times and committed mode briefs took 13.0 to 44.1 s in direct mode (docs/RESULTS.md "Game modes from one prompt"; details under "Mode library breadth"). |
| Edit while people play, without a reset | Typically no: an edit is a new build and the session restarts. Not verified per vendor. | Yes. Acceptance run 2: two controllers walking the whole time, the request committed in 8.0 s, world version +1, hazard swapped to lava, new bridge added, collected relic and score unchanged, both sockets open, max tick gap 67 ms, 15 of 15 checks (docs/ACCEPTANCE.md). Six fresh edits: 5 of 6 committed in 2.0 / 8.0 / 14.0 s (docs/RESULTS.md run 3). Undo through the same validated path (v7 to v8, docs/RESULTS.md). Measured with scripted WebSocket controllers; physical phones not yet run (BUILD_STATUS.md). |
| Deterministic validation and repair before publish | Typically not a separate step; the model's output is the build. Not verified per vendor. | Yes. Validation is game code (schema, references, geometry, bridge sockets, walk field, reachability with the gate locked, occupied support at commit). DISCONNECTED_GOAL refused at 1.7 s and the repaired patch committed at 3.0 s on the fixture world; 6 of 12 edit attempts across runs 2 and 3 had an invalid candidate refused; invalid worlds committed: 0 (docs/RESULTS.md). Deterministic normalization lifted corpus validity from 2 of 30 to 13 of 30 (docs/MODEL_FAILURE_MODES.md). Repairs are bounded (2 attempts) and a failed request leaves the world untouched. |
| Local-first inference | Typically cloud-hosted. Not verified per vendor. | Yes by configuration: Ollama on 127.0.0.1:11434, qwen3.5:4b Q4_K_M, no cloud fallback host exists in the code (docs/LOCAL_ONLY_CHECKLIST.md, BUILD_STATUS.md case 15). The egress-blocked rehearsal is not run yet: only a "before" record exists (docs/OFFLINE_PROOF.md). So: local by construction, offline proof not measured. |
| Phones as controllers | Typically the generated game is played in the browser or app that shows it; a separate controller role is not the category's norm. Not verified per vendor. | Implemented: QR invite, `/controller` page, phones send inputs only, the shared display renders. Verified with the controller page under mobile emulation and with real WebSocket controllers in 23 integration tests plus the five-mode integration test, 5 of 5 (BUILD_STATUS.md case 12 and tests/integration/modes.test.ts). Two physical phones on the LAN: not yet run. |
| World streams in as players move | Typically the whole game is generated before anyone plays; growing the level around players during a session is not the category's norm. Not verified per vendor. | Yes, measured, slower than a typed edit and less reliable. With streaming on, the brief builds only the zone around the spawn (the streaming brief rule asks for 2 to 4 islands); when an active player stands within 4 m of an island rim with no crossing within 45 degrees, the server opens an automatic extension request (at most one in flight, at least 12 s apart) and the agent answers with `add_island`, 1 to 2 islands each bridged from an anchor, validated and committed like any edit. Hard stop at 24 islands and 48 bridges; the director can switch it off (apps/server/src/expansion.ts, packages/agent/src/expansion-prompts.ts, packages/contracts/src/limits.ts `STREAMING`). Acceptance (docs/ACCEPTANCE.md streaming section, three runs, GPU contended by about nine other workers): 4 of 6 extensions committed, request to commit 10.6 to 65.9 s; 1 failed schema validation after its repair and 1 hit the 80 s model timeout, both leaving the world untouched; run 3 passed 21 of 21 (56.0 s and 10.6 s, player, relic and score kept, position jump 0.15 m, player walked onto both new islands). Trigger to request: under 0.3 s in 5 of 6. Quiet GPU, once: 9.5 s (docs/RESULTS.md 15:16 CDT). Tested: 18 streaming tests in packages/world, 10 expansion tests in the server (BUILD_STATUS.md). Not measured: spawn-zone brief time, repeated extensions on a quiet GPU, tick gaps while an extension commits. |
| Measured latency | Not verified offline. | Loopback, scripted controllers: WebSocket RTT p50 0.46 ms (p95 0.74 ms, n = 100); input to server tick p50 0.78 ms (p95 1.15 ms, n = 120) idle, p50 0.68 ms and p95 12.33 ms under 2 x 30 inputs/s (docs/LATENCY.md, run of 15:26 CDT, data/latency/latency-1791059205014.json). Not input to photon: no phone, Wi-Fi hop, browser or display is included. |
| Mode library breadth | Typically open-ended: the model writes the game logic, so the space of games is wide and the depth of any one game varies. Not verified per vendor. | Bounded and growing: 5 engine modes (relic_hunt, time_trial, king_of_the_hill, checkpoint_race, survival), 5 biomes (garden, volcanic, frost, desert, night), 2 hazards (water, lava), movement speed 3 to 7 m/s, a rising hazard, 11 decoration types (packages/contracts/src/limits.ts). Any request outside the library is mapped to the closest mode and biome and the agent names the mapping in the title (10 of 14 final-prompt briefs did). Measured (docs/RESULTS.md "Game modes from one prompt", 14:25 to 14:42 CDT, direct mode): mode sensible on 18 of 18 briefs, exact mode missed twice; biome written 10 of 14 with the final prompt (desert never written); committed briefs 13.0 to 44.1 s, 8 of 14 final-prompt attempts committed, all failures geometry, MODE_INVALID never fired; mode and biome edits on a running world 3.0 s each; out-of-library requests (Red Ball 5, stickman fight, Mario with lava, zombie night, capture the flag) committed as time trial, king of the hill, time trial, survival and king of the hill. |
| Builds any genre | Typically yes in principle: the model writes the game logic, so a shooter or a racer can be attempted directly; how often the result is playable is not verified per vendor. | Partly, and says so. Any request is built within the mechanic library (5 modes, 5 biomes, 2 terrains, 11 decoration types, sprint and precision walk, pings and emotes, streaming, live validated edits) and mapped with a stated mapping: shooting, enemies, combat, first-person, vehicles, building and inventories beyond relics are not in the library, so such a request becomes the closest playable mechanic and the title or summary says what it became ("shoot walking trees" becomes a relic hunt in a dense forest where the trees are scenery). Measured mapping quality (docs/RESULTS.md "Game modes from one prompt", direct mode): mode sensible on 18 of 18 briefs, 5 of 7 out-of-library requests committed (2 failed on geometry), titles named the mapping in 10 of 14 final-prompt briefs. Not done: enemies and combat, per-player views, vehicles (docs/CAPABILITIES.md). |
| Visual fidelity | Varies widely by product. Not verified offline. | Procedural terrain islands, plank bridges, PBR materials with runtime textures, image-based lighting from a procedural sky, bloom, ACES, FXAA, MSAA, SSAO, god rays, glow, PCF shadows, cinematic follow camera; serene and volcanic themes verified in the browser with a 2 s blend on a committed hazard change (README "Presentation", docs/ACCEPTANCE.md). Frame rate was only observed in a software-rendered browser pane (3 to 11 fps high quality, 30 to 36 fps low); the demo GPU at 1920x1200 is not measured (BUILD_STATUS.md). Of the three new biomes, frost was verified in the browser on the hill fixture (32 fps in the software pane, BUILD_STATUS.md renderer row); desert and night presets are implemented with no separate browser check recorded. |

## How to read the Beetle column

- "Yes" means a measured run exists in the named file. "Implemented" means code and automated tests exist but the live
  measurement does not. "Not measured" means exactly that; no estimate is substituted.
- Every timing names its GPU state because the Ollama daemon was shared with other owners for most of the day
  (docs/MODEL_SELECTION.md section 2). Quiet-GPU numbers are the ones above; contended drafts took 58.8 to 214.1 s.
- Direct-mode numbers are labelled `[direct]` in every report. OpenClaw mode is verified end to end against the real
  server (edit v2 in 20.0 s, brief v1 in 33.4 s, gated test 38.9 s; docs/RESULTS.md, BUILD_STATUS.md case 17).

## What Beetle does not claim

- No claim about any named vendor's speed, price, hosting, validation or editing model: none of it was verified
  offline.
- No claim that Beetle's game space is as wide as a code-writing generator's: Beetle maps requests onto a bounded mode
  library and says so.
- No market size, pricing, traction or speed-up percentage (docs/PITCH_OUTLINE.md slide 6).
