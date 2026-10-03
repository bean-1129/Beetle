# Beetle architecture (2D)

Beetle turns one prompt into a playable 2D game on one machine. The browser does almost everything: reading the idea, building levels, playtesting, validating, rendering, sound and export. The server serves the page and is the only path to the local model.

## Pieces

```
browser (studio at /)                        server (apps/server, port 7700)          Ollama (127.0.0.1:11434)
  Studio2D.tsx  idea -> design -> build        GET  /api/2d/status                      qwen3.5:4b
  gen/          design, build, patches   --->  POST /api/2d/warm   (director token) --> /api/chat, format = JSON schema
  world/        level generators, bot          POST /api/2d/llm    (director token)
  spec/         GameSpec, validator            POST /api/2d/cancel (director token)
  engine/ render/ audio/ assets/               GET  director bootstrap (this machine only)
  runtime/      sandboxed play frame
  export/       single-file HTML
```

## Generation path

1. **Read the idea** (`gen/design.ts`, `designFromIdea`). Picks a route: one of the seven genres, or a shipped template for a classic game (`samples/scripts.ts`, `findTemplate`). A request that fits neither maps to the closest genre and the studio says so (`MODEL_SCRIPTS_OFF` in `gen/ai.ts`).
2. **Design document** (`gen/ai.ts`, `makeDesign`). One structured call to the local model through `/api/2d/llm` with `DESIGN_SCHEMA` as the Ollama `format`. The reply is parsed tolerantly and passed through `repairDesign`. With no model online, the idea reader's design is used as is.
3. **Build** (`gen/build.ts`, `specFromDesign`, run in a Web Worker by `gen/worker.ts`). `assemble` combines the theme with the genre kit (`spec/kit.ts`); `buildWorld` (`world/levels.ts`) plans levels on a beat order (intro, teach, test, twist, finale), generates each one with the genre's generator, checks reachability and a difficulty budget, and has the bot play it. A level the bot cannot finish is regenerated.
4. **Validate** (`spec/validate.ts`). `repairSpec` normalizes and clamps the spec (sizes, hex palette, known behaviors, parameter ranges); `validateSpec` reports remaining errors. Only a valid spec reaches the player.
5. **Assets** (`assets/`). Sprites, rigs, tilesets and backgrounds are painted procedurally from recipes and seeds in the spec. Sound effects and music come from `audio/`.
6. **Play** (`runtime/`). The spec runs in an iframe with `sandbox="allow-scripts"` and no same-origin access. The parent sends the spec by `postMessage`; the frame reports state back.

## Genres

| Genre | Generator | Bot or solver |
|---|---|---|
| platformer | side-view level builder in `world/levels.ts` | beam search over inputs (`world/bot.ts`), reachability check `reachableSide` |
| runner | endless or fixed side-view levels with auto-run | same bot, look-ahead camera |
| top-down | dungeon rooms with wave function collapse interiors, keys and doors (`world/topdown.ts`) | flood-fill reachability plus bot |
| arena | open arena with waves (`world/topdown.ts`, `arena`) | bot |
| puzzle | crate and plate rooms generated with a known solution (`world/puzzle.ts`) | state-space solver `solvePuzzle`, replayed |
| builder | terrain plus a parts budget (planks, springs, fans) (`world/builder.ts`) | part placement search `solveBuilder`, simulated |
| lane defense | lane grid, shop and economy (`world/defense.ts`) | placement policy `defenseMove`, replayed |

## Plain-word changes

`gen/nlpatch.ts` turns "make the boss slower" or "add a double jump" into RFC 6902 style patch operations. Common requests are matched directly; anything else goes to the local model with `PATCH_SCHEMA`. `spec/patch.ts` applies the operations, refuses `__proto__`, `prototype` and `constructor` segments and any operation under `/script` (that would add game code). The patched spec must validate, and physics changes must keep every level reachable, or the change is refused with a reason.

## Model-written code is off

`MODEL_SCRIPTS_ENABLED = false` (`gen/ai.ts`). The model writes only data: the design document and patch operations. The only game code that runs is the engine and the hand-written templates shipped in `samples/scripts.ts`; template text substitution keeps only words reduced to `[a-z -]`.

## Export and library

- `export/export.ts` writes one HTML file: the bundled runtime (`build/runtime-plugin.mjs`, esbuild IIFE of `runtime/entry.ts`), the spec as escaped JSON, and inlined art. The page carries a content security policy with `default-src 'none'`, so the exported game cannot load anything from the network.
- The library (`bridge.ts`) keeps saved games in the browser's localStorage on this machine.

## Server

`apps/server` (Fastify) does three things:

1. Serves the built studio at `/`.
2. Hands the director token to pages opened on this machine (loopback or the machine's own interface address). Other devices are refused.
3. Proxies structured model calls (`apps/server/src/studio2d.ts`):
   - `GET /api/2d/status`: is Ollama up, which models are present.
   - `POST /api/2d/warm`: load the model.
   - `POST /api/2d/llm`: one chat call with `stream: false`, `think: false`, a JSON schema as `format`, `num_ctx` 8192 by default; strict zod body; at most two concurrent calls; 120 s timeout.
   - `POST /api/2d/cancel`: abort a call by id.

The Ollama URL must be loopback; the server refuses any other. Prompts, replies and tokens are never logged.

## Measurement

`scripts/measure-2d.ts` (`npm run benchmark:local`) runs the same steps in Node with a shim that calls Ollama directly. Results: docs/RESULTS.md.
