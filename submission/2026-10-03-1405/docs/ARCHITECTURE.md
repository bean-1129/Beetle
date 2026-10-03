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
