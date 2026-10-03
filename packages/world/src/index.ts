// packages/world public API. Signatures here are the contract that apps/server and tests build against.
// The world owner implements the bodies (split into files as needed) and keeps these exports stable.
import type {
  WorldSpec, WorldPatch, PatchDraft, ValidationIssue, PlayabilityReport, SessionState, SessionSummary, PlayerStatus, Vec2, CompassName,
} from '@beetle/contracts';

export type IslandSurface = { id: string; kind: 'island'; center: Vec2; radius: number; name: string; compass: CompassName };
export type BridgeSurface = { id: string; kind: 'bridge'; a: Vec2; b: Vec2; width: number; length: number; islandIds: [string, string] };
export type Surface = IslandSurface | BridgeSurface;
export type Obstacle = { id: string; kind: 'decoration' | 'gate'; x: number; z: number; r: number; type?: string };

export type NavGrid = {
  cell: number;
  originX: number; // world X of column 0 centre
  originZ: number; // world Z of row 0 centre
  cols: number;
  rows: number;
  walkable: Uint8Array; // 1 = fits(cellCentre, { gateOpen: false }); gate cells tracked separately in gateCells
  gateCells: Uint8Array; // 1 = walkable only when the gate is open
  indexOf(x: number, z: number): number; // -1 when outside the grid
  centerOf(index: number): Vec2;
};

export type CompiledWorld = {
  spec: WorldSpec;
  compilerVersion: number;
  surfaces: Surface[];
  obstacles: Obstacle[];
  /** Island centre + local offset. null when the surface id is not an island. */
  worldPos(surfaceId: string, local: Vec2): Vec2 | null;
  /** Island or bridge id under the point (no inflation), or null when over the hazard. Islands win over bridges. */
  supportAt(x: number, z: number): string | null;
  /** Obstacle id whose radius + playerRadius contains the point; the gate counts only while locked. */
  blockedAt(x: number, z: number, opts: { gateOpen: boolean }): string | null;
  /** Centre not blocked and the four points at ±playerRadius on X and on Z are all supported. */
  fits(x: number, z: number, opts: { gateOpen: boolean }): boolean;
  nav: NavGrid;
  /** Cosmetic only (seeded): per-decoration jitter, tree shapes, rock tilt. Never affects colliders. */
  renderHints: Record<string, unknown>;
  /** Structural digest: sha256 of canonical surfaces + obstacles. Equal for equal spec + compiler version. */
  structuralDigest: string;
};

export type LivePlayer = { id: string; x: number; z: number; status: PlayerStatus; spawnId: string };
export type LiveContext = {
  players?: LivePlayer[];
  collectedRelicIds?: string[];
  previousSpec?: WorldSpec;
};

export type ValidationOutcome =
  | { ok: true; issues: ValidationIssue[]; compiled: CompiledWorld }
  | { ok: false; issues: ValidationIssue[]; compiled?: CompiledWorld };

// ---- Movement (single source of truth for server simulation and headless playability walks) ----
export type Mover = {
  x: number; z: number; vx: number; vz: number; facingDeg: number;
  status: PlayerStatus;
  statusSinceMs: number;
  supportId: string | null;
};
export type MoveInput = { axes: { x: number; z: number }; active: boolean }; // active=false clears velocity (stale input, disconnected)
export type StepEvent = 'fell' | 'hazard_contact' | 'respawned';
export type StepResult = { mover: Mover; events: StepEvent[] };

function notImplemented(name: string): never {
  throw new Error(`@beetle/world: ${name} is not implemented yet`);
}

/** Deterministic: same spec + COMPILER_VERSION gives identical surfaces, obstacles, nav grid and structuralDigest. */
export function compileWorld(_spec: WorldSpec): CompiledWorld {
  return notImplemented('compileWorld');
}

/** Full validator pipeline from docs/ARCHITECTURE.md. Accepts unknown input; INVALID_SCHEMA short-circuits. */
export function validateSpec(_spec: unknown, _ctx?: LiveContext): ValidationOutcome {
  return notImplemented('validateSpec');
}

/** Connectivity and supported-movement checks, including a headless walk using stepMover. */
export function runPlayabilityChecks(_compiled: CompiledWorld, _ctx?: LiveContext): Omit<PlayabilityReport, 'candidateId'> {
  return notImplemented('runPlayabilityChecks');
}

/** Applies ops to a clone. Does not bump worldVersion. Derives add_bridge endpoints as rim points on the centre line. */
export function applyPatch(
  _spec: WorldSpec,
  _patch: PatchDraft | WorldPatch,
  _ctx?: { collectedRelicIds?: string[] },
): { ok: true; spec: WorldSpec; changedIds: string[] } | { ok: false; issues: ValidationIssue[] } {
  return notImplemented('applyPatch');
}

/** Expands a model WorldDraft (validated here with WorldDraftSchema) into a full WorldSpec. */
export function expandDraft(
  _draft: unknown,
  _opts: { seed: number; worldId: string; worldVersion?: number },
): { ok: true; spec: WorldSpec } | { ok: false; issues: ValidationIssue[] } {
  return notImplemented('expandDraft');
}

/** Compact agent-facing summary. Positions are reduced to a surface id. */
export function buildSessionSummary(
  _compiled: CompiledWorld,
  _session: Pick<SessionState, 'worldVersion' | 'elapsedMs' | 'players' | 'collectedRelicIds' | 'gateUnlocked' | 'won' | 'score'>,
): SessionSummary {
  return notImplemented('buildSessionSummary');
}

/** sha256 hex of canonicalJson(spec). */
export function specDigest(_spec: WorldSpec): string {
  return notImplemented('specDigest');
}

/**
 * One simulation step for one player. Rules (see ARCHITECTURE.md):
 * active: v = normalize(axes) * playerSpeed (zero when !active or axes ~ 0); candidate = pos + v*dt;
 *   if blockedAt(candidate) try X-only then Z-only slide; if supportAt(final) is null -> status 'falling', event 'fell'.
 * falling: after GEOMETRY.fallDurationMs -> event 'hazard_contact', status 'respawning', position = spawn, velocity 0.
 * respawning: after GEOMETRY.respawnDurationMs -> status 'active', event 'respawned'.
 * disconnected: no movement. facingDeg follows non-zero velocity. supportId is updated every step.
 */
export function stepMover(
  _compiled: CompiledWorld,
  _mover: Mover,
  _input: MoveInput,
  _dtMs: number,
  _nowMs: number,
  _opts: { gateOpen: boolean; spawn: Vec2 },
): StepResult {
  return notImplemented('stepMover');
}

/** BFS on the nav grid from the nearest walkable cell to `from` (within snapRadius) to any walkable cell within goalRadius of `to`. */
export function reachable(
  _compiled: CompiledWorld,
  _from: Vec2,
  _to: Vec2,
  _opts?: { gateOpen?: boolean; snapRadius?: number; goalRadius?: number },
): { reachable: boolean; cells: number; path?: Vec2[] } {
  return notImplemented('reachable');
}

/** Small deterministic PRNG (mulberry32) for cosmetic streams and fixture generation. */
export function seededRandom(_seed: number): () => number {
  return notImplemented('seededRandom');
}

export type FixtureName = 'garden5' | 'garden5-gapped-bridge' | 'garden5-gate-hides-relic' | 'garden5-blocked-path' | 'garden4-no-temple-bridge';
/** Hand-made development fixtures. Clearly labelled; never used as a hidden switch for prompts. */
export function fixtureWorld(_name: FixtureName = 'garden5'): WorldSpec {
  return notImplemented('fixtureWorld');
}
