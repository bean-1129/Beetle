# Beetle results

Measured on this machine on 2026-10-03. Reproduce with `npm run benchmark:local` (runs `scripts/measure-2d.ts`).

## Beetle 2D: prompt to playable (16:04 to 16:06 CDT, direct Ollama, qwen3.5:4b, shared GPU)

Script: `scripts/measure-2d.ts` (run with `node_modules/.bin/tsx`, Node v24.21.0). Raw data: `data/studio2d-runs/run-1791061567084.json`.
It installs its own `globalThis.studio2d` shim (llm posts to `http://127.0.0.1:11434/api/chat` with stream false, think false,
format = schema, num_ctx 8192 like the server route; tolerant JSON parse) and runs the UI's own path from `Studio2D.tsx`:
`designFromIdea` (route), `makeDesign` (one model call for the design doc), then `specFromDesign` from `gen/build.ts`
(what the build worker runs: assemble, build and playtest levels, `repairSpec`), and finally `validateSpec`. All of it
runs in Node; nothing was skipped for DOM or canvas on these prompts because all six took the genre route (no template,
no scripted game, so no sandbox iframe check was needed). Not included: the Web Worker hop, procedural asset painting
(`buildAssets`), generated art, and the human pause between "Design it" and "Build". Level seed fixed at 12345 (the UI
uses a random seed). One warm-up design call first, excluded: 14.0 s, of which 5.5 s was model load. The GPU was at 14 %
utilization at the start and may have been shared with other work, so treat the model times as indicative.

| Prompt | Genre chosen | Valid | Model ms | Total ms | Retries | Notes |
|---|---|---|---|---|---|---|
| a platformer where a fox collects acorns across floating cliffs | platformer | yes | 10943 | 14740 | 0 | "Fox & Acorn"; 469 output tokens; build 3792 ms; 5 levels, bot finished 5/5 |
| a top-down dungeon crawler with keys and doors | top-down | yes | 11453 | 11615 | 0 | "Key & Door"; 503 tokens; build 162 ms; 5 levels, bot 5/5 |
| a tower defense where bees protect a hive | defense | yes | 10319 | 10656 | 0 | "Hive Guard"; 463 tokens; build 337 ms; 4 levels, bot 4/4 |
| a sliding block puzzle in a candy factory | puzzle | yes | 12695 | 12931 | 0 | "Candy Slide"; 494 tokens; build 235 ms; 5 levels, bot 5/5 |
| a game like Red Ball 5 | runner | yes | 12226 | 16857 | 0 | "Red Roll"; 455 tokens; build 4630 ms; 5 levels, bot 5/5, one level rebuilt (6 attempts). The idea reader guessed platformer; the model picked runner (no genre word in the idea, so its pick stands) |
| a stickman fight game | arena | yes | 10581 | 14345 | 0 | "Stick Duel"; 371 tokens; build 3764 ms; 3 levels, bot 3/3, one level rebuilt (4 attempts). Idea reader guessed platformer; model picked arena |

Summary: every prompt reached a validated spec on the first model call, with zero validator errors and zero `repairSpec`
fixes. Model time was 10.3 to 12.7 s per design (about 350 prompt and 370 to 500 output tokens, model already loaded);
total prompt to validated, playtested spec was 10.7 to 16.9 s. The level build adds 0.2 to 0.3 s for top-down, defense and
puzzle, and about 3.8 to 4.6 s for the side-view genres, where the bot plays every level. "Retries" counts model repair
calls; the genre route has none, so the only re-dos are the level builder's internal regenerations noted above.
