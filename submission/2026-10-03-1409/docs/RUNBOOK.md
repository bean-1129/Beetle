# Demo runbook

Updated 2026-10-03 13:40 CDT. Each step is marked with what was verified today on this machine and what remains unrun. "Verified" means it was done and observed today (sources: BUILD_STATUS.md, docs/RESULTS.md, the browser checks against the live server); "unrun" means nobody has done it yet and nothing is claimed for it.

## Verified today versus unrun

| Step | Status | Evidence |
|---|---|---|
| Server start in prod mode with the real server and agent worker (`npm run dev -- --prod`) | verified | live stack used for run 3 (port 7781) and the 13:32 CDT checks (port 7783), docs/RESULTS.md |
| Director page in the browser against the live server | verified | fixture world renders, panel, activity trail, version badge (BUILD_STATUS.md, web row) |
| Keyboard player joins and moves | verified | BUILD_STATUS.md, web row |
| Phone controller page joined and moved under mobile emulation (desktop browser, phone viewport) | verified | BUILD_STATUS.md, web row; two scripted WebSocket controllers measured in docs/LATENCY.md |
| Brief to playable world | verified | fresh brief committed v1 (4 islands, 4 bridges) in 14 s on a quiet GPU, run 3 stack (docs/RESULTS.md); benchmarks 24 to 28 s warm when the first draft is valid (docs/MODEL_SELECTION.md) |
| Edit while the world is live | verified | run 3: 5 of 6 edits committed, 2.0 / 8.0 / 14.0 s min / p50 / max (docs/RESULTS.md) |
| Lava swap and new bridge without reset | verified | browser check (BUILD_STATUS.md); E5 in run 2 and the lava edits in run 3 (docs/RESULTS.md) |
| Validator refusal and repair | verified | DISCONNECTED_GOAL refused at 1.7 s and the repaired patch committed at 3.0 s on garden5; INVALID_REFERENCE then BRIDGE_CROSSES_ISLAND refused and repaired on run 3 E6 (docs/RESULTS.md) |
| Undo via the API | verified | in tests (BUILD_STATUS.md case 11) and once on the live stack: `POST /api/director/undo` on v7 produced v8, deferred 0 ms (docs/RESULTS.md) |
| Two physical phones on the LAN | unrun | needs a person on site; controller behaviour is covered by real-socket integration tests only |
| Offline rehearsal (route removed, edit still commits) | unrun | only the "before" record exists, data/offline-proof/1791049273707.json; procedure in docs/OFFLINE_PROOF.md |
| OpenClaw mode live against the real server | unrun | tool calls proven against the fake server only (packages/agent/SMOKE.md); the real-server run times out before any model call and is being diagnosed |
| qwen3.8:27b | unrun | never benchmarked; pull failed once with a digest mismatch, re-downloading (docs/MODEL_SELECTION.md section 6) |

## Shell setup (every terminal)

```bash
cd /home/dell/Beetle
export PATH=/home/dell/Beetle/.tools/node/bin:/home/dell/Beetle/.tools/npm-global/bin:/home/dell/Beetle/.tools/ollama/bin:$PATH
```

Ollama must already be serving on 127.0.0.1:11434 with `qwen3.5:4b` present (`ollama list`). The daemon in use today was started with `OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NUM_PARALLEL=4 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KEEP_ALIVE=1h` (docs/ARCHITECTURE.md). No other Ollama client (benchmark, corpus builder, openclaw smoke run) may run during the demo: the same world draft took 24 s on a quiet GPU and 58 to 214 s under contention (docs/MODEL_SELECTION.md).

## Before the recording (T minus 30 minutes)

1. `npm run demo:check` must print Ready. It checks Node, OpenClaw, Ollama, the model tag, the web build and the LAN address. Verified today (run with and without a server up; the server-health and secrets rows fail only when no server is running).
2. `npm run build` if `apps/web/dist` is older than the last web change (verified today), then `npm run dev -- --prod` in one terminal (verified today). Keep that terminal on another workspace, not on the recording screen: the director URL with its token is printed there on first start (docs/SECURITY_REVIEW.md).
3. Open the director URL printed by the server on the recording screen. Collapse the panel so the world canvas dominates. Verified today.
4. Phones: join the team LAN, open the QR from the director panel for player 1, then player 2. Confirm both connection dots are green and the phones move their avatars. Unrun with physical phones; verified with the controller page under mobile emulation.
   USB tether note: an iPhone tethered over USB reaches the server at the tether interface address (observed 172.20.10.12), not the Wi-Fi address shown in the QR (192.168.204.116 at 12:40 CDT, docs/ENVIRONMENT.md). For a tethered phone, type the URL by hand with the tether address and the same port and path as the QR URL, for example `http://172.20.10.12:7700/controller?...` with the invite code from the director panel. The server listens on 0.0.0.0, so it answers on both interfaces.
5. Run one throwaway brief to warm the model, then clear it with a new brief when recording starts. Cold load is 23.1 s on a never-loaded file (docs/MODEL_SELECTION.md 4.1) and is reported separately in the benchmark, never hidden.
6. Start the screen capture on the director page at the display's native resolution (GNOME recorder, Ctrl+Shift+Alt+R, see docs/RECORDING.md). Start a phone-over-shoulder capture if a third person is available.

## Recorded sequence (90 to 120 seconds, label any time compression)

1. Fresh brief: "Five floating garden islands with a temple to the north. Water below. A safe wide route and a narrow risky one." Show the activity trail: planning, validating, committed, with the measured time. Rehearsal: 14 s on a quiet GPU for a 4-island brief; budget 30 s on screen.
2. Both phones move. One player collects a relic. Show relics 1/3.
3. Edit while playing: "Turn the water into lava and add a bridge to the northern island. Keep our players and collected relics." Players keep moving during planning. Show the version badge change and that relics stay 1/3 and both players stay connected. Rehearsal: edits committed in 2 to 14 s.
4. Conflicting edit: "Remove the only bridge to the temple. Keep the temple reachable." Run it on a world whose temple has exactly one bridge (garden5 does). Show the validator error (DISCONNECTED_GOAL with the gate, temple and spawn ids), the repair attempt, revalidation and commit of the passing patch only. Rehearsal on garden5: refused at 1.7 s, committed at 3.0 s. If the world has two temple bridges the model submits a valid alternative first time (observed: v7 in 6.4 s) and there is nothing to refuse; if the agent's first attempt is already valid, say so on screen and run the separately labelled invalid-patch test instead.
5. End on the version report: committed version, attempts, validator codes, timings. The caption names the agent mode (direct or OpenClaw, whichever was green at recording time).

## If something fails

- Model unreachable: the director shows the specific error and the world stays playable. Fix Ollama, retry the request. Do not switch providers.
- Agent worker not claiming: restart `npm run agent` (or the whole `npm run dev -- --prod`). Check `data/events/agent.jsonl`.
- Phone cannot connect: confirm it is on the same LAN as the printed public URL; the venue Wi-Fi may isolate clients. A USB-tethered iPhone uses the tether address (172.20.10.12 observed), see step 4 above. Fallback for recording: the director's keyboard player plus the controller page in a desktop browser, named in the caption.
- Commit deferred with OCCUPIED_SUPPORT: a player is standing on a bridge the patch removes; move the player, the agent retries within its budget.
- Brief fails three attempts (observed in 3 of 18 benchmark drafts): keep one pre-drafted world as a fallback and say so on screen.
- OpenClaw mode not green: record in direct mode (labelled `[direct]` in every trail line and report) and say so in the caption.

## Evidence to keep

- `data/events/server.jsonl`, `data/events/agent.jsonl`, `data/prompt-runs/*.json`, `data/benchmarks/*.json`, `data/latency/*.json`, `data/offline-proof/*.json`.
- The uncut capture. All attempts, including failed ones, are listed in docs/RESULTS.md and BUILD_STATUS.md.
