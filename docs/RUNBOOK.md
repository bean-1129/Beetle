# Demo runbook

Updated 2026-10-03 14:22 CDT. Each step is marked with what was verified today on this machine and what remains unrun. "Verified" means it was done and observed today (sources: BUILD_STATUS.md, docs/RESULTS.md, the browser checks against the live server); "unrun" means nobody has done it yet and nothing is claimed for it.

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
| Any game to the closest mode and biome (mode briefs and mode edits) | verified in direct mode, no controllers connected | docs/RESULTS.md "Game modes from one prompt": mode sensible on 18 of 18 briefs, committed briefs 13.0 to 44.1 s, 8 of 14 final-prompt attempts committed (failures all geometry), mode and biome edits 3.0 s each; king of the hill brief 31.1 s and 15.0 s |
| Two physical phones on the LAN | unrun | needs a person on site; controller behaviour is covered by real-socket integration tests only |
| Offline rehearsal (route removed, edit still commits) | unrun | only the "before" record exists, data/offline-proof/1791049273707.json; procedure in docs/OFFLINE_PROOF.md |
| OpenClaw mode live against the real server | verified | edit committed v2 in 20.0 s with real OpenClaw tool calls (13:43 CDT), gated integration test committed v2 in 38.9 s, fresh brief committed v1 in 33.4 s (docs/RESULTS.md, BUILD_STATUS.md case 17); the 13:24 timeout was the Ollama daemon, restarted at 13:43 |
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

6. Optional, only if the take has room inside 120 s: the "any game" shot. Type a second brief on the same stack using the measured wording, "King of the hill, desert, four islands, hold ten seconds." With players connected it is a new world, so send it with `authorizeNewWorld: true` and say "new world" in the caption (players keep ids and connections, positions reset to spawns). Show the title naming the mode ("King of the Hill (Desert)") and the measured time from the activity trail. Rehearsal (docs/RESULTS.md "Game modes from one prompt", direct mode, 14:25 to 14:42 CDT): committed in 31.1 s with one repair and in 15.0 s with none; failed once at 42.1 s on geometry. The model never wrote desert, so expect the volcanic biome and do not call it desert on screen. Budget 45 s. Shorter alternative without a reset, both measured at 3.0 s: "Make it a 60 second time trial" (`set_mode`) and "Make it snowy and slow the players down" (`set_biome frost` plus `set_movement 3.5`).

7. Streaming moment (new, unrun): with both players on the world, walk one player (phone or the keyboard player) toward an island rim that has no bridge beyond it. Within 4 m of the rim the activity trail shows a new request tagged `auto` with the reason ("extending north of Hearth Island for Amber"), then planning, validating, committed, and one or two new islands with a bridge land in that direction without a reset; the version badge increments and the players keep moving. Caption the measured time from the trail. Expect roughly an edit's time (2 to 14 s in run 3) and say "not yet measured" if no streaming run exists in docs/RESULTS.md. Fallback: if the extension fails (model unreachable, validator refusal after the repair budget, or the agent worker not claiming), the world stays exactly as it was built and the trail shows `failed`; keep playing on the existing islands, say so in the caption, and either wait 12 s for the next automatic attempt or untick "Grow the world as players explore" in the panel to stop further attempts.

## Ground worlds and the mapping sentence

To get one continuous landmass instead of floating islands, say so in the brief: "one big valley", "rolling hills", "a continuous landscape", or plainly "on the ground, no islands". "Floating", "islands" or "over lava" asks for islands; a brief that implies neither alternates between the two. On a running world, "make it solid ground" is a live `set_terrain` edit. On ground there is nothing to fall into: a player who walks to a plateau edge stops and slides along it, so do not stage a fall on a ground world. When the request asks for something the library does not have (shooting, enemies, combat, first-person, vehicles, building), read the title and the summary line on screen before narrating: that sentence says what the request became (for example a title like "Walking Trees (relic hunt, trees are scenery)") and is the line to say out loud; never describe the mapped game as the requested one. If the title does not name the mapping (observed on some briefs, docs/RESULTS.md "Out-of-library requests"), say the mapping yourself from the mode shown in the HUD objective. Status: no ground world and no shooter-style request is measured yet, so treat both as unrehearsed (docs/CAPABILITIES.md).

## Beetle 2D studio

With the stack up (`npm run dev -- --prod`, same shell setup and Ollama as above), open the director link printed at startup so the tab holds the director token, then either pick "2D game" next to the prompt on the landing page and press "Make the 2D game" (it opens `/2d?prompt=...` and carries `?token=`), use the "2D studio" link in the director panel header, or open `http://<host>:<port>/2d` directly. In the studio's Idea view, type a sentence (for example "a fox who collects glowing seeds in a rainy forest, with moving platforms and a boss at the end") and press "Design it" to have the local model write a design you can edit (genre, levels, palette, art style, weather) before building, or "Play now" to build straight from the idea; the Build view shows each level being generated, checked and playtested by the bot, then Play runs the game in a sandboxed frame where typed changes ("make the jump higher", "add a double jump") are validated and applied without leaving the game. Save keeps the game in this browser's library (localStorage); the export button writes one HTML file that plays offline. Without the token or with Ollama down, `/api/2d/llm` is refused and the studio reads the sentence directly and still builds a playable game with procedural art, so check `GET /api/2d/status` (online, models) before showing model generation. Unrun on the recording stack and not yet measured (no 2D entry in docs/RESULTS.md): rehearse once and quote only times read off the screen.

## If something fails

- Model unreachable: the director shows the specific error and the world stays playable. Fix Ollama, retry the request. Do not switch providers.
- Agent worker not claiming: restart `npm run agent` (or the whole `npm run dev -- --prod`). Check `data/events/agent.jsonl`.
- Phone cannot connect: confirm it is on the same LAN as the printed public URL; the venue Wi-Fi may isolate clients. A USB-tethered iPhone uses the tether address (172.20.10.12 observed), see step 4 above. Fallback for recording: the director's keyboard player plus the controller page in a desktop browser, named in the caption.
- Commit deferred with OCCUPIED_SUPPORT: a player is standing on a bridge the patch removes; move the player, the agent retries within its budget.
- Brief fails three attempts (observed in 3 of 18 benchmark drafts): keep one pre-drafted world as a fallback and say so on screen.
- OpenClaw mode not green (it depends on a healthy Ollama daemon; the 13:24 CDT timeout was the daemon, fixed by a restart): record in direct mode (labelled `[direct]` in every trail line and report) and say so in the caption.

## Evidence to keep

- `data/events/server.jsonl`, `data/events/agent.jsonl`, `data/prompt-runs/*.json`, `data/benchmarks/*.json`, `data/latency/*.json`, `data/offline-proof/*.json`.
- The uncut capture. All attempts, including failed ones, are listed in docs/RESULTS.md and BUILD_STATUS.md.
