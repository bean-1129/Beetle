// Prompts for streaming generation: automatic extension requests (request.auto) and the brief's "start small" rule.
// Kept compact (under 450 tokens for the system prompt on a 24-island world): the extension is on the critical path
// of a player walking toward the frontier, so every prompt token costs latency.
import {
  DECORATION_TYPES,
  STREAMING,
  WORLD_LIMITS,
  compassName,
  type DirectorRequest,
  type Vec2,
  type WorldSpec,
} from '@beetle/contracts';

/** Sentence added to the brief prompt when streaming is on. */
export const STREAMING_BRIEF_RULE = 'Start small: 2 to 4 islands around the spawn; the world will grow as players explore. Set "streaming": true.';

/** Streaming is the default for briefs unless the director asks for the whole world up front. */
export function briefWantsStreaming(prompt: string): boolean {
  const t = prompt.toLowerCase();
  if (/\bno streaming\b|\bstreaming off\b|\bdisable streaming\b/.test(t)) return false;
  if (/\b(whole|entire|full|complete) (world|map|level)\b.*\b(up ?front|at once|now|in one go|from the start)\b/.test(t)) return false;
  if (/\b(up ?front|all at once|in one go)\b/.test(t)) return false;
  return true;
}

const DIRS: Record<string, Vec2> = {
  north: { x: 0, z: 1 }, south: { x: 0, z: -1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 },
  'north-east': { x: Math.SQRT1_2, z: Math.SQRT1_2 }, 'north-west': { x: -Math.SQRT1_2, z: Math.SQRT1_2 },
  'south-east': { x: Math.SQRT1_2, z: -Math.SQRT1_2 }, 'south-west': { x: -Math.SQRT1_2, z: -Math.SQRT1_2 },
};

/** Unit vector for a compass word (north, north-east, ne, ...); falls back to the direction from the world centre to the island. */
export function directionVector(direction: string, from: Vec2): Vec2 {
  const d = direction.toLowerCase().trim().replace(/[\s_]+/g, '-');
  const short: Record<string, string> = { n: 'north', s: 'south', e: 'east', w: 'west', ne: 'north-east', nw: 'north-west', se: 'south-east', sw: 'south-west', northeast: 'north-east', northwest: 'north-west', southeast: 'south-east', southwest: 'south-west' };
  const v = DIRS[d] ?? DIRS[short[d] ?? ''];
  if (v) return v;
  const len = Math.hypot(from.x, from.z);
  return len > 0.5 ? { x: from.x / len, z: from.z / len } : { x: 0, z: 1 };
}

const HALF = WORLD_LIMITS.bounds.halfExtent - WORLD_LIMITS.island.maxRadius - 2;
const r1 = (n: number) => Math.round(n);

/** First free id of the form `${prefix}${n}` (lowercase slug, unique across every object in the world). */
export function freshIds(spec: WorldSpec, prefix: string, count: number): string[] {
  const taken = new Set<string>([
    ...spec.islands.map((i) => i.id), ...spec.bridges.map((b) => b.id), ...spec.relics.map((r) => r.id),
    ...spec.decorations.map((d) => d.id), ...spec.spawns.map((s) => s.id), spec.gate.id,
  ]);
  const out: string[] = [];
  for (let n = spec.islands.length; out.length < count && n < 999; n++) if (!taken.has(`${prefix}${n}`)) out.push(`${prefix}${n}`);
  return out;
}

/** Suggested centres: 18 m beyond the target rim along the direction, plus a 40 degree side step for a second island. */
export function suggestedCentres(spec: WorldSpec, islandId: string, direction: string): { center: Vec2; radius: number }[] {
  const isl = spec.islands.find((i) => i.id === islandId);
  if (!isl) return [];
  const dir = directionVector(direction, isl.center);
  const out: { center: Vec2; radius: number }[] = [];
  for (const deg of [0, 40, -40]) {
    const a = (deg * Math.PI) / 180;
    const v = { x: dir.x * Math.cos(a) - dir.z * Math.sin(a), z: dir.x * Math.sin(a) + dir.z * Math.cos(a) };
    const radius = 7;
    const d = isl.radius + 18;
    const c = { x: r1(isl.center.x + v.x * d), z: r1(isl.center.z + v.z * d) };
    if (Math.abs(c.x) > HALF || Math.abs(c.z) > HALF) continue;
    const clear = spec.islands.every((o) => Math.hypot(o.center.x - c.x, o.center.z - c.z) >= o.radius + radius + 2)
      && out.every((o) => Math.hypot(o.center.x - c.x, o.center.z - c.z) >= o.radius + radius + 2);
    if (clear) out.push({ center: c, radius });
    if (out.length >= STREAMING.islandsPerExtension.max) break;
  }
  return out;
}

/** System prompt for an automatic extension request. Compact island table, target, rule, suggestions. */
export function expansionSystemPrompt(spec: WorldSpec, islandId: string, direction: string): string {
  const bridgesOf = new Map<string, string[]>();
  for (const b of spec.bridges) {
    const [a, c] = [b.endpoints[0].islandId, b.endpoints[1].islandId];
    bridgesOf.set(a, [...(bridgesOf.get(a) ?? []), c]);
    bridgesOf.set(c, [...(bridgesOf.get(c) ?? []), a]);
  }
  const target0 = spec.islands.find((i) => i.id === islandId);
  // Only the 10 islands nearest the target: keeps the prompt under 450 tokens on a full 24-island world.
  const near = target0 ? [...spec.islands].sort((p, q) => Math.hypot(p.center.x - target0.center.x, p.center.z - target0.center.z) - Math.hypot(q.center.x - target0.center.x, q.center.z - target0.center.z)).slice(0, 10) : spec.islands.slice(0, 10);
  const rows = near.map((i) => `${i.id} | ${compassName(i.center)} | ${r1(i.center.x)},${r1(i.center.z)} | ${r1(i.radius)} | ${(bridgesOf.get(i.id) ?? []).join(' ') || '-'}`);
  const target = spec.islands.find((i) => i.id === islandId);
  const ids = freshIds(spec, 'x', 2);
  const decoIds = freshIds(spec, 'xd', 2);
  const types = ['tree', 'rock'].filter((t) => (DECORATION_TYPES as readonly string[]).includes(t));
  const sugg = suggestedCentres(spec, islandId, direction).flatMap((s, k) => [
    `{"op":"add_island","id":"${ids[k]}","center":{"x":${s.center.x},"z":${s.center.z}},"radius":${s.radius},"bridgeFrom":"${islandId}"}`,
    `{"op":"add_decoration","id":"${decoIds[k]}","type":"${types[k % types.length] ?? DECORATION_TYPES[0]}","islandId":"${ids[k]}","localPosition":{"x":1,"z":-1}}`,
  ]);
  return [
    'You extend a floating-island world ahead of a player. North is +z, east is +x, metres.',
    `Islands near the target (${near.length} of ${spec.islands.length}; id | compass | centre x,z | radius | bridged to):`,
    ...rows,
    `Target: island ${islandId}${target ? ` at ${r1(target.center.x)},${r1(target.center.z)} radius ${r1(target.radius)}` : ''}, direction ${direction}.`,
    `Rule: return 1 to 2 add_island ops with bridgeFrom set to the target island, centres 14 to 24 m beyond its rim in that direction, radius 5 to 9, plus one add_decoration per new island; never remove or move anything; ids must be new lowercase slugs. Keep centres within plus or minus ${HALF} and at least 2 m clear of every other island rim.`,
    `add_decoration types: ${DECORATION_TYPES.join(', ')}. localPosition is an offset from the new island centre within 2 m, never a world position.`,
    `Fresh ids: ${ids.join(', ')}; decorations ${decoIds.join(', ')}.`,
    sugg.length ? `Valid answer: {"summary":"New islands ${direction} of ${islandId}","ops":[${sugg.join(',')}]}` : 'No clear spot was found along that direction; turn up to 60 degrees aside.',
    'Output only compact JSON {"summary","ops"}; summary one short sentence.',
  ].join('\n');
}

/** User message for an automatic request (also usable verbatim as a manual edit prompt for measurement). */
export function expansionUserPrompt(request: Pick<DirectorRequest, 'prompt' | 'autoReason'>): string {
  const r = request.autoReason;
  return request.prompt.trim() ? `Extension request: ${request.prompt}` : r ? `Extension request: extend the world ${r.direction} of ${r.islandId}.` : 'Extension request.';
}

/**
 * Deterministic fixes for an automatic extension draft (the model's common slips), applied before the server sees it:
 * add_island without bridgeFrom gets the target island; an add_decoration on a new island whose localPosition is a
 * world position (outside the island) is converted to an offset from that island centre, or reset to (1, -1).
 * Returns what changed.
 */
export function fixExpansionDraft(draft: Record<string, unknown>, targetIslandId: string): string[] {
  const changed: string[] = [];
  if (!Array.isArray(draft.ops)) return changed;
  const newIslands = new Map<string, { center: Vec2; radius: number }>();
  for (const o of draft.ops as Record<string, unknown>[]) {
    if (!o || o.op !== 'add_island') continue;
    if (typeof o.bridgeFrom !== 'string' || !o.bridgeFrom) { o.bridgeFrom = targetIslandId; changed.push(`bridgeFrom ${String(o.id)} -> ${targetIslandId}`); }
    const c = o.center as Vec2 | undefined;
    if (c && Number.isFinite(c.x) && Number.isFinite(c.z) && typeof o.id === 'string') newIslands.set(o.id, { center: c, radius: Number(o.radius) || 5 });
  }
  for (const o of draft.ops as Record<string, unknown>[]) {
    if (!o || o.op !== 'add_decoration' || typeof o.islandId !== 'string') continue;
    const isl = newIslands.get(o.islandId);
    const lp = o.localPosition as Vec2 | undefined;
    if (!isl || !lp || !Number.isFinite(lp.x) || !Number.isFinite(lp.z)) continue;
    const limit = Math.max(0.5, isl.radius - 1.5);
    if (Math.hypot(lp.x, lp.z) <= limit) continue;
    const rel = { x: Math.round(lp.x - isl.center.x), z: Math.round(lp.z - isl.center.z) };
    o.localPosition = Math.hypot(rel.x, rel.z) <= limit ? rel : { x: 1, z: -1 };
    changed.push(`decoration ${String(o.id)} localPosition -> ${JSON.stringify(o.localPosition)}`);
  }
  return changed;
}
