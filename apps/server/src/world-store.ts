// Holds the active WorldSpec, its compiled geometry and the version history used by undo.
import { GEOMETRY, type Vec2, type WorldSpec } from '@beetle/contracts';
import { compileWorld, type CompiledWorld } from '@beetle/world';

export type ActiveWorld = {
  spec: WorldSpec;
  compiled: CompiledWorld;
  version: number;
};

export class WorldStore {
  private active: ActiveWorld | null = null;
  /** Previous specs, oldest first. The last entry is what undo restores. */
  readonly history: WorldSpec[] = [];

  get current(): ActiveWorld | null {
    return this.active;
  }

  get version(): number {
    return this.active?.version ?? 0;
  }

  get hasWorld(): boolean {
    return this.active !== null;
  }

  /** Installs a world without recording history (startup load). */
  install(spec: WorldSpec, version: number, compiled?: CompiledWorld): ActiveWorld {
    const withVersion: WorldSpec = { ...spec, worldVersion: version };
    this.active = { spec: withVersion, compiled: compiled ?? compileWorld(withVersion), version };
    return this.active;
  }

  /** Swaps in a committed spec and keeps the previous one for undo. */
  swap(spec: WorldSpec, version: number, compiled?: CompiledWorld): ActiveWorld {
    if (this.active) {
      this.history.push(this.active.spec);
      if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
    }
    return this.install(spec, version, compiled);
  }

  /** The spec that undo would restore (null when there is nothing to undo). */
  previousSpec(): WorldSpec | null {
    return this.history.length ? this.history[this.history.length - 1] : null;
  }

  /** Called after a successful undo commit so the restored spec is not undone again in a loop. */
  consumeHistory(): void {
    this.history.pop();
    // swap() pushed the spec that undo replaced; drop it too so undo is a single step back.
    this.history.pop();
  }

  spawnWorldPos(slot: 0 | 1): { spawnId: string; pos: Vec2 } | null {
    if (!this.active) return null;
    const spawn = this.active.spec.spawns.find((s) => s.playerSlot === slot) ?? this.active.spec.spawns[slot];
    if (!spawn) return null;
    const pos = this.active.compiled.worldPos(spawn.supportingSurfaceId, spawn.localPosition);
    return pos ? { spawnId: spawn.id, pos } : null;
  }

  relicWorldPositions(): { id: string; pos: Vec2 }[] {
    if (!this.active) return [];
    const out: { id: string; pos: Vec2 }[] = [];
    for (const relic of this.active.spec.relics) {
      const pos = this.active.compiled.worldPos(relic.supportingSurfaceId, relic.localPosition);
      if (pos) out.push({ id: relic.id, pos });
    }
    return out;
  }

  gateWorldPos(): Vec2 | null {
    if (!this.active) return null;
    const g = this.active.spec.gate;
    return this.active.compiled.worldPos(g.supportingSurfaceId, g.localPosition);
  }

  hazardPenalty(): number {
    if (!this.active) return 0;
    const h = this.active.spec.hazard;
    return h.kind === 'lava' ? h.policy.scorePenalty : 0;
  }

  hazardKind(): 'water' | 'lava' | null {
    return this.active?.spec.hazard.kind ?? null;
  }

  hazardElevation(): number {
    return this.active?.spec.hazard.planeElevation ?? GEOMETRY.hazardPlaneElevation;
  }
}
