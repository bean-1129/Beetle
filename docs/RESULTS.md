# Live run record

Status: RUN COMPLETE (2026-10-03, 12:42 to 12:47 CDT). Every number below comes from the two run files listed under
"Run setup"; nothing is estimated or fabricated. Failed attempts are reported exactly as they happened.

Headline: of the six edits, two committed (E1, E5), four failed; both briefs (B1, B2) failed. The validator and the
model-output boundary rejected every invalid candidate (no bad world was ever committed), but none of the rejected
candidates was repaired into a passing one. The dominant failure is the local model inventing object ids
(`orchard-island`, `hearth-island`, `relic-sun`) even though the world description it receives lists the real ids
(`east`, `centre`, `relic-east`), which surfaces as INVALID_REFERENCE at `propose_patch`.

## Run setup

| Item | Value |
|---|---|
| Run files | `data/prompt-runs/run-1791049347630.json` (run 1, cut short by an external SIGTERM to the server after E2; E1 and E2 are real results, E3 to B2 were never sent) and `data/prompt-runs/run-1791049429696.json` (run 2, complete, the one summarised below) |
| Date and time | run 1 started 12:42:27 CDT, run 2 started 12:43:49 CDT and finished 12:47:09 CDT |
| Server | `apps/server/src/main.ts` on `http://127.0.0.1:7790`, `BEETLE_START_WORLD=fixture` (garden5 loaded as world version 1), isolated data dir under the session scratchpad, own director and agent tokens via env |
| Agent | `packages/agent/src/main.ts --mode direct` (labelled `direct / qwen3.5:4b` in every build report); defaults: request deadline 120 s, 2 repair attempts, 3 model-output attempts, patch draft budget 512 tokens, world draft budget 2048 tokens |
| Model | qwen3.5:4b on Ollama 127.0.0.1:11434, warm (it had served the probe and run 1 before run 2) |
| Players | none connected during the run, so PLAYER_CUT_OFF, OCCUPIED_SUPPORT and the "players preserved" claim were not exercised here |
| Prompts | docs/PROMPTS.md: E1 to E6 in order, then B1 and B2 (B3 to B6 not sent, see "Not run") |
| Timeout per request | 240 s (none hit it) |
| Commands | see the bottom of this file |

## Attempts (run 2, all of them, in order)

| Id | Kind | Status | Version | Validator codes seen | Validation attempts | Repairs | Elapsed | Expected (docs/PROMPTS.md) |
|---|---|---|---|---|---|---|---|---|
| E1 | edit | committed | v1 -> v2 | - | 1 | 0 | 3.0 s | pass: matched |
| E2 | edit | failed: VALIDATION_FAILED (INVALID_REFERENCE bridge-west-loop, hearth-island, mossy-island) | v2 -> v2 | UNREACHABLE_RELIC, INVALID_REFERENCE | 3 | 2 | 4.0 s | fail first with UNREACHABLE_RELIC then repair: first half matched (UNREACHABLE_RELIC on relic-west), repair failed on invented island ids |
| E3 | edit | failed: VALIDATION_FAILED (INVALID_REFERENCE bridge-sun, hearth; relic-sun) | v2 -> v2 | INVALID_REFERENCE | 3 | 2 | 6.0 s | fail first with GATE_HIDES_RELIC: not reached, the model wrote `relic-sun` instead of `relic-east` |
| E4 | edit | failed: MODEL_OUTPUT_INVALID (truncated JSON at char 1294, three times) | v2 -> v2 | - (rejected before any candidate) | 0 | 2 | 31.1 s | pass: not matched, 8-op patch exceeded the 512-token draft budget |
| E5 | edit | committed | v2 -> v3 | - | 1 | 0 | 3.0 s | pass: matched |
| E6 | edit | failed: VALIDATION_FAILED (INVALID_REFERENCE bridge-hearth-temple, hearth-island, temple-island) | v3 -> v3 | INVALID_REFERENCE | 3 | 2 | 5.0 s | fail first with BRIDGE_CROSSES_ISLAND: not reached, invented island ids on all three attempts |
| B1 | brief | failed: VALIDATION_FAILED (OBJECT_NOT_ON_SURFACE on spawn-0, gate and decorations, three times) | v3 -> v3 | OBJECT_NOT_ON_SURFACE, UNREACHABLE_RELIC | 3 | 2 | 77.2 s | pass: not matched, local offsets larger than the island radius in every draft |
| B2 | brief | failed: MODEL_OUTPUT_INVALID (localPosition outside the ±20 schema range, three times) | v3 -> v3 | - (rejected before any candidate) | 0 | 2 | 70.2 s | pass: not matched, the model wrote world coordinates into localPosition |

Run 1 (cut short): E1 failed VALIDATION_FAILED with INVALID_REFERENCE (orchard-island, lantern-island, then east-island,
south-island) in 7.0 s, 3 validation attempts, 2 repairs; E2 was in its repair phase at 4.0 s when the server received
SIGTERM from outside this session (the agent log shows its finish call succeeded, then every claim failed). The
remaining six prompts of run 1 are recorded as `error: fetch failed` with no request id.

## Timings (request created to terminal status, measured by the runner; run 2)

| Kind | Count | Min | p50 | Max | Committed |
|---|---|---|---|---|---|
| briefs | 2 | 70.2 s | 70.2 s | 77.2 s | 0 of 2 |
| edits | 6 | 3.0 s | 4.0 s | 31.1 s | 2 of 6 |
| edits that committed | 2 | 3.0 s | 3.0 s | 3.0 s | report totals 2459 ms and 2120 ms, first model response 2389 ms and 2049 ms |

Per build report (run 2): first model response for an edit 1.5 to 2.4 s when the output parsed, 10 s per attempt when
the patch draft hit the token budget (E4); first world draft 37.3 s (B1) and 22.7 s (B2); validation plus playability
under 50 ms; commit at the next safe tick within 50 ms of validation.

## Validator and repair counts (run 2 edits)

| Measure | Count | Ids |
|---|---|---|
| Edits sent | 6 | E1 to E6 |
| Invalid edits caught before any commit (validator, reference check or model-output boundary) | 4 | E2 (validator: UNREACHABLE_RELIC on the first candidate, then INVALID_REFERENCE), E3 and E6 (INVALID_REFERENCE at propose_patch), E4 (truncated JSON at the output boundary) |
| Of those, repairs that then committed | 0 | - |
| Edits that ended failed | 4 | E2, E3, E4, E6 |
| Edits that timed out (240 s) | 0 | - |
| Expected validator codes that actually appeared | 1 of 3 | UNREACHABLE_RELIC (E2); GATE_HIDES_RELIC (E3) and BRIDGE_CROSSES_ISLAND (E6) were never reached |
| Worlds committed with an outstanding issue | 0 | every commit followed a passing validation and playability report |

## Not run

| Id | Reason |
|---|---|
| B3, B4, B5, B6 | not sent in this run; the live run record asked for the six edits plus two briefs. Run them with `npx tsx scripts/run-prompts.ts --ids B3,B4,B5,B6` against a running server and agent |
| any prompt with players connected | no controller joined during the run, so live-player constraints were not exercised |
| openclaw mode | the run used the clearly labelled direct harness; no OpenClaw result is claimed here |

## Blockers and findings for the other owners (observed, not fixed here)

1. Island and relic id invention (packages/agent): on E1 (run 1), E2, E3 and E6 the model turned display names into
   slugs (`orchard-island`, `mossy-island`, `hearth-island`, `temple-island`, `relic-sun`) although the prompt's world
   description lists `island east "Orchard Island" ...`. The repair text for INVALID_REFERENCE carries no hint, so the
   second attempt repeated the mistake. Likely fix: list the exact id tokens once more in the repair message, or map
   unknown ids to the island whose name matches before staging.
2. Patch draft budget (packages/agent/src/jobs.ts, numPredict 512 for patches): an 8-op decoration patch truncated at
   1294 characters three times (E4): at roughly 2.5 characters per token, 512 tokens is about 1300 characters of JSON.
3. Brief local offsets (packages/agent prompt): the world drafts used absolute world coordinates for `localPosition`
   (B2, out of the ±20 schema range) or offsets larger than the island radius (B1, OBJECT_NOT_ON_SURFACE on spawn-0,
   gate and decorations), and the same error survived both repairs.
4. Process hygiene: in run 1 the server on port 7790 received a SIGTERM from outside this session at 17:42:39Z. Run 2
   started the same entry file through a scratchpad launcher so a `pkill -f apps/server` pattern no longer matches it.

## Commands used

```
export PATH=/home/dell/Beetle/.tools/node/bin:$PATH
export BEETLE_PORT=7790 BEETLE_HOST=127.0.0.1 BEETLE_START_WORLD=fixture BEETLE_DATA_DIR=<scratchpad>/run-prompts-data
export BEETLE_DIRECTOR_TOKEN=<own value> BEETLE_AGENT_TOKEN=<own value> BEETLE_SERVER_URL=http://127.0.0.1:7790
npx tsx apps/server/src/main.ts                       # run 1 (killed externally); run 2 used a scratchpad launcher importing the same file
npx tsx packages/agent/src/main.ts --mode direct
npx tsx scripts/run-prompts.ts --ids E1,E2,E3,E4,E5,E6,B1,B2
```

Both processes were stopped after the run. Activity trails below are generated from the run 2 file.

## Activity trail per attempt

### E1 (edit, request req-a81a2794) expected: pass

Prompt: Add a second route: a 3 metre wide bridge from the Orchard Island in the east straight to the Lantern Island in the south, and retitle the world "Orchard Loop".

- 0 ms, queued: Edit queued for the agent
- 1 ms, planning: Agent claimed the request
- 3 ms, planning: [direct] reading the current world
- 6 ms, planning: [direct] drafting a patch for v1 with qwen3.5:4b
- 2396 ms, validating: [direct] validating the candidate
- 2417 ms, validating: [direct] running connectivity and supported-movement checks
- 2434 ms, awaiting_safe_commit: [direct] committing at the next safe tick
- 2459 ms, committed: [direct] committed v2
- 2461 ms, committed: direct / qwen3.5:4b: [direct] Added a new bridge connecting Orchard Island to Lantern Island and updated the world title.
- 2462 ms, committed: Committed world version 2
- report: outcome committed, attempts 1, failedCodes [], playability ok (5 checks, 0 failed), firstModelResponse 2389 ms, validated 2415 ms, committed 2457 ms, total 2459 ms, tool calls 5 (read_world_state, propose_patch, validate_candidate, run_playability_checks, commit_candidate); summary: [direc

### E2 (edit, request req-166d90bc) expected: fail first: UNREACHABLE_RELIC, then repair

Prompt: Remove the narrow western bridge, but keep the Moon Relic collectable.

- 0 ms, queued: Edit queued for the agent
- 1 ms, planning: Agent claimed the request
- 2 ms, planning: [direct] reading the current world
- 3 ms, planning: [direct] drafting a patch for v2 with qwen3.5:4b
- 1546 ms, validating: [direct] validating the candidate
- 1558 ms, repairing: [direct] repair 1 of 2: UNREACHABLE_RELIC[relic-west,west,spawn-0,spawn-1] [UNREACHABLE_RELIC] {relic-west, west, spawn-0, spawn-1}
- 2710 ms, repairing: [direct] repair 2 of 2: INVALID_REFERENCE[bridge-west-loop,hearth-island,mossy-island] [INVALID_REFERENCE] {bridge-west-loop, hearth-island, mossy-island}
- 3971 ms, failed: direct / qwen3.5:4b: [direct] failed: VALIDATION_FAILED rejected after 2 repairs: INVALID_REFERENCE[bridge-west-loop,hearth-island,mossy-island] [UNREACHABLE_RELIC, INVALID_REFERENCE]
- 3972 ms, failed: Failed: rejected after 2 repairs: INVALID_REFERENCE[bridge-west-loop,hearth-island,mossy-island] [VALIDATION_FAILED]
- report: outcome failed, attempts 3, failedCodes [UNREACHABLE_RELIC, INVALID_REFERENCE], playability none, firstModelResponse 1542 ms, validated - ms, committed - ms, total 3969 ms, tool calls 5 (read_world_state, propose_patch, validate_candidate, propose_patch!, propose_patch!); summary: [direct]

### E3 (edit, request req-e2125719) expected: fail first: GATE_HIDES_RELIC

Prompt: Move the Sun Relic onto the Temple Island, right beside the shrine.

- 0 ms, queued: Edit queued for the agent
- 0 ms, planning: Agent claimed the request
- 2 ms, planning: [direct] reading the current world
- 4 ms, planning: [direct] drafting a patch for v2 with qwen3.5:4b
- 2176 ms, repairing: [direct] repair 1 of 2: INVALID_REFERENCE[relic-sun] [INVALID_REFERENCE] {relic-sun}
- 3709 ms, repairing: [direct] repair 2 of 2: INVALID_REFERENCE[bridge-sun,hearth], INVALID_REFERENCE[relic-sun] [INVALID_REFERENCE, INVALID_REFERENCE] {bridge-sun, hearth, relic-sun}
- 5225 ms, failed: direct / qwen3.5:4b: [direct] failed: VALIDATION_FAILED rejected after 2 repairs: INVALID_REFERENCE[bridge-sun,hearth] [INVALID_REFERENCE]
- 5226 ms, failed: Failed: rejected after 2 repairs: INVALID_REFERENCE[bridge-sun,hearth] [VALIDATION_FAILED]
- report: outcome failed, attempts 3, failedCodes [INVALID_REFERENCE], playability none, firstModelResponse 2173 ms, validated - ms, committed - ms, total 5223 ms, tool calls 4 (read_world_state, propose_patch!, propose_patch!, propose_patch!); summary: [direct] failed: VALIDATION_FAILED rejected af

### E4 (edit, request req-954baf0e) expected: pass

Prompt: Plant a ring of six bushes around the edge of the Hearth Island, well clear of the four bridge mouths, and add one lantern next to each spawn.

- 0 ms, queued: Edit queued for the agent
- 0 ms, planning: Agent claimed the request
- 1 ms, planning: [direct] reading the current world
- 3 ms, planning: [direct] drafting a patch for v2 with qwen3.5:4b
- 10245 ms, repairing: [direct] model output did not match the schema, asking again (1 of 2): truncated JSON (Unterminated string in JSON at position 1294 (line 54 column 28))
- 20219 ms, repairing: [direct] model output did not match the schema, asking again (2 of 2): truncated JSON (Unterminated string in JSON at position 1294 (line 54 column 28))
- 30103 ms, failed: direct / qwen3.5:4b: [direct] failed: MODEL_OUTPUT_INVALID model output failed schema validation 3 times: truncated JSON (Unterminated string in JSON at position 1294 (line 54 column 28))
- 30103 ms, failed: Failed: model output failed schema validation 3 times: truncated JSON (Unterminated string in JSON at position 1294 (line 54 column 28)) [MODEL_OUTPUT_INVALID]
- report: outcome failed, attempts 0, failedCodes [], playability none, firstModelResponse 10243 ms, validated - ms, committed - ms, total 30101 ms, tool calls 1 (read_world_state); summary: [direct] failed: MODEL_OUTPUT_INVALID model output failed schema validation 3 times: truncated JSON (Untermin

### E5 (edit, request req-31848a30) expected: pass

Prompt: Make the fall deadly: the hazard beneath the islands becomes lava. Rename the world "Ember Garden" to match.

- 0 ms, queued: Edit queued for the agent
- 0 ms, planning: Agent claimed the request
- 1 ms, planning: [direct] reading the current world
- 1 ms, planning: [direct] drafting a patch for v2 with qwen3.5:4b
- 2052 ms, validating: [direct] validating the candidate
- 2064 ms, validating: [direct] running connectivity and supported-movement checks
- 2072 ms, awaiting_safe_commit: [direct] committing at the next safe tick
- 2120 ms, committed: [direct] committed v3
- 2121 ms, committed: direct / qwen3.5:4b: [direct] Changed the world hazard to lava and renamed the title.
- 2123 ms, committed: Committed world version 3
- report: outcome committed, attempts 1, failedCodes [], playability ok (5 checks, 0 failed), firstModelResponse 2049 ms, validated 2063 ms, committed 2119 ms, total 2120 ms, tool calls 5 (read_world_state, propose_patch, validate_candidate, run_playability_checks, commit_candidate); summary: [direc

### E6 (edit, request req-75892bcd) expected: fail first: BRIDGE_CROSSES_ISLAND

Prompt: Add a straight bridge from the Orchard Island in the east directly across to the Mossy Island in the west.

- 0 ms, queued: Edit queued for the agent
- 0 ms, planning: Agent claimed the request
- 1 ms, planning: [direct] reading the current world
- 3 ms, planning: [direct] drafting a patch for v3 with qwen3.5:4b
- 2223 ms, repairing: [direct] repair 1 of 2: INVALID_REFERENCE[bridge-east-west,orchard-island,mossy-island] [INVALID_REFERENCE] {bridge-east-west, orchard-island, mossy-island}
- 3441 ms, repairing: [direct] repair 2 of 2: INVALID_REFERENCE[bridge-hearth-temple,hearth-island,temple-island] [INVALID_REFERENCE] {bridge-hearth-temple, hearth-island, temple-island}
- 4721 ms, failed: direct / qwen3.5:4b: [direct] failed: VALIDATION_FAILED rejected after 2 repairs: INVALID_REFERENCE[bridge-hearth-temple,hearth-island,temple-island] [INVALID_REFERENCE]
- 4723 ms, failed: Failed: rejected after 2 repairs: INVALID_REFERENCE[bridge-hearth-temple,hearth-island,temple-island] [VALIDATION_FAILED]
- report: outcome failed, attempts 3, failedCodes [INVALID_REFERENCE], playability none, firstModelResponse 2220 ms, validated - ms, committed - ms, total 4720 ms, tool calls 4 (read_world_state, propose_patch!, propose_patch!, propose_patch!); summary: [direct] failed: VALIDATION_FAILED rejected af

### B1 (brief, request req-5ad48f21) expected: pass

Prompt: Four islands arranged in a diamond with water below. Both spawns on the west island, the gate on the east island, one relic each on the north, south and west islands. Bridge every island to its two ring neighbours so there are two ways round. Title it "Diamond Pond".

- 0 ms, queued: Brief queued for the agent
- 0 ms, planning: Agent claimed the request
- 2 ms, planning: [direct] drafting a new world with qwen3.5:4b
- 37284 ms, validating: [direct] validating the candidate
- 37299 ms, repairing: [direct] repair 1 of 2: OBJECT_NOT_ON_SURFACE[spawn-0,west_island], OBJECT_NOT_ON_SURFACE[relic_north,north_island], OBJECT_NOT_ON_SURFACE[relic_south,south_island], OBJECT_NOT_ON_SURFACE[gate,east_island], OBJECT_NOT_ON_SURFACE[dec_west_1,west_island], OBJECT_NOT_ON_SURFACE[d
- 57308 ms, validating: [direct] validating the candidate
- 57315 ms, repairing: [direct] repair 2 of 2: OBJECT_NOT_ON_SURFACE[spawn-0,west_island], OBJECT_NOT_ON_SURFACE[gate,east_island], OBJECT_NOT_ON_SURFACE[dec_west_1,west_island], OBJECT_NOT_ON_SURFACE[dec_north_1,north_island], OBJECT_NOT_ON_SURFACE[dec_north_2,north_island], OBJECT_NOT_ON_SURFACE[d
- 76306 ms, validating: [direct] validating the candidate
- 76314 ms, failed: direct / qwen3.5:4b: [direct] failed: VALIDATION_FAILED rejected after 2 repairs: OBJECT_NOT_ON_SURFACE[spawn-0,west_island], OBJECT_NOT_ON_SURFACE[dec_north_1,north_island], OBJECT_NOT_ON_SURFACE[dec_north_2,north_island], OBJECT_NOT_ON_SURFACE[dec_south_1,south_island], OBJECT_
- 76314 ms, failed: Failed: rejected after 2 repairs: OBJECT_NOT_ON_SURFACE[spawn-0,west_island], OBJECT_NOT_ON_SURFACE[dec_north_1,north_island], OBJECT_NOT_ON_SURFACE[dec_north_2,north_island], OBJECT_NOT_ON_SURFACE[dec_south_1,south_island], OBJECT_NOT_ON_SURFACE[dec_south_2,south_island], OBJECT
- report: outcome failed, attempts 3, failedCodes [OBJECT_NOT_ON_SURFACE, UNREACHABLE_RELIC], playability none, firstModelResponse 37278 ms, validated - ms, committed - ms, total 76312 ms, tool calls 6 (propose_world, validate_candidate, propose_world, validate_candidate, propose_world, validate_can

### B2 (brief, request req-5835e4cb) expected: pass

Prompt: A chain of six small islands running from the south-west corner to the north-east corner, each linked to the next by one bridge, lava below. Spawns on the first island, the gate on the last, relics on the second, fourth and fifth islands. A few rocks and bushes at the edges, never on the bri

- 0 ms, queued: Brief queued for the agent
- 0 ms, planning: Agent claimed the request
- 2 ms, planning: [direct] drafting a new world with qwen3.5:4b
- 22684 ms, repairing: [direct] model output did not match the schema, asking again (1 of 2): spawns.0.localPosition.x: Number must be greater than or equal to -20; spawns.0.localPosition.z: Number must be greater than or equal to -20; spawns.1.localPosition.x: Number must be greater than or equal t
- 45562 ms, repairing: [direct] model output did not match the schema, asking again (2 of 2): spawns.0.localPosition.x: Number must be greater than or equal to -20; spawns.0.localPosition.z: Number must be greater than or equal to -20; spawns.1.localPosition.x: Number must be greater than or equal t
- 69568 ms, failed: direct / qwen3.5:4b: [direct] failed: MODEL_OUTPUT_INVALID model output failed schema validation 3 times: relics.2.localPosition.z: Number must be less than or equal to 20; gate.localPosition.z: Number must be less than or equal to 20; decorations.0.localPosition.x: Number must b
- 69569 ms, failed: Failed: model output failed schema validation 3 times: relics.2.localPosition.z: Number must be less than or equal to 20; gate.localPosition.z: Number must be less than or equal to 20; decorations.0.localPosition.x: Number must be greater than or equal to -20; decorations.0.local
- report: outcome failed, attempts 0, failedCodes [], playability none, firstModelResponse 22681 ms, validated - ms, committed - ms, total 69566 ms, tool calls 0 (); summary: [direct] failed: MODEL_OUTPUT_INVALID model output failed schema validation 3 times: relics.2.localPosition.z: Number must be



## Run 3 (13:28 CDT): six fresh edits after model-output normalization

Stack: real server on port 7781 with the world produced by a fresh brief (4 islands, 4 bridges, committed in 14 s), direct-mode worker, qwen3.5:4b, quiet GPU. Raw record: `run-1791052136845.json`.

| Id | Kind | Status | Version | Codes seen | Elapsed |
|---|---|---|---|---|---|
| E1 | edit | failed | v1 -> v1 | - | 8.0 s |
| E2 | edit | committed | v1 -> v2 | - | 2.0 s |
| E3 | edit | committed | v2 -> v3 | - | 3.0 s |
| E4 | edit | committed | v3 -> v4 | - | 14.0 s |
| E5 | edit | committed | v4 -> v5 | - | 3.0 s |
| E6 | edit | committed | v5 -> v6 | - | 8.0 s |

Committed: 5 of 6 (run 2 before normalization: 2 of 6). Elapsed min/p50/max: 2.0 / 8.0 / 14.0 s. Repairs still happen (INVALID_REFERENCE and BRIDGE_CROSSES_ISLAND were reported by the validator and repaired within the two-attempt budget in E6; E1 exhausted its budget and left the world untouched). No invalid world was ever committed. Note: this run used a model-generated world, not the garden5 fixture, so the "expected failure" annotations in PROMPTS.md (written for garden5) do not apply one to one.

## Conflicting edit on the model-built world (13:32 CDT)

Prompt: "Remove the only bridge to the temple. Keep the temple reachable." on world v6 (built by a fresh brief, then six edits). The temple island had two bridges at that point, so the model removed one and added `temple_alt_passage` in the same patch; the validator passed it on the first attempt and v7 committed in 6.4 s. This is the "agent submitted a valid alternative" case: no validator failure occurred in this run, and none is claimed. The validator refusing an edit is shown separately below on the fixture world, where the temple has exactly one bridge.

## Conflicting edit on the fixture world, single temple bridge (13:32 CDT, port 7783, direct mode, quiet GPU)

Prompt: "Remove the only bridge to the temple. Keep the temple reachable." on garden5 v1 (the temple has exactly one bridge, `bridge-north`).

| Elapsed | Phase | Detail |
|---|---|---|
| 1.7 s | validating | first candidate: the model removed `bridge-north` only |
| 1.7 s | repairing | validator refused: `DISCONNECTED_GOAL` [gate, temple, spawn-0, spawn-1]; repair 1 of 2 |
| 2.9 s | validating | second candidate: removal plus `bridge-new-west` from centre to temple |
| 2.9 s | validating | connectivity and supported-movement checks pass |
| 3.0 s | committed | v2; summary "Added a bridge from Hearth Island to Temple Island to ensure the gate remains reachable." |

This is the validator-refusal case the storyboard needs: the invalid patch never published, the agent received the real code and object ids, and only the passing patch committed. Measured once; raw trail in the server events of that run.

## Undo on the live stack (13:32 CDT)

`POST /api/director/undo` on v7 produced v8 with the v6 bridge set restored through the normal validated commit path (`patchId undo-c468fb97`, deferred 0 ms).

## All rehearsal attempts today (integration owner's log, honest, including failures)

| Time (CDT) | Request | Mode | GPU state | Outcome |
|---|---|---|---|---|
| 12:49 | edit: lava + bridge to the northern island (fixture) | direct | quiet | committed v2 in 7.0 s |
| 12:53 | brief: five islands, temple north (no world) | direct | contended (corpus + benchmark) | failed: schema repairs then MODEL_TIMEOUT at 120 s |
| 12:58 | same brief | direct | contended | failed: MODEL_TIMEOUT at 180 s |
| 13:08 | edit: lava + bridge (fixture, keyboard player connected) | direct | contended | committed v2 in 61 s, player preserved |
| 13:14 | brief (after normalization) | direct | contended | failed: MODEL_TIMEOUT at 90 s per call |
| 13:20 | brief | direct | quiet | failed after 2 repairs: BRIDGE_LENGTH, BRIDGE_CROSSES_ISLAND, GATE_HIDES_RELIC |
| 13:22 | brief (after bridge contraction and relic-off-gate normalization) | direct | quiet | committed v1 in 14.0 s (4 islands, 4 bridges) |
| 13:24 | edit: lava + bridge | openclaw | daemon wedged | failed: OPENCLAW_TIMEOUT, the Ollama daemon had stopped answering chat requests (restarted 13:43) |
| 13:43 | edit: lava + bridge (fixture) | openclaw | quiet | committed v2 in 20.0 s with real OpenClaw tool calls |
| 13:28 | six fresh edits (run 3) | direct | quiet | 5 of 6 committed, 2.0 / 8.0 / 14.0 s |
| 13:32 | edit: remove the only temple bridge (model world, two temple bridges) | direct | quiet | committed v7 in 6.4 s, valid alternative on the first attempt |
| 13:32 | undo | server | quiet | v8, previous structure restored |
| 13:32 | edit: remove the only temple bridge (fixture, one temple bridge) | direct | quiet | DISCONNECTED_GOAL refused, repair added a crossing, committed v2 in 3.0 s |

## OpenClaw mode live against the real server (13:43 CDT, port 7783, fixture world, quiet GPU after the daemon restart)

Prompt: "Turn the water into lava and add a bridge to the northern island. Keep our players and collected relics." Worker in `openclaw` mode; OpenClaw 2026.9.8 `agent exec` with the Beetle tool plugin in the isolated profile, model `ollama/qwen3.5:4b`, thinking off, timeout 600 s.

| Elapsed | Phase | Detail |
|---|---|---|
| 11.6 s | planning | `read_world_state` called by OpenClaw |
| 14.8 s | repairing | `propose_patch` rejected at the boundary: `INVALID_SCHEMA` |
| 18.1 s | validating | second `propose_patch` accepted; validator and connectivity checks pass |
| 20.0 s | committed | v2: hazard lava, new bridge `bridge-north-new` centre to temple; build report published by the plugin |

Daemon log shows the chat requests from OpenClaw. This is the submission path, verified end to end once against the real server. Earlier at 13:24 the same path timed out because the Ollama daemon had stopped answering chat requests (see "All rehearsal attempts"); the daemon was restarted at 13:43 with a single slot.

## Gated live integration tests (13:44 CDT, tests/integration/live-agent.test.ts, BEETLE_LIVE_MODEL=1 BEETLE_LIVE_OPENCLAW=1)

| Case | Mode | Result | Timings |
|---|---|---|---|
| 18 | direct | committed: lava, new bridge to the northern island, players preserved | 14.3 s wall |
| 17 | openclaw | committed v2 through the real OpenClaw tools; report: 7 tool calls, validation attempts 3 (INVALID_SCHEMA, DUPLICATE_ID rejected at the boundary), first model response 8.2 s, validated 32.2 s, committed 34.3 s | 38.9 s wall |

## Hero transformation on the cinematic renderer (14:02 CDT, port 7781, fixture world, two scripted controllers walking the whole time)

Prompt: "Turn the environment volcanic: the water becomes lava. Also add one new bridge from the east island to the temple island as an alternative route. Keep our players and collected relics." Direct worker, quiet GPU.

| Elapsed | Phase |
|---|---|
| 3.1 s | validating (first candidate) |
| 3.1 s | connectivity and supported-movement checks |
| 3.2 s | committed v2 |

Before: v1, 2 controllers connected, relics [], score 0. After: v2, hazard lava, bridges + `bridge-east-temple` (east to temple, a genuinely different route under the new BRIDGE_DUPLICATE rule), 2 controllers still connected, both players on `centre`, relics [] and score 0 unchanged. Visually the renderer blended from the serene theme (teal sky, water shimmer, green islands) to volcanic (ash sky, lava with glowing crust rings, scorched islands, embers) in about 2 s without a reset. The unattended version of this test (scripts/acceptance-volcanic.ts) passed 15 of 15 checks at 13:48 with a relic collected beforehand (docs/ACCEPTANCE.md).
