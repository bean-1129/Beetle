# Beetle

Change the game without stopping the game.

Beetle is a local AI prototyping teammate for small game studios. A designer writes a brief, a local model composes a playable floating-garden world, two people join from their phones, and the designer keeps editing the world while they play. Every edit is validated by deterministic game logic, repaired by the agent when it fails, and committed as a new world version without disconnecting anyone or resetting progress.

Everything runs on one machine. Model inference is Ollama on loopback. The agent runtime is OpenClaw with Beetle-specific tools, plus a clearly labelled in-process direct harness used for the measured runs so far (see "Known limitations"). There is no cloud fallback.

## Layout

| Path | Purpose |
|---|---|
| apps/web | director, shared display and phone controller pages (React, Vite, Babylon.js) |
| apps/server | HTTP and WebSocket server, authoritative 30 Hz simulation, world transactions |
| packages/contracts | zod schemas, limits, validation codes, protocol, routes |
| packages/world | world compiler, walk field, nav grid, validators, playability checks, patches, model-output normalization |
| packages/agent | OpenClaw tool plugin, agent worker, Ollama client, labelled direct harness, SMOKE.md |
| packages/observability | JSONL events and timing helpers |
| scripts | dev runner, demo readiness check, benchmark, model probe, prompt runner, latency, offline proof, export, recording |
| tests | unit, integration, fixtures (including the real model-output corpus) |
| docs | environment, architecture, model selection, results, latency, failure modes, security review, local-only checklist, runbook, storyboard, pitch |
| data | local runtime data: snapshots, events, benchmarks, prompt runs, latency, logs (ignored) |

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
| `npm test` | unit tests (vitest): contracts, compiler, validators, adversarial worlds, normalization, corpus replay, agent with a fake Ollama, movement | yes (BUILD_STATUS.md: 73 world tests, 14 agent tests, 38 in-process server tests) |
| `npm run test:integration` | real server process with real WebSocket controllers | yes (BUILD_STATUS.md: 23 integration tests) |
| `npm run build` | production web build into apps/web/dist | yes |
| `npm run benchmark:local` | model benchmark, writes data/benchmarks/*.json | yes, three times for qwen3.5:4b (docs/MODEL_SELECTION.md) |
| `npm run demo:check` | read-only readiness check before recording | yes (server-health and secrets rows fail only when no server is running) |
| `npm run dev -- --prod` | server + agent worker serving the built web app on port 7700 | yes, with the real server and worker (the rehearsal stacks behind docs/RESULTS.md) |
| `npm run dev` | server + agent worker + Vite dev server with prefixed logs | not run today in this form; the prod form above was used |
| `npx tsx scripts/run-prompts.ts --ids ...` | sends the fresh prompts from docs/PROMPTS.md to a running stack and records data/prompt-runs/*.json | yes, three runs (docs/RESULTS.md) |
| `npx tsx scripts/measure-latency.ts` | controller RTT and input-to-tick on loopback | yes, once (docs/LATENCY.md) |
| `node scripts/offline-proof.mjs` | records routes, sockets, egress probe and an edit outcome | "before" record only; the egress-blocked rehearsal is not run |
| `node scripts/export-demo.mjs` | copies the deliverables into submission/<stamp>/ with a manifest | yes, once at 12:44 CDT (stale; re-run before packaging) |

## First run

1. Copy `.env.example` to `.env` and adjust `BEETLE_MODEL` if needed.
2. `npm run build` then `npm run dev -- --prod`.
3. The server prints the director URL once (it carries the director token) when the token is first generated. Open it on the desktop.
4. In the director panel, press Invite for each player and scan the QR with a phone on the same LAN. A phone tethered over USB must use the tether interface address instead of the Wi-Fi address in the QR (docs/RUNBOOK.md).
5. Type a brief and submit. Then keep editing while people play.

## What works today (2026-10-03, measured on the GB10)

- Brief to a committed, validated world with qwen3.5:4b: 14 s on a quiet GPU in the latest run (docs/RESULTS.md run 3); 24 to 28 s warm in the benchmarks when the first draft is valid, 55 to 61 s with one repair round (docs/MODEL_SELECTION.md).
- Live edits on a running world: 5 of 6 fresh edits committed in 2.0 / 8.0 / 14.0 s (min / p50 / max) after model-output normalization (docs/RESULTS.md run 3); before normalization 2 of 6.
- The validator refusing an edit and the agent repairing it within the 2-attempt budget: DISCONNECTED_GOAL refused at 1.7 s and the repaired patch committed at 3.0 s on the fixture world; INVALID_REFERENCE then BRIDGE_CROSSES_ISLAND refused and repaired on run 3 E6 (docs/RESULTS.md). No invalid world was ever committed.
- Director page, keyboard player, phone controller page (under mobile emulation), lava swap and new bridge without a reset, verified in the browser against the live server (BUILD_STATUS.md).
- Undo through `POST /api/director/undo` on the live stack (v7 to v8 through the normal validated commit path) and in tests.
- Controller transport on loopback: WebSocket RTT p50 0.48 ms, input to server tick p50 18.79 ms; not input to photon (docs/LATENCY.md).
- Deterministic normalization of model output: corpus validity 2 of 30 without it versus 13 of 30 with it (docs/MODEL_FAILURE_MODES.md).
- OpenClaw: the seven Beetle tools called by qwen3.5:4b through `openclaw agent exec` against a fake Beetle server, twice, ending in a committed v2 and a genuine build report (packages/agent/SMOKE.md).
- Required test cases 1 to 16 tested, 17 partial, 18 tested live in direct mode (BUILD_STATUS.md).

## Presentation (14:00 CDT pass)

- Procedural terrain islands, plank suspension bridges, crystal relics, rune gate and humanoid players with PBR materials and runtime-generated textures.
- Two environment themes driven by the world hazard (serene for water, volcanic for lava) with a procedural sky used for image-based lighting, fog, sun, particles and a 2 s blend on every committed hazard change; the theme change is an ordinary validated patch, so players, inventory, score, connections and version history survive it (docs/ACCEPTANCE.md, 15 of 15 checks).
- Post pipeline: bloom, ACES tone mapping, FXAA, MSAA, SSAO, god rays, glow and PCF shadows; Q toggles a low-quality mode, C toggles the debug camera; a cinematic follow camera frames both players.
- Minimal glass HUD with relic gems, objective and agent status; developer readouts behind the backquote key or ?debug=1; optional procedural ambient audio (off by default).

## Known limitations (2026-10-03)

- The 10 s brief target is not met: 24 to 28 s warm on a quiet GPU when the first draft is valid, 2.4x to 2.8x over (docs/MODEL_SELECTION.md). Cold load adds 23.1 s. Under a contended GPU drafts took 58 to 214 s.
- OpenClaw mode against the real server times out before any model call and is being diagnosed; every measured number so far comes from the direct harness, labelled `[direct]` in every report (packages/agent/SMOKE.md, BUILD_STATUS.md case 17).
- qwen3.8:27b was never benchmarked: its pull failed once with a digest mismatch and is re-downloading (docs/MODEL_SELECTION.md section 6).
- Session continuity with players (players kept, relics kept, reconnects across commits) is covered by integration tests but not yet measured in a live session: no controller was connected during the recorded runs.
- Two physical phones, the offline (egress-blocked) rehearsal and the demo recording are not done yet (docs/RUNBOOK.md, docs/SUBMISSION.md).
- About half of first world drafts need a repair or fail: first-attempt validity 9 of 18 drafts, 15 of 18 within two retries (docs/MODEL_SELECTION.md 4.6); failure modes are invented ids, offsets written as world coordinates and truncated JSON (docs/MODEL_FAILURE_MODES.md).
- Transport is plain HTTP and WebSocket on the team LAN; tokens could be replayed by anyone sniffing the LAN (docs/SECURITY_REVIEW.md). Team chat publishing is not wired (no credentials); reports stay local.
- No Playwright browser tests; browser checks were manual.

## Honest measurements

Benchmarks, prompt runs, latency samples and the model-output corpus live in `data/benchmarks/`, `data/prompt-runs/`, `data/latency/` and `tests/fixtures/corpus/`. Numbers quoted anywhere in docs come from those files; see BUILD_STATUS.md for what was and was not tested.
