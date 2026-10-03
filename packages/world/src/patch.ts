// applyPatch: clone the spec, apply ops in order, report changed ids. Never bumps worldVersion (commit does that).
import {
  PATCH_OP_NAMES, PatchDraftSchema, SCORING, WORLD_LIMITS, WorldPatchSchema, dist,
  type PatchDraft, type PatchOp, type ValidationIssue, type WorldPatch, type WorldSpec,
} from '@beetle/contracts';
import { rimPointToward, round3 } from './geom.ts';
import { issue, zodIssuesToValidation } from './validate.ts';
import { normalizePatchDraft, type Normalization } from './normalize.ts';

export const DEFAULT_BRIDGE_WIDTH = 2.4;

export function hazardPolicyFor(kind: WorldSpec['hazard']['kind']): WorldSpec['hazard']['policy'] {
  return { onContact: 'respawn', scorePenalty: kind === 'lava' ? SCORING.lavaFallPenalty : 0 };
}

function allIds(spec: WorldSpec): Set<string> {
  const ids = new Set<string>();
  for (const o of spec.islands) ids.add(o.id);
  for (const o of spec.bridges) ids.add(o.id);
  for (const o of spec.spawns) ids.add(o.id);
  for (const o of spec.relics) ids.add(o.id);
  ids.add(spec.gate.id);
  for (const o of spec.decorations) ids.add(o.id);
  return ids;
}

export function applyPatch(
  spec: WorldSpec,
  patch: PatchDraft | WorldPatch,
  ctx: { collectedRelicIds?: string[] } = {},
): { ok: true; spec: WorldSpec; changedIds: string[]; normalizations: Normalization[] } | { ok: false; issues: ValidationIssue[] } {
  // Validate the patch shape at the boundary; unknown ops are called out explicitly. A non-object patch (null,
  // undefined, a number) is INVALID_SCHEMA rather than a TypeError.
  if (patch === null || typeof patch !== 'object') {
    return { ok: false, issues: [issue('INVALID_SCHEMA', `(root): expected a patch object, got ${patch === null ? 'null' : typeof patch}`, [], { path: [] })] };
  }
  // Model drafts get deterministic reference and range normalization first (see normalize.ts); full WorldPatches do not.
  const normalizedInput = typeof (patch as WorldPatch).patchId === 'string'
    ? { patch, normalizations: [] as Normalization[] }
    : normalizePatchDraft(spec, patch);
  patch = normalizedInput.patch as PatchDraft | WorldPatch;
  const normalizations = normalizedInput.normalizations;
  const raw = patch as unknown as { ops?: unknown };
  const unknownOps: ValidationIssue[] = [];
  if (Array.isArray(raw?.ops)) {
    raw.ops.forEach((op, i) => {
      const name = (op as { op?: unknown })?.op;
      if (typeof name !== 'string' || !(PATCH_OP_NAMES as readonly string[]).includes(name)) {
        unknownOps.push(issue('UNKNOWN_OPERATION', `ops[${i}]: unknown op "${String(name)}"; supported: ${PATCH_OP_NAMES.join(', ')}`, [], { opIndex: i, op: name }));
      }
    });
  }
  if (unknownOps.length > 0) return { ok: false, issues: unknownOps };
  const isWorldPatch = typeof (patch as WorldPatch).patchId === 'string';
  const parsed = isWorldPatch ? WorldPatchSchema.safeParse(patch) : PatchDraftSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, issues: zodIssuesToValidation(parsed.error) };

  const out: WorldSpec = structuredClone(spec);
  const issues: ValidationIssue[] = [];
  const changed: string[] = [];
  const collected = new Set(ctx.collectedRelicIds ?? []);
  const note = (id: string) => { if (!changed.includes(id)) changed.push(id); };

  parsed.data.ops.forEach((op: PatchOp, i) => {
    const ev = (extra: Record<string, unknown> = {}) => ({ opIndex: i, op: op.op, ...extra });
    const islandById = new Map(out.islands.map((is) => [is.id, is] as const));
    switch (op.op) {
      case 'add_bridge': {
        if (allIds(out).has(op.id)) { issues.push(issue('DUPLICATE_ID', `ops[${i}] add_bridge: id "${op.id}" already exists`, [op.id], ev())); break; }
        const a = islandById.get(op.from);
        const b = islandById.get(op.to);
        if (!a || !b) {
          const missing = [!a ? op.from : null, !b ? op.to : null].filter((s): s is string => s !== null);
          issues.push(issue('INVALID_REFERENCE', `ops[${i}] add_bridge "${op.id}": unknown island ${missing.map((m) => `"${m}"`).join(' and ')}`, [op.id, ...missing], ev({ missing })));
          break;
        }
        if (op.from === op.to) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] add_bridge "${op.id}": from and to are the same island "${op.from}"`, [op.id, op.from], ev())); break; }
        if (out.bridges.length >= WORLD_LIMITS.bridges.max) { issues.push(issue('RESOURCE_LIMIT', `ops[${i}] add_bridge "${op.id}": world already has ${out.bridges.length} bridges (max ${WORLD_LIMITS.bridges.max})`, [op.id], ev({ count: out.bridges.length, max: WORLD_LIMITS.bridges.max }))); break; }
        const pa = rimPointToward(a.center, a.radius, b.center);
        const pb = rimPointToward(b.center, b.radius, a.center);
        out.bridges.push({
          id: op.id,
          endpoints: [
            { islandId: a.id, point: { x: round3(pa.x), z: round3(pa.z) } },
            { islandId: b.id, point: { x: round3(pb.x), z: round3(pb.z) } },
          ],
          width: op.width ?? DEFAULT_BRIDGE_WIDTH,
        });
        note(op.id);
        break;
      }
      case 'remove_bridge': {
        const idx = out.bridges.findIndex((b) => b.id === op.id);
        if (idx < 0) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] remove_bridge: unknown bridge "${op.id}"`, [op.id], ev())); break; }
        out.bridges.splice(idx, 1);
        note(op.id);
        break;
      }
      case 'set_hazard': {
        out.hazard.kind = op.kind;
        out.hazard.policy = hazardPolicyFor(op.kind);
        note('hazard');
        break;
      }
      case 'add_decoration': {
        if (allIds(out).has(op.id)) { issues.push(issue('DUPLICATE_ID', `ops[${i}] add_decoration: id "${op.id}" already exists`, [op.id], ev())); break; }
        if (!islandById.has(op.islandId)) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] add_decoration "${op.id}": unknown island "${op.islandId}"`, [op.id, op.islandId], ev())); break; }
        if (out.decorations.length >= WORLD_LIMITS.decorations.max) { issues.push(issue('RESOURCE_LIMIT', `ops[${i}] add_decoration "${op.id}": world already has ${out.decorations.length} decorations (max ${WORLD_LIMITS.decorations.max})`, [op.id], ev({ count: out.decorations.length, max: WORLD_LIMITS.decorations.max }))); break; }
        out.decorations.push({
          id: op.id, type: op.type, supportingSurfaceId: op.islandId,
          localPosition: { x: op.localPosition.x, z: op.localPosition.z },
          rotationDeg: op.rotationDeg ?? 0, scale: op.scale ?? 1,
        });
        note(op.id);
        break;
      }
      case 'move_decoration': {
        const d = out.decorations.find((x) => x.id === op.id);
        if (!d) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] move_decoration: unknown decoration "${op.id}"`, [op.id], ev())); break; }
        if (!islandById.has(op.islandId)) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] move_decoration "${op.id}": unknown island "${op.islandId}"`, [op.id, op.islandId], ev())); break; }
        d.supportingSurfaceId = op.islandId;
        d.localPosition = { x: op.localPosition.x, z: op.localPosition.z };
        note(op.id);
        break;
      }
      case 'remove_decoration': {
        const idx = out.decorations.findIndex((d) => d.id === op.id);
        if (idx < 0) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] remove_decoration: unknown decoration "${op.id}"`, [op.id], ev())); break; }
        out.decorations.splice(idx, 1);
        note(op.id);
        break;
      }
      case 'move_relic': {
        const r = out.relics.find((x) => x.id === op.id);
        if (!r) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] move_relic: unknown relic "${op.id}"`, [op.id], ev())); break; }
        if (collected.has(op.id)) { issues.push(issue('RELIC_ALREADY_COLLECTED', `ops[${i}] move_relic: relic "${op.id}" has already been collected and cannot move`, [op.id], ev())); break; }
        if (!islandById.has(op.islandId)) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] move_relic "${op.id}": unknown island "${op.islandId}"`, [op.id, op.islandId], ev())); break; }
        r.supportingSurfaceId = op.islandId;
        r.localPosition = { x: op.localPosition.x, z: op.localPosition.z };
        note(op.id);
        break;
      }
      case 'set_title': {
        out.title = op.title;
        note('title');
        break;
      }
      case 'set_mode': {
        if ((op.mode.relicsRequired ?? 1) > out.relics.length) {
          issues.push(issue('MODE_INVALID', `ops[${i}] set_mode: relicsRequired ${op.mode.relicsRequired} exceeds the ${out.relics.length} relics in the world`, ['mode'], ev()));
          break;
        }
        out.mode = { ...op.mode };
        note('mode');
        break;
      }
      case 'set_biome': {
        out.biome = op.biome;
        note('biome');
        break;
      }
      case 'set_movement': {
        out.movement = { speed: op.speed };
        note('movement');
        break;
      }
      default: {
        const never: never = op;
        issues.push(issue('UNKNOWN_OPERATION', `ops[${i}]: unsupported op ${JSON.stringify(never)}`, [], ev()));
      }
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, spec: out, changedIds: changed, normalizations };
}

/** Length of the bridge an add_bridge op would create, for callers that want to pre-check limits. */
export function derivedBridgeLength(spec: WorldSpec, from: string, to: string): number | null {
  const a = spec.islands.find((i) => i.id === from);
  const b = spec.islands.find((i) => i.id === to);
  if (!a || !b) return null;
  return dist(a.center, b.center) - a.radius - b.radius;
}
