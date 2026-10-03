# Submission checklist

Checked against the filesystem on 2026-10-03 at 12:45 CDT (deadline 15:32 CDT). "Exists" means the file or folder was present at that moment; it says nothing about whether the content is final. Re-check with the command at the bottom before packaging. The deliverable names follow the list in BUILD_STATUS.md.

| # | Deliverable | Where | Exists at time of writing |
|---|---|---|---|
| 1 | Source with lockfiles | repo root: `package.json`, `package-lock.json` (npm workspaces, one lockfile), workspace `package.json` in `apps/server`, `apps/web`, `packages/contracts`, `packages/world`, `packages/observability`, `packages/agent`; git history (4 commits at time of writing) | yes |
| 2 | Isolated OpenClaw configuration | `packages/agent/src/openclaw.ts` (code exists); isolated home `.openclaw-home/` (ignored, created at first agent run); plugin directory `packages/agent/openclaw-plugin/` | code: yes; `openclaw-plugin/`: yes (build.mjs, openclaw.plugin.json, src, dist; appeared 12:45 CDT); `.openclaw-home/`: yes (openclaw.json, runs, workspace; ignored, not part of the export) |
| 2b | OpenClaw smoke evidence | `packages/agent/SMOKE.md` | no (agent owner; export-demo copies it automatically once present) |
| 3 | `.env.example` | repo root | yes |
| 4 | README | `README.md` | yes |
| 5 | Environment report | `docs/ENVIRONMENT.md` | yes (LAN address in it is stale: 172.20.65.84 then, 192.168.204.116 now) |
| 6 | Architecture | `docs/ARCHITECTURE.md` | yes |
| 7 | Local-only checklist | `docs/LOCAL_ONLY_CHECKLIST.md` | yes (offline-proof row still "unverified"; see 13b) |
| 8 | Third-party inventory | `THIRD_PARTY.md` | yes |
| 9 | Benchmark results | `data/benchmarks/*.json` (written by `npm run benchmark:local`, `scripts/benchmark-local.ts`); summary in `docs/RESULTS.md` | benchmark file: yes (`bench-qwen3.5_4b-1791049348895.json`); `docs/RESULTS.md`: exists but states "NOT YET RUN" (placeholder until the live run) |
| 9b | Prompt runs | `data/prompt-runs/*.json`, `docs/PROMPTS.md` | yes: one run file, `docs/PROMPTS.md` |
| 10 | Event logs | `data/events/server.jsonl`, `data/events/agent.jsonl` (written by the server and the agent worker at runtime) | no (directory exists, empty; no demo run yet) |
| 10b | Build reports | `data/reports/` | no (written by the server when an agent job publishes a report) |
| 11 | Runbook | `docs/RUNBOOK.md` | yes |
| 12 | Storyboard | `docs/STORYBOARD.md` | yes |
| 13 | Pitch outline | `docs/PITCH_OUTLINE.md` | yes |
| 13b | Offline proof procedure and records | `docs/OFFLINE_PROOF.md` (manual procedure, not executed automatically); `data/offline-proof/<unix ms>.json` from `scripts/offline-proof.mjs` | procedure: yes; records: one "before" record (`1791049273707.json`, egress NOT blocked, server not up); no record from a rehearsal with the route removed |
| 14 | Demo export folder | `submission/<yyyy-mm-dd-hhmm>/` from `node scripts/export-demo.mjs` (copies data, docs, root docs, package manifests, git log, demo-check output; `MANIFEST.json` with size and sha256 per file; secrets excluded and token-like JSON keys redacted) | yes: `submission/2026-10-03-1244/` (30 files, 290 KiB, demo-check exit 0 with server-health and secrets rows failing because no server was running) |
| 15 | BUILD_STATUS.md | `BUILD_STATUS.md` | yes (last updated 12:35 CDT; test-case table still all "pending") |
| 16 | Web build | `apps/web/dist/` (`npm run build`), served by the server in `--prod` | yes |
| 17 | Tests | `tests/unit/`, `tests/integration/`, `apps/server/src/*.test.ts` | `tests/unit`: yes (agent, compiler, contracts, movement, validators); `tests/integration`: directory exists, empty; results belong in BUILD_STATUS.md |

## Before packaging (final 30 minutes)

1. Update `BUILD_STATUS.md` (status table, test cases 1 to 18, offline-proof result, known gaps). Do not claim anything that was not run.
2. Run the demo once in `--prod` mode so `data/events/*.jsonl`, `data/reports/` and `data/snapshots/` contain real entries. Review `data/events/*.jsonl` for anything token-like (the export redacts keys matching token, secret or invite, but check the free-text fields).
3. `node scripts/offline-proof.mjs` (and during the rehearsal the `--edit` form from `docs/OFFLINE_PROOF.md`). Paste the verdict lines into BUILD_STATUS.md.
4. `node scripts/export-demo.mjs` and read its summary: the "Not present" list is the list of missing deliverables; `demo-check.txt` inside the folder is the readiness check as it was at export time (exit code recorded in the file).
5. Verify the export never contains secrets: `grep -rIl -E "[0-9a-f]{32}" submission/<stamp>/ --include=*.json --include=*.jsonl` should print only files whose matches are sha256 digests or ids (world digests, proof ids), never `directorToken`, `agentToken` or `controllerToken` values; `ls submission/<stamp>/.env submission/<stamp>/data/secrets.json` must fail.
6. Commit (the user pushes; no credentials on the machine, see BUILD_STATUS.md "Blocked").

## Re-check command

```bash
for p in package.json package-lock.json packages/agent/SMOKE.md packages/agent/openclaw-plugin .openclaw-home .env.example README.md \
  docs/ENVIRONMENT.md docs/ARCHITECTURE.md docs/LOCAL_ONLY_CHECKLIST.md THIRD_PARTY.md data/benchmarks docs/RESULTS.md \
  data/events/server.jsonl data/events/agent.jsonl data/reports docs/RUNBOOK.md docs/STORYBOARD.md docs/PITCH_OUTLINE.md \
  docs/OFFLINE_PROOF.md data/offline-proof submission BUILD_STATUS.md apps/web/dist; do
  [ -e "$p" ] && echo "EXISTS  $p" || echo "MISSING $p"; done
```
