# Competitive framework: Beetle against one-prompt game generators

Written 2026-10-03 14:18 CDT. This is a comparison framework, not a scorecard. The category column describes
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
| One prompt to playable | Yes, this is the category's defining feature. Typical time: not verified offline. | Yes. Fresh brief to a committed, validated world: 14 s once on a quiet GPU in direct mode (docs/RESULTS.md run 3 stack); 26.2 / 26.5 / 27.7 s min / p50 / max warm when the first draft is valid (data/benchmarks, docs/MODEL_SELECTION.md 4.2); 33.4 s to v1 through real OpenClaw tool calls (docs/RESULTS.md 14:08 CDT). The 10 s target is not met. Any requested game is mapped onto the closest supported mode and biome and the agent says which (today's contract; mapping quality not yet measured, see "Mode library breadth"). |
| Edit while people play, without a reset | Typically no: an edit is a new build and the session restarts. Not verified per vendor. | Yes. Acceptance run 2: two controllers walking the whole time, the request committed in 8.0 s, world version +1, hazard swapped to lava, new bridge added, collected relic and score unchanged, both sockets open, max tick gap 67 ms, 15 of 15 checks (docs/ACCEPTANCE.md). Six fresh edits: 5 of 6 committed in 2.0 / 8.0 / 14.0 s (docs/RESULTS.md run 3). Undo through the same validated path (v7 to v8, docs/RESULTS.md). Measured with scripted WebSocket controllers; physical phones not yet run (BUILD_STATUS.md). |
| Deterministic validation and repair before publish | Typically not a separate step; the model's output is the build. Not verified per vendor. | Yes. Validation is game code (schema, references, geometry, bridge sockets, walk field, reachability with the gate locked, occupied support at commit). DISCONNECTED_GOAL refused at 1.7 s and the repaired patch committed at 3.0 s on the fixture world; 6 of 12 edit attempts across runs 2 and 3 had an invalid candidate refused; invalid worlds committed: 0 (docs/RESULTS.md). Deterministic normalization lifted corpus validity from 2 of 30 to 13 of 30 (docs/MODEL_FAILURE_MODES.md). Repairs are bounded (2 attempts) and a failed request leaves the world untouched. |
| Local-first inference | Typically cloud-hosted. Not verified per vendor. | Yes by configuration: Ollama on 127.0.0.1:11434, qwen3.5:4b Q4_K_M, no cloud fallback host exists in the code (docs/LOCAL_ONLY_CHECKLIST.md, BUILD_STATUS.md case 15). The egress-blocked rehearsal is not run yet: only a "before" record exists (docs/OFFLINE_PROOF.md). So: local by construction, offline proof not measured. |
| Phones as controllers | Typically the generated game is played in the browser or app that shows it; a separate controller role is not the category's norm. Not verified per vendor. | Implemented: QR invite, `/controller` page, phones send inputs only, the shared display renders. Verified with the controller page under mobile emulation and with real WebSocket controllers in 23 integration tests (BUILD_STATUS.md case 12). Two physical phones on the LAN: not yet run. |
| Measured latency | Not verified offline. | Loopback, scripted controllers: WebSocket RTT p50 0.48 ms (p95 0.81 ms, n = 400); input to server tick p50 18.79 ms (p95 33.08 ms, n = 200), p50 17.53 ms under 2 x 30 inputs/s (docs/LATENCY.md). Not input to photon: no phone, Wi-Fi hop, browser or display is included. |
| Mode library breadth | Typically open-ended: the model writes the game logic, so the space of games is wide and the depth of any one game varies. Not verified per vendor. | Bounded and growing: 5 engine modes (relic_hunt, time_trial, king_of_the_hill, checkpoint_race, survival), 5 biomes (garden, volcanic, frost, desert, night), 2 hazards (water, lava), movement speed 3 to 7 m/s, a rising hazard, 11 decoration types (packages/contracts/src/limits.ts). Any request outside the library is mapped to the closest mode and biome and the agent says so. Measured mode-from-one-prompt results: not yet measured at the time of writing (the agent owner is appending them to docs/RESULTS.md under "Game modes from one prompt"). |
| Visual fidelity | Varies widely by product. Not verified offline. | Procedural terrain islands, plank bridges, PBR materials with runtime textures, image-based lighting from a procedural sky, bloom, ACES, FXAA, MSAA, SSAO, god rays, glow, PCF shadows, cinematic follow camera; serene and volcanic themes verified in the browser with a 2 s blend on a committed hazard change (README "Presentation", docs/ACCEPTANCE.md). Frame rate was only observed in a software-rendered browser pane (3 to 11 fps high quality, 30 to 36 fps low); the demo GPU at 1920x1200 is not measured (BUILD_STATUS.md). Rendering of the three new biomes (frost, desert, night): not verified. |

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
