// Public types of @beetle/world. Re-exported unchanged from index.ts; apps/server and tests build against them.
import type {
  WorldSpec, ValidationIssue, PlayerStatus, Vec2, CompassName,
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
export type MoveInput = { axes: { x: number; z: number }; active: boolean; speedScale?: number }; // speedScale: sprint or slow multiplier, default 1 // active=false clears velocity (stale input, disconnected)
export type StepEvent = 'fell' | 'hazard_contact' | 'respawned';
export type StepResult = { mover: Mover; events: StepEvent[] };

export type FixtureName =
  | 'garden5' | 'garden5-gapped-bridge' | 'garden5-gate-hides-relic' | 'garden5-blocked-path' | 'garden4-no-temple-bridge'
  | 'race5' | 'hill4' | 'survival5' | 'trial5';
