# OpenClaw smoke test (real model, fake Beetle server on 7711)

Date: 2026-10-03. OpenClaw 2026.9.8 (fc23bc8) at `.tools/npm-global/bin/openclaw`. Ollama 0.35.1 at http://127.0.0.1:11434, model qwen3.5:4b (Q4_K_M).
The Beetle server was never started; every request below hit the fake server in `packages/agent/test-support/fake-beetle-server.ts`, which records method, path and whether the Bearer token matched.

## What was proven

OpenClaw's embedded agent run (`openclaw agent exec`) with the Beetle tool plugin installed in the isolated home `.openclaw-home/` made the model (qwen3.5:4b, native Ollama API, thinking off) call, over HTTP against the fake server:
`read_world_state` -> `propose_patch` (rejected 400 at the boundary once, then accepted) -> `validate_candidate` -> `run_playability_checks` -> `commit_candidate` (world v2) -> `publish_build_report`.
This happened twice (runs G and J below) with two slightly different deny lists. The second fake-server log also shows the worker path (claim, status, report, finish) working; that run timed out at the model because the shared GPU was saturated (see "Failures observed").

## Setup commands (exact)

```bash
export PATH=/home/dell/Beetle/.tools/node/bin:/home/dell/Beetle/.tools/npm-global/bin:$PATH
export OPENCLAW_STATE_DIR=/home/dell/Beetle/.openclaw-home OPENCLAW_CONFIG_PATH=/home/dell/Beetle/.openclaw-home/openclaw.json

# plugin: bundle, generate manifest, validate
node packages/agent/openclaw-plugin/build.mjs
openclaw plugins build --root packages/agent/openclaw-plugin --entry ./dist/index.js      # Wrote openclaw.plugin.json
openclaw plugins validate --root packages/agent/openclaw-plugin --entry ./dist/index.js   # Plugin beetle-tools is valid.

# isolated home config (written by the agent's setup code), then the documented local install
npm run agent -- --mode openclaw --setup-openclaw
openclaw plugins install /home/dell/Beetle/packages/agent/openclaw-plugin --force --accept-capabilities
openclaw plugins inspect beetle-tools --runtime     # Status: loaded, Tools: the seven Beetle tools
openclaw config validate                            # Config valid
```

Notes from the install: the first install attempt without `--accept-capabilities` stops with "requires capability consent"; the loader also refuses a plugin whose package.json declares a dependency that is not in its node_modules, so typebox and zod are bundled into `dist/index.js` and not declared as dependencies.

## Fake server and the run

```bash
BEETLE_FAKE_PORT=7711 BEETLE_FAKE_TOKEN=<48 hex> BEETLE_FAKE_LOG=<log> BEETLE_FAKE_STATE=<state.json> BEETLE_FAKE_REQUEST_ID=req-smoke-1 \
  npx tsx packages/agent/test-support/run-fake-server.ts
# queued request req-smoke-1 (edit): Turn the water into lava and add a bridge from the orchard island to the temple island.

BEETLE_SERVER_URL=http://127.0.0.1:7711 BEETLE_AGENT_TOKEN=<same token> BEETLE_REQUEST_ID=req-smoke-1 BEETLE_MODEL=qwen3.5:4b \
BEETLE_OPENCLAW_RUN_FILE=<run.jsonl> \
openclaw agent exec --config /home/dell/Beetle/.openclaw-home/openclaw.json --model ollama/qwen3.5:4b --thinking off \
  --code-mode direct --json --timeout 240 --cwd /home/dell/Beetle/.openclaw-home/workspace --message-file <prompt.txt>
```

The prompt file is `openclawInstructionPrompt()` from `packages/agent/src/prompts.ts`:

```
You are Beetle, a local game-prototyping teammate. You change a running two-player relic-hunt world only through the Beetle tools; never answer with prose before the tools are done.
Request id: req-smoke-2. Pass it as requestId to propose_world, propose_patch and publish_build_report.
Coordinates: walk plane XZ, up is Y, north is +Z, east is +X, units metres, origin at the world centre.
Islands are circles (center, radius 4 to 14) that must keep a gap of at least 1 m from each other. Keep every centre within plus or minus 44.
Bridges join two different islands by id, width 1.6 to 4, length 1 to 36 m between the island rims, and must not cross a third island.
Objects (spawns, relics, gate, decorations) sit on an island; localPosition is an offset from that island centre and must stay inside the radius minus 1.5.
Ids are lowercase slugs (letters, digits, dash, underscore, max 32 chars) and unique across the whole world.
Procedure for an edit request:
1. Call read_world_state to get the island ids, names and compass directions.
2. Call propose_patch with { requestId, summary, ops } using only these ops: add_bridge, remove_bridge, set_hazard, add_decoration, move_decoration, remove_decoration, move_relic, set_title. Change only what the request asks for.
3. Call validate_candidate with the candidateId. If ok is false, read the issues (code, objectIds, evidence), call propose_patch again with a corrected patch, then validate again. At most 2 repairs.
4. Call run_playability_checks with the candidateId.
5. Call commit_candidate with the candidateId and the proofId from the successful validation. If it fails with OCCUPIED_SUPPORT and retryable is true, call commit_candidate once more with the same proofId.
6. Call publish_build_report with requestId, outcome, summary and the worldVersion from the commit, then reply with one sentence.
Director's edit request: Turn the water into lava and add a bridge from the orchard island to the temple island.
```

## Run G (12:49 local): fake server log excerpt

Every line is one HTTP request as seen by the fake server (`token=ok` means the Bearer agent token matched). Status posts come from the plugin itself (phase updates), the `tool=` column maps the route to the Beetle tool.

```
2026-10-03T17:49:05.276Z #3 POST /api/agent/requests/req-smoke-1/status token=ok status=200
2026-10-03T17:49:05.281Z #4 GET /api/agent/world token=ok status=200 tool=read_world_state
2026-10-03T17:49:07.719Z #5 POST /api/agent/requests/req-smoke-1/status token=ok status=200
2026-10-03T17:49:07.721Z #6 POST /api/agent/candidates/patch token=ok status=400 tool=propose_patch
2026-10-03T17:49:07.724Z #7 POST /api/agent/requests/req-smoke-1/status token=ok status=200
2026-10-03T17:49:09.898Z #8 POST /api/agent/requests/req-smoke-1/status token=ok status=200
2026-10-03T17:49:09.900Z #9 POST /api/agent/candidates/patch token=ok status=200 tool=propose_patch
2026-10-03T17:49:10.754Z #10 POST /api/agent/requests/req-smoke-1/status token=ok status=200
2026-10-03T17:49:10.755Z #11 POST /api/agent/candidates/cand-103a77f5/validate token=ok status=200 tool=validate_candidate
2026-10-03T17:49:11.602Z #12 POST /api/agent/requests/req-smoke-1/status token=ok status=200
2026-10-03T17:49:11.604Z #13 POST /api/agent/candidates/cand-103a77f5/playability token=ok status=200 tool=run_playability_checks
2026-10-03T17:49:13.060Z #14 POST /api/agent/requests/req-smoke-1/status token=ok status=200
2026-10-03T17:49:13.062Z #15 POST /api/agent/candidates/cand-103a77f5/commit token=ok status=200 tool=commit_candidate
2026-10-03T17:49:13.063Z #16 POST /api/agent/requests/req-smoke-1/status token=ok status=200
2026-10-03T17:49:14.634Z #17 POST /api/agent/reports token=ok status=200 tool=publish_build_report
```

Status updates recorded by the fake server (real phases, mode label):

```
planning              | [openclaw] reading the current world
planning              | [openclaw] staging patch: Turn water hazard into lava and add bridge from orchard to temple island
repairing             | [openclaw] patch rejected at the boundary ["INVALID_SCHEMA"]
planning              | [openclaw] staging patch: Turn water hazard into lava and add bridge from orchard to temple island
validating            | [openclaw] validating the candidate
validating            | [openclaw] running connectivity and supported-movement checks
awaiting_safe_commit  | [openclaw] committing at the next safe tick
committed             | [openclaw] committed v2
```

Build report published by the model through `publish_build_report` (stored by the fake server):

```json
{
  "reportId": "report-d9e3faca",
  "requestId": "req-smoke-1",
  "mode": "openclaw",
  "model": "qwen3.5:4b",
  "outcome": "committed",
  "worldVersion": 2,
  "baseWorldVersion": 1,
  "summary": "[openclaw] Changed hazard from water to lava and added bridge from orchard to temple island",
  "validation": {
    "attempts": 2,
    "failedCodes": [
      "INVALID_SCHEMA"
    ]
  },
  "playability": {
    "ok": true,
    "checks": 2,
    "failed": 0
  },
  "timings": {
    "requestedAt": 1791049735079,
    "firstModelResponseMs": 10191,
    "validatedMs": 15677,
    "committedMs": 17984,
    "totalMs": 19553
  },
  "toolCalls": [
    {
      "tool": "read_world_state",
      "ok": true,
      "ms": 3
    },
    {
      "tool": "propose_patch",
      "ok": false,
      "ms": 3
    },
    {
      "tool": "propose_patch",
      "ok": true,
      "ms": 3
    },
    {
      "tool": "validate_candidate",
      "ok": true,
      "ms": 1
    },
    {
      "tool": "run_playability_checks",
      "ok": true,
      "ms": 1
    },
    {
      "tool": "commit_candidate",
      "ok": true,
      "ms": 2
    }
  ],
  "createdAt": 1791049754634
}
```

Resulting fake world state: version 2, hazard lava, bridges [bridge-temple, bridge-east, bridge-west, bridge-south, bridge-new]. The first `propose_patch` was a 400 (INVALID_SCHEMA at the boundary); the model repaired and the second was accepted.

## Run J (13:01 local): exec envelope and plugin run file

`openclaw agent exec --json` envelope (stdout):

```json
{
  "ok": true,
  "status": "ok",
  "final": "Done: hazard changed from water to lava and bridge added from orchard to temple island.",
  "usage": {
    "input": 7404,
    "output": 511,
    "cacheRead": 45977,
    "cacheWrite": 0,
    "total": 53892,
    "cost": {
      "total": 0
    }
  },
  "codeModeEngaged": false,
  "assistantTurns": 9,
  "toolSummary": {
    "calls": 7,
    "tools": [
      "read_world_state",
      "propose_patch",
      "validate_candidate",
      "run_playability_checks",
      "commit_candidate",
      "publish_build_report"
    ],
    "failures": 0
  },
  "model": "qwen3.5:4b",
  "provider": "ollama",
  "sessionId": "4a9b020b-78e8-4077-b87e-b49e376f5028"
}
```

Plugin evidence file (`BEETLE_OPENCLAW_RUN_FILE`, one line per tool call, commit and report):

```
{"at":1791050607177,"mode":"openclaw","kind":"tool","tool":"read_world_state","ok":true,"ms":2}
{"at":1791050609507,"mode":"openclaw","kind":"tool","tool":"propose_patch","ok":false,"ms":1}
{"at":1791050611937,"mode":"openclaw","kind":"tool","tool":"propose_patch","ok":true,"ms":3}
{"at":1791050612734,"mode":"openclaw","kind":"tool","tool":"validate_candidate","ok":true,"ms":2}
{"at":1791050613544,"mode":"openclaw","kind":"tool","tool":"run_playability_checks","ok":true,"ms":1}
{"at":1791050614987,"mode":"openclaw","kind":"tool","tool":"commit_candidate","ok":true,"ms":1}
{"at":1791050614987,"mode":"openclaw","kind":"commit","ok":true,"worldVersion":2,"deferredMs":0,"idempotentReplay":false}
{"at":1791050616574,"mode":"openclaw","kind":"tool","tool":"publish_build_report","ok":true,"ms":2}
{"at":1791050616574,"mode":"openclaw","kind":"report","ok":true,"reportId":"report-3a2701c1","outcome":"committed"}
```

Fake server log for the same window:

```
2026-10-03T18:03:27.172Z #7 POST /api/agent/requests/req-smoke-2/status token=ok status=200
2026-10-03T18:03:27.175Z #8 GET /api/agent/world token=ok status=200 tool=read_world_state
2026-10-03T18:03:29.505Z #9 POST /api/agent/requests/req-smoke-2/status token=ok status=200
2026-10-03T18:03:29.506Z #10 POST /api/agent/candidates/patch token=ok status=400 tool=propose_patch
2026-10-03T18:03:29.508Z #11 POST /api/agent/requests/req-smoke-2/status token=ok status=200
2026-10-03T18:03:31.933Z #12 POST /api/agent/requests/req-smoke-2/status token=ok status=200
2026-10-03T18:03:31.936Z #13 POST /api/agent/candidates/patch token=ok status=200 tool=propose_patch
2026-10-03T18:03:32.731Z #14 POST /api/agent/requests/req-smoke-2/status token=ok status=200
2026-10-03T18:03:32.733Z #15 POST /api/agent/candidates/cand-773891fe/validate token=ok status=200 tool=validate_candidate
2026-10-03T18:03:33.542Z #16 POST /api/agent/requests/req-smoke-2/status token=ok status=200
2026-10-03T18:03:33.544Z #17 POST /api/agent/candidates/cand-773891fe/playability token=ok status=200 tool=run_playability_checks
2026-10-03T18:03:34.985Z #18 POST /api/agent/requests/req-smoke-2/status token=ok status=200
2026-10-03T18:03:34.986Z #19 POST /api/agent/candidates/cand-773891fe/commit token=ok status=200 tool=commit_candidate
2026-10-03T18:03:34.987Z #20 POST /api/agent/requests/req-smoke-2/status token=ok status=200
2026-10-03T18:03:36.573Z #21 POST /api/agent/reports token=ok status=200 tool=publish_build_report
```

## Config file (.openclaw-home/openclaw.json, gateway token redacted)

Generated by `buildOpenClawConfig()` in `packages/agent/src/openclaw.ts` and audited by `auditOpenClawConfig()` before every run (one loopback provider, no fallbacks, loopback gateway, plugins.allow only beetle-tools, exec denied, updates and telemetry off).

```json
{
  "models": {
    "mode": "replace",
    "providers": {
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434",
        "apiKey": "ollama-local",
        "api": "ollama",
        "timeoutSeconds": 300,
        "models": [
          {
            "id": "qwen3.5:4b",
            "name": "qwen3.5:4b",
            "reasoning": false,
            "input": [
              "text"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 32768,
            "contextTokens": 8192,
            "maxTokens": 2048,
            "params": {
              "num_ctx": 8192,
              "think": false,
              "temperature": 0.2,
              "keep_alive": "15m"
            }
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "ollama/qwen3.5:4b",
        "fallbacks": []
      },
      "thinkingDefault": "off",
      "workspace": "/home/dell/Beetle/.openclaw-home/workspace",
      "skipBootstrap": true,
      "sandbox": {
        "mode": "off"
      }
    }
  },
  "tools": {
    "profile": "minimal",
    "alsoAllow": [
      "beetle-tools",
      "read_world_state",
      "propose_world",
      "propose_patch",
      "validate_candidate",
      "run_playability_checks",
      "commit_candidate",
      "publish_build_report"
    ],
    "deny": [
      "exec",
      "process",
      "read",
      "write",
      "edit",
      "apply_patch",
      "browser",
      "web_fetch",
      "web_search",
      "fetch",
      "gateway",
      "cron",
      "sessions_spawn",
      "sessions_send",
      "sessions_list",
      "sessions_history",
      "session_status",
      "canvas",
      "image",
      "nodes",
      "message",
      "memory_search",
      "memory_get",
      "tts",
      "openclaw",
      "skills",
      "plugins_install",
      "presence"
    ],
    "toolSearch": false,
    "exec": {
      "security": "deny"
    },
    "fs": {
      "workspaceOnly": true
    },
    "web": {
      "search": {
        "enabled": false
      },
      "fetch": {
        "enabled": false
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 18799,
    "auth": {
      "mode": "token",
      "token": "[redacted]"
    }
  },
  "update": {
    "checkOnStart": false,
    "auto": {
      "enabled": false
    }
  },
  "telemetry": {
    "enabled": false
  },
  "diagnostics": {
    "otel": {
      "enabled": false
    }
  },
  "plugins": {
    "enabled": true,
    "allow": [
      "beetle-tools"
    ],
    "entries": {
      "beetle-tools": {
        "enabled": true,
        "config": {
          "serverUrl": "http://127.0.0.1:7711",
          "secretsPath": "/home/dell/Beetle/data/secrets.json",
          "model": "qwen3.5:4b"
        }
      }
    }
  },
  "meta": {
    "migrations": {
      "modelPolicyAllowlist": true,
      "utilityModelSeparation": true
    },
    "lastTouchedVersion": "2026.9.8"
  }
}
```

## Failures observed (honest log)

1. `tools.allow` (the absolute allowlist) hides plugin tools from the embedded run on 2026.9.8: every exec with it failed immediately with
   "No callable tools remain after resolving explicit tool allowlist (tools.allow: beetle-tools, read_world_state, ...); no registered tools matched", even though `openclaw plugins inspect beetle-tools --runtime --json` lists the seven tools as registered. `tools.alsoAllow` with `tools.profile: "minimal"` plus an explicit `tools.deny` list is what works. Variants tried before finding this: `--state-dir`, `plugins.load.paths`, `agent --local`, debug and lifecycle tracing (all with the same error).
2. Without any allow list the minimal profile still exposes the core `presence` tool, which the 4B model called five times; it is therefore on the deny list.
3. The first worker-driven run (req-smoke-2, 12:53 local) and two direct execs with a deny list extended to the whole core catalog timed out at the model with one assistant turn and no tool call ("Request timed out before a response was generated"). Ollama's log shows the shared GPU saturated by another workload at that time (other clients' /api/chat calls taking 30 s to 1m32s, several in flight), our request waiting in Ollama's queue and being aborted after 15 s of actual processing, and no /api/chat completing at all after 13:03:16 (a 5-token probe got no answer in 20 s, GPU utilisation 91 percent). Run J, with the 27-name deny list, succeeded in the same period at 13:01. The extended list therefore stays opt-in (BEETLE_OPENCLAW_EXTENDED_DENY=1) and unverified; the shipped default is the verified list plus `presence`.
4. The model's first `propose_patch` in both successful runs was rejected at the boundary (INVALID_SCHEMA); the tool returned the issues and the model repaired on the next turn. The server's zod schemas remain the only gate.

## Direct mode (labelled fallback)

Direct mode runs the same bounded job in-process (`packages/agent/src/jobs.ts`) and is covered by `npx vitest run tests/unit/agent.test.ts` (14 tests, fake Ollama plus fake Beetle server) and by `scripts/benchmark-local.ts` against the real model. It is labelled `[direct]` in every status message, report and event and is never presented as OpenClaw.

## Root cause of the OpenClaw-path timeouts (added 13:40 local, after the live rehearsal failure)

Symptom (coordinator's run against the real server on 7781, and my runs K, L, M, N, P): `openclaw agent exec` ends with status "timeout", assistantTurns 1, no tool calls, empty run jsonl, while the direct path still answers in seconds at other moments.

What was measured:

1. A logging proxy on 127.0.0.1:11435 in front of Ollama shows OpenClaw sends its model request about 4 s after launch: `POST /api/chat model=qwen3.5:4b stream=true think=false msgs=2 tools=7 num_ctx=8192 bytes=17418`. Nothing in OpenClaw blocks before the model call (plugin load, session sqlite, gateway and update check all passed; the config has update checks and telemetry off).
2. Ollama's own log (`data/logs/ollama-serve-2.log`) contains no `/api/chat` completion during the coordinator's run window (13:24:14 to 13:27:14) and none at all after 13:32:51, while the runner logs `srv update_slots: all slots are idle`. A direct 5-token `/api/chat` probe (curl, no OpenClaw) hangs for 10, 30 and 60 s. Requests are stuck inside Ollama's scheduler, for every client.
3. Earlier in the afternoon the same daemon was serializing all qwen35 requests (`model architecture does not currently support parallel requests architecture=qwen35`, so OLLAMA_NUM_PARALLEL=4 is ignored) behind other clients' 1 to 2 minute generations. OpenClaw's Ollama adapter abandons a request after about 100 s ("LLM request failed: network connection error, failoverReason=timeout" in run J, then "transient same-model retry 1/8", then success in 20 s). An edit through OpenClaw needed 7 to 9 sequential model turns, each queued, each abandoned and re-queued after 100 s, so a 180 s run deadline could not be met; the direct path needs one or two calls and fits into a gap.

The plugin bundle and config in this repo were never the cause: run G and run J (same plugin, same deny list as the shipped default) completed the full tool chain, see above.

What changed in packages/agent as a result:

- The plugin now stages and validates in one call (`propose_patch` / `propose_world` run validate_candidate and run_playability_checks and return the proofId) and `commit_candidate` publishes the build report. An edit is three tool calls (four model turns) instead of seven; the seven tools still exist and work individually.
- The embedded run gets its own timeout, `BEETLE_OPENCLAW_TIMEOUT_MS` (default 600000, never below BEETLE_REQUEST_DEADLINE_MS), and `agents.defaults.timeoutSeconds` is set to match in the generated config.
- The runner audits the config on disk before every run and refuses anything that is not the loopback profile.

Blocker that remains outside this package: the Ollama daemon must be serving `/api/chat`. While it is wedged (idle runner, no completions, probes hang) neither mode can work; while it is merely saturated by another client, the OpenClaw path needs the longer timeout above. Recommended: restart Ollama with OLLAMA_NUM_PARALLEL=1 (qwen35 ignores higher values anyway) and keep the corpus builder and the `ollama pull qwen3.8:27b` (restarted at 13:19 after "digest mismatch, file must be downloaded again") away from the rehearsal window; then rerun `npm run agent -- --mode openclaw --once` against a server with a fixture world. The shortened flow has not been verified end to end with the real model because of the wedge; runs G and J verified the previous flow.

## Plugin schema catch-up and live brief on 7797 (added 14:58 local)

Problem: `packages/agent/openclaw-plugin/src/index.ts` declared typebox schemas for `propose_world` and `propose_patch` that predated the mode/biome contract, so the model could not pass `mode`, `biome`, `movementSpeed`, `hazardRise` or the `set_mode`, `set_biome`, `set_movement` ops through OpenClaw.

What changed in the plugin (mirrors `packages/contracts/src/world.ts` WorldDraftSchema and `patch.ts` PatchOpSchema):

- `worldDraftSchema`: optional `biome` (garden, volcanic, frost, desert, night), `mode` { kind: relic_hunt | time_trial | king_of_the_hill | checkpoint_race | survival; timeLimitSec 20..600; holdSeconds 3..60; relicsRequired 1..3; orderedCheckpoints }, `movementSpeed` 3..7, `hazardRise` { afterSec 5..300, metersPerSec 0.01..0.5, maxElevation -2..-0.6 }. Decoration types come from `DECORATION_TYPES` (tree, rock, lantern, pillar, bush, shrine, tower, ruin, crystal, mushroom, statue).
- `patchOpSchema`: optional `mode` (set_mode), `biome` (set_biome), `speed` (set_movement); `op` lists all eleven `PATCH_OP_NAMES`.
- `read_world_state` now also returns `biome`, `mode` and `movementSpeed` so an edit can see the current mode.
- Context budget: the first live attempt with the new fields (req-fd265d37) failed at the model with `request (8202 tokens) exceeds the available context size (8192 tokens)` (OpenClaw diag: payload 29244 bytes, tools 12131 bytes of it). Every enum was serialised as `anyOf` of `const` literals and every field carried a description. The schemas were compacted: enums as `{type: string, enum: [...]}` (typebox `Type.Unsafe`, which `Value.Check` accepts), one description per schema instead of per field, shorter tool descriptions. Serialised tool definitions went from 12131 to 7227 bytes (about 1200 tokens). The OpenClaw system prompt (about 14 KB) and `num_ctx: 8192` are outside this package; a brief now fits with roughly 1 KB of headroom on the commit turn.

Commands run (exact):

```bash
node packages/agent/openclaw-plugin/build.mjs                                               # dist/index.js 395.5kb
openclaw plugins build --root packages/agent/openclaw-plugin --entry ./dist/index.js        # Wrote openclaw.plugin.json
openclaw plugins validate --root packages/agent/openclaw-plugin --entry ./dist/index.js     # Plugin beetle-tools is valid.
openclaw plugins install /home/dell/Beetle/packages/agent/openclaw-plugin --force --accept-capabilities
openclaw plugins inspect beetle-tools --runtime     # Status: loaded; Tools: the seven Beetle tools; Installed at 2026-10-03T19:53:20Z
```

Live run (real server, real model, no fixture world):

```bash
BEETLE_HOST=127.0.0.1 BEETLE_PORT=7797 BEETLE_DATA_DIR=<scratch>/server-data BEETLE_DIRECTOR_TOKEN=<48 hex> BEETLE_AGENT_TOKEN=<48 hex> BEETLE_START_WORLD=none \
  npx tsx apps/server/src/main.ts
BEETLE_SERVER_URL=http://127.0.0.1:7797 BEETLE_AGENT_TOKEN=<same> BEETLE_DATA_DIR=<scratch>/agent-data BEETLE_OPENCLAW_TIMEOUT_MS=600000 \
  npx tsx packages/agent/src/main.ts --mode openclaw --once
POST /api/director/requests {"kind":"brief","prompt":"King of the hill on a frozen arena of four islands, hold the hill for ten seconds","authorizeNewWorld":true}
```

Result (req-2f8eddb1, claimed 14:54:03 local): `openclaw agent exec` status ok, 3 assistant turns, usage input 16613 / output 856 tokens over the run. Plugin run file: `propose_world` ok -> `validate_candidate` ok -> `run_playability_checks` ok (all inside the one propose call) -> `commit_candidate` ok, world v1, deferredMs 0 -> `publish_build_report` ok (rep-cd4d7fc9, outcome committed). Worker: `committed v1 (189665 ms)`. The model skipped `read_world_state` for the fresh brief and the first `propose_world` was accepted without a repair.

`GET /api/world` afterwards: `hasWorld true, version 1`, `summary.mode = { kind: "king_of_the_hill", timeLimitSec: null, holdSeconds: 10, relicsRequired: 3 }`, `summary.biome = "frost"`, title "Frozen King of the Hill Arena", 4 islands, 3 bridges, `spec.movement.speed 5`. Both requested fields landed: `summary.mode.kind = king_of_the_hill`, `summary.biome = frost`.

Not explained: the 7797 server process received SIGTERM twice, each time within the same second that the `--once` worker exited (after the failed run and after the committed run); the world and report were already persisted, and a restart restored `world-current.json` as version 1, which is where the `GET /api/world` above was taken. The server was started with `setsid nohup` the second time, so it was not process-group signalling from the worker's shell; not investigated further.
