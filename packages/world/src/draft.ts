// expandDraft: model WorldDraft -> full WorldSpec. Derives ids, bridge sockets, hazard policy, cosmetic decoration params.
import {
  GEOMETRY, MOVEMENT_RULES_VERSION, SCHEMA_VERSION, WORLD_LIMITS, WorldDraftSchema, WorldSpecSchema,
  type ValidationIssue, type WorldSpec,
} from '@beetle/contracts';
import { rimPointToward, round3 } from './geom.ts';
import { seededRandom } from './prng.ts';
import { hazardPolicyFor, DEFAULT_BRIDGE_WIDTH } from './patch.ts';
import { issue, zodIssuesToValidation } from './validate.ts';

export function expandDraft(
  draft: unknown,
  opts: { seed: number; worldId: string; worldVersion?: number },
): { ok: true; spec: WorldSpec } | { ok: false; issues: ValidationIssue[] } {
  const parsed = WorldDraftSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, issues: zodIssuesToValidation(parsed.error) };
  const d = parsed.data;
  const issues: ValidationIssue[] = [];
  const islandById = new Map(d.islands.map((is) => [is.id, is] as const));

  const bridges: WorldSpec['bridges'] = [];
  d.bridges.forEach((b, i) => {
    const a = islandById.get(b.from);
    const c = islandById.get(b.to);
    if (!a || !c) {
      const missing = [!a ? b.from : null, !c ? b.to : null].filter((s): s is string => s !== null);
      issues.push(issue('INVALID_REFERENCE', `bridges[${i}] "${b.id}": unknown island ${missing.map((m) => `"${m}"`).join(' and ')}`, [b.id, ...missing], { path: ['bridges', i], missing }));
      return;
    }
    if (a.id === c.id) {
      issues.push(issue('INVALID_REFERENCE', `bridges[${i}] "${b.id}": from and to are the same island "${a.id}"`, [b.id, a.id], { path: ['bridges', i] }));
      return;
    }
    const pa = rimPointToward(a.center, a.radius, c.center);
    const pb = rimPointToward(c.center, c.radius, a.center);
    bridges.push({
      id: b.id,
      endpoints: [
        { islandId: a.id, point: { x: round3(pa.x), z: round3(pa.z) } },
        { islandId: c.id, point: { x: round3(pb.x), z: round3(pb.z) } },
      ],
      width: b.width ?? DEFAULT_BRIDGE_WIDTH,
    });
  });
  if (issues.length > 0) return { ok: false, issues };

  const rng = seededRandom(opts.seed);
  const spec: WorldSpec = {
    schemaVersion: SCHEMA_VERSION,
    worldId: opts.worldId,
    worldVersion: opts.worldVersion ?? 0,
    seed: opts.seed,
    title: d.title,
    biome: 'garden',
    bounds: { halfExtent: WORLD_LIMITS.bounds.halfExtent },
    movementRulesVersion: MOVEMENT_RULES_VERSION,
    islands: d.islands.map((is) => ({ id: is.id, name: is.name, center: { x: is.center.x, z: is.center.z }, radius: is.radius, topElevation: 0 })),
    bridges,
    spawns: d.spawns.map((s, i) => ({
      id: `spawn-${i}`,
      supportingSurfaceId: s.islandId,
      localPosition: { x: s.localPosition.x, z: s.localPosition.z },
      playerSlot: i === 0 ? 0 : 1,
    })),
    relics: d.relics.map((r) => ({ id: r.id, name: r.name, supportingSurfaceId: r.islandId, localPosition: { x: r.localPosition.x, z: r.localPosition.z } })),
    gate: {
      id: 'gate',
      supportingSurfaceId: d.gate.islandId,
      localPosition: { x: d.gate.localPosition.x, z: d.gate.localPosition.z },
      requiredRelicIds: d.relics.map((r) => r.id),
    },
    hazard: { kind: d.hazard, planeElevation: GEOMETRY.hazardPlaneElevation, policy: hazardPolicyFor(d.hazard) },
    decorations: d.decorations.map((dec) => ({
      id: dec.id,
      type: dec.type,
      supportingSurfaceId: dec.islandId,
      localPosition: { x: dec.localPosition.x, z: dec.localPosition.z },
      rotationDeg: round3(rng() * 360),
      scale: round3(0.8 + rng() * 0.4),
    })),
    objectiveRules: ['collect_all_relics_then_enter_gate'],
  };

  const check = WorldSpecSchema.safeParse(spec);
  if (!check.success) return { ok: false, issues: zodIssuesToValidation(check.error) };
  return { ok: true, spec: check.data };
}
