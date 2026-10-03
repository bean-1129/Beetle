# Submission checklist

Existence checked at 15:41 CDT by the integration owner (script-free refresh).

| # | Deliverable | Where | Exists at time of writing |
|---|---|---|---|
| 1 | Source with lockfiles | repo root: `package.json`, `package-lock.json` (npm workspaces, one lockfile), workspace `package.json` in `apps/server`, `apps/web`, `packages/contracts`, `packages/world`, `packages/observability`, `packages/agent`; git history (24 commits at 13:40 CDT) | yes |
| 2 | Isolated OpenClaw configuration | `packages/agent/src/openclaw.ts` (code exists); isolated home `.openclaw-home/` (ignored, created at first agent run); plugin directory `packages/agent/openclaw-plugin/` | code: yes; `openclaw-plugin/`: yes; `.openclaw-home/`: yes (ignored, not part of the export) |
| 2b | OpenClaw smoke evidence | `packages/agent/SMOKE.md` | yes (tool calls proven against the fake server on port 7711, runs G and J; the run against the real server times out before any model call and is being diagnosed) |
| 3 | `.env.example` | repo root | yes |
| 4 | README | `README.md` | yes (commands table, "What works today" and "Known limitations" updated 13:40 CDT) |
| 5 | Environment report | `docs/ENVIRONMENT.md` | yes (records both LAN addresses seen today: 172.20.65.84 then 192.168.204.116; the USB-tether address 172.20.10.12 is in docs/RUNBOOK.md) |
| 6 | Architecture | `docs/ARCHITECTURE.md` | yes (normalization and security sections at the end) |
| 7 | Local-only checklist | `docs/LOCAL_ONLY_CHECKLIST.md` | yes (offline-proof row depends on 13b, still unrun) |
| 8 | Third-party inventory | `THIRD_PARTY.md` | yes |
| 9 | Benchmark results | `data/benchmarks/*.json` (written by `npm run benchmark:local`, `scripts/benchmark-local.ts`); summary in `docs/MODEL_SELECTION.md` and `docs/RESULTS.md` | yes: three files (`bench-qwen3.5_4b-1791049348895.json`, `bench-qwen3.5_4b-1791050596040.json`, `bench-qwen3.5_4b-1791051548394.json`); `docs/MODEL_SELECTION.md`: yes; `docs/RESULTS.md`: yes, three runs recorded (run 3 after normalization) plus the conflicting-edit and undo checks |
| 9b | Prompt runs | `data/prompt-runs/*.json`, `docs/PROMPTS.md` | yes: three run files (`run-1791049347630.json`, `run-1791049429696.json`, `run-1791052136845.json`), `docs/PROMPTS.md` |
| 9c | Model failure corpus | `tests/fixtures/corpus/` (`summary.json`, draft, patch and probe samples), `docs/MODEL_FAILURE_MODES.md` | yes |
| 9d | Controller latency | `docs/LATENCY.md`, `data/latency/latency-1791050379652.json` | yes |
| 9e | Security review | `docs/SECURITY_REVIEW.md` | yes |
| 10 | Event logs | `data/events/server.jsonl`, `data/events/agent.jsonl` (written by the server and the agent worker at runtime) | `agent.jsonl`: yes; `server.jsonl`: no (the rehearsal servers ran with isolated `BEETLE_DATA_DIR`s under scratch directories; a `--prod` run from the repo root writes it) |
| 10b | Build reports | `data/reports/` | no (directory absent; the build reports from the runs are embedded per attempt in `data/prompt-runs/*.json`) |
| 11 | Runbook | `docs/RUNBOOK.md` | yes (verified versus unrun table, tether note) |
| 12 | Storyboard | `docs/STORYBOARD.md` | yes (rehearsal timings, mode fallback) |
| 13 | Pitch outline and deck | `docs/PITCH_OUTLINE.md`; `docs/pitch/Beetle-pitch.pptx`, `docs/pitch/Beetle-pitch.pdf`, `docs/pitch/build-deck.js`, `docs/pitch/FILL_IN.md` | yes, all five; placeholders filled with measured values except the video frame, the mode word in one caption, session continuity and offline proof (stated as not measured, see FILL_IN.md) |
| 13b | Offline proof procedure and records | `docs/OFFLINE_PROOF.md` (manual procedure, not executed automatically); `data/offline-proof/<unix ms>.json` from `scripts/offline-proof.mjs` | procedure: yes; records: one "before" record only (`1791049273707.json`, egress NOT blocked, server not up); no record from a rehearsal with the route removed |
| 13c | Recording guide | `docs/RECORDING.md`, `scripts/record-demo.sh`, `scripts/caption-video.sh` | guide: yes; recording itself: not made yet (`data/recordings/` not checked here) |
| 14 | Demo export folder | `submission/<yyyy-mm-dd-hhmm>/` from `node scripts/export-demo.mjs` (copies data, docs, root docs, package manifests, git log, demo-check output; `MANIFEST.json` with size and sha256 per file; secrets excluded and token-like JSON keys redacted) | yes but stale: `submission/2026-10-03-1244/` predates every run and doc above; re-export before packaging |
| 15 | BUILD_STATUS.md | `BUILD_STATUS.md` | yes (owned by the integration owner; see its "Last updated" line) |
| 16 | Web build | `apps/web/dist/` (`npm run build`), served by the server in `--prod` | yes |
| 17 | Tests | `tests/unit/`, `tests/integration/`, `apps/server/src/*.test.ts` | `tests/unit`: yes (agent, compiler, contracts, corpus, movement, normalize, validators, world-adversarial); `tests/integration`: yes (`server.test.ts`, `live-agent.test.ts`); results in BUILD_STATUS.md |
| 18 | Model logs | `data/logs/` (probe, ollama serve, 27b pull logs) | yes |

## Before packaging (final 30 minutes)

1. Update `BUILD_STATUS.md` (status table, test cases 1 to 18, offline-proof result, known gaps). Do not claim anything that was not run.
2. Run the demo once in `--prod` mode from the repo root so `data/events/*.jsonl` and `data/snapshots/` contain real entries. Review `data/events/*.jsonl` for anything token-like (the export redacts keys matching token, secret or invite, but check the free-text fields).
3. `node scripts/offline-proof.mjs` (and during the rehearsal the `--edit` form from `docs/OFFLINE_PROOF.md`). Paste the verdict lines into BUILD_STATUS.md. Until this is done the offline proof stays "not run" everywhere.
4. `node scripts/export-demo.mjs` and read its summary: the "Not present" list is the list of missing deliverables; `demo-check.txt` inside the folder is the readiness check as it was at export time (exit code recorded in the file).
5. Verify the export never contains secrets: `grep -rIl -E "[0-9a-f]{32}" submission/<stamp>/ --include=*.json --include=*.jsonl` should print only files whose matches are sha256 digests or ids (world digests, proof ids), never `directorToken`, `agentToken` or `controllerToken` values; `ls submission/<stamp>/.env submission/<stamp>/data/secrets.json` must fail.
6. Commit (the user pushes; no credentials on the machine, see BUILD_STATUS.md "Blocked").

## Re-check command

```bash
for p in package.json package-lock.json packages/agent/SMOKE.md packages/agent/openclaw-plugin .openclaw-home .env.example README.md \
  docs/ENVIRONMENT.md docs/ARCHITECTURE.md docs/LOCAL_ONLY_CHECKLIST.md THIRD_PARTY.md data/benchmarks docs/MODEL_SELECTION.md docs/RESULTS.md \
  data/prompt-runs docs/PROMPTS.md tests/fixtures/corpus docs/MODEL_FAILURE_MODES.md docs/LATENCY.md data/latency docs/SECURITY_REVIEW.md \
  data/events/server.jsonl data/events/agent.jsonl data/reports docs/RUNBOOK.md docs/STORYBOARD.md docs/PITCH_OUTLINE.md \
  docs/pitch/Beetle-pitch.pptx docs/pitch/Beetle-pitch.pdf docs/pitch/FILL_IN.md docs/OFFLINE_PROOF.md data/offline-proof docs/RECORDING.md \
  submission BUILD_STATUS.md apps/web/dist tests/unit tests/integration data/logs; do
  [ -e "$p" ] && echo "EXISTS  $p" || echo "MISSING $p"; done
```

Result at 13:40 CDT: everything above EXISTS except `data/events/server.jsonl` and `data/reports`.
