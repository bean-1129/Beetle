# BUILD_STATUS

Last updated: 2026-10-03 12:35 CDT. Submission deadline set by the user: 15:32 CDT (3 hours from 12:32). Integration and packaging reserve starts 14:45 CDT.

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
| Observability (JSONL events, sanitizer, stopwatch) | implemented, untested | packages/observability |
| World compiler, WalkField, nav grid, validators, playability, patches, fixtures | in progress | packages/world |
| Server: HTTP, WebSocket, simulation, transactions, persistence, auth | in progress | apps/server |
| Web: director, play, controller, Babylon renderer | in progress | apps/web |
| Agent: Ollama client, jobs, worker, direct harness | in progress | packages/agent |
| OpenClaw tool plugin and isolated profile | in progress | packages/agent/openclaw-plugin |
| Benchmark script | in progress | scripts/benchmark-local.ts |
| Dev runner, demo check | implemented, untested | scripts/dev.mjs, scripts/demo-check.mjs |
| Docs: environment, architecture, local-only checklist | implemented | docs/ |
| README, runbook, storyboard, pitch outline | not started | |

## Required test cases (section 14)

| # | Case | Status |
|---|---|---|
| 1 | schema rejections | pending |
| 2 | deterministic compile | pending |
| 3 | valid world routes | pending |
| 4 | gapped bridge fails | pending |
| 5 | blocked path and gate dependency fail | pending |
| 6 | removing only goal route fails without mutation | pending |
| 7 | replacement crossing passes and commits | pending |
| 8 | occupied support cannot vanish under a player | pending |
| 9 | stale patch fails, duplicate commit idempotent | pending |
| 10 | editing preserves identity, relics, score, connections | pending |
| 11 | simultaneous pickup once, undo cannot duplicate | pending |
| 12 | two phones, reconnect, timeout clears motion | pending (physical part unrun) |
| 13 | controller token cannot edit or call admin | pending |
| 14 | malformed model output triggers bounded retries | pending |
| 15 | slow or missing model leaves gameplay responsive, no cloud fallback | pending |
| 16 | client behind on versions resyncs | pending |
| 17 | fresh request through real OpenClaw tools with genuine report | pending |
| 18 | fresh edit under local-only runtime configuration | pending |

## Blocked

- GitHub push: no credentials on the machine (no gh, no credential helper, no SSH key). The user must authenticate once from their terminal.
- Team chat channel: no credentials; report publishing stays local.
- Physical phone tests: need a person on site.

## Omitted (deliberately)

- Voice, tilt controls, neural asset generation, NPC conversations, extra biomes, general physics, fancy transitions, extra channels.
- Playwright browser tests (large browser download on a slow link).
- Database service (JSON snapshots and JSONL events instead).
