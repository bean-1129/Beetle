# Beetle architecture (implementation contract for all package owners)

Beetle: change the game without stopping the game. A local AI prototyping teammate for game studios.
Read `packages/contracts/src/*.ts` first. Those schemas, limits, codes and routes are fixed. Propose contract changes to the integration owner instead of editing them unilaterally.

## Packages and ownership

| Path | Owns | Imports |
|---|---|---|
| packages/contracts | zod schemas, limits, codes, protocol types, routes, pure geometry helpers | zod only |
| packages/world | world compiler (spec to geometry and colliders), WalkField, nav grid, validators, playability checks, draft expansion, fixtures, seeded PRNG | contracts |
| packages/observability | JSONL event log, sanitizer, Stopwatch, summarize | contracts |
| apps/server | Fastify HTTP + ws WebSocket, authoritative 30 Hz simulation, session state, candidate store, validation proofs, commit transaction, persistence, auth tokens, request queue, static serving of apps/web/dist | contracts, world, observability |
| packages/agent | OpenClaw tool plugin (7 tools), agent worker loop, Ollama client with JSON-schema structured output, labelled direct-mode harness, benchmark runner | contracts, observability (never world or server internals; it talks to the server over HTTP) |
| apps/web | /director, /play, /controller pages (React + Vite), Babylon.js renderer with diff-by-id updates, QR join, activity trail | contracts only |
| tests | unit (vitest, fixtures), integration (real server process, optional real model) | everything |
| scripts | dev.mjs, demo-check.mjs, benchmark-local.ts | |

## Three kinds of state

- `WorldSpec` (contracts/world.ts): persistent structure. Changes only when a transaction commits; `worldVersion` increments by exactly one per commit.
- `SessionState` (contracts/session.ts): players, positions, collected relics, tombstones, score, tick. Advances every simulation tick. Never written by the agent.
- `PresentationState`: client only (camera, animation blends, UI). Never authoritative.

Patch validity is bound to `worldVersion`, never to the tick, so moving players do not make edits stale.

## Coordinates and geometry

X/Z is the walk plane, Y is up, +Z is north, +X is east, metres, origin at world centre. All platform tops are at Y = 0 (`GEOMETRY.platformElevation`); the hazard plane is at `hazard.planeElevation` (default -2.5). Islands are circles (`center`, `radius`). Bridges are axis-free rectangles between two endpoint points with `width`. Island names for the model come from `compassName(center)` in contracts (published convention), optionally plus the model's own display name.

### CompiledWorld and WalkField (packages/world)

`compileWorld(spec: WorldSpec): CompiledWorld` is deterministic: same spec + `COMPILER_VERSION` gives identical structural geometry. Cosmetic variation (tree shape, rock tilt) comes from a separate seeded PRNG stream over `spec.seed` and is exposed only as render hints; it never affects colliders.

```ts
type Surface = { id: string; kind: 'island' | 'bridge'; /* geometry */ };
type Obstacle = { id: string; kind: 'decoration' | 'gate'; x: number; z: number; r: number };
type CompiledWorld = {
  spec: WorldSpec;
  surfaces: Surface[];
  obstacles: Obstacle[];
  worldPos(surfaceId: string, local: Vec2): Vec2 | null;    // island centre + local offset
  supportAt(x: number, z: number): string | null;            // island or bridge id under the point, no inflation
  blockedAt(x: number, z: number, opts: { gateOpen: boolean }): string | null; // obstacle whose radius + playerRadius contains the point
  fits(x: number, z: number, opts: { gateOpen: boolean }): boolean; // centre not blocked and the four points at ±playerRadius on X and Z are all supported
  nav: NavGrid;                                               // cell = GEOMETRY.navCell; walkable = fits(cellCentre)
  renderHints: Record<string, unknown>;                       // cosmetic only
};
```

Server movement and the validator both use this object. The validator's reachability uses `fits` (conservative). Server movement uses `blockedAt` for props and the locked gate (slide along), and `supportAt` at the player centre for support, so a player can walk off an edge and fall. That difference is deliberate and documented: the validator proves a conservative route exists; the simulation allows risk at edges.

### Validation (packages/world/validators)

`validateSpec(spec, ctx)` returns `ValidationIssue[]` using codes from contracts. `ctx` carries optional live constraints: active player positions (for `PLAYER_CUT_OFF`), collected relic ids (uncollected relics must be reachable), and the previous spec (for patch semantics). Checks, in order, short-circuiting only on schema failure:

1. `INVALID_SCHEMA` via `WorldSpecSchema.safeParse` (finite numbers, bounds, counts, enums, unknown properties).
2. `DUPLICATE_ID` across all object ids; `INVALID_REFERENCE` for any surface, island, relic id that does not exist; gate `requiredRelicIds` must be existing relics.
3. `RESOURCE_LIMIT` is covered by schema counts; re-report with object ids when a patch would exceed limits.
4. `ISLAND_OVERLAP`: island discs must keep a gap of at least 1.0 m.
5. `OBJECT_NOT_ON_SURFACE`: spawns, relics, gate, decorations must lie on an island (distance from centre + object radius ≤ island radius). Only islands are supporting surfaces for objects in v1.
6. `BRIDGE_ENDPOINT_GAP`: each endpoint point must be on its island rim: `|dist(center, point) - radius| ≤ GEOMETRY.socketTolerance`, and the endpoint island ids must differ. `BRIDGE_LENGTH` for length outside limits. `BRIDGE_CROSSES_ISLAND` when the bridge segment passes through a third island. `BRIDGE_TOO_NARROW` when `width < 2 * playerRadius + 0.2` (schema minimum already enforces 1.6, keep the check for patches that bypass defaults).
7. Reachability on `nav` with the gate treated as blocked (locked): from every spawn, every uncollected relic must be reachable (`UNREACHABLE_RELIC`), and a cell within `gateTriggerRadius` of the gate must be reachable (`DISCONNECTED_GOAL`). `UNREACHABLE_SPAWN` if a spawn cell itself is not walkable. `GATE_HIDES_RELIC` when a relic is reachable only with the gate open.
8. With live context: for each active player, snap to the nearest walkable cell within 1.0 m (or their spawn if falling/respawning/disconnected) and require the same reachability (`PLAYER_CUT_OFF`).

`runPlayabilityChecks(compiled, ctx): PlayabilityReport` reruns the route checks and adds a headless walk test: simulate the server movement rules along the BFS path for spawn → each relic → gate and confirm the walker arrives without falling. Name it "connectivity and supported-movement checks".

### Patches

`applyPatch(spec, patch): { spec: WorldSpec; changedIds: string[] } | { issues }`. `add_bridge` derives endpoint points as the rim points on the line between island centres; a generated id must not collide. `set_hazard` only changes `hazard.kind` and the policy (lava: `scorePenalty` = `SCORING.lavaFallPenalty`); it never touches platforms. `move_relic` on a collected relic yields `RELIC_ALREADY_COLLECTED`. The resulting spec gets `worldVersion = base + 1` only at commit time; candidates carry the base version.

`expandDraft(draft: WorldDraft, seed, worldId): WorldSpec` turns the model draft into a full spec (spawn/relic ids generated from slot/index if absent, bridge endpoints derived, `requiredRelicIds` = all relics, hazard policy from kind, objectiveRules fixed).

## Transaction flow (apps/server)

1. Agent `GET /api/agent/world` → `{ spec, version, summary: SessionSummary }`.
2. Agent `POST /api/agent/candidates/world` or `/patch` → server builds a candidate copy (applies the patch to a clone), stores `{ candidateId, requestId, baseWorldVersion, spec, digest = sha256(canonicalJson(spec)) }`. Never touches the active world. Schema errors are returned as issues here.
3. `POST /api/agent/candidates/:id/validate` → runs `validateSpec` with live context → `ValidationResult`. When ok, stores and returns a `ValidationProof` with a random `proofId` (crypto), bound to digest, base version, validator version, `expiresAt = now + SIMULATION.validationProofTtlMs`.
4. `POST /api/agent/candidates/:id/playability` → `PlayabilityReport`.
5. `POST /api/agent/candidates/:id/commit { proofId }` → checks: candidate exists (`UNKNOWN_CANDIDATE`), proof exists and matches digest (`DIGEST_MISMATCH`), not expired (`VALIDATION_EXPIRED`), `baseWorldVersion === current` (`STALE_WORLD_VERSION`), then enqueues the commit for the simulation loop. At the next tick boundary the loop rechecks: every active player's `supportId` must still exist in the candidate and the player must still `fit` (else `OCCUPIED_SUPPORT`, deferred up to `SIMULATION.commitDeferMaxMs`, then rejected with the player ids). On success: `worldVersion + 1`, swap compiled world, preserve players (same ids, positions, inventory, connections), append event + snapshot, broadcast `world` message with `reason: 'commit'` and `changedIds`. Committing the same `patchId` twice returns the first result with `idempotentReplay: true` and does not change anything.
6. New-world candidates during an active session with connected players require `authorizeNewWorld: true` on the director request; otherwise the commit is rejected with `UNSUPPORTED_OPERATION` ("edit is never promoted to a reset"). A new world resets positions to spawns but keeps player ids and connections.
7. Undo (`POST /api/director/undo`): builds a candidate from the previous spec with `worldVersion` = current + 1, validates with live context (tombstones keep collected relics collected), and commits through the same path. If unsafe, returns the issue instead of resetting.

Display readiness: the display acks `world` messages; the server waits at most `SIMULATION.displayAckTimeoutMs` for the active display before considering a commit presented, and never blocks the simulation on it.

## Simulation (apps/server)

Fixed 30 Hz loop using `setInterval` with drift correction; the loop body never awaits. Per tick for each connected player with fresh input (age ≤ `SIMULATION.inputTimeoutMs`): velocity = normalized axes × `playerSpeed`; candidate = position + v × dt; if `blockedAt(candidate)` try X-only then Z-only slide; if `supportAt(final) === null` → `status = 'falling'`, after `fallDurationMs` → hazard contact: `respawns++`, if lava `lavaFalls++` and `score -= scorePenalty`, `status = 'respawning'` at own spawn for `respawnDurationMs`, then `active`. Stale input (age > timeout, or seq ≤ last seq) clears velocity. Interact press (edge-triggered) within `relicPickupRadius` of an uncollected relic collects it exactly once (first player in slot order wins the same tick), `score += SCORING.relic`, tombstone recorded. Gate unlocks when all `requiredRelicIds` are collected; win when an active player is within `gateTriggerRadius` after unlock; `score += SCORING.win` once.

Tick broadcast: one `tick` message per tick to all sockets (small JSON). Controllers also get `lastInputSeq`.

## Auth and network

- Director token and agent token: from env or generated once into `data/secrets.json` (ignored). Printed to the console at startup as a `/director?token=` URL only when generated, never logged elsewhere. Request logs use `redactUrl`.
- Invite: director `POST /api/director/invite` → `{ inviteCode, url, expiresAt }` (5 minutes, single use per player slot). Phone opens `url` (`/controller?invite=CODE`), the page `POST /api/join` → `{ controllerToken, playerId, label, color }`, stores it in sessionStorage, connects to `/ws` and sends `hello` with role controller. Reconnect with the same token restores the same player.
- Agent routes accept only loopback source addresses and the agent token. Controller tokens cannot call director or agent routes (403). WebSocket origin check: same host as the server or configured `BEETLE_PUBLIC_URL`.
- Rate limits: inputs over `inputRateLimitPerSec` are dropped; messages over `maxMessageBytes` close the socket; unknown message shapes are ignored with one `error` reply.
- Server listens on `BEETLE_HOST:BEETLE_PORT` (default 0.0.0.0:7700) and serves `apps/web/dist` when present. Ollama and the OpenClaw gateway stay on loopback.

## Agent (packages/agent)

Worker loop (`npm run agent`): long-polls `POST /api/agent/requests/claim`; for each request runs one bounded job: deadline `BEETLE_REQUEST_DEADLINE_MS`, at most `BEETLE_MAX_REPAIR_ATTEMPTS` repairs, finite tool calls (16). Status updates go to `/api/agent/requests/:id/status` with phases from `AGENT_PHASES`; the server turns them into `activity` broadcasts. The job ends with `/api/agent/requests/:id/finish`.

Two modes, both labelled in every report and event:
- `openclaw` (submission path): the job invokes the installed OpenClaw (`openclaw agent exec` or the documented equivalent for 2026.9.8) with the Beetle tool plugin registered in an isolated OpenClaw home (`.openclaw-home/`, ignored), local-only Ollama provider at `http://127.0.0.1:11434`, exact model allowlist, no remote failover. The seven tools (`read_world_state`, `propose_world`, `propose_patch`, `validate_candidate`, `run_playability_checks`, `commit_candidate`, `publish_build_report`) are thin HTTP clients to the agent routes. Tool schemas are short; the system prompt carries the coordinate convention, limits and the compact summary.
- `direct` (dev harness): same tool functions called in-process, model via Ollama `/api/chat` with `format` = the JSON schemas in contracts, `think: false` for drafts and edits, `stream: false`. Used by the benchmark and as a clearly labelled fallback; never presented as OpenClaw.

Model output is parsed and validated at the boundary (`WorldDraftSchema` / `PatchDraftSchema`); invalid or truncated output triggers a bounded retry with the zod error summary, never a scene mutation. Validator issues are fed back verbatim (codes, object ids, evidence) for the repair attempt. Nothing from the model is ever executed.

## Web (apps/web)

Vite multi-page app: `index.html` (landing with links), `director.html` (`/director`), `play.html` (`/play`), `controller.html` (`/controller`). Vite dev server proxies `/api` and `/ws` to 7700. The renderer keeps a map `id → mesh`; on a `world` message it diffs by id (add, update, remove) and never recreates the scene. Hazard change swaps the water material to lava with a short blend. Players, camera and relic state persist. Director panel shows prompt input, capability hints, current version, activity trail (real phases only), model status, join QR, controller states and measured timings.

## Observability

`createEventLog({ filePath, source })` → `emit`, `recent`, `onEvent`. Server writes `data/events/server.jsonl`, agent writes `data/events/agent.jsonl`. Snapshots `data/snapshots/world-v{N}.json` and `data/snapshots/session.json` written atomically (temp file + rename). Benchmarks write `data/benchmarks/*.json`.

## Tests map

| Case | Where |
|---|---|
| 1 schema rejections | tests/unit/contracts.test.ts |
| 2 deterministic compile | tests/unit/compiler.test.ts |
| 3, 4, 5, 6, 7 validators | tests/unit/validators.test.ts (fixtures in tests/fixtures) |
| 8, 9, 10, 11, 16 transactions and session | apps/server/src/*.test.ts (in-process, no sockets) and tests/integration/server.test.ts (real process) |
| 12, 13 controllers and auth | tests/integration/server.test.ts |
| 14, 15 model failure handling | tests/unit/agent.test.ts with a fake Ollama server |
| 17, 18 live OpenClaw and local-only | tests/integration/live-agent.test.ts, run only with `BEETLE_LIVE_MODEL=1`; results recorded in BUILD_STATUS.md honestly |

## Model-output normalization (added 13:05 CDT after live runs)

Live runs with qwen3.5:4b showed three mechanical failure modes: island references by display name or compass word instead of id, world coordinates or over-radius offsets written into `localPosition`, and numeric limits the JSON-schema grammar does not enforce (bridge width 10, overlapping islands). `packages/world/src/normalize.ts` fixes these deterministically before schema validation:

- `resolveIslandRef`: exact id, then slug of the display name, then stripped id ("temple-island" to "temple"), then a unique compass octant ("northern island" to the one island whose `compassName` is north), then a unique substring. Ambiguous or unknown references are left untouched so the validator reports `INVALID_REFERENCE`.
- `normalizeLocalPosition`: a world coordinate that lies on the island becomes an offset; an over-long offset is scaled back to `radius - 1.2` along the same direction.
- `separateIslands`: overlapping discs are pushed apart along their centre line until every pair keeps a 1.0 m gap (plus 0.25 m margin), clamped to bounds, at most 60 iterations.
- Widths, radii and centres are clamped to `WORLD_LIMITS`; a missing bridge id is generated.

`expandDraft` and `applyPatch` (for `PatchDraft` input only, never for a full `WorldPatch`) apply this and return a `normalizations` array that records every change with its path, old value, new value and reason. Strict schemas and the full validator still run afterwards; normalization never bypasses reachability, gate or occupancy checks. On the corpus of real model drafts, validity after normalization rose from 1 of 3 to 3 of 3 for briefs; patches that fail on semantics (an unreachable relic) still fail.

The direct-mode agent therefore sends parsed JSON to `propose_world` / `propose_patch` without a local schema check (JSON syntax and truncation only) and repairs from the server's issues.

## Security changes from the review (docs/SECURITY_REVIEW.md)

- Agent routes refuse candidates and reports for a request that is cancelled or finished (409); a report only produces an activity entry for a request that exists and is open.
- The director URL with its token is printed at startup only when the token was just generated into `data/secrets.json`, or when `BEETLE_PRINT_DIRECTOR_URL=1`.
- `SafeText` rejects control, bidi and zero-width characters.
- The isolated OpenClaw profile disables update checks and telemetry (`update.checkOnStart=false`, `update.auto.enabled=false`, `telemetry.enabled=false`, `DO_NOT_TRACK=1`) and the runner refuses to start if the on-disk config no longer pins one loopback provider, no fallbacks, a loopback gateway and only the Beetle tools.
- The Ollama daemon is started with `OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NUM_PARALLEL=4 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KEEP_ALIVE=1h` (project-local binary, loopback only).

## Mode library and generator mapping (added 14:20 CDT with today's contract)

Beetle is a generator with a bounded library: any game request is mapped onto the closest supported mode and biome, never onto model-written rules. This section records the contract fields, the server rule per mode, the validator checks and the agent's mapping rule. At 14:27 CDT the contract, validator, patch ops, movement speed and session summary (packages/contracts, packages/world), the server objective rules (apps/server/src/simulation.ts), the agent's mapping prompt (packages/agent/src/prompts.ts) and the biome palettes (apps/web/src/renderer/palette.ts) exist in code; Tested per BUILD_STATUS.md (14:36 CDT): 29 mode unit tests (tests/unit/modes.test.ts, fixtures race5, hill4, survival5, trial5), 50 in-process server tests, and tests/integration/modes.test.ts with the five modes on a real server with real controllers, 5 of 5; the frost hill fixture verified in the browser. Measured mode briefs (14:25 to 14:42 CDT, direct mode) are in docs/RESULTS.md "Game modes from one prompt": mode sensible on 18 of 18 briefs, committed briefs 13.0 to 44.1 s, every failure geometry, MODE_INVALID never fired, mode and biome edits 3.0 s each.

### Contract fields (packages/contracts/src/limits.ts, world.ts, patch.ts, session.ts)

- `GAME_MODES = ['relic_hunt', 'time_trial', 'king_of_the_hill', 'checkpoint_race', 'survival']`; `BIOMES = ['garden', 'volcanic', 'frost', 'desert', 'night']`; `HAZARD_KINDS` stays `['water', 'lava']`; `DECORATION_TYPES` grows to 11 (tree, rock, lantern, pillar, bush, shrine, tower, ruin, crystal, mushroom, statue, each with a collision radius in `DECORATION_RADIUS`).
- `MODE_LIMITS`: `timeLimitSec` 20 to 600 (default 120), `holdSeconds` 3 to 60 (default 10), `relicsRequired` 1 to 3, `movementSpeed` 3 to 7 (default 4.5), `hazardRise` with `afterSec` 5 to 300, `metersPerSec` 0.01 to 0.5, `maxElevation` -2 to -0.6.
- `WorldSpec` gains `biome` (required), `mode?: ModeSchema` (`kind`, optional `timeLimitSec`, `holdSeconds`, `relicsRequired`, `orderedCheckpoints`), `movement?: { speed }` and `hazard.rise?: HazardRiseSchema`. Omitted `mode` means relic_hunt with every relic required, so every world committed before today still parses and plays as before. `effectiveMode(spec)` and `effectiveSpeed(spec)` apply the defaults in one place: `relicsRequired` defaults to the relic count, `timeLimitSec` defaults to 120 for time_trial and survival and is null otherwise, `orderedCheckpoints` defaults to true for checkpoint_race, `holdSeconds` defaults to 10.
- `WorldDraft` (the model-facing brief output) gains optional `biome`, `mode`, `movementSpeed` and `hazardRise`; `expandDraft` carries them into the spec (`movementSpeed` becomes `movement.speed`, `hazardRise` becomes `hazard.rise`, biome defaults to garden). The Ollama `format` JSON schema (`WORLD_DRAFT_JSON_SCHEMA`) carries the same enums and ranges so the grammar already constrains the model.
- Patch ops: `set_mode { mode }`, `set_biome { biome }`, `set_movement { speed }` join the eight structural ops; `PATCH_OP_NAMES` and `PATCH_DRAFT_JSON_SCHEMA` list them. `applyPatch` replaces the whole `mode` object on `set_mode` (an edit that changes one parameter restates the mode) and reports `MODE_INVALID` immediately when `relicsRequired` exceeds the relics in the world.
- `SessionState.objective?: ObjectiveState` (`kind`, `remainingSec`, `lost`, `holdSec` per player, `holdTarget`, `nextCheckpointId`, `relicsRequired`, `hazardElevation`) is the mode-dependent state the simulation advances and the display renders; absent fields mean not applicable. `SessionSummary` (what the agent reads) gains `mode` and `biome` so an edit prompt knows the current rules.
- The validation code `MODE_INVALID` is added to the contract's code list.

### Server rule per mode (apps/server/src/simulation.ts, `resolveMode`, `updateHazard`, `handleInteractions`, `updateGate`; objective state in contracts/session.ts)

The simulation keeps the common rules for every mode (30 Hz tick, movement with `effectiveSpeed`, support and fall, hazard contact and respawn, relic pickup once, `score += SCORING.relic` per relic and `SCORING.win` once) and adds one objective rule chosen by `resolveMode(spec).kind`. A per-world mode runtime (elapsed time, hold time per player, submerged bridges, `lost`) is reset on a world commit and on a `set_mode` patch; players, positions, inventory, score and connections live in SessionState and are preserved exactly as for any other commit. `buildObjective` publishes the fields below in every tick.

| Mode | Rule the server applies each tick | Objective fields |
|---|---|---|
| `relic_hunt` | gate unlocks when every id in `gate.requiredRelicIds` is collected or the collected count reaches `relicsRequired` (default all); win when an active, connected player is within `gateTriggerRadius` after unlock | `relicsRequired` |
| `time_trial` | relic_hunt plus a countdown from `timeLimitSec`; `remainingSec` is published each tick; when it reaches 0 before a win, `lost` is set, pickups are disabled and the gate no longer wins until a new world or a `set_mode` patch | `remainingSec`, `lost`, `relicsRequired` |
| `king_of_the_hill` | the gate island is the hill and the gate has no lock; every active, connected player within `gateTriggerRadius` of the gate accumulates one tick of hold time per tick (both can accumulate at once); the first player whose hold reaches `holdSeconds` wins | `holdSec` per player, `holdTarget` |
| `checkpoint_race` | with `orderedCheckpoints` (the mode default) only the next relic in order can be collected, published as `nextCheckpointId`; the gate unlocks after the last checkpoint and the gate trigger wins; with `orderedCheckpoints: false` it behaves like relic_hunt | `nextCheckpointId` |
| `survival` | hazard elevation = min(`maxElevation`, `planeElevation` + `metersPerSec` x max(0, elapsed - `afterSec`)), published as `hazardElevation`; every bridge deck sits at Y = 0, so all bridges submerge together once the plane passes -1.0 m (`SUBMERGE_PLANE_ELEVATION`) and stop supporting players through a filtered `supportAt`, no recompilation; `relicsRequired` defaults to 1 for this mode; win by collecting that many relics and reaching the gate before the countdown from `timeLimitSec` ends, otherwise `lost` | `remainingSec`, `lost`, `hazardElevation`, `relicsRequired` |

`movement.speed` is read through `effectiveSpeed` by the shared mover (packages/world/src/movement.ts) and by the playability walker (packages/world/src/playability.ts), so a `set_movement` commit changes the walk speed for the next tick.

### Validator checks (packages/world/src/validate.ts, step 2c, plus the existing steps)

- Ranges are schema-checked first (`ModeSchema`, `MovementSchema`, `HazardRiseSchema`, the biome and decoration enums): out-of-range values are `INVALID_SCHEMA`, never silently clamped.
- `MODE_INVALID` cross-field rules: `relicsRequired` above the relic count; `checkpoint_race` with fewer than 2 relics; `survival` without `hazard.rise`, or with `maxElevation` not above the starting `planeElevation` (the hazard would never rise); an effective `timeLimitSec` outside 20 to 600.
- Every mode keeps the structural and reachability checks unchanged: geometry, bridge sockets, `BRIDGE_DUPLICATE`, walk field, every uncollected relic and the gate reachable from every spawn with the gate locked (`UNREACHABLE_RELIC`, `DISCONNECTED_GOAL`, `GATE_HIDES_RELIC`), live players not cut off (`PLAYER_CUT_OFF`), occupied support at commit time (`OCCUPIED_SUPPORT`). A `set_mode` to king_of_the_hill therefore still requires a reachable gate, because the gate island is the hill.
- `set_biome` and `set_movement` never change geometry, so a biome or speed change passes the structural checks trivially and is still committed through the proof-bound transaction (digest, base version, TTL, idempotent replay) like every other patch.

### How the agent maps a request (packages/agent/src/prompts.ts, direct and OpenClaw paths)

1. The brief prompt (`MODE_LINES`, `BIOME_LINE`, `MODE_RULE` in packages/agent/src/prompts.ts, shared by the direct path and the OpenClaw instruction) lists the five modes with one line each on what players do and what wins, with the mapping hints written in ("tag or capture maps here" on king_of_the_hill, "a race maps here" on checkpoint_race, "survival requires hazardRise"), the five biomes with synonyms (snow is frost, dark is night, sand is desert, lava is volcanic), the movement range (fast 6, slow 3.5) and the parameter ranges. The rule is: always set mode and biome explicitly; set `timeLimitSec`, `holdSeconds` or `relicsRequired` whenever the request implies them ("a 90 second limit" is `timeLimitSec: 90`, "hold ten seconds" is `holdSeconds: 10`); when the requested game is not an exact match, name the mapping in the title, for example "Tag Arena (king of the hill)", so the director sees which mode was chosen. The hill in king_of_the_hill is the gate island.
2. The draft is structured output under `WORLD_DRAFT_JSON_SCHEMA`, so the model can only emit a listed mode kind, a listed biome and in-range parameters; a mode it cannot express (team deathmatch, a ball sport) has to land on the nearest listed kind, and the prompt tells it to say so rather than refuse.
3. Deterministic normalization (packages/world/src/normalize.ts) runs before the strict schema exactly as before: island references by name, over-radius offsets, clamped widths and radii, island separation. On the mode fields it infers a missing biome from the hazard (lava gives volcanic, otherwise the garden default) and clamps `hazardRise` into range; it never changes a mode kind (measured: docs/RESULTS.md "Game modes from one prompt", where the first prompt version produced no biome on 4 of 4 briefs and the normalizer decided it).
4. The validator runs; `MODE_INVALID` issues go back verbatim with the object ids and evidence (`relicsRequired`, `relics`, `maxElevation`, `planeElevation`) for the bounded repair, the same loop as every other code. A survival brief that forgets `hazardRise` is repaired by adding it, not by changing the mode.
5. For edits, the patch prompt describes the current mode (`describeMode`: "time_trial 60 s", "relic_hunt (default)") and biome from the world and offers `set_mode`, `set_biome` and `set_movement` beside the structural ops with worked examples ("make it a 60 second time trial" is `set_mode {kind: time_trial, timeLimitSec: 60}`, "make it snowy" is `set_biome frost`, "faster players" is `set_movement 6`), so "make it a race" or "frost, and faster" become one bounded patch that commits without a reset.

Nothing here changes the trust boundary: the model proposes JSON, the server decides validity, and the mode rule is engine code chosen by an enum, never text the model wrote.

## Streaming generation (added 15:20 CDT)

A brief no longer builds the whole map. It builds the zone around the spawn (2 to 4 islands) and Beetle keeps extending the world ahead of the players with automatic director requests. The contract pieces are `STREAMING` in packages/contracts/src/limits.ts (`frontierMeters: 4`, `cooldownMs: 12000`, `maxIslands: 24`, `islandsPerExtension: {min: 1, max: 2}`), `WorldSpec.streaming` (world.ts), the patch ops `add_island` and `remove_island` (patch.ts, applied in packages/world/src/patch.ts), `DirectorRequest.auto` / `autoReason` and `DirectorSettingsBodySchema` with `ROUTES.directorSettings` (protocol.ts). World limits were raised to 24 islands and 48 bridges so a grown world still validates.

The server trigger, settings route and extension prompt belong to the server and agent owners; the paragraphs below state the agreed contract (what the web and docs rely on). Confirm the exact heading quantisation, cooldown start and cancellation rule against apps/server once their change lands.

### Trigger (server, deterministic)

Each simulation tick the server looks at every connected player's authoritative position. A player is "at the frontier" when they are within `STREAMING.frontierMeters` of the rim of the island that supports them, and no bridge leaves that island on the side the player is approaching (the direction is the compass heading from the island centre through the player, quantised to north, east, south, west). Nothing on the client decides this: the check uses the same compiled world and the same positions that drive collision and support, so two displays, or a replay from `data/events/server.jsonl`, reach the same decision at the same tick. Keeping it server-side also means a phone that lies about its position cannot force generation; inputs are still intent only.

### Cooldown and limits

- At most one automatic request every `STREAMING.cooldownMs` (12 s) per world, and never while another request (manual or automatic) is open, so a slow model cannot queue a backlog of extensions.
- No automatic request when the world already has `STREAMING.maxIslands` (24) islands, when `WorldSpec.streaming` is false, or when the director switched `autoExpand` off (`POST /api/director/settings { autoExpand: false }`, director token; the setting is in memory and defaults to on at startup).
- An extension asks for `islandsPerExtension.min` to `max` (1 to 2) islands; the patch budget stays `WORLD_LIMITS.patchOps.max`, so one extension is a normal-sized edit.
- Manual requests come first: a director brief or edit is never blocked by an automatic request (the intended rule is that a queued automatic request is cancelled and shows as cancelled in the trail; confirm in apps/server).

### Request flow

1. The frontier check fires for player P at island I in direction D. The server creates a `DirectorRequest` with `kind: 'edit'`, `auto: true`, `autoReason: { islandId: I, direction: D, playerId: P }` and a server-written prompt ("Add one or two islands north of Hearth Island, each joined by a bridge, matching the biome; keep every existing island, bridge, relic, spawn and the gate"). It is queued, broadcast as activity and claimed by the agent worker exactly like a manual edit.
2. The agent drafts a patch made of `add_island` (with `bridgeFrom` set to the frontier island) and `add_bridge` / `add_decoration` ops, proposes it through the normal candidate route, and the server validates, defers on `OCCUPIED_SUPPORT` and commits through the same transaction as any edit (see "Transaction flow"). Players keep positions, inventory and connections; nothing resets.
3. The committed world is broadcast as a new version; the director trail shows the request with the `auto` tag and the reason ("extending north of Hearth Island for Amber"), and the build report carries the same request id.
4. If the agent fails within its repair budget, the request finishes `failed`, the world stays exactly as it was and the cooldown applies before the next attempt. There is no partial commit.

### Ops

- `add_island { id, name?, center, radius, bridgeFrom? }`: the applier clamps the centre inside the bounds, pushes the island away from its nearest neighbour until the 1.25 m gap holds (deterministic, at most 40 iterations), and when `bridgeFrom` names an island it adds a straight bridge between the two rims so the new land is reachable in the same op. Refused with `DUPLICATE_ID` or `RESOURCE_LIMIT` (24 islands).
- `remove_island { id }`: refused with `INVALID_REFERENCE` for an unknown id, `UNSUPPORTED_OPERATION` when the island carries a spawn, a relic or the gate, and `RESOURCE_LIMIT` below the minimum island count; otherwise the island, its bridges and its decorations go, and the touched ids are recorded for the live checks.

### Validator checks

An extension is validated as a full world, not as a delta: `OUT_OF_BOUNDS` (island discs inside the +-60 m bounds, step 3b), `ISLAND_OVERLAP` (step 4), bridge geometry (`BRIDGE_ENDPOINT_GAP`, `BRIDGE_LENGTH`, `BRIDGE_CROSSES_ISLAND`, `BRIDGE_DUPLICATE`), reachability of spawns, relics and the gate over the recompiled walk field, and the live checks against connected players (`PLAYER_CUT_OFF`, `OCCUPIED_SUPPORT` deferral). The `add_island` applier cannot produce an overlapping or out-of-bounds island, so the usual failure on an extension is a bridge the model drew across an existing island, which the agent repairs within its budget.

### Why the frontier check lives on the server and is deterministic

- Authority: positions, support and bridges are server state; a client-side trigger would have to trust a controller's view of where it stands.
- Replay: the trigger is a pure function of (compiled world, tick positions, cooldown clock), so an extension seen in the demo can be reproduced from the event log and tested without a model by driving a scripted controller to a rim and asserting the automatic request.
- Single writer: the server is the only thing that creates requests, so manual and automatic requests share one queue, one cooldown and one transaction path, and the "manual wins" rule is enforceable.
- Status at 15:20 CDT: contracts, limits, the island ops and applier, the director toggle and the trail tagging are in the tree (`npx tsc -p apps/web/tsconfig.json` clean). The server trigger, the settings route and the agent prompt for extensions are owned by the server and agent owners and were still landing when this section was written; no streaming run is recorded in docs/RESULTS.md yet.

## Terrain types (added 15:31 CDT)

A world is either floating islands over a hazard or one continuous landmass. The terrain changes how zones and crossings read and how an edge behaves; it does not change their geometry, so the compiler, validator and agent work the same on both.

### Contract field

- `WorldSpec.terrain`: `'islands' | 'ground'`, optional (`TERRAINS` in packages/contracts/src/limits.ts, schema in packages/contracts/src/world.ts). `effectiveTerrain(spec)` returns `'islands'` when the field is absent, so every world written before this field is unchanged.
- Patch op `set_terrain { terrain }` (packages/contracts/src/patch.ts, applied in packages/world/src/patch.ts) switches it live through the normal validated commit path.
- The same `islands`, `bridges` and hazard arrays describe both terrains. On `ground` an island is a plateau and a bridge is a path; nothing is renamed in the contract.
- The model chooses the terrain from the brief and alternates when the brief implies neither, so islands are not the default look of generated worlds.

### Movement rule difference (packages/world/src/movement.ts)

- `islands`: a step that leaves every supporting surface sets `fell`; the player drops into the hazard and respawns, as before.
- `ground`: a step that would leave support is cancelled. The position stays where it was and the velocity on that step is zeroed, so the plateau or path edge blocks like a wall; the existing axis-separated slide against `blockedAt` lets the player keep moving along the edge. There is nothing to fall into, so `fell` is never set on ground.

### Renderer difference (apps/web)

- `islands`: floating terrain bodies with undersides, plank bridges, and the water or lava plane below, as described under "Web".
- `ground`: one continuous landmass. Zones render as raised plateaus and crossings as paths on the ground surface, with no floating undersides and no void between zones. The biome preset (garden, volcanic, frost, desert, night) applies to both.
- Status at 15:40 CDT: the ground renderer, the terrain choice in the agent prompt and the set_terrain op are landed; a ground world was committed and rendered live (docs/RESULTS.md, Ground terrain live) and three briefs were measured (docs/RESULTS.md, Terrain choice and honest mapping).

### Validator unchanged

The validator (packages/world/src/validate.ts) needs no terrain branch, because zones and crossings keep their geometry: island discs still carry centre and radius, bridges still join two rims, and the walk field is compiled from the same shapes. Every existing check applies unchanged on ground (`ISLAND_OVERLAP`, `OUT_OF_BOUNDS`, the bridge geometry codes, reachability of spawns, relics and the gate, `OBJECT_NOT_ON_SURFACE`, the live `PLAYER_CUT_OFF` and `OCCUPIED_SUPPORT` checks). Reachability means the same thing on both: a relic off the walk field is unreachable whether the gap below it is water or the side of a plateau.

## Beetle 2D (added 16:05 CDT)

Beetle builds 2D games as well as 3D worlds. The 2D studio is a separate page with its own engine; it shares the server, the local model, the director token and the visual language with the 3D side, and nothing in the 3D contract, world package or simulation changes.

### Page and entry points

- `apps/web/studio2d.html`, served at `/2d` (clean route in apps/web/vite.config.ts, built as the `studio2d` input). Entry `src/studio2d/page/main.tsx` installs the browser bridge, then mounts `ui/Studio2D.tsx` full page.
- The landing page offers "3D world" or "2D game" next to the prompt: 3D goes to `/director?prompt=...`, 2D goes to `/2d?prompt=...`; both carry `?token=` when the landing link had one. The director panel header has a quiet "2D studio" link to `/2d`. The token lives in sessionStorage under `beetle.directorToken` (`shared/token.ts`), so it follows the user between pages in the same tab.

### Module layout (apps/web/src/studio2d)

| Folder | Contents |
|---|---|
| spec | `GameSpec` types and the seven genres (`GENRES` in types.ts), per-genre defaults (rules, controls, HUD, palettes), the standard entity kit per genre (kit.ts), behaviours, the patch format (patch.ts) and the validator with repair (validate.ts) |
| engine | fixed-step game loop, input, physics, behaviours, seeded RNG; runs headless for checks and the playtest bot |
| world | level generators per genre: platformer and runner chunk stitching, top-down rooms and arena, puzzle rooms built backwards from their solution with an exact solver, physics-builder levels proven by simulation, lane defense; `levels.ts` runs outline, layout, populate, validate, decorate; `bot.ts` is the playtest bot |
| assets | procedural pixel sprites, character rigs, tiles, parallax backgrounds, sprite sheets and asset checks |
| audio | synthesised sound effects, music and the mixer |
| render | the 2D canvas renderer |
| gen | the model side: idea to design document (design.ts), natural-language patches (nlpatch.ts), Studio2D Script for games outside the genres (script.ts), the build pipeline and a worker |
| runtime | the player (`player.ts`, `script-player.ts`), the Studio2D Script runtime and checker, and `entry.ts`, the entry of the sandboxed play frame and of exported games |
| samples | hand-written sample games and script templates |
| export | single-file HTML export and project files |
| build | `runtime-plugin.mjs`, a Vite plugin that bundles `runtime/entry.ts` with esbuild into one self-contained script for the play frame and for exports |
| ui | `Studio2D.tsx` and its stylesheet |
| page, bridge.ts | the page entry and the browser bridge |

### Server routes (apps/server/src/studio2d.ts)

- `GET /api/2d/status` (public): whether the configured loopback Ollama answers and which models it has.
- `POST /api/2d/warm`, `POST /api/2d/llm`, `POST /api/2d/cancel` (director token as `Authorization: Bearer`): load the model, make one JSON-schema-constrained call with a system prompt and a prompt, cancel an in-flight call by id.
- The server uses its own configured model and Ollama endpoint; a request cannot choose the host. Limits are in `STUDIO2D_LIMITS`: at most 2 calls in flight (429 beyond), 120 s per call, 1.5 s for the status probe, default context 8192. Each call emits a `studio2d.*` event to the JSONL log.
- Tests: apps/server/src/studio2d.test.ts.

### Browser bridge (apps/web/src/studio2d/bridge.ts)

The studio talks to its host only through `window.studio2d` (`Studio2DApi` in gen/ai.ts). The bridge implements it in the page:

- Model calls go to `/api/2d/*` with the director token. With no model or no token, the idea is read directly by code and generation still produces a playable game; generated (image-model) art is not available and procedural art is always used.
- Library: saved games and generated assets live in `localStorage` under the `beetle2d:` prefix (`beetle2d:library` index, `beetle2d:game:<id>` per game, `beetle2d:assets`), with size caps per game and for assets; the index is rebuilt from saved games when it is missing. Nothing is stored on the server.
- Sandboxed staging frame: a game runs in `<iframe sandbox="allow-scripts">` loaded from a `blob:` URL, so it has an opaque origin, no access to the page, its storage or the token, and talks to the studio only through `postMessage` (live spec patches in, game events out). The newest 8 staged URLs are kept alive. Studio2D Script written by the model is statically checked and smoke-tested in a hidden frame of the same kind before it is shown.
- Downloads and files: export and project download as browser downloads (a project is a stored zip); opening a project uses a file picker.

### Export

`export/export.ts` writes one HTML file containing the bundled player, the spec as JSON (escaped so it cannot close its script tag) and all art inlined, under a strict content security policy so the exported game cannot reach the network. It runs from a file with no server.

### Status

Implemented today: the studio, engine, generators, bridge, routes and export, with unit tests in tests/unit/studio2d-*.test.ts and route tests in apps/server/src/studio2d.test.ts. Generation time and level pass rates for 2D are not yet measured; docs/RESULTS.md has no 2D run at the time of writing.
