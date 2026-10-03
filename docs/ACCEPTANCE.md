# Acceptance test: the volcanic hero transformation

`scripts/acceptance-volcanic.ts` is the unattended, end-to-end functional acceptance test for Beetle's hero moment:
two players keep playing while the director asks the local agent to turn the water into lava and add an alternative
bridge, and the world changes in place without dropping a socket, a tick, a player or a collected relic.

Every run writes one record to `data/acceptance/volcanic-<unix ms>.json` with all measurements and a PASS/FAIL
per assertion, and prints a PASS/FAIL table. A model failure is reported as FAIL with the activity trail; nothing is
retried.

## Exact command

```bash
cd /home/dell/Beetle
export PATH=/home/dell/Beetle/.tools/node/bin:$PATH
npx tsx scripts/acceptance-volcanic.ts --data-dir /tmp/claude-1000/-home-dell-Beetle/21ab41dd-867e-4ca2-b74f-579f811eb422/scratchpad/acceptance/run2
```

Options: `--data-dir <dir>` (BEETLE_DATA_DIR for the child server and worker; default: a fresh `beetle-acceptance-*`
directory under the OS temp dir), `--port <n>` (default 7784; the script refuses to start if the port is in use, so it
can never touch the live rehearsal on 7781), `--out-dir <dir>` (default `data/acceptance`). Exit code 0 = PASS,
1 = FAIL, 2 = the script itself crashed. Ollama must be serving `qwen3.5:4b` on 127.0.0.1:11434 (not started here).

## What the script does

1. Starts the real server (`apps/server/src/main.ts`, `BEETLE_START_WORLD=fixture`, hazard water, fixed director and
   agent tokens, scratch data dir) and the direct-mode worker (`packages/agent/src/main.ts --mode direct`,
   `BEETLE_REQUEST_DEADLINE_MS=180000`, `BEETLE_MODEL_CALL_TIMEOUT_MS=170000`) as child processes
   (`node node_modules/tsx/dist/cli.mjs <entry>`, the same thing `npx tsx` resolves to). Waits for `/api/health`
   `ok` and then `agentConnected`.
2. Joins two controllers (`POST /api/director/invite` then `POST /api/join`), opens two WebSocket clients
   (`ws`, `hello` as controller) plus one display observer (the server sends `world` messages only to display and
   director sockets; the observer acks them like the real display page). Reuses `WsClient`, `joinController`,
   `collectRelic`, `navigateTo` from `tests/support/server-harness.ts` and the geometry helpers from
   `tests/support/world-geom.ts`.
3. Drives both players for the whole run with axes inputs at 20 Hz and a monotonic `seq`:
   player 2 patrols west then back on the centre island (lane z = +3, x in [-4, 4]) from the moment it joins;
   player 1 first walks along the bridge graph to the Sun Relic on the east island and presses interact, then walks
   back to the centre island and patrols east then back (lane z = -3). Both stay within radius 5 of the island centre
   (the island has radius 9), so no commit is ever deferred with `OCCUPIED_SUPPORT`.
4. Records the baseline from the tick stream: collected relic ids, score, both player ids and `connected` flags,
   `worldVersion`, plus the bridge and island id sets from `GET /api/world`.
5. Submits `POST /api/director/requests` with kind `edit` and the prompt
   "Turn the environment volcanic: water becomes lava. Also add one new bridge from the centre island to the east
   island as an alternative route. Keep our players and collected relics." and polls
   `GET /api/director/requests/:id` every second until `committed`, `failed`, `cancelled` or 240 s. Both sockets keep
   moving their players throughout; every poll also logs socket state and tick age.
6. Keeps playing 3 s after the terminal state, then fetches `GET /api/world`, `GET /api/director/activity?limit=500`
   and `GET /api/director/reports`, and evaluates the assertions below from the recorded tick streams.
7. Writes the JSON record (phase timings, activity-trail phase timings, tick gap statistics per socket for the wait
   window and the whole run, motion statistics, before/after summaries, request, report, patrol statistics, socket
   state, child log tails) and prints the table. `finally` stops the patrols, closes the sockets, SIGTERMs the worker
   and the server (SIGKILL after 8 s) and writes the record even when a phase throws; SIGINT/SIGTERM do the same.

## Assertions

| Id | Check |
|---|---|
| A0 | server and worker up: health ok, `agentConnected` |
| A1 | fixture world is serene: `garden5`, hazard `water` |
| A2 | two controllers joined with distinct player ids matching their welcome messages |
| A3 | baseline: one relic collected (score > 0) and both players connected on the centre island before the request |
| A4 | the request reached `committed` within 240 s (status, error and director-observed time recorded) |
| A5 | neither controller socket closed during the run |
| A6 | ticks kept arriving on both sockets during the wait: max tick gap under 1000 ms |
| A7 | both players kept moving during the wait: path length >= 10 m and no still span >= 1500 ms |
| A8 | `worldVersion` increased by exactly one (HTTP and both tick streams) |
| A9 | hazard kind is `lava` |
| A10 | the bridge set changed and a new bridge touches the east island (centre-to-east recorded separately) |
| A11 | collected relic ids and score unchanged on both sockets |
| A12 | both player ids still present and `connected` |
| A13 | both players' `supportId` values are islands or bridges of the new world |
| A14 | the display observer received the `world` message with `reason: commit` for the new version |
| A15 | a build report exists for the request with the same outcome |

## Measured results (3 October 2026, GPU otherwise quiet, model `qwen3.5:4b`, direct mode)

| Run | Record | Verdict | Total | Relic walk | Request (director observed) | Model first response | Tick gap max / p99 (wait) | Path during wait p1 / p2 |
|---|---|---|---|---|---|---|---|---|
| 1 | `data/acceptance/volcanic-1791053102957.json` | FAIL (A14 only, see below) | 34.2 s | 6.6 s + 6.4 s back | committed, 9.0 s | 8006 ms | 67 ms / 66 ms | 40.4 m / 40.4 m |
| 2 | `data/acceptance/volcanic-1791053195167.json` | PASS (15 of 15) | 33.1 s | 6.5 s + 6.4 s back | committed, 8.0 s | 7831 ms | 66 ms / 47 ms | 36.0 m / 36.0 m |

Run 1 failed exactly one assertion: the first version of A14 expected the two controller sockets to receive the
`world` commit message. They never do by design (`apps/server/src/ws.ts` `broadcastWorld` sends it to display and
director sockets only; controllers see the version change in every tick), so this was a wrong assertion, not a
product defect. The script was changed to open a display observer socket and run 2 was recorded with it. Everything the
task asked for (A4 to A13) passed in both runs. Both records are kept.

Run 2 in detail:

- Phases (script wall clock): server healthy 342 ms after spawn, agent connected 208 ms after the worker spawn, join
  87 ms, relic walk 6497 ms, return to centre 6398 ms, director request 8018 ms, post-commit observation 3000 ms,
  cleanup 8563 ms (the worker stops "after the current job" and its claim long-poll runs to the 8 s SIGKILL limit).
- Agent activity trail (ms since request creation): queued 1, planning 1, validating 7846, awaiting_safe_commit 7889,
  committed 7916; total 7920 ms; 0 repairs; no validation codes. Build report timings: first model response 7831 ms,
  validated 7862 ms, committed 7905 ms, total 7908 ms; validation attempts 1; playability 5 checks, 0 failed.
- Tick stream, whole run (721 ticks per socket): mean gap 33.31 ms, p50 33, p95 34, p99 44, max 66/67 ms, zero gaps
  over 1000 ms. Wait window (241 ticks per socket): mean 33.23 ms, p99 47 ms, max 66/67 ms.
- Motion, whole run: p1 106.4 m over 709 of 721 ticks moving (supports centre, bridge-east, east), longest still
  166 ms (the interact press); p2 107.6 m over 717 of 721 ticks, longest still 132 ms. Status `active` on every tick;
  nobody fell. Inputs sent: p1 543, p2 477 (20 Hz, monotonic seq).
- World before: v1, hazard water, bridges [bridge-north, bridge-east, bridge-west, bridge-south]. After: v2, hazard
  lava, title unchanged, one new bridge `bridge-east-alt` centre -> east (width 2.4 in run 2, 3.0 in run 1), no bridge
  removed, `changedIds` [hazard, bridge-east-alt], patch summary "The world hazard is changed from water to lava, and
  a new bridge connects the centre island to the east island." The display observer received the commit 7914 ms
  after submit.
- Session before and after: collected [relic-east], score 10, players player-0 (Amber) and player-1 (Azure) connected,
  active and on `centre` in both tick streams and in the summary.

## Observations worth knowing

- In both runs the model's "alternative" bridge `bridge-east-alt` uses exactly the same endpoints as the existing
  `bridge-east` ((9, 0) to (17, 0)). The graph gains a second edge and the acceptance criterion as written ("a new
  bridge touching the east island") is met, but geometrically it is a duplicate; the validator has no overlapping-bridge
  rule, so it accepted it. If a truly separate route matters for the demo, the validator or the prompt needs to say so.
- `report.preserved` is null in direct mode; player and relic preservation is therefore asserted from the tick stream
  (A11 to A13), not from the report.
- The A4 timeout is 240 s and the worker's request deadline is 180 s, so a slow or broken model run ends as a
  `failed` request with its trail in the record, never as a hang.
