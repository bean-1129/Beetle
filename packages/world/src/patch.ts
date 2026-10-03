// applyPatch: clone the spec, apply ops in order, report changed ids. Never bumps worldVersion (commit does that).
import {
  PATCH_OP_NAMES, PatchDraftSchema, SCORING, WORLD_LIMITS, WorldPatchSchema, dist,
  type PatchDraft, type PatchOp, type ValidationIssue, type WorldPatch, type WorldSpec,
} from '@beetle/contracts';
import { pointSegment, rimPointToward, round3 } from './geom.ts';
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
      case 'add_island': {
        if (allIds(out).has(op.id)) { issues.push(issue('DUPLICATE_ID', `ops[${i}] add_island: id "${op.id}" already exists`, [op.id], ev())); break; }
        if (out.islands.length >= WORLD_LIMITS.islands.max) { issues.push(issue('RESOURCE_LIMIT', `ops[${i}] add_island "${op.id}": world already has ${out.islands.length} islands (max ${WORLD_LIMITS.islands.max})`, [op.id], ev({ count: out.islands.length, max: WORLD_LIMITS.islands.max }))); break; }
        if (op.bridgeFrom !== undefined && !islandById.has(op.bridgeFrom)) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] add_island "${op.id}": unknown bridgeFrom island "${op.bridgeFrom}"`, [op.id, op.bridgeFrom], ev())); break; }
        const placement = placeNewIsland(out.islands, op);
        const centre = placement.centre;
        for (const n of placement.notes) normalizations.push({ ...n, path: `ops[${i}].${n.path}` });
        out.islands.push({ id: op.id, name: op.name, center: centre, radius: op.radius, topElevation: 0 });
        note(op.id);
        // Crossing from the chosen anchor island, as a regular bridge subject to the same validation (validator has the final say).
        const anchor = placement.anchorId ? out.islands.find((is) => is.id === placement.anchorId) : undefined;
        if (anchor && out.bridges.length < WORLD_LIMITS.bridges.max) {
          const ids = allIds(out);
          const stem = `bridge-${anchor.id}-${op.id}`.slice(0, 32);
          let bid = stem;
          for (let k = 2; ids.has(bid) && k < 100; k++) bid = `${stem.slice(0, 32 - String(k).length - 1)}-${k}`;
          if (!ids.has(bid)) {
            const [pa, pb] = crossingPoints(anchor, { center: centre, radius: op.radius });
            out.bridges.push({ id: bid, endpoints: [{ islandId: anchor.id, point: pa }, { islandId: op.id, point: pb }], width: DEFAULT_BRIDGE_WIDTH });
            note(bid);
          }
        }
        break;
      }
      case 'remove_island': {
        const idx = out.islands.findIndex((is) => is.id === op.id);
        if (idx < 0) { issues.push(issue('INVALID_REFERENCE', `ops[${i}] remove_island: unknown island "${op.id}"`, [op.id], ev())); break; }
        const holds = [...out.spawns, ...out.relics, out.gate].filter((o) => o.supportingSurfaceId === op.id).map((o) => o.id);
        if (holds.length) { issues.push(issue('UNSUPPORTED_OPERATION', `ops[${i}] remove_island "${op.id}": it carries ${holds.join(', ')}; move them first`, [op.id, ...holds], ev())); break; }
        if (out.islands.length <= WORLD_LIMITS.islands.min) { issues.push(issue('RESOURCE_LIMIT', `ops[${i}] remove_island "${op.id}": a world needs at least ${WORLD_LIMITS.islands.min} islands`, [op.id], ev())); break; }
        out.islands.splice(idx, 1);
        for (const b of out.bridges.filter((b) => b.endpoints.some((e) => e.islandId === op.id))) note(b.id);
        out.bridges = out.bridges.filter((b) => !b.endpoints.some((e) => e.islandId === op.id));
        for (const d of out.decorations.filter((d) => d.supportingSurfaceId === op.id)) note(d.id);
        out.decorations = out.decorations.filter((d) => d.supportingSurfaceId !== op.id);
        note(op.id);
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
      case 'set_terrain': {
        out.terrain = op.terrain;
        note('terrain');
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

// ---- add_island placement ----
type Disc = { id?: string; center: { x: number; z: number }; radius: number };
const NEW_ISLAND_GAP = 1.25; // rim-to-rim gap kept between a new island and every existing island (validator needs 1.0)
const PULL_STEP = 0.5;
const ANCHOR_CANDIDATES = 3;

function clampCentre(x: number, z: number, r: number): { x: number; z: number } {
  const lim = WORLD_LIMITS.bounds.halfExtent - r;
  return { x: Math.min(lim, Math.max(-lim, x)), z: Math.min(lim, Math.max(-lim, z)) };
}

/** Rounded rim points of the straight crossing between two discs, along their centre line (same rule as add_bridge). */
function crossingPoints(a: Disc, b: Disc): [{ x: number; z: number }, { x: number; z: number }] {
  const pa = rimPointToward(a.center, a.radius, b.center);
  const pb = rimPointToward(b.center, b.radius, a.center);
  return [{ x: round3(pa.x), z: round3(pa.z) }, { x: round3(pb.x), z: round3(pb.z) }];
}

function clearOfAll(islands: readonly Disc[], c: { x: number; z: number }, r: number): boolean {
  return islands.every((is) => dist(is.center, c) - is.radius - r >= NEW_ISLAND_GAP - 1e-3);
}

/** True when the straight crossing anchor -> new disc passes through no third island (the validator's BRIDGE_CROSSES_ISLAND rule). */
function cleanCrossing(islands: readonly Disc[], anchor: Disc, c: { x: number; z: number }, r: number): boolean {
  const [pa, pb] = crossingPoints(anchor, { center: c, radius: r });
  return islands.every((is) => is.id === anchor.id || pointSegment(is.center, pa, pb).dist >= is.radius + 1e-3);
}

/**
 * Deterministic placement for add_island:
 *  1. clamp into the bounds and push away from overlapping islands until the 1.25 m gap holds;
 *  2. pick the crossing anchor: bridgeFrom (when given) first, then the three nearest islands, preferring the first one
 *     whose straight crossing passes through no third island;
 *  3. when the crossing would exceed WORLD_LIMITS.bridge.maxLength, pull the island toward the anchor along the centre
 *     line (keeping the 1.25 m gap to every island) until it fits.
 * When nothing yields a clean crossing the first candidate is kept and the validator reports the problem.
 */
function placeNewIsland(
  islands: readonly Disc[],
  op: { id: string; center: { x: number; z: number }; radius: number; bridgeFrom?: string },
): { centre: { x: number; z: number }; anchorId: string | undefined; notes: Normalization[] } {
  const r = op.radius;
  let { x: cx, z: cz } = clampCentre(op.center.x, op.center.z, r);
  for (let iter = 0; iter < 40; iter++) {
    let worst: { dx: number; dz: number; depth: number } | null = null;
    for (const is of islands) {
      const dx = cx - is.center.x; const dz = cz - is.center.z;
      const d = Math.hypot(dx, dz);
      // Coincident centres: push due east (deterministic) rather than dividing by zero.
      const ux = d > 1e-6 ? dx / d : 1; const uz = d > 1e-6 ? dz / d : 0;
      const depth = is.radius + r + NEW_ISLAND_GAP - d;
      if (depth > 1e-4 && (!worst || depth > worst.depth)) worst = { dx: ux, dz: uz, depth: depth + 1e-3 };
    }
    if (!worst) break;
    ({ x: cx, z: cz } = clampCentre(cx + worst.dx * worst.depth, cz + worst.dz * worst.depth, r));
  }
  const pushed = { x: round3(cx), z: round3(cz) };
  const notes: Normalization[] = [];
  if (pushed.x !== op.center.x || pushed.z !== op.center.z) notes.push({ path: 'center', from: op.center, to: pushed, reason: 'island moved to clear existing islands or the bounds' });
  if (islands.length === 0) return { centre: pushed, anchorId: undefined, notes };

  const byNearest = [...islands].sort((a, b) => dist(a.center, pushed) - dist(b.center, pushed) || (a.id ?? '').localeCompare(b.id ?? ''));
  const anchors: Disc[] = [];
  const preferred = op.bridgeFrom !== undefined ? islands.find((is) => is.id === op.bridgeFrom) : undefined;
  if (preferred) anchors.push(preferred);
  for (const is of byNearest.slice(0, ANCHOR_CANDIDATES)) if (!anchors.includes(is)) anchors.push(is);

  const maxLen = WORLD_LIMITS.bridge.maxLength;
  type Option = { anchor: Disc; centre: { x: number; z: number }; clean: boolean; pulled: boolean };
  const optionsFor = (anchor: Disc): Option[] => {
    const span = dist(anchor.center, pushed) - anchor.radius - r;
    if (span <= maxLen - 0.01) return [{ anchor, centre: pushed, clean: cleanCrossing(islands, anchor, pushed, r), pulled: false }];
    // Too long: walk the centre line from the longest allowed crossing toward the anchor until a placement keeps the gap.
    const out: Option[] = [];
    const d0 = dist(anchor.center, pushed) || 1;
    const ux = (pushed.x - anchor.center.x) / d0; const uz = (pushed.z - anchor.center.z) / d0;
    for (let len = maxLen - 0.05; len >= NEW_ISLAND_GAP; len -= PULL_STEP) {
      const D = anchor.radius + r + len;
      const c = clampCentre(anchor.center.x + ux * D, anchor.center.z + uz * D, r);
      const rc = { x: round3(c.x), z: round3(c.z) };
      const crossing = dist(anchor.center, rc) - anchor.radius - r;
      if (crossing > maxLen - 0.01 || crossing < NEW_ISLAND_GAP - 1e-3) continue;
      if (!clearOfAll(islands, rc, r)) continue;
      const clean = cleanCrossing(islands, anchor, rc, r);
      out.push({ anchor, centre: rc, clean, pulled: true });
      if (clean) break;
    }
    return out;
  };
  const all: Option[] = [];
  let chosen: Option | undefined;
  for (const anchor of anchors) {
    const opts = optionsFor(anchor);
    all.push(...opts);
    chosen = opts.find((o) => o.clean);
    if (chosen) break;
  }
  chosen ??= all[0];
  if (!chosen) return { centre: pushed, anchorId: anchors[0].id, notes };
  if (chosen.pulled) notes.push({ path: 'center', from: pushed, to: chosen.centre, reason: `island pulled toward "${chosen.anchor.id}" so its crossing fits within ${maxLen} m` });
  if (op.bridgeFrom !== undefined && chosen.anchor.id !== op.bridgeFrom) notes.push({ path: 'bridgeFrom', from: op.bridgeFrom, to: chosen.anchor.id, reason: 'crossing anchored on a nearer island so it passes through no other island' });
  return { centre: chosen.centre, anchorId: chosen.anchor.id, notes };
}

/** Length of the bridge an add_bridge op would create, for callers that want to pre-check limits. */
export function derivedBridgeLength(spec: WorldSpec, from: string, to: string): number | null {
  const a = spec.islands.find((i) => i.id === from);
  const b = spec.islands.find((i) => i.id === to);
  if (!a || !b) return null;
  return dist(a.center, b.center) - a.radius - b.radius;
}
