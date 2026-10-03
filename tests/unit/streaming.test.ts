// Streaming generation, world side: add_island / remove_island, the seed2 and grown12 fixtures, and scale bounds.
import { describe, expect, it } from 'vitest';
import { STREAMING, WORLD_LIMITS, dist, type PatchDraft, type Vec2, type WorldSpec } from '@beetle/contracts';
import { applyPatch, buildSessionSummary, compileWorld, expandDraft, fixtureWorld, runPlayabilityChecks, validateSpec } from '@beetle/world';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const patch = (ops: PatchDraft['ops'], summary = 'extend'): PatchDraft => ({ summary, ops });

function applyOk(spec: WorldSpec, p: PatchDraft) {
  const r = applyPatch(spec, p);
  if (!r.ok) throw new Error(`patch rejected: ${JSON.stringify(r.issues)}`);
  return r;
}

function bridgeLength(spec: WorldSpec, id: string): number {
  const b = spec.bridges.find((x) => x.id === id)!;
  return dist(b.endpoints[0].point, b.endpoints[1].point);
}

function minGap(spec: WorldSpec, id: string): number {
  const a = spec.islands.find((i) => i.id === id)!;
  return Math.min(...spec.islands.filter((i) => i.id !== id).map((b) => dist(a.center, b.center) - a.radius - b.radius));
}

/** 6 x 4 grid of radius-4 islands 20 m apart: 38 neighbour crossings plus 10 diagonals = 48 bridges, 24 islands. */
function grid24(): WorldSpec {
  const spec = fixtureWorld('seed2');
  const xs = [-50, -30, -10, 10, 30, 50];
  const zs = [-30, -10, 10, 30];
  const id = (c: number, r: number) => `g-${c}-${r}`;
  spec.islands = [];
  for (let r = 0; r < zs.length; r++) for (let c = 0; c < xs.length; c++) spec.islands.push({ id: id(c, r), center: { x: xs[c], z: zs[r] }, radius: 4, topElevation: 0 });
  const pairs: [string, string][] = [];
  for (let r = 0; r < zs.length; r++) {
    for (let c = 0; c < xs.length; c++) {
      if (c + 1 < xs.length) pairs.push([id(c, r), id(c + 1, r)]);
      if (r + 1 < zs.length) pairs.push([id(c, r), id(c, r + 1)]);
    }
  }
  for (let k = 0; pairs.length < WORLD_LIMITS.bridges.max; k++) pairs.push([id(k % 5, Math.floor(k / 5) % 3), id((k % 5) + 1, (Math.floor(k / 5) % 3) + 1)]);
  spec.bridges = [];
  spec.decorations = [];
  // Seed the bridges with add_bridge so the endpoints are derived exactly as the server derives them (16 ops per patch).
  let s = spec;
  for (let i = 0; i < pairs.length; i += WORLD_LIMITS.patchOps.max) {
    s = applyOk(s, patch(pairs.slice(i, i + WORLD_LIMITS.patchOps.max).map(([from, to], k) => ({ op: 'add_bridge' as const, id: `gb-${i + k}`, from, to })))).spec;
  }
  s.spawns = s.spawns.map((sp, k) => ({ ...sp, supportingSurfaceId: id(2, 1), localPosition: { x: k ? 1.5 : -1.5, z: -1.5 } }));
  s.relics = s.relics.map((r, k) => ({ ...r, supportingSurfaceId: [id(5, 3), id(0, 3), id(5, 0)][k], localPosition: { x: 0, z: 0 } }));
  s.gate = { ...s.gate, supportingSurfaceId: id(0, 0), localPosition: { x: -1.5, z: -1.5 } };
  return s;
}

describe('streaming fixtures and the 2-island minimum', () => {
  it('seed2 is a valid two-island streaming world with both spawns on one island', () => {
    const s = fixtureWorld('seed2');
    expect(s.streaming).toBe(true);
    expect(s.islands).toHaveLength(WORLD_LIMITS.islands.min);
    expect(s.bridges).toHaveLength(1);
    expect(new Set(s.spawns.map((sp) => sp.supportingSurfaceId))).toEqual(new Set(['haven']));
    expect(s.relics.filter((r) => r.supportingSurfaceId === 'haven')).toHaveLength(1);
    expect(s.relics.filter((r) => r.supportingSurfaceId === 'grove')).toHaveLength(2);
    expect(s.gate.supportingSurfaceId).toBe('grove');
    const v = validateSpec(s);
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('a two-island world compiles, passes playability, summarises and expands from a draft', () => {
    const s = fixtureWorld('seed2');
    const c = compileWorld(s);
    expect(c.surfaces.filter((x) => x.kind === 'island')).toHaveLength(2);
    expect(runPlayabilityChecks(c).ok).toBe(true);
    const summary = buildSessionSummary(c, { worldVersion: 0, elapsedMs: 0, players: [], collectedRelicIds: [], gateUnlocked: false, won: false, score: {} } as never);
    expect(summary).toBeTruthy();
    const draft = {
      title: 'Two islands', hazard: 'water', decorations: [], streaming: true,
      islands: s.islands.map((i) => ({ id: i.id, name: i.name!, center: i.center, radius: i.radius })),
      bridges: [{ id: 'bridge-grove', from: 'haven', to: 'grove', width: 2.4 }],
      spawns: s.spawns.map((sp) => ({ islandId: sp.supportingSurfaceId, localPosition: sp.localPosition })),
      relics: s.relics.map((r) => ({ id: r.id, name: r.name!, islandId: r.supportingSurfaceId, localPosition: r.localPosition })),
      gate: { islandId: s.gate.supportingSurfaceId, localPosition: s.gate.localPosition },
    };
    const r = expandDraft(draft, { seed: 1, worldId: 'two' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.islands).toHaveLength(2);
    expect(validateSpec(r.spec).ok).toBe(true);
  });

  it('grown12 is a valid 12-island streaming world', () => {
    const s = fixtureWorld('grown12');
    expect(s.streaming).toBe(true);
    expect(s.islands).toHaveLength(12);
    const v = validateSpec(s);
    expect(v.issues).toEqual([]);
  });
});

describe('add_island', () => {
  it('with bridgeFrom: adds the island and a crossing from that island', () => {
    const r = applyOk(fixtureWorld('seed2'), patch([{ op: 'add_island', id: 'ridge', name: 'Ridge', center: { x: 22, z: 24 }, radius: 6, bridgeFrom: 'grove' }]));
    const ridge = r.spec.islands.find((i) => i.id === 'ridge')!;
    expect(ridge).toMatchObject({ name: 'Ridge', center: { x: 22, z: 24 }, radius: 6, topElevation: 0 });
    const b = r.spec.bridges.find((x) => x.id === 'bridge-grove-ridge')!;
    expect(b.endpoints.map((e) => e.islandId)).toEqual(['grove', 'ridge']);
    expect(r.changedIds).toEqual(['ridge', 'bridge-grove-ridge']);
    expect(r.normalizations).toEqual([]);
    expect(validateSpec(r.spec).issues).toEqual([]);
  });

  it('without bridgeFrom: the crossing starts at the nearest island', () => {
    const r = applyOk(fixtureWorld('seed2'), patch([{ op: 'add_island', id: 'marsh', center: { x: -24, z: 2 }, radius: 6 }]));
    expect(r.spec.bridges.map((b) => b.id)).toContain('bridge-haven-marsh');
    expect(validateSpec(r.spec).issues).toEqual([]);
  });

  it('pushes an overlapping island away until the 1.25 m gap holds, and records it', () => {
    const r = applyOk(fixtureWorld('seed2'), patch([{ op: 'add_island', id: 'crowd', center: { x: 12, z: 4 }, radius: 6 }]));
    const crowd = r.spec.islands.find((i) => i.id === 'crowd')!;
    expect(crowd.center).not.toEqual({ x: 12, z: 4 });
    expect(minGap(r.spec, 'crowd')).toBeGreaterThanOrEqual(1.25 - 0.01);
    expect(r.normalizations.some((n) => n.path === 'ops[0].center')).toBe(true);
    expect(validateSpec(r.spec).issues).toEqual([]);
  });

  it('pulls a far island toward its anchor so the crossing fits the maximum bridge length', () => {
    const r = applyOk(fixtureWorld('seed2'), patch([{ op: 'add_island', id: 'far', center: { x: 55, z: -55 }, radius: 5, bridgeFrom: 'haven' }]));
    const far = r.spec.islands.find((i) => i.id === 'far')!;
    const len = bridgeLength(r.spec, 'bridge-haven-far');
    expect(len).toBeLessThanOrEqual(WORLD_LIMITS.bridge.maxLength);
    expect(len).toBeGreaterThan(WORLD_LIMITS.bridge.maxLength - 1);
    // Still on the original centre line (direction south-east from the haven).
    expect(Math.abs(far.center.x + far.center.z)).toBeLessThan(0.01);
    expect(r.normalizations.some((n) => n.path === 'ops[0].center' && /pulled toward "haven"/.test(n.reason))).toBe(true);
    expect(validateSpec(r.spec).issues).toEqual([]);
  });

  it('clamps an island into the world bounds', () => {
    const r = applyOk(fixtureWorld('grown12'), patch([{ op: 'add_island', id: 'edge', center: { x: 60, z: 0 }, radius: 6 }]));
    const edge = r.spec.islands.find((i) => i.id === 'edge')!;
    expect(edge.center).toEqual({ x: WORLD_LIMITS.bounds.halfExtent - 6, z: 0 });
    expect(r.normalizations.find((n) => n.path === 'ops[0].center')?.to).toEqual({ x: 54, z: 0 });
    expect(r.spec.bridges.map((b) => b.id)).toContain('bridge-isle-3-1-edge');
    expect(validateSpec(r.spec).issues).toEqual([]);
  });

  it('re-anchors a crossing that would pass through a third island', () => {
    // From the haven due north, the straight crossing would run through the grove; the grove is the clean anchor.
    const r = applyOk(fixtureWorld('seed2'), patch([{ op: 'add_island', id: 'peak', center: { x: 0, z: 48 }, radius: 6, bridgeFrom: 'haven' }]));
    expect(r.spec.bridges.map((b) => b.id)).toContain('bridge-grove-peak');
    expect(r.spec.bridges.map((b) => b.id)).not.toContain('bridge-haven-peak');
    expect(r.normalizations).toContainEqual(expect.objectContaining({ path: 'ops[0].bridgeFrom', from: 'haven', to: 'grove' }));
    expect(validateSpec(r.spec).issues).toEqual([]);
  });

  it('accepts decorations placed on the new island later in the same patch', () => {
    const r = applyOk(fixtureWorld('seed2'), patch([
      { op: 'add_island', id: 'ridge', center: { x: 22, z: 24 }, radius: 6, bridgeFrom: 'grove' },
      { op: 'add_decoration', id: 'ridge-tree', type: 'tree', islandId: 'ridge', localPosition: { x: 2, z: 3 } },
    ]));
    expect(r.spec.decorations.find((d) => d.id === 'ridge-tree')?.supportingSurfaceId).toBe('ridge');
    expect(validateSpec(r.spec).issues).toEqual([]);
  });

  it('rejects a duplicate id (island or any other object) with DUPLICATE_ID', () => {
    for (const id of ['grove', 'gate', 'bridge-grove', 'relic-haven']) {
      const r = applyPatch(fixtureWorld('seed2'), patch([{ op: 'add_island', id, center: { x: -24, z: 0 }, radius: 6 }]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(codes(r.issues)).toEqual(['DUPLICATE_ID']);
    }
    const twice = applyPatch(fixtureWorld('seed2'), patch([
      { op: 'add_island', id: 'twin', center: { x: -24, z: 0 }, radius: 6 },
      { op: 'add_island', id: 'twin', center: { x: 24, z: 0 }, radius: 6 },
    ]));
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.issues[0]).toMatchObject({ code: 'DUPLICATE_ID', evidence: { opIndex: 1 } });
  });

  it('rejects an unknown bridgeFrom with INVALID_REFERENCE', () => {
    const r = applyPatch(fixtureWorld('seed2'), patch([{ op: 'add_island', id: 'lost', center: { x: -24, z: 0 }, radius: 6, bridgeFrom: 'nowhere' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r.issues)).toEqual(['INVALID_REFERENCE']);
  });

  it('rejects the 25th island with RESOURCE_LIMIT', () => {
    const full = grid24();
    expect(full.islands).toHaveLength(WORLD_LIMITS.islands.max);
    expect(STREAMING.maxIslands).toBe(WORLD_LIMITS.islands.max);
    const r = applyPatch(full, patch([{ op: 'add_island', id: 'one-more', center: { x: 0, z: 50 }, radius: 4 }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ code: 'RESOURCE_LIMIT', evidence: { count: 24, max: 24 } });
    // Inside one patch: grown12 takes 12 more, the 13th is refused.
    const ops = Array.from({ length: 13 }, (_, k) => ({ op: 'add_island' as const, id: `n-${k}`, center: { x: -50 + (k % 7) * 16, z: k < 7 ? 48 : -48 }, radius: 4 }));
    const r2 = applyPatch(fixtureWorld('grown12'), patch(ops));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues.map((i) => [i.code, i.evidence?.opIndex])).toEqual([['RESOURCE_LIMIT', 12]]);
  });
});

describe('remove_island', () => {
  it('refuses islands carrying spawns, relics or the gate, and unknown islands', () => {
    const s = fixtureWorld('seed2');
    for (const [id, holds] of [['haven', ['spawn-0', 'spawn-1', 'relic-haven']], ['grove', ['relic-grove-w', 'relic-grove-e', 'gate']]] as const) {
      const r = applyPatch(s, patch([{ op: 'remove_island', id }]));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(codes(r.issues)).toEqual(['UNSUPPORTED_OPERATION']);
        for (const h of holds) expect(r.issues[0].objectIds).toContain(h);
      }
    }
    const unknown = applyPatch(s, patch([{ op: 'remove_island', id: 'ghost' }]));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(codes(unknown.issues)).toEqual(['INVALID_REFERENCE']);
  });

  it('refuses to go below the two-island minimum', () => {
    const s = fixtureWorld('seed2');
    s.relics = s.relics.map((r, k) => ({ ...r, supportingSurfaceId: 'haven', localPosition: { x: -4 + k * 4, z: 4 } }));
    s.gate = { ...s.gate, supportingSurfaceId: 'haven', localPosition: { x: 5, z: -3 } };
    s.decorations = s.decorations.filter((d) => d.supportingSurfaceId !== 'grove');
    const r = applyPatch(s, patch([{ op: 'remove_island', id: 'grove' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r.issues)).toEqual(['RESOURCE_LIMIT']);
  });

  it('drops the island bridges and decorations with it', () => {
    const grown = applyOk(fixtureWorld('seed2'), patch([
      { op: 'add_island', id: 'ridge', center: { x: 22, z: 24 }, radius: 6, bridgeFrom: 'grove' },
      { op: 'add_bridge', id: 'ridge-haven', from: 'haven', to: 'ridge' },
      { op: 'add_decoration', id: 'ridge-tree', type: 'tree', islandId: 'ridge', localPosition: { x: 2, z: 3 } },
    ])).spec;
    expect(validateSpec(grown).issues).toEqual([]);
    const r = applyOk(grown, patch([{ op: 'remove_island', id: 'ridge' }]));
    expect(r.spec.islands.map((i) => i.id)).toEqual(['haven', 'grove']);
    expect(r.spec.bridges.map((b) => b.id)).toEqual(['bridge-grove']);
    expect(r.spec.decorations.map((d) => d.id)).not.toContain('ridge-tree');
    expect(new Set(r.changedIds)).toEqual(new Set(['ridge', 'bridge-grove-ridge', 'ridge-haven', 'ridge-tree']));
    expect(r.spec).toEqual(fixtureWorld('seed2'));
    expect(validateSpec(r.spec).issues).toEqual([]);
  });
});

/**
 * A simulated streaming agent: each extension adds one island beyond the island farthest from the spawn, in a
 * direction where that island has no bridge yet, preferring the most outward direction whose target stays in bounds.
 */
function nextExtension(spec: WorldSpec, n: number): PatchDraft {
  const spawnIsland = spec.islands.find((i) => i.id === spec.spawns[0].supportingSurfaceId)!;
  const origin: Vec2 = spawnIsland.center;
  const radius = 6;
  const H = WORLD_LIMITS.bounds.halfExtent;
  const ranked = [...spec.islands].sort((a, b) => dist(b.center, origin) - dist(a.center, origin));
  for (const from of ranked) {
    const out = dist(from.center, origin) > 0.01 ? { x: (from.center.x - origin.x) / dist(from.center, origin), z: (from.center.z - origin.z) / dist(from.center, origin) } : { x: 1, z: 0 };
    const used = spec.bridges.flatMap((b) => b.endpoints.filter((e) => e.islandId === from.id).map((e) => Math.atan2(e.point.z - from.center.z, e.point.x - from.center.x)));
    const options: { dir: Vec2; score: number; center: Vec2 }[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      if (used.some((u) => Math.abs(Math.atan2(Math.sin(a - u), Math.cos(a - u))) < Math.PI / 6)) continue; // a bridge already leaves this way
      const dir = { x: Math.cos(a), z: Math.sin(a) };
      const D = from.radius + radius + 10;
      const center = { x: Math.round((from.center.x + dir.x * D) * 100) / 100, z: Math.round((from.center.z + dir.z * D) * 100) / 100 };
      if (Math.max(Math.abs(center.x), Math.abs(center.z)) + radius > H) continue;
      if (spec.islands.some((i) => dist(i.center, center) - i.radius - radius < 1.25)) continue;
      options.push({ dir, score: dir.x * out.x + dir.z * out.z, center });
    }
    options.sort((p, q) => q.score - p.score);
    if (options.length) {
      return patch([
        { op: 'add_island', id: `ext-${n}`, name: `Frontier ${n}`, center: options[0].center, radius, bridgeFrom: from.id },
        { op: 'add_decoration', id: `ext-${n}-rock`, type: 'rock', islandId: `ext-${n}`, localPosition: { x: 2, z: 2 } },
      ], `extend beyond ${from.id}`);
    }
  }
  throw new Error('no room to extend');
}

describe('streaming growth', () => {
  it('ten extensions from seed2 all apply and validate', () => {
    let spec = fixtureWorld('seed2');
    for (let n = 1; n <= 10; n++) {
      const r = applyOk(spec, nextExtension(spec, n));
      const v = validateSpec(r.spec);
      expect(v.issues, `extension ${n}`).toEqual([]);
      expect(r.spec.islands).toHaveLength(2 + n);
      // Every new island is connected by exactly one new crossing that fits the limits.
      const newBridges = r.spec.bridges.filter((b) => !spec.bridges.some((o) => o.id === b.id));
      expect(newBridges).toHaveLength(1);
      expect(newBridges[0].endpoints[1].islandId).toBe(`ext-${n}`);
      spec = { ...r.spec, worldVersion: spec.worldVersion + 1 };
    }
    expect(spec.islands).toHaveLength(12);
    expect(spec.islands.length).toBeLessThanOrEqual(STREAMING.maxIslands);
    // Deterministic: replaying the same extensions gives the same world.
    let again = fixtureWorld('seed2');
    for (let n = 1; n <= 10; n++) again = { ...applyOk(again, nextExtension(again, n)).spec, worldVersion: again.worldVersion + 1 };
    expect(again).toEqual(spec);
  });

  it('validates a 24-island, 48-bridge world in under 150 ms', () => {
    const s = grid24();
    expect(s.islands).toHaveLength(WORLD_LIMITS.islands.max);
    expect(s.bridges).toHaveLength(WORLD_LIMITS.bridges.max);
    expect(validateSpec(s).issues).toEqual([]); // warm
    const times: number[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const v = validateSpec(s);
      times.push(performance.now() - t0);
      expect(v.ok).toBe(true);
    }
    expect(Math.min(...times)).toBeLessThan(150);
    const g = fixtureWorld('grown12');
    const t0 = performance.now();
    expect(validateSpec(g).ok).toBe(true);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});
