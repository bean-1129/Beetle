# Beetle pitch outline (six slides, five minutes)

Filled 2026-10-03 13:35 CDT. Every number below is copied from the file named next to it; nothing is estimated. Where a measurement does not exist the line says so instead of carrying a number. GPU state is labelled on every timing because the Ollama daemon was shared with other owners' runs for most of the day (docs/MODEL_SELECTION.md section 2).

## 1. The problem and the user

- Technical designers at small studios iterate on playable prototypes by stopping the session, editing, rebuilding, and re-gathering playtesters.
- Every "stop" costs the thing they are trying to observe: how people actually play.
- Beetle's promise: change the game without stopping the game.

## 2. The Beetle workflow

- Brief to playable world, two phones join, designer edits while people play, agent validates and repairs, new version lands without a reset, version report.
- One machine, one local model, one real agent runtime (OpenClaw), zero cloud.
- Status of the OpenClaw path (packages/agent/SMOKE.md): the seven Beetle tools were driven by qwen3.5:4b through `openclaw agent exec` against a fake Beetle server twice (read_world_state, propose_patch, validate_candidate, run_playability_checks, commit_candidate, publish_build_report; 19.6 s end to end in run G). The same run against the real server currently times out before any model call and is being diagnosed. Every measured number on slide 5 therefore comes from the direct harness, which is labelled `[direct]` in every report.

## 3. The working video

- 90 to 120 seconds: fresh world, two phones, an edit prepared while players move, preserved progress, a conflicting edit caught by the validator, the repaired version committed.
- Any time compression is labelled on screen.
- The recording uses whichever agent mode is green at recording time (direct or OpenClaw) and the caption names it (docs/STORYBOARD.md).

## 4. Agent architecture and validation

- WorldSpec (structure) is separate from SessionState (players, relics, score). Versions advance only on committed transactions.
- The agent reads state, proposes, validates, repairs within a bounded budget (at most 2 repair attempts, `BEETLE_MAX_REPAIR_ATTEMPTS=2` in .env.example; the `attempts` field in every failed run report reads 3, one first try plus two repairs), commits only with a server-issued proof, and reports.
- Validation is deterministic game code: geometry, bridge sockets, walk field, reachability with the gate locked, occupied-support checks at commit time. An LLM saying valid is never approval.
- Nothing from the model is executed. Output is schema-checked JSON only. Since 13:05 CDT a deterministic normalizer (packages/world/src/normalize.ts, docs/ARCHITECTURE.md "Model-output normalization") maps display names and compass words to real ids and pulls offsets back inside the island before the strict schema and the full validator run; it never bypasses reachability, gate or occupancy checks.

## 5. Measured local-first results

- Model: qwen3.5:4b, Q4_K_M, 4.7B parameters, 3.4 GB on disk, on the GB10 via Ollama 0.35.1 on 127.0.0.1:11434 (docs/MODEL_SELECTION.md section 3; `model` field in data/benchmarks/*.json). qwen3.8:27b is not benchmarked: its first pull failed with a sha256 digest mismatch at 13:19 CDT and a second pull was re-downloading from 0 (9% at 13:23 CDT), so no 27b number exists and none is claimed (docs/MODEL_SELECTION.md section 6).
- Brief to playable, warm, quiet GPU, first draft valid: 26.2 / 26.5 / 27.7 s (min / p50 / max over 3 runs, data/benchmarks/bench-qwen3.5_4b-1791049348895.json); the two quiet single-attempt drafts in data/benchmarks/bench-qwen3.5_4b-1791051548394.json took 23.8 and 28.7 s. With one repair round: 55.4 and 61.4 s. The 10 s warm target for a small world is not met; the 4b is 2.4x to 2.8x over it on a quiet GPU (docs/MODEL_SELECTION.md section 5). After normalization, the brief that produced the run 3 world (4 islands, 4 bridges) committed in 14 s on a quiet GPU, observed once (docs/RESULTS.md, run 3).
- Cold load, reported separately: 23.1 s model load inside a 54.4 s first draft on a never-loaded file (data/logs/probe-run.log run 0, docs/MODEL_SELECTION.md section 4.1).
- Contended GPU (other owners' agents calling Ollama at the same time): world drafts 58.8 to 214.1 s, one edit patch 45.1 s (data/benchmarks/bench-qwen3.5_4b-1791050596040.json). These measure contention, not the model; the GPU must be quiet during the demo.
- Edit to commit, run 3 (after normalization, quiet GPU, direct mode, data/prompt-runs/run-1791052136845.json, docs/RESULTS.md): 2.0 / 8.0 / 14.0 s (min / p50 / max over 6 edits, 5 of 6 committed). Run 2 before normalization (data/prompt-runs/run-1791049429696.json): the two edits that committed took 3.0 s each, 2 of 6 committed.
- Invalid edits caught: run 2, 4 of 6 edits had every candidate refused (E2: UNREACHABLE_RELIC then INVALID_REFERENCE; E3 and E6: INVALID_REFERENCE; E4: truncated JSON stopped at the output boundary), repairs that then committed: 0. Run 3, 2 of 6 edits had a candidate refused (E1 and E6, INVALID_REFERENCE then BRIDGE_CROSSES_ISLAND), repairs that then committed: 1 (E6, v5 to v6 in 8.0 s; E1 exhausted its 2 repairs and left the world untouched). Across both runs: 6 of 12 edit attempts had an invalid candidate caught, 1 repair committed, 0 invalid worlds committed (docs/RESULTS.md).
- The storyboard's conflicting edit, measured once on garden5 at 13:32 CDT (docs/RESULTS.md, "Conflicting edit on the fixture world"): "Remove the only bridge to the temple. Keep the temple reachable." The validator refused the first candidate with DISCONNECTED_GOAL [gate, temple, spawn-0, spawn-1] at 1.7 s; the repair added a replacement bridge and v2 committed at 3.0 s. On the model-built world (two temple bridges) the same prompt produced a valid alternative on the first attempt and committed v7 in 6.4 s with no validator failure; that case is not presented as a refusal.
- Undo on the live stack (docs/RESULTS.md): `POST /api/director/undo` on v7 produced v8 through the normal validated commit path, deferred 0 ms.
- Normalization effect on the corpus of 30 real model outputs (docs/MODEL_FAILURE_MODES.md, tests/fixtures/corpus/summary.json): validity 2 of 30 (6.7%) without normalization versus 13 of 30 (43.3%) with it; drafts 0 of 15 to 5 of 15. Live edits committed went from 2 of 6 (run 2) to 5 of 6 (run 3).
- Controller latency, loopback, two scripted controllers (docs/LATENCY.md, data/latency/latency-1791050379652.json): WebSocket RTT p50 0.48 ms, p95 0.81 ms (n = 400); input to server tick p50 18.79 ms, p95 33.08 ms idle (n = 200) and p50 17.53 ms under 2 x 30 inputs/s load. This is not input to photon: no phone, no Wi-Fi hop, no browser sampling, no renderer or display is included.
- Session continuity: not measured in a live session with players (no controller was connected during runs 2 and 3, docs/RESULTS.md "Players"). Preservation of ids, relics, score and sockets across a commit, and reconnect restoring identity, are covered by the integration tests on a real server with real WebSocket controllers (BUILD_STATUS.md cases 10 and 12); the browser check showed a live edit swapping water to lava and adding a bridge without a reset for a keyboard player (BUILD_STATUS.md, web row). Say "covered by tests, not yet measured live" on stage.
- Offline proof: not run. The only record is a "before" sample taken with egress not blocked and the server not up (data/offline-proof/1791049273707.json; procedure in docs/OFFLINE_PROOF.md). Nothing is claimed until the rehearsal with the route removed is recorded.

## 6. Business hypothesis and next validation

- Hypothesis: studios will pay for faster prototype iteration that keeps playtests running, with data staying on their machines.
- Not claimed: market size, pricing, customer traction, speed-up percentages without a measured baseline.
- Next validation: time a conventional edit-rebuild-regather loop with the same designers and the same change list, and compare against Beetle's measured edit-to-commit times (2.0 / 8.0 / 14.0 s in run 3).
