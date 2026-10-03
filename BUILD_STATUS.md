# BUILD_STATUS

Last updated: 2026-10-03 14:36 CDT. Submission deadline set by the user: 16:30 CDT. Final checkpoint at 16:05, export and push by 16:20.

Legend: implemented = code exists; tested = an automated or recorded manual test ran and passed; untested = exists, no test run; blocked = cannot proceed without something external; omitted = deliberately cut.

## Verified facts

- Machine: aarch64 GB10, 121 GiB unified memory, 3.4 TB free, driver 580.178.04. See docs/ENVIRONMENT.md.
- Runtimes are project-local under .tools/: Node 24.21.0, npm 11.19.0, OpenClaw 2026.9.8, Ollama 0.35.1 on 127.0.0.1:11434.
- Models: qwen3.5:4b (Q4_K_M, 4.7B) present. qwen3.8:27b (17.7 GB) downloading in the background.
- Probe of qwen3.5:4b (scripts/probe-model.ts, data/logs/probe-run.log): world draft valid JSON in 54 s cold (23 s load) and 20 s warm; edit patch 1.6 to 2.2 s; tool call via /api/chat tools in 0.3 to 0.4 s. One of two patches violated a numeric maximum that the JSON-schema grammar did not enforce, so boundary validation and repair are required.
- Workspace dependencies installed; lockfile committed.

## Assumptions

- The rules' 18:00 deadline is Boston time; the machine clock is America/Chicago, so the deadline is 17:00 on the machine clock.
- Development assistance (Claude Code) is permitted by the organisers; the product itself never calls a cloud model.

## Status by area

| Area | Status | Notes |
|---|---|---|
| Contracts (schemas, limits, codes, protocol, routes) | implemented, typechecked | packages/contracts |
| Observability (JSONL events, sanitizer, stopwatch) | implemented, used by server and agent | packages/observability |
| World compiler, WalkField, nav grid, validators, playability, patches, fixtures | implemented, tested (73 unit tests incl. 23 adversarial) | packages/world; deterministic normalization of model output added (names and compass words to ids, offsets, limits, island separation) |
| Server: HTTP, WebSocket, simulation, transactions, persistence, auth | implemented, tested (38 in-process tests, 23 integration tests on a real server with real sockets) | apps/server; loop body avg 0.04 ms per tick with 2 players and a 16-bridge world |
| Web: director, play, controller, Babylon renderer | implemented, built; cinematic pass done (terrain islands, PBR materials with runtime textures, image-based lighting from a procedural sky, post pipeline with bloom, ACES, FXAA, SSAO, god rays, glow, shadows, particles, cinematic follow camera with C debug toggle, commit transitions and movement effects, premium HUD, procedural audio); hero transformation serene to volcanic verified in the browser with two connected moving players (v2 in 3.2 s, inventory and score unchanged) | apps/web |
| Agent: Ollama client, jobs, worker, direct harness | implemented, tested (14 unit tests); live briefs and edits verified (docs/RESULTS.md) | packages/agent; direct mode is labelled in every report |
| OpenClaw tool plugin and isolated profile | implemented, tested live against the real server (v2 committed in 20 s) and against a fake server | packages/agent/openclaw-plugin, .openclaw-home, packages/agent/SMOKE.md |
| Benchmark script | implemented, run for qwen3.5:4b | scripts/benchmark-local.ts, data/benchmarks |
| Live-run recorder and fresh prompts | implemented, run (docs/RESULTS.md, before normalization) | scripts/run-prompts.ts |
| Latency measurement | implemented, run | docs/LATENCY.md: WebSocket RTT p50 0.5 ms, input to server tick p50 19 ms (not input to photon) |
| Dev runner, demo check, export, offline proof, recording, captions | implemented; export and offline-proof run once; capture scripts tested with a synthetic clip | scripts/ |
| Pitch deck | implemented (six slides, placeholders for measured numbers) | docs/pitch |
| Security review | done; high and medium findings fixed or assigned | docs/SECURITY_REVIEW.md |
| Docs: environment, architecture, local-only checklist, runbook, storyboard, pitch outline, submission checklist | implemented | docs/ |

## Game generator expansion (14:10 to 14:35 CDT)

Beetle now maps any requested game onto a mode library and a biome, then builds it; the model states the mapping. Everything below is backward compatible with the morning's worlds and tests.

| Area | Status | Evidence |
|---|---|---|
| Contract: modes (relic_hunt, time_trial, king_of_the_hill, checkpoint_race, survival), biomes (garden, volcanic, frost, desert, night), movement speed, rising hazard, five new decoration types, patch ops set_mode, set_biome, set_movement; controller buttons (sprint, walk, ping, wave), ping markers, emotes | implemented, typechecked | packages/contracts |
| World: mode validation (MODE_INVALID), mode and biome normalization from plain words, fixtures race5, hill4, survival5, trial5, speed scale in movement | implemented, tested (29 mode tests; 148 unit tests total) | packages/world, tests/unit/modes.test.ts |
| Server: mode rules in the 30 Hz simulation (timers, hill holding, ordered checkpoints, rising lava that submerges bridges), buttons, markers, emotes, fixture selection | implemented, tested (50 in-process tests; adversarial review in progress) | apps/server |
| Integration: five modes on a real server with real controllers | tested (5 of 5) | tests/integration/modes.test.ts |
| Renderer: biome presets with lava overlays, new decorations, rigged players with run cycle, mode visuals, ping beacons | implemented, verified in the browser (frost hill fixture at 32 fps in the software pane) | apps/web/src/renderer |
| HUD and pages: mode-aware objective, won and lost overlays, one-prompt landing, director hints and prefill, restraint pass | implemented, built | apps/web |
| Phone: console-style pad (stick, D-pad, L2 walk, R2 sprint, triangle ping, square wave, circle sprint, cross interact), objective strip, cues | implemented, verified against the live server under phone emulation | apps/web/src/controller |
| Agent: prompts map any game onto a mode and biome; out-of-library requests measured | implemented (16 agent tests); live measurement in progress | packages/agent, docs/RESULTS.md |
| Movement acceleration | deliberately omitted: an exponential acceleration model broke the validator's headless traversal timing and three tests; instant velocity kept (best measured input latency), weight comes from client interpolation and character animation | |

## Streaming generation (15:05 to 15:16 CDT)

| Area | Status | Evidence |
|---|---|---|
| Contract: add_island and remove_island ops, worlds of 2 to 24 islands and 48 bridges, WorldSpec.streaming, automatic requests with autoReason, director settings route | implemented, typechecked | packages/contracts |
| World: island placement with anchor selection, pull-in and overlap push-away; seed2 and grown12 fixtures; 24-island worlds validate in about 10 ms | implemented, tested (18 streaming tests) | packages/world, tests/unit/streaming.test.ts |
| Server: frontier trigger (4 m from a rim with no crossing within 45 degrees), 12 s cooldown, one in-flight request, autoExpand setting, snapshot persistence | implemented, tested (10 expansion tests; 75 server tests total) | apps/server/src/expansion.ts |
| Agent: expansion prompt for automatic requests; briefs start small when streaming is on | implemented (measurement in progress) | packages/agent |
| Director toggle, HUD "building ahead" line, docs | implemented | apps/web, docs/ARCHITECTURE.md |
| Live runs | verified: extension committed 9.5 s after the trigger with the player preserved (docs/RESULTS.md); real-server integration tests 4 of 4 (tests/integration/streaming.test.ts); unattended acceptance 21 of 21 on run 3 with two extensions at 56.0 s and 10.6 s on a GPU shared with nine other workers, two of six automatic requests across three runs failed cleanly on the model side with the world untouched (docs/ACCEPTANCE.md) | |

## Required test cases (section 14)

| # | Case | Status |
|---|---|---|
| 1 | schema rejections | tested (tests/unit/contracts.test.ts) |
| 2 | deterministic compile | tested (tests/unit/compiler.test.ts) |
| 3 | valid world routes | tested (validators.test.ts) |
| 4 | gapped bridge fails | tested (BRIDGE_ENDPOINT_GAP) |
| 5 | blocked path and gate dependency fail | tested (UNREACHABLE_RELIC, GATE_HIDES_RELIC) |
| 6 | removing only goal route fails without mutation | tested (DISCONNECTED_GOAL, spec unchanged) |
| 7 | replacement crossing passes and commits | tested (add_bridge passes, commits in integration) |
| 8 | occupied support cannot vanish under a player | tested (deferred then OCCUPIED_SUPPORT, then commits after the player moves) |
| 9 | stale patch fails, duplicate commit idempotent | tested (STALE_WORLD_VERSION; idempotent replay) |
| 10 | editing preserves identity, relics, score, connections | tested (ids, positions, relics, score, sockets preserved) |
| 11 | simultaneous pickup once, undo cannot duplicate | tested (one award; undo keeps relic collected) |
| 12 | two phones, reconnect, timeout clears motion | tested with real WebSocket controllers (independent movement, reconnect restores identity, timeout clears motion); physical phones unrun |
| 13 | controller token cannot edit or call admin | tested (401/403 on director and agent routes; non-loopback rejected) |
| 14 | malformed model output triggers bounded retries | tested (tests/unit/agent.test.ts: malformed and truncated output, bounded retries, no mutation) |
| 15 | slow or missing model leaves gameplay responsive, no cloud fallback | tested (deadline ends the job, no fallback host contacted) |
| 16 | client behind on versions resyncs | tested (resync returns current spec) |
| 17 | fresh request through real OpenClaw tools with genuine report | tested live twice: manual run (v2 in 20 s, docs/RESULTS.md) and the gated integration test tests/integration/live-agent.test.ts with BEETLE_LIVE_MODEL=1 BEETLE_LIVE_OPENCLAW=1 (committed v2 in 38.9 s, 7 tool calls, validation attempts 3 with INVALID_SCHEMA and DUPLICATE_ID rejected at the boundary, genuine build report); plus two recorded runs against a fake server (packages/agent/SMOKE.md) |
| 18 | fresh edit under local-only runtime configuration | tested live: gated integration test (direct mode) committed lava plus a new northern bridge with preserved players in 14.3 s; 5 of 6 fresh edits committed in 2 to 14 s (docs/RESULTS.md run 3); validator refusal and repair demonstrated (DISCONNECTED_GOAL, 3.0 s); offline (egress-blocked) rehearsal not yet run |

## Demo state at 14:10 CDT

- Live stack on port 7781: fixture world at v4 (lava, west-to-temple bridge added by the agent), two scripted controllers connected, worker in OpenClaw mode (the submission path), Ollama daemon restarted at 13:43 with a single slot and 1 h keep-alive.
- Both agent modes verified live: OpenClaw (edit v2 in 20 s manual and 38.9 s in the gated test; fresh brief to v1 in 33 s) and direct (edits 3 to 14 s, brief 14 s). The runbook's recorded sequence uses OpenClaw mode; direct mode is the labelled fallback.
- Visual pass complete and verified in the browser: serene and volcanic themes, cinematic camera, humanoid players walking, commit transitions, premium HUD. Frame rate was only observed in the software-rendered browser pane (3 to 11 fps high quality, 30 to 36 low); the demo GPU at 1920x1200 is expected to be far faster but was not measured; Q toggles quality, C toggles the debug camera.

## Blocked

- Team chat channel: no credentials; report publishing stays local (UI, data/prompt-runs, data/acceptance).
- qwen3.8:27b: never benchmarked; one pull failed with a digest mismatch, the second was stopped when the daemon had to be restarted (docs/MODEL_SELECTION.md).
- Physical phone tests: need a person on site; the iPhone was reachable over the USB tether (172.20.10.12) and invites were issued, but no phone joined during the session, so the physical test is unrun.
- Offline (egress-blocked) rehearsal: procedure in docs/OFFLINE_PROOF.md, not executed.

## Omitted (deliberately)

- Voice, tilt controls, neural asset generation, NPC conversations, extra biomes, general physics, fancy transitions, extra channels.
- Playwright browser tests (large browser download on a slow link).
- Database service (JSON snapshots and JSONL events instead).
