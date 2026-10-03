# Video storyboard (90 to 120 seconds)

Draft. Every shot below must be re-checked against the implemented behaviour during the rehearsal; shots that cannot be produced honestly are cut, not faked. Any time compression is labelled on screen.

| # | Seconds | On screen | Caption (no em dashes) | Evidence |
|---|---|---|---|---|
| 1 | 0 to 6 | Director page, empty world, Beetle wordmark, panel open | Beetle. Change the game without stopping the game. | |
| 2 | 6 to 22 | Designer types the brief; activity trail shows planning, validating, committed; world appears | A local model composes the world. Validated by game code before it is published. | report timings, version v1 |
| 3 | 22 to 34 | Two phones scan the QR; two avatars move; one relic collected | Two players join from their phones. Same screen, their phones only send controls. | controller connection dots, relics 1/3 |
| 4 | 34 to 58 | Edit typed while players keep moving; trail shows planning then validating; lava swaps in, new bridge appears; version badge v2; relics still 1/3, both dots green | Edits land live. No disconnect, no reset. | world message v2, preserved summary |
| 5 | 58 to 90 | Conflicting edit; trail shows validator error DISCONNECTED_GOAL with the bridge id; repairing; revalidated; committed v3 with a new crossing | The validator refuses a world nobody can finish. The agent repairs it and commits only a passing version. | validation issues in the trail, report attempts 2 |
| 6 | 90 to 105 | Version report panel: versions, attempts, codes, measured times; demo-check output | Measured on one GB10. Local model, local agent, no cloud. | data/reports, data/benchmarks |
| 7 | 105 to 115 | Wordmark, GitHub URL | Beetle | |

Fallbacks decided during rehearsal:
- If the agent's first attempt at shot 5 is already valid, show it as a valid repair and cut to a separately labelled "invalid patch test" clip produced by the test suite output.
- If phones cannot join the venue LAN, use the director keyboard player and say so in the caption.
