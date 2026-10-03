// Cases 3 to 7: validators, patches and live context. Owner: world package.
import { describe, expect, it } from 'vitest';
import { GEOMETRY, MOVEMENT_RULES_VERSION, SCHEMA_VERSION, WORLD_LIMITS, type WorldSpec } from '@beetle/contracts';
import { applyPatch, buildSessionSummary, compileWorld, expandDraft, fixtureWorld, reachable, runPlayabilityChecks, validateSpec } from '@beetle/world';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('case 3: garden5 is valid and fully connected', () => {
  it('passes validation', () => {
    const r = validateSpec(fixtureWorld('garden5'));
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('every relic and the gate are reachable from both spawns with the gate locked', () => {
    const spec = fixtureWorld('garden5');
    const c = compileWorld(spec);
    for (const s of spec.spawns) {
      const from = c.worldPos(s.supportingSurfaceId, s.localPosition)!;
      for (const r of spec.relics) {
        const to = c.worldPos(r.supportingSurfaceId, r.localPosition)!;
        const res = reachable(c, from, to, { gateOpen: false, goalRadius: GEOMETRY.relicPickupRadius });
        expect(res.reachable, `${s.id} -> ${r.id}`).toBe(true);
        expect(res.path!.length).toBeGreaterThan(2);
      }
      const gate = c.worldPos(spec.gate.supportingSurfaceId, spec.gate.localPosition)!;
      expect(reachable(c, from, gate, { gateOpen: false, goalRadius: GEOMETRY.gateTriggerRadius }).reachable).toBe(true);
      // the temple island itself is sealed off while the gate is locked, and opens with the gate
      const templeCentre = { x: 0, z: 28 };
      expect(reachable(c, from, templeCentre, { gateOpen: false }).reachable).toBe(false);
      expect(reachable(c, from, templeCentre, { gateOpen: true }).reachable).toBe(true);
    }
  });

  it('playability report is ok with the exact note', () => {
    const rep = runPlayabilityChecks(compileWorld(fixtureWorld('garden5')));
    expect(rep.ok).toBe(true);
    expect(rep.note).toBe('connectivity and supported-movement checks only; not a fun or completeness guarantee');
    expect(rep.checks.every((c) => c.ok)).toBe(true);
    expect(rep.routes.filter((r) => r.reachable).length).toBe(8);
  });
});

describe('case 4: gapped bridge', () => {
  it('fails with BRIDGE_ENDPOINT_GAP naming the bridge id', () => {
    const r = validateSpec(fixtureWorld('garden5-gapped-bridge'));
    expect(r.ok).toBe(false);
    const gap = r.issues.find((i) => i.code === 'BRIDGE_ENDPOINT_GAP');
    expect(gap).toBeDefined();
    expect(gap!.objectIds).toContain('bridge-east');
    expect(gap!.evidence).toMatchObject({ gap: 1.5 });
  });
});

describe('case 5: blocked path and hidden relic', () => {
  it('blocked path fails with UNREACHABLE_RELIC', () => {
    const r = validateSpec(fixtureWorld('garden5-blocked-path'));
    expect(r.ok).toBe(false);
    const u = r.issues.find((i) => i.code === 'UNREACHABLE_RELIC');
    expect(u).toBeDefined();
    expect(u!.objectIds).toContain('relic-south');
    expect(codes(r.issues)).not.toContain('OBJECT_NOT_ON_SURFACE');
    const rep = runPlayabilityChecks(compileWorld(fixtureWorld('garden5-blocked-path')));
    expect(rep.ok).toBe(false);
  });

  it('gate-hides-relic fails with GATE_HIDES_RELIC', () => {
    const r = validateSpec(fixtureWorld('garden5-gate-hides-relic'));
    expect(r.ok).toBe(false);
    expect(codes(r.issues)).toContain('GATE_HIDES_RELIC');
    expect(codes(r.issues)).not.toContain('UNREACHABLE_RELIC');
    const h = r.issues.find((i) => i.code === 'GATE_HIDES_RELIC')!;
    expect(h.objectIds).toContain('relic-east');
    expect(h.objectIds).toContain('gate');
  });

  it('stranded temple fails with DISCONNECTED_GOAL', () => {
    const r = validateSpec(fixtureWorld('garden4-no-temple-bridge'));
    expect(codes(r.issues)).toContain('DISCONNECTED_GOAL');
  });
});

describe('case 6: remove the only temple bridge', () => {
  it('validation fails with DISCONNECTED_GOAL and the original spec is untouched', () => {
    const original = fixtureWorld('garden5');
    const before = structuredClone(original);
    const p = applyPatch(original, { summary: 'remove the temple bridge', ops: [{ op: 'remove_bridge', id: 'bridge-north' }] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.changedIds).toEqual(['bridge-north']);
    expect(p.spec.bridges.map((b) => b.id)).not.toContain('bridge-north');
    expect(p.spec.worldVersion).toBe(original.worldVersion);
    const r = validateSpec(p.spec);
    expect(r.ok).toBe(false);
    expect(codes(r.issues)).toContain('DISCONNECTED_GOAL');
    expect(original).toEqual(before);
  });
});

describe('case 7: add a bridge to the temple', () => {
  it('passes validation and changedIds lists the new bridge', () => {
    const spec = fixtureWorld('garden5');
    const p = applyPatch(spec, { summary: 'second way in', ops: [{ op: 'add_bridge', id: 'bridge-east-temple', from: 'east', to: 'temple' }] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.changedIds).toEqual(['bridge-east-temple']);
    const added = p.spec.bridges.find((b) => b.id === 'bridge-east-temple')!;
    expect(added.width).toBe(2.4);
    expect(added.endpoints[0].islandId).toBe('east');
    expect(added.endpoints[1].islandId).toBe('temple');
    // endpoints sit on the rims along the centre line
    expect(Math.hypot(added.endpoints[0].point.x - 24, added.endpoints[0].point.z - 0)).toBeCloseTo(7, 2);
    expect(Math.hypot(added.endpoints[1].point.x - 0, added.endpoints[1].point.z - 28)).toBeCloseTo(8, 2);
    const r = validateSpec(p.spec);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(spec.bridges.length).toBe(4);
  });

  it('rejects duplicate ids, unknown islands, self loops and the bridge limit', () => {
    const spec = fixtureWorld('garden5');
    const dup = applyPatch(spec, { summary: 'x', ops: [{ op: 'add_bridge', id: 'bridge-east', from: 'east', to: 'temple' }] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(codes(dup.issues)).toEqual(['DUPLICATE_ID']);
    const unknown = applyPatch(spec, { summary: 'x', ops: [{ op: 'add_bridge', id: 'b-new', from: 'east', to: 'nowhere' }] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues[0]).toMatchObject({ code: 'INVALID_REFERENCE', objectIds: ['b-new', 'nowhere'] });
    const self = applyPatch(spec, { summary: 'x', ops: [{ op: 'add_bridge', id: 'b-new', from: 'east', to: 'east' }] });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(codes(self.issues)).toEqual(['INVALID_REFERENCE']);
    const full = ringWorld16();
    const limit = applyPatch(full, { summary: 'x', ops: [{ op: 'add_bridge', id: 'b-17', from: 'ring-0', to: 'ring-3' }] });
    expect(limit.ok).toBe(false);
    if (!limit.ok) expect(codes(limit.issues)).toEqual(['RESOURCE_LIMIT']);
    const gone = applyPatch(spec, { summary: 'x', ops: [{ op: 'remove_bridge', id: 'nope' }, { op: 'remove_decoration', id: 'nope' }] });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(codes(gone.issues)).toEqual(['INVALID_REFERENCE', 'INVALID_REFERENCE']);
  });

  it('move_relic on a collected relic yields RELIC_ALREADY_COLLECTED; set_hazard only touches hazard', () => {
    const spec = fixtureWorld('garden5');
    const moved = applyPatch(spec, { summary: 'x', ops: [{ op: 'move_relic', id: 'relic-east', islandId: 'south', localPosition: { x: 1, z: 1 } }] }, { collectedRelicIds: ['relic-east'] });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(codes(moved.issues)).toEqual(['RELIC_ALREADY_COLLECTED']);
    const lava = applyPatch(spec, { summary: 'x', ops: [{ op: 'set_hazard', kind: 'lava' }] });
    expect(lava.ok).toBe(true);
    if (lava.ok) {
      expect(lava.spec.hazard).toEqual({ kind: 'lava', planeElevation: spec.hazard.planeElevation, policy: { onContact: 'respawn', scorePenalty: 1 } });
      expect(lava.spec.islands).toEqual(spec.islands);
      expect(lava.changedIds).toEqual(['hazard']);
      const water = applyPatch(lava.spec, { summary: 'x', ops: [{ op: 'set_hazard', kind: 'water' }] });
      if (water.ok) expect(water.spec.hazard.policy.scorePenalty).toBe(0);
    }
  });
});

describe('live context', () => {
  it('reports PLAYER_CUT_OFF when a patch disconnects an active player', () => {
    const spec = fixtureWorld('garden5');
    const p = applyPatch(spec, { summary: 'x', ops: [{ op: 'remove_bridge', id: 'bridge-east' }] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const r = validateSpec(p.spec, {
      players: [{ id: 'amber', x: 23, z: 1, status: 'active', spawnId: 'spawn-0' }],
      collectedRelicIds: ['relic-east'],
    });
    expect(r.ok).toBe(false);
    const cut = r.issues.find((i) => i.code === 'PLAYER_CUT_OFF');
    expect(cut).toBeDefined();
    expect(cut!.objectIds[0]).toBe('amber');
    expect(cut!.objectIds).toContain('gate');
    // the relic on the east island was already collected, so it is not an unreachable relic
    expect(codes(r.issues)).not.toContain('UNREACHABLE_RELIC');
  });

  it('does not cut off a falling player, who is judged from their spawn', () => {
    const spec = fixtureWorld('garden5');
    const p = applyPatch(spec, { summary: 'x', ops: [{ op: 'remove_bridge', id: 'bridge-east' }] });
    if (!p.ok) throw new Error('patch failed');
    const r = validateSpec(p.spec, {
      players: [{ id: 'amber', x: 23, z: 1, status: 'falling', spawnId: 'spawn-0' }],
      collectedRelicIds: ['relic-east'],
    });
    expect(codes(r.issues)).not.toContain('PLAYER_CUT_OFF');
    expect(r.ok).toBe(true);
  });

  it('collected relics do not need to be reachable', () => {
    const r = validateSpec(fixtureWorld('garden5-blocked-path'), { collectedRelicIds: ['relic-south'] });
    expect(r.ok).toBe(true);
  });
});

describe('performance', () => {
  it('validates a 16-bridge world in under 100 ms', () => {
    const spec = ringWorld16();
    validateSpec(spec); // warm the JIT once; the budget is for steady-state validation
    const t0 = performance.now();
    const r = validateSpec(spec);
    const ms = performance.now() - t0;
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(spec.bridges.length).toBe(16);
    expect(ms).toBeLessThan(100);
  });
});

describe('expandDraft and buildSessionSummary', () => {
  const draft = {
    title: 'Draft garden',
    islands: [
      { id: 'hub', name: 'Hub', center: { x: 0, z: 0 }, radius: 8 },
      { id: 'n', name: 'North', center: { x: 0, z: 24 }, radius: 6 },
      { id: 'e', name: 'East', center: { x: 22, z: 0 }, radius: 6 },
      { id: 'w', name: 'West', center: { x: -22, z: 0 }, radius: 6 },
    ],
    bridges: [
      { id: 'hub-n', from: 'hub', to: 'n', width: 2.4 },
      { id: 'hub-e', from: 'hub', to: 'e', width: 2.4 },
      { id: 'hub-w', from: 'hub', to: 'w', width: 1.6 },
    ],
    spawns: [{ islandId: 'hub', localPosition: { x: -1, z: -1 } }, { islandId: 'hub', localPosition: { x: 1, z: -1 } }],
    relics: [
      { id: 'r1', name: 'One', islandId: 'e', localPosition: { x: 1, z: 1 } },
      { id: 'r2', name: 'Two', islandId: 'w', localPosition: { x: -1, z: 1 } },
      { id: 'r3', name: 'Three', islandId: 'hub', localPosition: { x: 0, z: 4 } },
    ],
    gate: { islandId: 'n', localPosition: { x: 0, z: 1 } },
    hazard: 'lava',
    decorations: [{ id: 'd1', type: 'tree', islandId: 'hub', localPosition: { x: 3, z: -3 } }],
  };

  it('expands a draft into a valid, deterministic WorldSpec', () => {
    const ex = expandDraft(draft, { seed: 42, worldId: 'draft-1' });
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;
    expect(ex.spec.worldVersion).toBe(0);
    expect(ex.spec.spawns.map((s) => [s.id, s.playerSlot])).toEqual([['spawn-0', 0], ['spawn-1', 1]]);
    expect(ex.spec.gate).toMatchObject({ id: 'gate', supportingSurfaceId: 'n', requiredRelicIds: ['r1', 'r2', 'r3'] });
    expect(ex.spec.hazard).toEqual({ kind: 'lava', planeElevation: GEOMETRY.hazardPlaneElevation, policy: { onContact: 'respawn', scorePenalty: 1 } });
    expect(ex.spec.bridges[0].endpoints).toEqual([{ islandId: 'hub', point: { x: 0, z: 8 } }, { islandId: 'n', point: { x: 0, z: 18 } }]);
    expect(ex.spec.decorations[0].rotationDeg).toBeGreaterThanOrEqual(0);
    expect(ex.spec.objectiveRules).toEqual(['collect_all_relics_then_enter_gate']);
    const again = expandDraft(draft, { seed: 42, worldId: 'draft-1' });
    expect(again).toEqual(ex);
    const reseeded = expandDraft(draft, { seed: 43, worldId: 'draft-1' });
    if (reseeded.ok) expect(reseeded.spec.decorations[0].rotationDeg).not.toBe(ex.spec.decorations[0].rotationDeg);
    const v = validateSpec(ex.spec);
    expect(v.issues).toEqual([]);
  });

  it('reports INVALID_SCHEMA with zod paths and INVALID_REFERENCE for unknown bridge islands', () => {
    const bad = expandDraft({ ...draft, hazard: 'acid' }, { seed: 1, worldId: 'w' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]).toMatchObject({ code: 'INVALID_SCHEMA', objectIds: ['hazard'] });
    const ref = expandDraft({ ...draft, bridges: [{ id: 'x', from: 'hub', to: 'nope', width: 2 }] }, { seed: 1, worldId: 'w' });
    expect(ref.ok).toBe(false);
    if (!ref.ok) expect(ref.issues[0]).toMatchObject({ code: 'INVALID_REFERENCE', objectIds: ['x', 'nope'] });
  });

  it('builds a compact summary with surface ids, compass names and bridge lists', () => {
    const c = compileWorld(fixtureWorld('garden5'));
    const player = (id: string, x: number, z: number, status: 'active' | 'falling', supportId: string | null) => ({
      id, slot: 0 as const, label: id, color: '#fff', x, z, y: 0, vx: 0, vz: 0, facingDeg: 0, status, connected: true,
      lastInputSeq: 0, lastInputAtMs: 0, supportId, respawns: 0, lavaFalls: 0,
    });
    const sum = buildSessionSummary(c, {
      worldVersion: 3, elapsedMs: 12345, collectedRelicIds: ['relic-west'], gateUnlocked: false, won: false, score: 10,
      players: [player('amber', 13, 0, 'active', 'bridge-east'), player('azure', 50, 50, 'falling', null)],
    });
    expect(sum.worldVersion).toBe(3);
    expect(sum.elapsedSec).toBe(12.3);
    expect(sum.players.map((p) => p.onSurfaceId)).toEqual(['bridge-east', null]);
    expect(sum.remainingRelicIds).toEqual(['relic-east', 'relic-south']);
    expect(sum.islands.find((i) => i.id === 'temple')).toEqual({ id: 'temple', name: 'Temple Island', compass: 'north', bridgeIds: ['bridge-north'] });
    expect(sum.islands.find((i) => i.id === 'centre')!.bridgeIds.length).toBe(4);
    expect(JSON.stringify(sum)).not.toMatch(/"x":/);
  });
});

/** Eight islands on a ring, 8 neighbour bridges plus 8 skip-one bridges = 16 bridges, all valid. */
function ringWorld16(): WorldSpec {
  const R = 30;
  const r = 6;
  const n = 8;
  const centres = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: Math.round(Math.cos(a) * R * 1000) / 1000, z: Math.round(Math.sin(a) * R * 1000) / 1000 };
  });
  const rim = (from: number, to: number) => {
    const dx = centres[to].x - centres[from].x;
    const dz = centres[to].z - centres[from].z;
    const l = Math.hypot(dx, dz);
    return { x: Math.round((centres[from].x + (dx / l) * r) * 1000) / 1000, z: Math.round((centres[from].z + (dz / l) * r) * 1000) / 1000 };
  };
  const bridges: WorldSpec['bridges'] = [];
  for (let i = 0; i < n; i++) {
    for (const step of [1, 2]) {
      const j = (i + step) % n;
      bridges.push({ id: `b-${i}-${j}`, endpoints: [{ islandId: `ring-${i}`, point: rim(i, j) }, { islandId: `ring-${j}`, point: rim(j, i) }], width: 2.4 });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    worldId: 'ring16',
    worldVersion: 0,
    seed: 7,
    title: 'Ring of eight (test world)',
    biome: 'garden',
    bounds: { halfExtent: WORLD_LIMITS.bounds.halfExtent },
    movementRulesVersion: MOVEMENT_RULES_VERSION,
    islands: centres.map((c, i) => ({ id: `ring-${i}`, center: c, radius: r, topElevation: 0 })),
    bridges,
    spawns: [
      { id: 'spawn-0', supportingSurfaceId: 'ring-0', localPosition: { x: -1.5, z: 0 }, playerSlot: 0 },
      { id: 'spawn-1', supportingSurfaceId: 'ring-0', localPosition: { x: 1.5, z: 0 }, playerSlot: 1 },
    ],
    relics: [
      { id: 'relic-a', supportingSurfaceId: 'ring-2', localPosition: { x: 0, z: 0 } },
      { id: 'relic-b', supportingSurfaceId: 'ring-4', localPosition: { x: 0, z: 0 } },
      { id: 'relic-c', supportingSurfaceId: 'ring-6', localPosition: { x: 0, z: 0 } },
    ],
    gate: { id: 'gate', supportingSurfaceId: 'ring-5', localPosition: { x: 0, z: 0 }, requiredRelicIds: ['relic-a', 'relic-b', 'relic-c'] },
    hazard: { kind: 'water', planeElevation: GEOMETRY.hazardPlaneElevation, policy: { onContact: 'respawn', scorePenalty: 0 } },
    decorations: [],
    objectiveRules: ['collect_all_relics_then_enter_gate'],
  };
}

describe('BRIDGE_DUPLICATE', () => {
  it('rejects a second bridge along the same line between the same islands and accepts a genuinely different route', async () => {
    const { applyPatch, fixtureWorld, validateSpec } = await import('@beetle/world');
    const spec = fixtureWorld('garden5');
    const dup = applyPatch(spec, { summary: 'dup', ops: [{ op: 'add_bridge', id: 'bridge-north-new', from: 'centre', to: 'temple' }] });
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    const v = validateSpec(dup.spec);
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain('BRIDGE_DUPLICATE');
    const alt = applyPatch(spec, { summary: 'alt', ops: [{ op: 'add_bridge', id: 'bridge-east-temple', from: 'east', to: 'temple' }] });
    expect(alt.ok).toBe(true);
    if (!alt.ok) return;
    const v2 = validateSpec(alt.spec);
    expect(v2.issues.map((i) => i.code)).not.toContain('BRIDGE_DUPLICATE');
  });
});
