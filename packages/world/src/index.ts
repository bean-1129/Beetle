// packages/world public API. Signatures here are the contract that apps/server and tests build against.
// Implementation lives in the sibling files; this module only re-exports the fixed names and types.
export type {
  IslandSurface, BridgeSurface, Surface, Obstacle, NavGrid, CompiledWorld, LivePlayer, LiveContext, ValidationOutcome,
  Mover, MoveInput, StepEvent, StepResult, FixtureName,
} from './types.ts';

/** Deterministic: same spec + COMPILER_VERSION gives identical surfaces, obstacles, nav grid and structuralDigest. */
export { compileWorld } from './compile.ts';
/** Full validator pipeline from docs/ARCHITECTURE.md. Accepts unknown input; INVALID_SCHEMA short-circuits. */
export { validateSpec } from './validate.ts';
/** Connectivity and supported-movement checks, including a headless walk using stepMover. */
export { runPlayabilityChecks } from './playability.ts';
/** Applies ops to a clone. Does not bump worldVersion. Derives add_bridge endpoints as rim points on the centre line. */
export { applyPatch } from './patch.ts';
/** Expands a model WorldDraft (validated here with WorldDraftSchema) into a full WorldSpec. */
export { expandDraft } from './draft.ts';
/** Compact agent-facing summary. Positions are reduced to a surface id. */
export { buildSessionSummary } from './summary.ts';
/** sha256 hex of canonicalJson(spec). */
export { specDigest } from './digest.ts';
/** One simulation step for one player. See the doc comment in movement.ts for the exact rules. */
export { stepMover } from './movement.ts';
/** BFS on the nav grid from the nearest walkable cell to `from` (within snapRadius) to any walkable cell within goalRadius of `to`. */
export { reachable } from './nav.ts';
/** Small deterministic PRNG (mulberry32) for cosmetic streams and fixture generation. */
export { seededRandom } from './prng.ts';
/** Hand-made development fixtures. Clearly labelled; never used as a hidden switch for prompts. */
export { fixtureWorld } from './fixtures.ts';

// Extra helpers (not part of the fixed signature set, but useful to the server and tests).
export { createMover, facingFrom, DEAD_ZONE } from './movement.ts';
export { FIXTURE_NAMES } from './fixtures.ts';
export { DEFAULT_BRIDGE_WIDTH, hazardPolicyFor } from './patch.ts';

/** Deterministic normalization of model output (reference resolution, range clamping). Applied inside expandDraft and applyPatch. */
export { normalizeDraft, normalizePatchDraft, resolveIslandRef, resolveNamedRef, normalizeLocalPosition, slugify } from './normalize.ts';
export type { Normalization } from './normalize.ts';
