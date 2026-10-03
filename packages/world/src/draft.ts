// expandDraft: model WorldDraft -> full WorldSpec. Derives ids, bridge sockets, hazard policy, cosmetic decoration params.
// Carries biome (default garden), mode, movementSpeed -> movement.speed and hazardRise -> hazard.rise from the draft.
import {
  GEOMETRY, MOVEMENT_RULES_VERSION, SCHEMA_VERSION, WORLD_LIMITS, WorldDraftSchema, WorldSpecSchema,
  type ValidationIssue, type WorldSpec,
} from '@beetle/contracts';
import { rimPointToward, round3 } from './geom.ts';
import { seededRandom } from './prng.ts';
import { hazardPolicyFor, DEFAULT_BRIDGE_WIDTH } from './patch.ts';
import { issue, zodIssuesToValidation } from './validate.ts';
import { normalizeDraft, type Normalization } from './normalize.ts';

export function expandDraft(
  draft: unknown,
  opts: { seed: number; worldId: string; worldVersion?: number },
): { ok: true; spec: WorldSpec; normalizations: Normalization[] } | { ok: false; issues: ValidationIssue[] } {
  // Deterministic normalization of model output (references by name, over-radius offsets, clamped numbers) before the schema.
  const { draft: normalizedDraft, normalizations } = normalizeDraft(draft);
  const parsed = WorldDraftSchema.safeParse(normalizedDraft);
  if (!parsed.success) return { ok: false, issues: zodIssuesToValidation(parsed.error) };
  const d = parsed.data;
  const issues: ValidationIssue[] = [];
  const islandById = new Map(d.islands.map((is) => [is.id, is] as const));

  // Ids must be unique across every object, including the ids this expansion derives (gate, spawn-0, spawn-1).
  const idKinds = new Map<string, string[]>();
  const noteId = (id: string, kind: string) => { const l = idKinds.get(id); if (l) l.push(kind); else idKinds.set(id, [kind]); };
  for (const o of d.islands) noteId(o.id, 'island');
  for (const o of d.bridges) noteId(o.id, 'bridge');
  for (const o of d.relics) noteId(o.id, 'relic');
  for (const o of d.decorations) noteId(o.id, 'decoration');
  noteId('gate', 'gate (derived)');
  d.spawns.forEach((_, i) => noteId(`spawn-${i}`, 'spawn (derived)'));
  for (const [id, kinds] of idKinds) {
    if (kinds.length > 1) issues.push(issue('DUPLICATE_ID', `id "${id}" is used ${kinds.length} times (${kinds.join(', ')})`, [id], { kinds }));
  }
  // Every object must sit on a known island.
  const refIsland = (ownerId: string, kind: string, islandId: string, path: (string | number)[]) => {
    if (!islandById.has(islandId)) issues.push(issue('INVALID_REFERENCE', `${kind} "${ownerId}" references unknown island "${islandId}"`, [ownerId, islandId], { path, islandId }));
  };
  d.spawns.forEach((s, i) => refIsland(`spawn-${i}`, 'spawn', s.islandId, ['spawns', i]));
  d.relics.forEach((r, i) => refIsland(r.id, 'relic', r.islandId, ['relics', i]));
  refIsland('gate', 'gate', d.gate.islandId, ['gate']);
  d.decorations.forEach((dec, i) => refIsland(dec.id, 'decoration', dec.islandId, ['decorations', i]));

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
    biome: d.biome ?? 'garden',
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
    hazard: {
      kind: d.hazard, planeElevation: GEOMETRY.hazardPlaneElevation, policy: hazardPolicyFor(d.hazard),
      ...(d.hazardRise ? { rise: { afterSec: d.hazardRise.afterSec, metersPerSec: d.hazardRise.metersPerSec, maxElevation: d.hazardRise.maxElevation } } : {}),
    },
    decorations: d.decorations.map((dec) => ({
      id: dec.id,
      type: dec.type,
      supportingSurfaceId: dec.islandId,
      localPosition: { x: dec.localPosition.x, z: dec.localPosition.z },
      rotationDeg: round3(rng() * 360),
      scale: round3(0.8 + rng() * 0.4),
    })),
    objectiveRules: ['collect_all_relics_then_enter_gate'],
    ...(d.mode ? { mode: { ...d.mode } } : {}),
    ...(d.movementSpeed !== undefined ? { movement: { speed: d.movementSpeed } } : {}),
    ...(d.streaming !== undefined ? { streaming: d.streaming } : {}),
    ...(d.terrain !== undefined ? { terrain: d.terrain } : {}),
  };

  const check = WorldSpecSchema.safeParse(spec);
  if (!check.success) return { ok: false, issues: zodIssuesToValidation(check.error) };
  return { ok: true, spec: check.data, normalizations };
}
