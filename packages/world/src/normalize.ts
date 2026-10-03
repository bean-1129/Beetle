// Deterministic normalization of model output before schema validation.
// The local model often (a) refers to islands by display name or compass direction instead of id,
// (b) writes world coordinates or over-radius offsets into localPosition, (c) exceeds numeric limits the
// JSON-schema grammar does not enforce. These are mechanical, unambiguous corrections; anything ambiguous is
// left untouched so the validator reports it. Every change is recorded so the agent and the UI can show it.
import { WORLD_LIMITS, compassName, type Vec2 } from '@beetle/contracts';

export type Normalization = { path: string; from: unknown; to: unknown; reason: string };

type IslandLike = { id: string; name?: string; center: Vec2; radius: number };

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const DIRECTION_WORDS: Record<string, string> = {
  north: 'north', northern: 'north', n: 'north',
  south: 'south', southern: 'south', s: 'south',
  east: 'east', eastern: 'east', e: 'east',
  west: 'west', western: 'west', w: 'west',
  'north-east': 'north-east', northeast: 'north-east', northeastern: 'north-east', ne: 'north-east',
  'north-west': 'north-west', northwest: 'north-west', northwestern: 'north-west', nw: 'north-west',
  'south-east': 'south-east', southeast: 'south-east', southeastern: 'south-east', se: 'south-east',
  'south-west': 'south-west', southwest: 'south-west', southwestern: 'south-west', sw: 'south-west',
  centre: 'centre', center: 'centre', central: 'centre', middle: 'centre', hub: 'centre',
};

/** Resolve a model-provided island reference to a real island id. Returns undefined when ambiguous or unknown. */
export function resolveIslandRef(islands: IslandLike[], ref: unknown): string | undefined {
  if (typeof ref !== 'string' || ref.length === 0) return undefined;
  if (islands.some((i) => i.id === ref)) return ref;
  const want = slugify(ref);
  if (!want) return undefined;
  const stripped = want.replace(/-?(island|isle|islet)$/g, '').replace(/^(the|island|isle)-?/g, '');
  // 1. exact slug of display name
  const byName = islands.filter((i) => i.name && (slugify(i.name) === want || slugify(i.name) === stripped));
  if (byName.length === 1) return byName[0].id;
  // 2. id equals the stripped form (e.g. "temple-island" -> "temple")
  const byId = islands.filter((i) => i.id === stripped || slugify(i.id) === stripped);
  if (byId.length === 1) return byId[0].id;
  // 3. compass word ("northern island", "north", "the north isle")
  const dir = DIRECTION_WORDS[stripped] ?? DIRECTION_WORDS[want];
  if (dir) {
    const byCompass = islands.filter((i) => compassName(i.center) === dir);
    if (byCompass.length === 1) return byCompass[0].id;
    if (byCompass.length > 1) {
      // several islands in that octant: pick the farthest from the centre only if it is clearly dominant (20 percent)
      const sorted = byCompass.map((i) => ({ i, d: Math.hypot(i.center.x, i.center.z) })).sort((a, b) => b.d - a.d);
      if (sorted[0].d > sorted[1].d * 1.2) return sorted[0].i.id;
    }
    return undefined;
  }
  // 4. unique substring match on name or id
  const bySub = islands.filter((i) => (i.name && slugify(i.name).includes(stripped)) || i.id.includes(stripped) || (stripped.length >= 4 && (i.name ? slugify(i.name) : i.id).startsWith(stripped)));
  if (bySub.length === 1) return bySub[0].id;
  return undefined;
}

/** Resolve a reference to an object with id and optional name (relics, decorations). */
export function resolveNamedRef(items: { id: string; name?: string }[], ref: unknown): string | undefined {
  if (typeof ref !== 'string' || !ref) return undefined;
  if (items.some((i) => i.id === ref)) return ref;
  const want = slugify(ref);
  const byName = items.filter((i) => i.name && slugify(i.name) === want);
  if (byName.length === 1) return byName[0].id;
  const bySub = items.filter((i) => i.id.includes(want) || (i.name && slugify(i.name).includes(want)));
  if (bySub.length === 1) return bySub[0].id;
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Bring a localPosition inside its island. If the value looks like a world coordinate that lies on the island
 * (distance from centre <= radius) it is converted to an offset; otherwise an over-long offset is scaled back
 * to radius - clearance along the same direction.
 */
export function normalizeLocalPosition(island: IslandLike, local: unknown, clearance: number, log: Normalization[], path: string): { x: number; z: number } | undefined {
  if (!local || typeof local !== 'object') return undefined;
  const x = num((local as { x?: unknown }).x);
  const z = num((local as { z?: unknown }).z);
  if (x === undefined || z === undefined) return undefined;
  const maxR = Math.max(0.5, island.radius - clearance);
  const asLocal = Math.hypot(x, z);
  if (asLocal <= maxR) return { x, z };
  // world coordinate on the island?
  const dxw = x - island.center.x;
  const dzw = z - island.center.z;
  if (Math.hypot(dxw, dzw) <= maxR) {
    const to = { x: r3(dxw), z: r3(dzw) };
    log.push({ path, from: { x, z }, to, reason: 'world coordinate converted to island offset' });
    return to;
  }
  const k = maxR / asLocal;
  const to = { x: r3(x * k), z: r3(z * k) };
  log.push({ path, from: { x, z }, to, reason: `offset exceeded island radius ${island.radius}; scaled to ${r3(maxR)}` });
  return to;
}

function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function clampNum(v: unknown, min: number, max: number, log: Normalization[], path: string): unknown {
  const n = num(v);
  if (n === undefined) return v;
  if (n < min || n > max) {
    const to = Math.min(max, Math.max(min, n));
    log.push({ path, from: n, to, reason: `clamped to [${min}, ${max}]` });
    return to;
  }
  return n;
}


const ISLAND_MIN_GAP = 1.0;

/**
 * Push overlapping island discs apart so every pair keeps at least ISLAND_MIN_GAP (plus a small margin), keeping
 * the layout's shape: each iteration moves the two discs of the worst-overlapping pair equally along their centre
 * line, clamped to the bounds. Deterministic; at most 60 iterations. Touching islands are left alone.
 */
export function separateIslands(islands: IslandLike[], log: Normalization[]): void {
  const H = WORLD_LIMITS.bounds.halfExtent;
  const margin = 0.25;
  const start = new Map(islands.map((i) => [i.id, { ...i.center }]));
  const lim = (i: IslandLike) => H - i.radius;
  for (let iter = 0; iter < 200; iter++) {
    let worst: { a: IslandLike; b: IslandLike; depth: number } | null = null;
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        const a = islands[i]; const b = islands[j];
        const d = Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z);
        const depth = a.radius + b.radius + ISLAND_MIN_GAP + margin - d;
        if (depth > 1e-4 && (!worst || depth > worst.depth)) worst = { a, b, depth };
      }
    }
    if (!worst) break;
    const { a, b, depth } = worst;
    let dx = b.center.x - a.center.x; let dz = b.center.z - a.center.z;
    let d = Math.hypot(dx, dz);
    if (d < 1e-6) { dx = 1; dz = 0; d = 1; } // coincident centres: push along +X
    const ux = dx / d; const uz = dz / d;
    // Move both by half; whatever the bounds clamp takes away from one disc is added to the other, so the pair
    // always separates by the full depth unless both are pinned at opposite bounds.
    const want = depth / 2 + 1e-3;
    const ax = clampTo(a.center.x - ux * want, -lim(a), lim(a)); const az = clampTo(a.center.z - uz * want, -lim(a), lim(a));
    const movedA = Math.hypot(ax - a.center.x, az - a.center.z);
    const residualA = Math.max(0, want - movedA);
    const bx = clampTo(b.center.x + ux * (want + residualA), -lim(b), lim(b)); const bz = clampTo(b.center.z + uz * (want + residualA), -lim(b), lim(b));
    const movedB = Math.hypot(bx - b.center.x, bz - b.center.z);
    const residualB = Math.max(0, want + residualA - movedB);
    a.center = { x: r3(clampTo(ax - ux * residualB, -lim(a), lim(a))), z: r3(clampTo(az - uz * residualB, -lim(a), lim(a))) };
    b.center = { x: r3(bx), z: r3(bz) };
  }
  for (const i of islands) {
    const from = start.get(i.id)!;
    const moved = Math.hypot(i.center.x - from.x, i.center.z - from.z);
    if (moved > 1e-3) log.push({ path: `islands[${i.id}].center`, from, to: i.center, reason: `moved ${r3(moved)} m apart from overlapping islands` });
  }
}

function clampTo(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}


/**
 * Pull islands joined by an over-long bridge closer together: the island with fewer bridges moves toward the other
 * by the excess, clamped to bounds, then overlaps are re-resolved. At most 30 rounds. Deterministic.
 */
export function contractLongBridges(islands: IslandLike[], bridges: { from: string; to: string }[], log: Normalization[]): void {
  const H = WORLD_LIMITS.bounds.halfExtent;
  const maxRim = WORLD_LIMITS.bridge.maxLength - 1.0;
  const degree = (id: string) => bridges.filter((b) => b.from === id || b.to === id).length;
  for (let iter = 0; iter < 30; iter++) {
    let worst: { a: IslandLike; c: IslandLike; rim: number } | null = null;
    for (const b of bridges) {
      const a = islands.find((i) => i.id === b.from); const c = islands.find((i) => i.id === b.to);
      if (!a || !c || a === c) continue;
      const rim = Math.hypot(a.center.x - c.center.x, a.center.z - c.center.z) - a.radius - c.radius;
      if (rim > maxRim && (!worst || rim > worst.rim)) worst = { a, c, rim };
    }
    if (!worst) break;
    const mover = degree(worst.a.id) <= degree(worst.c.id) ? worst.a : worst.c;
    const anchor = mover === worst.a ? worst.c : worst.a;
    const dx = anchor.center.x - mover.center.x; const dz = anchor.center.z - mover.center.z;
    const d = Math.hypot(dx, dz) || 1;
    const excess = worst.rim - maxRim + 0.5;
    const lim = H - mover.radius;
    mover.center = {
      x: r3(clampTo(mover.center.x + (dx / d) * excess, -lim, lim)),
      z: r3(clampTo(mover.center.z + (dz / d) * excess, -lim, lim)),
    };
    separateIslands(islands, log);
  }
}

const OBJECT_CLEARANCE = 1.2;

/** Normalize a raw model WorldDraft. Returns a new object; never throws on odd shapes. */
export function normalizeDraft(draft: unknown): { draft: unknown; normalizations: Normalization[] } {
  const log: Normalization[] = [];
  if (!draft || typeof draft !== 'object') return { draft, normalizations: log };
  const d = structuredClone(draft) as Record<string, unknown>;
  const H = WORLD_LIMITS.bounds.halfExtent;
  const islands: IslandLike[] = [];
  if (Array.isArray(d.islands)) {
    d.islands.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const is = raw as Record<string, unknown>;
      is.radius = clampNum(is.radius, WORLD_LIMITS.island.minRadius, WORLD_LIMITS.island.maxRadius, log, `islands[${i}].radius`);
      const r = num(is.radius) ?? WORLD_LIMITS.island.minRadius;
      if (is.center && typeof is.center === 'object') {
        const c = is.center as Record<string, unknown>;
        c.x = clampNum(c.x, -(H - r), H - r, log, `islands[${i}].center.x`);
        c.z = clampNum(c.z, -(H - r), H - r, log, `islands[${i}].center.z`);
        const cx = num(c.x); const cz = num(c.z);
        if (typeof is.id === 'string' && cx !== undefined && cz !== undefined) {
          islands.push({ id: is.id, name: typeof is.name === 'string' ? is.name : undefined, center: { x: cx, z: cz }, radius: r });
        }
      }
    });
  }
  const fixRefEarly = (obj: Record<string, unknown>, key: string, path: string) => {
    const ref = obj[key];
    if (typeof ref !== 'string' || islands.some((i) => i.id === ref)) return;
    const resolved = resolveIslandRef(islands, ref);
    if (resolved) { log.push({ path, from: ref, to: resolved, reason: 'island reference resolved by name or direction' }); obj[key] = resolved; }
  };
  const bridgeRefs: { from: string; to: string }[] = [];
  if (Array.isArray(d.bridges)) {
    d.bridges.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const b = raw as Record<string, unknown>;
      fixRefEarly(b, 'from', `bridges[${i}].from`);
      fixRefEarly(b, 'to', `bridges[${i}].to`);
      if (typeof b.from === 'string' && typeof b.to === 'string') bridgeRefs.push({ from: b.from, to: b.to });
    });
  }
  // Overlapping islands and over-long bridges are the most common structural failures in model drafts: resolve both
  // deterministically (separate, contract, separate) and log one displacement per island.
  if (islands.length > 1) {
    const start = new Map(islands.map((i) => [i.id, { ...i.center }]));
    const scratch: Normalization[] = [];
    separateIslands(islands, scratch);
    contractLongBridges(islands, bridgeRefs, scratch);
    for (const i of islands) {
      const from = start.get(i.id)!;
      const moved = Math.hypot(i.center.x - from.x, i.center.z - from.z);
      if (moved > 1e-3) log.push({ path: `islands[${i.id}].center`, from, to: i.center, reason: `moved ${r3(moved)} m to resolve overlaps or over-long bridges` });
    }
    if (Array.isArray(d.islands)) {
      for (const raw of d.islands) {
        if (!raw || typeof raw !== 'object') continue;
        const is = raw as Record<string, unknown>;
        const moved = islands.find((i) => i.id === is.id);
        if (moved && is.center && typeof is.center === 'object') { (is.center as Record<string, unknown>).x = moved.center.x; (is.center as Record<string, unknown>).z = moved.center.z; }
      }
    }
  }
  const fixRef = (obj: Record<string, unknown>, key: string, path: string) => {
    const ref = obj[key];
    if (typeof ref !== 'string') return;
    if (islands.some((i) => i.id === ref)) return;
    const resolved = resolveIslandRef(islands, ref);
    if (resolved) { log.push({ path, from: ref, to: resolved, reason: 'island reference resolved by name or direction' }); obj[key] = resolved; }
  };
  const fixPlaced = (obj: Record<string, unknown>, path: string) => {
    fixRef(obj, 'islandId', `${path}.islandId`);
    const island = islands.find((i) => i.id === obj.islandId);
    if (island) {
      const lp = normalizeLocalPosition(island, obj.localPosition, OBJECT_CLEARANCE, log, `${path}.localPosition`);
      if (lp) obj.localPosition = lp;
    }
  };
  if (Array.isArray(d.bridges)) {
    d.bridges.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const b = raw as Record<string, unknown>;
      fixRef(b, 'from', `bridges[${i}].from`);
      fixRef(b, 'to', `bridges[${i}].to`);
      if (b.width !== undefined) b.width = clampNum(b.width, WORLD_LIMITS.bridge.minWidth, WORLD_LIMITS.bridge.maxWidth, log, `bridges[${i}].width`);
    });
  }
  // A relic on the gate's island would be hidden behind the locked gate (GATE_HIDES_RELIC): move it to the island
  // with the fewest relics among the others, preferring islands that have a bridge. The offset is clamped later.
  if (d.gate && typeof d.gate === 'object' && Array.isArray(d.relics) && islands.length > 1) {
    const gate = d.gate as Record<string, unknown>;
    fixRefEarly(gate, 'islandId', 'gate.islandId');
    const gateIsland = gate.islandId;
    if (typeof gateIsland === 'string') {
      const counts = new Map(islands.map((i) => [i.id, 0]));
      for (const r of d.relics as unknown[]) { const id = (r as { islandId?: unknown })?.islandId; if (typeof id === 'string' && counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1); }
      d.relics.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object') return;
        const rel = raw as Record<string, unknown>;
        fixRefEarly(rel, 'islandId', `relics[${i}].islandId`);
        if (rel.islandId !== gateIsland) return;
        const candidates = islands.filter((is) => is.id !== gateIsland);
        const bridged = candidates.filter((is) => bridgeRefs.some((b) => b.from === is.id || b.to === is.id));
        const pool = bridged.length ? bridged : candidates;
        const target = pool.slice().sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0))[0];
        if (!target) return;
        log.push({ path: `relics[${i}].islandId`, from: gateIsland, to: target.id, reason: 'relic moved off the gate island so the locked gate cannot hide it' });
        rel.islandId = target.id;
        counts.set(target.id, (counts.get(target.id) ?? 0) + 1);
      });
    }
  }
  for (const key of ['spawns', 'relics', 'decorations'] as const) {
    if (Array.isArray(d[key])) (d[key] as unknown[]).forEach((raw, i) => { if (raw && typeof raw === 'object') fixPlaced(raw as Record<string, unknown>, `${key}[${i}]`); });
  }
  if (d.gate && typeof d.gate === 'object') fixPlaced(d.gate as Record<string, unknown>, 'gate');
  if (Array.isArray(d.decorations) && d.decorations.length > WORLD_LIMITS.decorations.max) {
    log.push({ path: 'decorations', from: d.decorations.length, to: WORLD_LIMITS.decorations.max, reason: 'truncated to the decoration limit' });
    d.decorations = d.decorations.slice(0, WORLD_LIMITS.decorations.max);
  }
  return { draft: d, normalizations: log };
}

/** Normalize a raw model PatchDraft against the current spec: resolve references, clamp positions and widths. */
export function normalizePatchDraft(
  spec: { islands: IslandLike[]; relics: { id: string; name?: string }[]; decorations: { id: string }[]; bridges: { id: string }[] },
  patch: unknown,
): { patch: unknown; normalizations: Normalization[] } {
  const log: Normalization[] = [];
  if (!patch || typeof patch !== 'object' || !Array.isArray((patch as { ops?: unknown }).ops)) return { patch, normalizations: log };
  const p = structuredClone(patch) as { ops: unknown[] };
  const fixIsland = (op: Record<string, unknown>, key: string, path: string) => {
    const ref = op[key];
    if (typeof ref !== 'string' || spec.islands.some((i) => i.id === ref)) return;
    const resolved = resolveIslandRef(spec.islands, ref);
    if (resolved) { log.push({ path, from: ref, to: resolved, reason: 'island reference resolved by name or direction' }); op[key] = resolved; }
  };
  p.ops.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const op = raw as Record<string, unknown>;
    const path = `ops[${i}]`;
    switch (op.op) {
      case 'add_bridge':
        fixIsland(op, 'from', `${path}.from`);
        fixIsland(op, 'to', `${path}.to`);
        if (op.width !== undefined) op.width = clampNum(op.width, WORLD_LIMITS.bridge.minWidth, WORLD_LIMITS.bridge.maxWidth, log, `${path}.width`);
        if (typeof op.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(op.id)) {
          const to = `bridge-${slugify(String(op.from ?? 'a'))}-${slugify(String(op.to ?? 'b'))}`.slice(0, 32);
          log.push({ path: `${path}.id`, from: op.id, to, reason: 'bridge id generated' });
          op.id = to;
        }
        break;
      case 'remove_bridge': {
        if (typeof op.id === 'string' && !spec.bridges.some((b) => b.id === op.id)) {
          const resolved = resolveNamedRef(spec.bridges, op.id);
          if (resolved) { log.push({ path: `${path}.id`, from: op.id, to: resolved, reason: 'bridge reference resolved' }); op.id = resolved; }
        }
        break;
      }
      case 'add_decoration':
      case 'move_decoration':
      case 'move_relic': {
        fixIsland(op, 'islandId', `${path}.islandId`);
        if (op.op === 'move_relic' && typeof op.id === 'string' && !spec.relics.some((r) => r.id === op.id)) {
          const resolved = resolveNamedRef(spec.relics, op.id);
          if (resolved) { log.push({ path: `${path}.id`, from: op.id, to: resolved, reason: 'relic reference resolved by name' }); op.id = resolved; }
        }
        const island = spec.islands.find((is) => is.id === op.islandId);
        if (island) {
          const lp = normalizeLocalPosition(island, op.localPosition, OBJECT_CLEARANCE, log, `${path}.localPosition`);
          if (lp) op.localPosition = lp;
        }
        break;
      }
      default:
        break;
    }
  });
  return { patch: p, normalizations: log };
}
