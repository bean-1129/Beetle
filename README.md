# Beetle

One prompt becomes a playable 2D game in seconds, on a local model, on this machine.

Type an idea ("a platformer where a fox collects acorns across floating cliffs", "a tower defense where bees protect a hive"). Beetle reads it, asks the local model for a short design document, builds the levels, playtests every level with a bot, validates the result and starts the game in the page. Then change it in plain words ("make the jumps higher", "more rain", "slower enemies") and keep playing. Export the finished game as one HTML file that runs offline.

Everything runs locally. Model inference is Ollama on loopback (`qwen3.5:4b`). There is no cloud model and no cloud fallback.

## What is in the studio

The studio is served at `/` (page `apps/web/studio2d.html`, code `apps/web/src/studio2d`).

| Part | What it does | Code |
|---|---|---|
| Engine | fixed-step 2D game loop, tile physics, input, behaviors, seeded randomness | `engine/` |
| Seven genres | platformer, runner, top-down, arena, puzzle, builder, lane defense; each has a standard entity kit and a level generator | `spec/kit.ts`, `world/*.ts` |
| Procedural art | pixel sprites with simple rigs, tilesets, layered backgrounds; no image downloads | `assets/` |
| Sound and music | generated sound effects and music cues, mixed in the browser | `audio/` |
| Spec and validator | every game is a `GameSpec`; `validateSpec` and `repairSpec` check it before it runs | `spec/` |
| Bot playtests | a bot plays each generated level (side view: beam search over inputs; puzzle: solver; builder: part search; defense: placement policy); a level that the bot cannot finish is rebuilt | `world/bot.ts`, `world/levels.ts` |
| Plain-word changes | common requests become spec patches directly; others go to the local model as patch operations; every patch is validated and physics changes must keep every level beatable | `gen/nlpatch.ts`, `spec/patch.ts` |
| Classic game templates | hand-written, shipped games for ideas no genre covers well: block drop, paddle duel, fleet defense, rock field, whack, memory pairs, highway racer, catcher, 2048, snake, brick breaker, flap | `samples/scripts.ts` |
| Export | one self-contained HTML file with the runtime, the spec and all art inlined, under a strict content security policy | `export/export.ts` |
| Library | saved games kept in the browser (localStorage) on this machine | `bridge.ts` |

Model-written game code is turned off (`MODEL_SCRIPTS_ENABLED = false` in `gen/ai.ts`). The model only writes data: a design document or patch operations, both checked against schemas and the validator. A request outside the seven genres that matches no template maps to the closest genre, and the studio says so.

## Layout

| Path | Purpose |
|---|---|
| apps/web | the 2D studio page and its code (React, Vite) |
| apps/server | serves the page, hands the director token to pages opened on this machine, proxies structured model calls to the local Ollama |
| scripts | dev runner, readiness check, 2D benchmark |
| tests | unit tests |
| docs | architecture, results, runbook, capabilities, environment, security review, pitch outline and deck (docs/pitch) |
| data | local runtime data such as benchmark runs (ignored) |

## Requirements

- Node 24 (project-local copy under `.tools/node/bin`, or a system install).
- Ollama serving on `127.0.0.1:11434` with `qwen3.5:4b` pulled (`ollama pull qwen3.5:4b`). A project-local Ollama under `.tools/ollama/bin` works, as does a system install.

```bash
export PATH=$PWD/.tools/node/bin:$PWD/.tools/ollama/bin:$PATH
```

## Commands

| Command | What it does |
|---|---|
| `npm install` | install workspace dependencies from the lockfile |
| `npm run build` | production build of the studio into `apps/web/dist` |
| `npm start` | start the server; open `http://127.0.0.1:7700/` on this machine |
| `npm run dev` | server plus the Vite dev server (development) |
| `npm test` | unit tests (vitest) |
| `npm run typecheck` | TypeScript across the workspace |
| `npm run demo:check` | read-only readiness check before a demo (exits 1 when a required item fails) |
| `npm run benchmark:local` | runs `scripts/measure-2d.ts`: six prompts through the studio's own generation path against the local model; writes `data/studio2d-runs/run-<ms>.json` |

## First run

1. `npm install`, then `npm run build`.
2. Make sure Ollama is running and `ollama list` shows `qwen3.5:4b`.
3. `npm start`, then open `http://127.0.0.1:7700/` in a browser on the same machine. The page receives the director token automatically because it is opened on this machine; nothing to paste.
4. Type an idea, press Design it, then Build. Play in the page, change it in words, export the HTML file.

With Ollama stopped the studio still works: the idea is read directly into a design without the model, and plain-word changes fall back to the requests the studio understands on its own.

## Measured

From docs/RESULTS.md, section "Beetle 2D: prompt to playable" (qwen3.5:4b, direct Ollama, shared GPU, level seed 12345):

| Prompt | Genre | Valid | Model ms | Total ms |
|---|---|---|---|---|
| a platformer where a fox collects acorns across floating cliffs | platformer | yes | 10943 | 14740 |
| a top-down dungeon crawler with keys and doors | top-down | yes | 11453 | 11615 |
| a tower defense where bees protect a hive | defense | yes | 10319 | 10656 |
| a sliding block puzzle in a candy factory | puzzle | yes | 12695 | 12931 |
| a game like Red Ball 5 | runner | yes | 12226 | 16857 |
| a stickman fight game | arena | yes | 10581 | 14345 |

Six of six prompts became validated, bot-playtested specs on the first model call, in 10.7 to 16.9 s from prompt to playable spec. Zero validator errors, zero repair fixes. The warm-up call (14.0 s, of which 5.5 s model load) is excluded.

## Known limits

- Seven genres. Ideas outside them use a hand-written template when one matches, otherwise the closest genre; the game is then a reinterpretation, not the requested game.
- Model-written game code is off, so new game types cannot be invented at run time.
- The benchmark runs in Node: it excludes the Web Worker hop, procedural asset painting and the human pause between Design it and Build. The GPU was shared, so model times are indicative.
- Side-view genres spend about 3.8 to 4.6 s in level building because the bot plays every level.
- The library lives in this browser's localStorage: clearing site data removes it, and it does not sync between machines.
- Saves inside the sandboxed play frame do not persist; exported files opened from disk keep progress in their own storage.
- One machine, one designer. The server binds the LAN interface but only pages opened on this machine receive the director token.
