# Beetle

Change the game without stopping the game.

Beetle is a local AI prototyping teammate for small game studios. A designer writes a brief, a local model composes a playable floating-garden world, two people join from their phones, and the designer keeps editing the world while they play. Every edit is validated by deterministic game logic, repaired by the agent when it fails, and committed as a new world version without disconnecting anyone or resetting progress.

Everything runs on one machine. Model inference is Ollama on loopback. The agent is a real OpenClaw instance with Beetle-specific tools. There is no cloud fallback.

## Layout

| Path | Purpose |
|---|---|
| apps/web | director, shared display and phone controller pages (React, Vite, Babylon.js) |
| apps/server | HTTP and WebSocket server, authoritative 30 Hz simulation, world transactions |
| packages/contracts | zod schemas, limits, validation codes, protocol, routes |
| packages/world | world compiler, walk field, nav grid, validators, playability checks, patches |
| packages/agent | OpenClaw tool plugin, agent worker, Ollama client, labelled direct harness |
| packages/observability | JSONL events and timing helpers |
| scripts | dev runner, demo readiness check, benchmark, model probe |
| tests | unit, integration and fixtures |
| docs | environment, architecture, local-only checklist, runbook, storyboard, pitch outline |
| data | local runtime data: snapshots, events, reports, benchmarks (ignored) |

## Requirements

Project-local runtimes live under `.tools/` (ignored): Node 24, OpenClaw 2026.9.8, Ollama 0.35. Put them on your PATH:

```bash
export PATH=$PWD/.tools/node/bin:$PWD/.tools/npm-global/bin:$PWD/.tools/ollama/bin:$PATH
```

Ollama must be serving on 127.0.0.1:11434 with the configured model present (`ollama list`).

## Commands

| Command | What it does | Verified |
|---|---|---|
| `npm install` | installs workspace dependencies from the lockfile | yes |
| `npm run typecheck` | TypeScript across all packages | yes |
| `npm test` | unit tests (vitest) | see BUILD_STATUS.md |
| `npm run test:integration` | real server process tests | see BUILD_STATUS.md |
| `npm run build` | production web build into apps/web/dist | see BUILD_STATUS.md |
| `npm run dev` | server + agent worker + Vite dev server with prefixed logs | see BUILD_STATUS.md |
| `npm run dev -- --prod` | server + agent worker serving the built web app on port 7700 | see BUILD_STATUS.md |
| `npm run benchmark:local` | model benchmark, writes data/benchmarks/*.json | see BUILD_STATUS.md |
| `npm run demo:check` | read-only readiness check before recording | see BUILD_STATUS.md |

## First run

1. Copy `.env.example` to `.env` and adjust `BEETLE_MODEL` if needed.
2. `npm run build` then `npm run dev -- --prod`.
3. The server prints the director URL once (it carries the director token). Open it on the desktop.
4. In the director panel, press Invite for each player and scan the QR with a phone on the same LAN.
5. Type a brief and submit. Then keep editing while people play.

## Honest measurements

Benchmarks and demo timings are recorded in `data/benchmarks/` and `data/reports/`. Numbers quoted anywhere in docs come from those files; see BUILD_STATUS.md for what was and was not tested.
