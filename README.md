# Beetle

Any game, one prompt, then keep changing it while they play.

Beetle turns any game request into a playable 3D game inside a growing library of engine mechanics, then lets the designer change it live while people play. A designer types a brief ("king of the hill on a frozen arena, hold ten seconds", "a relic hunt across lava islands against a two-minute clock"); a local model maps the request onto the closest supported game mode and biome, says which it chose, and composes a playable world; two people join from their phones; the designer keeps editing the mode, the biome, the bridges, the hazard and the pace while they play. Every change is validated by deterministic game code, repaired by the agent when it fails, and committed as a new world version without disconnecting anyone or resetting progress.

Everything runs on one machine. Model inference is Ollama on loopback. The agent runtime is OpenClaw with Beetle-specific tools, verified live against the real server; a clearly labelled in-process direct harness is the fallback and is named `[direct]` in every report it produces. There is no cloud fallback. For how Beetle relates to one-prompt game generators, see docs/COMPETITIVE.md.

## Layout

| Path | Purpose |
|---|---|
| apps/web | director, shared display and phone controller pages (React, Vite, Babylon.js) |
| apps/server | HTTP and WebSocket server, authoritative 30 Hz simulation, world transactions |
| packages/contracts | zod schemas, limits (modes, biomes, hazards, decorations), validation codes, protocol, routes |
| packages/world | world compiler, walk field, nav grid, validators, playability checks, patches, model-output normalization |
| packages/agent | OpenClaw tool plugin, agent worker, Ollama client, labelled direct harness, SMOKE.md |
| packages/observability | JSONL events and timing helpers |
| scripts | dev runner, demo readiness check, benchmark, model probe, prompt runner, latency, offline proof, acceptance, export, recording |
| tests | unit, integration, fixtures (including the real model-output corpus) |
| docs | environment, architecture, model selection, results, acceptance, latency, failure modes, security review, local-only checklist, runbook, storyboard, competitive framework, pitch |
| data | local runtime data: snapshots, events, benchmarks, prompt runs, latency, acceptance, logs (ignored) |

## Requirements

Project-local runtimes live under `.tools/` (ignored): Node 24.21.0, npm 11.19.0, OpenClaw 2026.9.8, Ollama 0.35.1. Put them on your PATH:

```bash
export PATH=$PWD/.tools/node/bin:$PWD/.tools/npm-global/bin:$PWD/.tools/ollama/bin:$PATH
```

Ollama must be serving on 127.0.0.1:11434 with the configured model present (`ollama list`). The measured model is `qwen3.5:4b` (Q4_K_M).

## Commands

"Run today" means the command was run on this machine on 2026-10-03 and its outcome is recorded in BUILD_STATUS.md or the named doc.

| Command | What it does | Run today |
|---|---|---|
| `npm install` | installs workspace dependencies from the lockfile | yes (first attempt died on a network timeout, retry succeeded; docs/ENVIRONMENT.md) |
| `npm run typecheck` | TypeScript across all packages | yes |
| `npm test` | unit tests (vitest): contracts, compiler, validators, adversarial worlds, normalization, corpus replay, modes, agent with a fake Ollama, movement | yes (BUILD_STATUS.md 14:36 CDT: 148 unit tests including 29 mode tests, 16 agent tests, 50 in-process server tests) |
| `npm run test:integration` | real server process with real WebSocket controllers, including the five modes | yes (BUILD_STATUS.md: 23 integration tests plus tests/integration/modes.test.ts, 5 of 5 modes) |
| `npm run build` | production web build into apps/web/dist | yes |
| `npm run benchmark:local` | model benchmark, writes data/benchmarks/*.json | yes, three times for qwen3.5:4b (docs/MODEL_SELECTION.md) |
| `npm run demo:check` | read-only readiness check before recording | yes (server-health and secrets rows fail only when no server is running) |
| `npm run dev -- --prod` | server + agent worker serving the built web app on port 7700 | yes, with the real server and worker (the rehearsal stacks behind docs/RESULTS.md) |
| `npm run dev` | server + agent worker + Vite dev server with prefixed logs | not run today in this form; the prod form above was used |
| `npx tsx scripts/run-prompts.ts --ids ...` | sends the fresh prompts from docs/PROMPTS.md to a running stack and records data/prompt-runs/*.json | yes, three runs (docs/RESULTS.md) |
| `npx tsx scripts/acceptance-volcanic.ts` | unattended end-to-end acceptance: two moving players, live edit to lava plus a bridge, 15 assertions | yes, twice (docs/ACCEPTANCE.md: run 2 passed 15 of 15) |
| `npx tsx scripts/measure-latency.ts` | controller RTT and input-to-tick on loopback | yes, once (docs/LATENCY.md) |
| `node scripts/offline-proof.mjs` | records routes, sockets, egress probe and an edit outcome | "before" record only; the egress-blocked rehearsal is not run |
| `node scripts/export-demo.mjs` | copies the deliverables into submission/<stamp>/ with a manifest | yes, once at 12:44 CDT (stale; re-run before packaging) |

## First run

1. Copy `.env.example` to `.env` and adjust `BEETLE_MODEL` if needed.
2. `npm run build` then `npm run dev -- --prod`.
3. The server prints the director URL once (it carries the director token) when the token is first generated. Open it on the desktop.
4. In the director panel, press Invite for each player and scan the QR with a phone on the same LAN. A phone tethered over USB must use the tether interface address instead of the Wi-Fi address in the QR (docs/RUNBOOK.md).
5. Type any game brief and submit. The agent names the mode and biome it mapped the request to. Then keep editing while people play.

## Mode library

The engine implements five game modes (`GAME_MODES` in packages/contracts/src/limits.ts). The model never invents rules: it maps any requested game onto the closest supported mode, fills the mode's parameters, and names the mapping in the title when the request is not an exact match ("Tag Arena (king of the hill)"; `MODE_RULE` in packages/agent/src/prompts.ts). Biome synonyms are in the prompt too: snow is frost, dark is night, sand is desert, lava is volcanic. A world without a `mode` field is a relic hunt with every relic required (the original game). Parameter ranges are the contract's `MODE_LIMITS`; the server rule per mode and the validator's cross-field checks are described in docs/ARCHITECTURE.md "Mode library and generator mapping".

| Mode | What players do | Win condition | Parameters (contract ranges) |
|---|---|---|---|
| `relic_hunt` | Walk the bridges, collect relics, bring them to the gate | The gate unlocks once `relicsRequired` relics are collected and an active player stands in its trigger zone | `relicsRequired` 1 to 3 (default: all relics in the world) |
| `time_trial` | The same relic hunt against a clock | Finish the relic hunt before `timeLimitSec` runs out; the objective state carries `remainingSec` and flips `lost` when the timer expires (pickups and the gate stop until a new world or a `set_mode` patch) | `timeLimitSec` 20 to 600 s (default 120), `relicsRequired` 1 to 3 |
| `king_of_the_hill` | Reach the gate island (the hill, no lock) and stand in the gate zone; the other player tries to do the same. Tag and capture requests map here | The first player whose held time (`holdSec`) reaches `holdSeconds` (`holdTarget` in the objective state); both players accumulate while inside | `holdSeconds` 3 to 60 s (default 10) |
| `checkpoint_race` | Run through the relics as checkpoints, in order by default, then the gate. Race requests map here | Every checkpoint reached (ordered when `orderedCheckpoints` is true, the default for this mode), then the gate | `orderedCheckpoints` true or false, `relicsRequired` 1 to 3; the validator requires at least 2 relics (MODE_INVALID otherwise) |
| `survival` | Grab a relic and get to the gate while the hazard plane rises; once it passes -1.0 m every bridge submerges and stops supporting players | Collect `relicsRequired` relics (default 1 in this mode) and reach the gate before `timeLimitSec` ends; `lost` when the timer expires. The objective state carries `remainingSec`, `hazardElevation` and `lost`; the validator requires `hazard.rise` with `maxElevation` above the starting plane | `timeLimitSec` 20 to 600 s (default 120); `hazard.rise`: `afterSec` 5 to 300, `metersPerSec` 0.01 to 0.5, `maxElevation` -2 to -0.6 m (bridges below -1.0 m submerge) |

Common to every mode: 2 to 24 islands (worlds start small and stream in), at most 48 bridges, 2 spawns, 3 relics, 1 gate, at most 40 decorations, movement speed 3 to 7 m/s (default 4.5, changed live with `set_movement`), and a hazard of `water` or `lava` under everything.

Biomes (`BIOMES`): `garden`, `volcanic`, `frost`, `desert`, `night`. The biome is a world field, chosen by the brief and changed live with `set_biome`; the hazard kind is separate (`set_hazard`). Serene (garden, water) and volcanic (lava) rendering is verified in the browser with two moving players (docs/ACCEPTANCE.md); the biome presets for frost, desert and night are implemented and the frost hill fixture was verified in the browser at 32 fps in the software-rendered pane (BUILD_STATUS.md, renderer row); desert and night have no separate browser check recorded. Decoration types (11): tree, rock, lantern, pillar, bush, shrine, tower, ruin, crystal, mushroom, statue.

Live patch ops: `add_bridge`, `remove_bridge`, `set_hazard`, `add_decoration`, `move_decoration`, `remove_decoration`, `move_relic`, `set_title`, `set_mode`, `set_biome`, `set_movement`, `add_island`, `remove_island` (packages/contracts/src/patch.ts), at most 16 ops per patch.

Example briefs and where they land:

| Brief | Mode | Biome, hazard | Parameters the agent fills |
|---|---|---|---|
| "Five floating garden islands with a temple to the north, water below" | `relic_hunt` | garden, water | all 3 relics required |
| "King of the hill on a frozen arena, hold ten seconds" | `king_of_the_hill` | frost, water | `holdSeconds` 10 |
| "A race through three checkpoints over lava, no shortcuts" | `checkpoint_race` | volcanic, lava | `orderedCheckpoints` true |
| "Collect the relics before the two-minute bell, desert at night" | `time_trial` | desert or night (the agent picks one and says so), water | `timeLimitSec` 120 |
| "The flood is coming: stay above the water as it rises" | `survival` | garden, water | `hazard.rise` within the contract ranges |

These examples show the mapping rule. The measured runs (18 briefs, 4 edits, 7 out-of-library requests) are in docs/RESULTS.md "Game modes from one prompt" and summarised under "What works today" below; note that the measured king-of-the-hill brief asked for desert and committed as volcanic because the model never wrote `desert`.

## Streaming worlds

A brief now builds only the zone around the spawn, 2 to 4 islands, and Beetle grows the world ahead of the players. When a player walks within 4 m of an island rim with no crossing beyond it, the server creates an automatic director request (`auto: true`, with the island, direction and player as the reason) asking the agent for one or two more islands with bridges in that direction. The extension is validated and committed like any edit, so players keep positions, relics and connections; if it fails, the world stays as it was. At most one extension every 12 s, up to 24 islands (`STREAMING` in packages/contracts/src/limits.ts). In the director trail, automatic requests carry a quiet `auto` tag and the reason ("extending north of Hearth Island for Amber").

To turn it off, untick "Grow the world as players explore" in the director panel (it posts `{ autoExpand: false }` to `POST /api/director/settings` with the director token), or send that request yourself. The setting defaults to on.

Status (2026-10-03 15:20 CDT): the contract, the `add_island` / `remove_island` ops and their applier, the raised limits (24 islands, 48 bridges), the director toggle and the trail tagging are implemented today; the server-side frontier trigger and settings route are being landed by their owners. Measured numbers (time from frontier to committed extension, failure rate): not yet measured; docs/RESULTS.md has no streaming run at the time of writing. See docs/ARCHITECTURE.md "Streaming generation" for the trigger, cooldown and validator checks.

## What works today (2026-10-03, measured on the GB10)

- Any brief to a committed, validated world with qwen3.5:4b: 14 s on a quiet GPU in the latest direct run (docs/RESULTS.md run 3); 24 to 28 s warm in the benchmarks when the first draft is valid, 55 to 61 s with one repair round (docs/MODEL_SELECTION.md); 33.4 s to v1 through real OpenClaw tool calls (docs/RESULTS.md, 14:08 CDT). The 10 s target is not met.
- Any game to the closest mode, measured (docs/RESULTS.md "Game modes from one prompt", 14:25 to 14:42 CDT, direct mode, qwen3.5:4b, own stack on port 7786): the mode was sensible on 18 of 18 briefs across both prompt versions (races became checkpoint races; fights, tag and capture the flag became king of the hill; zombies and rising lava became survival; Red Ball and Mario became time trials); the exact mode was missed twice when a neighbour was picked. Requested numbers (hold 10 s, 2 of 3 relics, 120 s, fast players) were taken every time they were asked; one 90 s limit was missed. Biome written by the model: 0 of 4 with the first prompt, 10 of 14 with the final prompt; desert was never written (the normalizer then set volcanic from the lava hazard). Committed briefs took 13.0 to 44.1 s (first model answer 13 to 22 s, one repair about 15 s); 8 of 14 final-prompt attempts committed, every failure was geometry (BRIDGE_CROSSES_ISLAND in 9 of 10), MODE_INVALID never fired. Out-of-library requests that committed: "a game like Red Ball 5" (time trial, 31.1 s), "a stickman fight game" (king of the hill, 44.1 s), "a Mario style platformer with lava" (time trial, 33.1 s), "a zombie survival night map" (survival, night, 17.0 s), "capture the flag on four islands" (king of the hill, 20.1 s).
- Mode library tested: 29 mode unit tests (fixtures race5, hill4, survival5, trial5), 50 in-process server tests covering timers, hill holding, ordered checkpoints and rising lava that submerges bridges, and tests/integration/modes.test.ts running the five modes on a real server with real controllers, 5 of 5 (BUILD_STATUS.md 14:36 CDT).
- Mode and biome changed live, no reset: "make it a 60 second time trial" became `set_mode {time_trial, 60}` and "make it snowy and slow the players down" became `set_biome frost` plus `set_movement 3.5`, each committed in 3.0 s on the running world, exact, in both batches (docs/RESULTS.md "Game modes from one prompt" G5, G6).
- Live edits on a running world: 5 of 6 fresh edits committed in 2.0 / 8.0 / 14.0 s (min / p50 / max) after model-output normalization (docs/RESULTS.md run 3); before normalization 2 of 6.
- Edit while two players keep moving, without a reset: acceptance run 2 committed lava plus a new bridge in 8.0 s with both controllers walking the whole time, collected relic and score unchanged, both sockets open, max tick gap 67 ms, 15 of 15 checks (docs/ACCEPTANCE.md). Hero transformation on the cinematic renderer committed v2 in 3.2 s with two scripted controllers connected (docs/RESULTS.md, 14:02 CDT).
- The validator refusing an edit and the agent repairing it within the 2-attempt budget: DISCONNECTED_GOAL refused at 1.7 s and the repaired patch committed at 3.0 s on the fixture world; INVALID_REFERENCE then BRIDGE_CROSSES_ISLAND refused and repaired on run 3 E6 (docs/RESULTS.md). No invalid world was ever committed.
- Director page, keyboard player, phone controller page (under mobile emulation), lava swap and new bridge without a reset, verified in the browser against the live server (BUILD_STATUS.md).
- Undo through `POST /api/director/undo` on the live stack (v7 to v8 through the normal validated commit path) and in tests.
- Controller transport on loopback: WebSocket RTT p50 0.48 ms, input to server tick p50 18.79 ms; not input to photon (docs/LATENCY.md).
- Deterministic normalization of model output: corpus validity 2 of 30 without it versus 13 of 30 with it (docs/MODEL_FAILURE_MODES.md).
- OpenClaw live against the real server: an edit committed v2 in 20.0 s with real tool calls (13:43 CDT), the gated integration test committed v2 in 38.9 s with 7 tool calls and a genuine build report, and a fresh brief committed v1 in 33.4 s (docs/RESULTS.md, BUILD_STATUS.md case 17). Two earlier runs against a fake server are in packages/agent/SMOKE.md.
- Required test cases 1 to 18 tested; 17 and 18 tested live (BUILD_STATUS.md).

## Presentation (14:00 CDT pass)

- Procedural terrain islands, plank suspension bridges, crystal relics, rune gate and humanoid players with PBR materials and runtime-generated textures.
- Two environment themes driven by the world hazard (serene for water, volcanic for lava) with a procedural sky used for image-based lighting, fog, sun, particles and a 2 s blend on every committed hazard change; the theme change is an ordinary validated patch, so players, inventory, score, connections and version history survive it (docs/ACCEPTANCE.md, 15 of 15 checks). Biome presets for frost, desert and night with lava overlays are implemented; the frost hill fixture was verified in the browser (BUILD_STATUS.md), desert and night were not separately checked.
- Post pipeline: bloom, ACES tone mapping, FXAA, MSAA, SSAO, god rays, glow and PCF shadows; Q toggles a low-quality mode, C toggles the debug camera; a cinematic follow camera frames both players.
- Minimal glass HUD with relic gems, objective and agent status; developer readouts behind the backquote key or ?debug=1; optional procedural ambient audio (off by default).

## Known limitations (2026-10-03)

- The 10 s brief target is not met: 24 to 28 s warm on a quiet GPU when the first draft is valid, 2.4x to 2.8x over (docs/MODEL_SELECTION.md). Cold load adds 23.1 s. Under a contended GPU drafts took 58 to 214 s.
- Mode briefs fail on geometry as often as other briefs: 8 of 14 final-prompt attempts committed, the rest hit BRIDGE_CROSSES_ISLAND, UNREACHABLE_SPAWN or OBJECT_NOT_ON_SURFACE within the 2-repair budget (docs/RESULTS.md "Game modes from one prompt"). The model never wrote `desert` in three attempts, copied the prompt's example biome (`frost`) four times when none was requested, and twice picked a neighbouring mode when the exact one existed. No controller was connected during those runs. Measured in direct mode only; the OpenClaw path has not run a mode brief.
- The OpenClaw path depends on a healthy Ollama daemon: at 13:24 CDT it timed out because the daemon had stopped answering chat requests; after the restart at 13:43 it committed (docs/RESULTS.md). Most direct-mode numbers predate that restart and are labelled `[direct]`.
- qwen3.8:27b was never benchmarked: its first pull failed with a digest mismatch and the second pull was stopped when the daemon had to be restarted (docs/MODEL_SELECTION.md sections 6 and 9).
- Session continuity with physical phones is not measured: the acceptance test and the integration tests use scripted WebSocket controllers; no phone joined during the session (BUILD_STATUS.md).
- Two physical phones, the offline (egress-blocked) rehearsal and the demo recording are not done yet (docs/RUNBOOK.md, docs/SUBMISSION.md).
- About half of first world drafts need a repair or fail: first-attempt validity 9 of 18 drafts, 15 of 18 within two retries (docs/MODEL_SELECTION.md 4.6); failure modes are invented ids, offsets written as world coordinates and truncated JSON (docs/MODEL_FAILURE_MODES.md).
- Transport is plain HTTP and WebSocket on the team LAN; tokens could be replayed by anyone sniffing the LAN (docs/SECURITY_REVIEW.md). Team chat publishing is not wired (no credentials); reports stay local.
- No Playwright browser tests; browser checks were manual. Frame rate was observed only in a software-rendered browser pane (3 to 11 fps high quality, 30 to 36 low), not on the demo GPU (BUILD_STATUS.md).

## Honest measurements

Benchmarks, prompt runs, latency samples, acceptance records and the model-output corpus live in `data/benchmarks/`, `data/prompt-runs/`, `data/latency/`, `data/acceptance/` and `tests/fixtures/corpus/`. Numbers quoted anywhere in docs come from those files; see BUILD_STATUS.md for what was and was not tested.
