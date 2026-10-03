# Demo runbook

Draft written before the integration pass. Every step is re-verified during the final rehearsal and ticked in BUILD_STATUS.md.

## Before the recording (T minus 30 minutes)

1. `npm run demo:check` must print Ready. It checks Node, OpenClaw, Ollama, the model tag, the web build and the LAN address.
2. `npm run dev -- --prod` in one terminal. Keep it visible on a second screen, not in the recording.
3. Open the director URL printed by the server on the recording screen. Collapse the panel so the world canvas dominates.
4. Phones: join the team LAN, open the QR from the director panel for player 1, then player 2. Confirm both connection dots are green and the phones move their avatars.
5. Run one throwaway brief to warm the model, then clear it with a new brief when recording starts. The cold load is reported separately in the benchmark, never hidden.
6. Start the screen capture on the director page at the display's native resolution. Start a phone-over-shoulder capture if a third person is available.

## Recorded sequence (90 to 120 seconds, label any time compression)

1. Fresh brief: "Five floating garden islands with a temple to the north. Water below. A safe wide route and a narrow risky one." Show the activity trail: planning, validating, committed, with the measured time.
2. Both phones move. One player collects a relic. Show relics 1/3.
3. Edit while playing: "Turn the water into lava and add a bridge to the northern island. Keep our players and collected relics." Players keep moving during planning. Show the version badge change and that relics stay 1/3 and both players stay connected.
4. Conflicting edit: "Remove the only bridge to the temple. Keep the temple reachable." Show the validator error (DISCONNECTED_GOAL with the bridge id), the repair attempt, revalidation and commit of the passing patch only. If the agent's first attempt is already valid, say so on screen and run the separately labelled invalid-patch test instead.
5. End on the version report: committed version, attempts, validator codes, timings.

## If something fails

- Model unreachable: the director shows the specific error and the world stays playable. Fix Ollama, retry the request. Do not switch providers.
- Agent worker not claiming: restart `npm run agent`. Check `data/events/agent.jsonl`.
- Phone cannot connect: confirm it is on the same LAN as the printed public URL; the venue Wi-Fi may isolate clients. Use the director's keyboard player as the fallback for recording.
- Commit deferred with OCCUPIED_SUPPORT: a player is standing on a bridge the patch removes; move the player, the agent retries within its budget.

## Evidence to keep

- `data/events/server.jsonl`, `data/events/agent.jsonl`, `data/reports/*.json`, `data/benchmarks/*.json`.
- The uncut capture. All attempts, including failed ones, are listed in BUILD_STATUS.md.
