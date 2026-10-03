// Adversarial cases for packages/world: odd geometry, hostile patches, degenerate movement input, draft expansion.
// Every case must either succeed or fail with a validator code; nothing here may throw. Owner: world package.
import { describe, expect, it } from 'vitest';
import { GEOMETRY, SIMULATION, WORLD_LIMITS, type PatchDraft, type WorldSpec } from '@beetle/contracts';
import {
  applyPatch, compileWorld, createMover, expandDraft, fixtureWorld, reachable, runPlayabilityChecks, stepMover, validateSpec,
} from '@beetle/world';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const TICK = 1000 / SIMULATION.tickHz;
const spawn = { x: -2, z: -2 };
const REACH_CODES = ['UNREACHABLE_RELIC', 'DISCONNECTED_GOAL', 'UNREACHABLE_SPAWN', 'GATE_HIDES_RELIC', 'PLAYER_CUT_OFF'];

/** garden5 with the east island moved to `angleDeg` from the centre island, `gap` metres away, re-bridged at `width`. */
function angledEast(angleDeg: number, width: number, gap = 12): WorldSpec {
  const spec = fixtureWorld('garden5');
  const a = (angleDeg * Math.PI) / 180;
  const d = 9 + 7 + gap;
  const east = spec.islands.find((i) => i.id === 'east')!;
  east.center = { x: Math.round(Math.cos(a) * d * 1000) / 1000, z: Math.round(Math.sin(a) * d * 1000) / 1000 };
  spec.bridges = spec.bridges.filter((b) => b.id !== 'bridge-east');
  const r = applyPatch(spec, { summary: 'rebridge', ops: [{ op: 'add_bridge', id: 'bridge-east', from: 'centre', to: 'east', width }] });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.spec;
}

describe('bridges through clutter, tangent islands, odd angles', () => {
  it('a bridge whose rectangle leads into a decoration cluster never crashes: it passes or fails with a reachability code', () => {
    // garden5-blocked-path seals the south island's bridge mouth with a shrine and two rocks.
    const blocked = fixtureWorld('garden5-blocked-path');
    const v1 = validateSpec(blocked);
    expect(v1.ok).toBe(false);
    expect(codes(v1.issues)).toContain('UNREACHABLE_RELIC');
    expect(codes(v1.issues).every((c) => REACH_CODES.includes(c))).toBe(true);
    // A second bridge from the east island to the south island lands on a clear part of the rim and rescues the relic.
    const r = applyPatch(blocked, { summary: 'detour', ops: [{ op: 'add_bridge', id: 'bridge-se', from: 'east', to: 'south' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v2 = validateSpec(r.spec);
    expect(v2.issues).toEqual([]);
    expect(v2.ok).toBe(true);
    // Moving the cluster onto the new bridge's mouth closes it again: still only reachability codes, never an exception.
    const r3 = applyPatch(r.spec, {
      summary: 'clutter the detour',
      ops: [
        { op: 'remove_bridge', id: 'bridge-south' },
        { op: 'move_decoration', id: 'block-shrine', islandId: 'south', localPosition: { x: 3.8, z: 4.11 } },
        { op: 'move_decoration', id: 'block-rock-e', islandId: 'south', localPosition: { x: 5.05, z: 2.96 } },
        { op: 'move_decoration', id: 'block-rock-w', islandId: 'south', localPosition: { x: 2.55, z: 5.26 } },
      ],
    });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const v3 = validateSpec(r3.spec);
    expect(v3.ok).toBe(false);
    expect(codes(v3.issues)).toContain('UNREACHABLE_RELIC');
    expect(codes(v3.issues).every((c) => REACH_CODES.includes(c))).toBe(true);
  });

  it('add_bridge between islands exactly ISLAND_MIN_GAP (1.0 m) apart is valid, axis-aligned and diagonal', () => {
    for (const diagonal of [false, true]) {
      const spec = fixtureWorld('garden5');
      const east = spec.islands.find((i) => i.id === 'east')!;
      east.center = diagonal ? { x: 17 / Math.SQRT2, z: 17 / Math.SQRT2 } : { x: 17, z: 0 }; // 9 + 7 + 1.0
      spec.bridges = spec.bridges.filter((b) => b.id !== 'bridge-east');
      const r = applyPatch(spec, { summary: 'tangent', ops: [{ op: 'add_bridge', id: 'bridge-east', from: 'centre', to: 'east' }] });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const v = validateSpec(r.spec);
      expect(v.issues, diagonal ? 'diagonal' : 'axis').toEqual([]);
      expect(v.ok).toBe(true);
      const b = r.spec.bridges.find((x) => x.id === 'bridge-east')!;
      const len = Math.hypot(b.endpoints[1].point.x - b.endpoints[0].point.x, b.endpoints[1].point.z - b.endpoints[0].point.z);
      expect(len).toBeCloseTo(1.0, 2);
    }
  });

  it('add_bridge between islands closer than 1.0 m (and overlapping) is ISLAND_OVERLAP, never a crash', () => {
    for (const gap of [0.5, 0, -3]) {
      const spec = fixtureWorld('garden5');
      const east = spec.islands.find((i) => i.id === 'east')!;
      east.center = { x: 16 + gap, z: 0 };
      spec.bridges = spec.bridges.filter((b) => b.id !== 'bridge-east');
      const r = applyPatch(spec, { summary: 'too close', ops: [{ op: 'add_bridge', id: 'bridge-east', from: 'centre', to: 'east' }] });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const v = validateSpec(r.spec);
      expect(v.ok).toBe(false);
      expect(codes(v.issues)).toContain('ISLAND_OVERLAP');
      // Overlapping discs still derive a positive-length bridge between the facing rim points; only a short gap is BRIDGE_LENGTH.
      if (gap >= 0) expect(codes(v.issues)).toContain('BRIDGE_LENGTH');
      else expect(codes(v.issues)).toEqual(['ISLAND_OVERLAP']);
    }
  });

  it('a 1.6 m bridge is traversable by the conservative BFS at any angle (documented: passes without fits changes)', () => {
    for (const angle of [0, 15, 30, 45, 135, 225]) {
      const spec = angledEast(angle, WORLD_LIMITS.bridge.minWidth);
      const v = validateSpec(spec);
      expect(v.issues, `angle ${angle}`).toEqual([]);
      expect(v.ok).toBe(true);
      const c = compileWorld(spec);
      const relic = c.worldPos('east', { x: 2, z: 0 })!;
      const res = reachable(c, { x: -2, z: -2 }, relic, { gateOpen: false });
      expect(res.reachable, `angle ${angle}`).toBe(true);
      expect(res.path!.some((p) => c.supportAt(p.x, p.z) === 'bridge-east'), `angle ${angle} path crosses the bridge`).toBe(true);
    }
    // The headless walk (server movement rules at 30 Hz) also crosses the 45-degree 1.6 m bridge without falling.
    const report = runPlayabilityChecks(compileWorld(angledEast(45, WORLD_LIMITS.bridge.minWidth)));
    expect(report.checks.map((ch) => [ch.name, ch.ok])).toEqual(report.checks.map((ch) => [ch.name, true]));
    expect(report.ok).toBe(true);
  });
});

describe('hostile patches', () => {
  it('12 ops mixing adds and removes with duplicate ids inside one patch: DUPLICATE_ID, base spec untouched', () => {
    const base = fixtureWorld('garden5');
    const before = JSON.stringify(base);
    const ops: PatchDraft['ops'] = [
      { op: 'add_decoration', id: 'd1', type: 'rock', islandId: 'centre', localPosition: { x: 0, z: 4 } },
      { op: 'add_decoration', id: 'd2', type: 'bush', islandId: 'centre', localPosition: { x: 1, z: 4 } },
      { op: 'remove_decoration', id: 'd1' },
      { op: 'add_decoration', id: 'd1', type: 'lantern', islandId: 'centre', localPosition: { x: -1, z: 4 } },
      { op: 'add_bridge', id: 'nb', from: 'east', to: 'south' },
      { op: 'remove_bridge', id: 'nb' },
      { op: 'add_bridge', id: 'nb', from: 'west', to: 'south' },
      { op: 'add_decoration', id: 'd2', type: 'rock', islandId: 'east', localPosition: { x: 0, z: 0 } }, // duplicate of live d2
      { op: 'add_bridge', id: 'nb', from: 'east', to: 'south' }, // duplicate of live nb
      { op: 'add_decoration', id: 'tree-1', type: 'tree', islandId: 'west', localPosition: { x: 0, z: 0 } }, // duplicate of fixture id
      { op: 'add_bridge', id: 'centre', from: 'east', to: 'south' }, // collides with an island id
      { op: 'set_title', title: 'twelve ops' },
    ];
    expect(ops).toHaveLength(WORLD_LIMITS.patchOps.max);
    const r = applyPatch(base, { summary: 'dup ids', ops });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(codes(r.issues)).toEqual(['DUPLICATE_ID', 'DUPLICATE_ID', 'DUPLICATE_ID', 'DUPLICATE_ID']);
    expect(r.issues.map((i) => i.evidence?.opIndex)).toEqual([7, 8, 9, 10]);
    expect(JSON.stringify(base)).toBe(before);
    // The same patch without the four offenders applies, and remove-then-re-add of an id inside one patch is fine.
    const good = ops.filter((_, i) => ![7, 8, 9, 10].includes(i));
    const r2 = applyPatch(base, { summary: 'ok', ops: good });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.spec.decorations.filter((d) => d.id === 'd1')).toHaveLength(1);
    expect(r2.spec.decorations.find((d) => d.id === 'd1')!.type).toBe('lantern');
    expect(r2.spec.bridges.filter((b) => b.id === 'nb')).toHaveLength(1);
    expect(r2.spec.bridges.find((b) => b.id === 'nb')!.endpoints[0].islandId).toBe('west');
    expect(validateSpec(r2.spec).ok).toBe(true);
  });

  it('a null, undefined or scalar patch is INVALID_SCHEMA, not a TypeError', () => {
    const base = fixtureWorld('garden5');
    for (const bad of [null, undefined, 42, 'patch', true]) {
      const r = applyPatch(base, bad as unknown as PatchDraft);
      expect(r.ok, String(bad)).toBe(false);
      if (!r.ok) expect(codes(r.issues)).toEqual(['INVALID_SCHEMA']);
    }
    const r = applyPatch(base, { summary: 's', ops: [null, { op: 'teleport' }] } as unknown as PatchDraft);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r.issues)).toEqual(['UNKNOWN_OPERATION', 'UNKNOWN_OPERATION']);
  });

  it('13 ops is rejected at the schema boundary', () => {
    const ops = Array.from({ length: 13 }, () => ({ op: 'set_title' as const, title: 't' }));
    const r = applyPatch(fixtureWorld('garden5'), { summary: 'too many', ops });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r.issues)).toContain('INVALID_SCHEMA');
  });

  it('set_hazard lava then water keeps policy consistent with the kind at every step', () => {
    const base = fixtureWorld('garden5');
    const r1 = applyPatch(base, { summary: 'lava', ops: [{ op: 'set_hazard', kind: 'lava' }] });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.spec.hazard).toEqual({ kind: 'lava', planeElevation: GEOMETRY.hazardPlaneElevation, policy: { onContact: 'respawn', scorePenalty: 1 } });
    expect(r1.spec.hazard.planeElevation).toBe(base.hazard.planeElevation);
    const r2 = applyPatch(r1.spec, { summary: 'water', ops: [{ op: 'set_hazard', kind: 'water' }] });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.spec.hazard).toEqual(base.hazard);
    // Both in one patch: last op wins and the policy follows it.
    const r3 = applyPatch(base, { summary: 'both', ops: [{ op: 'set_hazard', kind: 'lava' }, { op: 'set_hazard', kind: 'water' }, { op: 'set_hazard', kind: 'lava' }] });
    expect(r3.ok && r3.spec.hazard.policy.scorePenalty === 1 && r3.spec.hazard.kind === 'lava').toBe(true);
    // Platforms are untouched by hazard changes.
    if (r3.ok) {
      expect(r3.spec.islands).toEqual(base.islands);
      expect(r3.spec.bridges).toEqual(base.bridges);
      expect(compileWorld(r3.spec).structuralDigest).toBe(compileWorld(base).structuralDigest);
      expect(validateSpec(r3.spec).ok).toBe(true);
    }
  });

  it('move_relic onto a bridge id fails INVALID_REFERENCE and never places the relic', () => {
    const base = fixtureWorld('garden5');
    const r = applyPatch(base, { summary: 'relic on bridge', ops: [{ op: 'move_relic', id: 'relic-east', islandId: 'bridge-east', localPosition: { x: 0, z: 0 } }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(codes(r.issues)).toEqual(['INVALID_REFERENCE']);
    expect(r.issues[0].objectIds).toContain('bridge-east');
    expect(base.relics.find((x) => x.id === 'relic-east')!.supportingSurfaceId).toBe('east');
    // A spec that already has a relic on a bridge (bypassing applyPatch) is OBJECT_NOT_ON_SURFACE at validation.
    const spec = fixtureWorld('garden5');
    spec.relics[0].supportingSurfaceId = 'bridge-east';
    const v = validateSpec(spec);
    expect(v.ok).toBe(false);
    expect(codes(v.issues)).toContain('OBJECT_NOT_ON_SURFACE');
    expect(v.issues.find((i) => i.code === 'OBJECT_NOT_ON_SURFACE')!.objectIds).toContain('relic-east');
  });

  it('an island at the bounds edge with a decoration poking outside is OUT_OF_BOUNDS, not a crash', () => {
    const spec = fixtureWorld('garden5');
    const east = spec.islands.find((i) => i.id === 'east')!;
    east.center = { x: 52, z: 0 };
    east.radius = 8; // rim at x = 60 exactly: inside; bridge from the centre island is 35 m, within limits
    spec.bridges = spec.bridges.filter((b) => b.id !== 'bridge-east');
    const r = applyPatch(spec, {
      summary: 'edge',
      ops: [
        { op: 'add_bridge', id: 'bridge-east', from: 'centre', to: 'east' },
        { op: 'move_decoration', id: 'rock-1', islandId: 'east', localPosition: { x: 7.5, z: 0 } }, // rock r0.8 reaches x = 60.3
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateSpec(r.spec);
    expect(v.ok).toBe(false);
    const oob = v.issues.filter((i) => i.code === 'OUT_OF_BOUNDS');
    expect(oob.map((i) => i.objectIds[0])).toEqual(['rock-1']);
    expect(oob[0].objectIds).toContain('rock-1');
    expect(codes(v.issues).filter((c) => c === 'OBJECT_NOT_ON_SURFACE')).toEqual(['OBJECT_NOT_ON_SURFACE']); // 7.5 + 0.8 > 8 too
    // Pull the rock back in: the edge island itself is fine and fully playable.
    const r2 = applyPatch(r.spec, { summary: 'back', ops: [{ op: 'move_decoration', id: 'rock-1', islandId: 'east', localPosition: { x: -1, z: 4 } }] });
    expect(r2.ok && validateSpec(r2.spec).ok).toBe(true);
    // An island whose disc crosses the bounds is OUT_OF_BOUNDS by itself.
    east.center = { x: 56, z: 0 };
    const v3 = validateSpec(spec);
    expect(v3.issues.filter((i) => i.code === 'OUT_OF_BOUNDS').map((i) => i.objectIds[0])).toEqual(['east']);
  });

  it('player on a removed bridge: on the endpoint they stand on the island; mid-bridge they are PLAYER_CUT_OFF', () => {
    const base = fixtureWorld('garden5');
    const r = applyPatch(base, { summary: 'drop east bridge', ops: [{ op: 'remove_bridge', id: 'bridge-east' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileWorld(r.spec);
    // Relic-east is already collected, so removing its bridge is otherwise legal.
    const ctx = { collectedRelicIds: ['relic-east'] };
    expect(validateSpec(r.spec, ctx).ok).toBe(true);
    // Exactly on the centre-side endpoint (9, 0): the island rim supports the player (closed disc), no cut-off.
    expect(c.supportAt(9, 0)).toBe('centre');
    const onRim = validateSpec(r.spec, { ...ctx, players: [{ id: 'p1', x: 9, z: 0, status: 'active', spawnId: 'spawn-0' }] });
    expect(onRim.issues).toEqual([]);
    // Exactly on the far endpoint (17, 0): supported by the now-isolated east island; the gate is unreachable.
    const farRim = validateSpec(r.spec, { ...ctx, players: [{ id: 'p1', x: 17, z: 0, status: 'active', spawnId: 'spawn-0' }] });
    expect(codes(farRim.issues)).toEqual(['PLAYER_CUT_OFF']);
    expect(farRim.issues[0].objectIds).toContain('gate');
    // Mid-bridge (13, 0): nothing under their feet and no walkable cell within the snap radius.
    expect(c.supportAt(13, 0)).toBeNull();
    const mid = validateSpec(r.spec, { ...ctx, players: [{ id: 'p1', x: 13, z: 0, status: 'active', spawnId: 'spawn-0' }] });
    expect(codes(mid.issues)).toEqual(['PLAYER_CUT_OFF']);
    // A falling/respawning player is judged from their spawn, which is still fine.
    const falling = validateSpec(r.spec, { ...ctx, players: [{ id: 'p1', x: 13, z: 0, status: 'falling', spawnId: 'spawn-0' }] });
    expect(falling.issues).toEqual([]);
  });
});

describe('stepMover under degenerate input', () => {
  const c = compileWorld(fixtureWorld('garden5'));

  it('dtMs 0 does not move; negative dtMs does not move backwards', () => {
    const m = createMover({ x: 0, z: 0 }, 0, c);
    for (const dt of [0, -50]) {
      const r = stepMover(c, m, { axes: { x: 1, z: 0 }, active: true }, dt, 33, { gateOpen: false, spawn });
      expect([r.mover.x, r.mover.z]).toEqual([0, 0]);
      expect(r.mover.status).toBe('active');
      expect(r.events).toEqual([]);
    }
  });

  it('NaN or Infinity axes, missing axes, and NaN dtMs are ignored and never produce NaN positions', () => {
    const m = createMover({ x: 0, z: 0 }, 0, c);
    const bad = [
      { axes: { x: NaN, z: 0 } }, { axes: { x: 0, z: Infinity } }, { axes: { x: NaN, z: NaN } },
      { axes: { x: 'a' as unknown as number, z: 0 } }, { axes: undefined as unknown as { x: number; z: number } },
    ];
    for (const b of bad) {
      const r = stepMover(c, m, { axes: b.axes, active: true }, TICK, 33, { gateOpen: false, spawn });
      expect(Number.isFinite(r.mover.x) && Number.isFinite(r.mover.z)).toBe(true);
      expect([r.mover.x, r.mover.z, r.mover.vx, r.mover.vz]).toEqual([0, 0, 0, 0]);
      expect(r.mover.status).toBe('active');
    }
    for (const dt of [NaN, Infinity, -Infinity]) {
      const r = stepMover(c, m, { axes: { x: 1, z: 0 }, active: true }, dt, 33, { gateOpen: false, spawn });
      expect(Number.isFinite(r.mover.x) && Number.isFinite(r.mover.z)).toBe(true);
      expect(r.mover.status).toBe('active');
      expect(c.supportAt(r.mover.x, r.mover.z)).toBe('centre');
    }
  });

  it('a huge dtMs is clamped: the player stays on a surface or falls at the edge, never teleports across the hazard', () => {
    // From the centre island heading east, a 100 s step at 4.5 m/s would be 450 m without the clamp.
    const m = createMover({ x: 0, z: 0 }, 0, c);
    const r = stepMover(c, m, { axes: { x: 1, z: 0 }, active: true }, 100_000, 33, { gateOpen: false, spawn });
    expect(Math.abs(r.mover.x)).toBeLessThanOrEqual(WORLD_LIMITS.bounds.halfExtent);
    expect(r.mover.x).toBeLessThanOrEqual(0.25 * GEOMETRY.playerSpeed + 1e-9);
    expect(r.mover.status).toBe('active');
    expect(r.mover.supportId).toBe('centre');
    // From a bridge heading sideways, a long step falls just past the bridge edge (half-width 1.2 m, sub-steps of 0.2 m)
    // instead of landing somewhere else.
    const onBridge = createMover({ x: 13, z: 0.5 }, 0, c);
    const rb = stepMover(c, onBridge, { axes: { x: 0, z: 1 }, active: true }, 10_000, 33, { gateOpen: false, spawn });
    expect(rb.mover.status).toBe('falling');
    expect(rb.events).toEqual(['fell']);
    expect(rb.mover.z).toBeGreaterThan(1.2);
    expect(rb.mover.z).toBeLessThanOrEqual(1.4 + 1e-9); // not 45 m away
    expect(rb.mover.supportId).toBeNull();
  });

  it('cannot tunnel through a 0.3 m lantern at full speed with 33 ms ticks, nor with one bunched 250 ms step', () => {
    // lantern-1 sits at temple-local (3, 3) = world (3, 31); block radius 0.3 + 0.45 = 0.75.
    const start = createMover({ x: 3, z: 29 }, 0, c);
    let m = start;
    for (let i = 0; i < 60; i++) m = stepMover(c, m, { axes: { x: 0, z: 1 }, active: true }, TICK, i * TICK, { gateOpen: true, spawn }).mover;
    expect(m.z).toBeLessThanOrEqual(31 - 0.75 + 1e-9);
    expect(m.status).toBe('active');
    expect(m.vx === 0 && m.vz === 0).toBe(true);
    for (const dt of [250, 1000, 60_000]) {
      const r = stepMover(c, start, { axes: { x: 0, z: 1 }, active: true }, dt, 33, { gateOpen: true, spawn });
      expect(r.mover.z, `dt ${dt}`).toBeLessThanOrEqual(31 - 0.75 + 1e-9);
      expect(r.mover.status).toBe('active');
    }
  });

  it('cannot skip over a bridge end: walking off the end of bridge-east onto the island, or off the side, is exact', () => {
    // Walk the full bridge-east (x 9 -> 17) at 30 Hz; every step is supported by centre, the bridge or east.
    let m = createMover({ x: 8, z: 0 }, 0, c);
    const supports = new Set<string | null>();
    for (let i = 0; i < 90; i++) {
      m = stepMover(c, m, { axes: { x: 1, z: 0 }, active: true }, TICK, i * TICK, { gateOpen: false, spawn }).mover;
      supports.add(m.supportId);
      if (m.status !== 'active') break;
    }
    expect(m.status).toBe('active');
    expect([...supports]).toEqual(['centre', 'bridge-east', 'east']);
    // One 2 s step along the bridge is clamped to 250 ms: still on the bridge, never beyond the east island.
    const r = stepMover(c, createMover({ x: 10, z: 0 }, 0, c), { axes: { x: 1, z: 0 }, active: true }, 2000, 33, { gateOpen: false, spawn });
    expect(r.mover.supportId).toBe('bridge-east');
    expect(r.mover.x).toBeCloseTo(10 + 0.25 * GEOMETRY.playerSpeed, 6);
  });
});

describe('expandDraft against hostile drafts', () => {
  function draft(): Record<string, unknown> {
    return {
      title: 'Draft',
      islands: [
        { id: 'a', name: 'A', center: { x: 0, z: 0 }, radius: 9 },
        { id: 'b', name: 'B', center: { x: 24, z: 0 }, radius: 7 },
        { id: 'c', name: 'C', center: { x: -24, z: 0 }, radius: 7 },
        { id: 'd', name: 'D', center: { x: 0, z: 26 }, radius: 7 },
      ],
      bridges: [
        { id: 'ab', from: 'a', to: 'b', width: 2.4 },
        { id: 'ac', from: 'a', to: 'c', width: 2.4 },
        { id: 'ad', from: 'a', to: 'd', width: 2.4 },
      ],
      spawns: [{ islandId: 'a', localPosition: { x: -2, z: -2 } }, { islandId: 'a', localPosition: { x: 2, z: -2 } }],
      relics: [
        { id: 'r1', name: 'R1', islandId: 'b', localPosition: { x: 2, z: 0 } },
        { id: 'r2', name: 'R2', islandId: 'c', localPosition: { x: -2, z: 0 } },
        { id: 'r3', name: 'R3', islandId: 'a', localPosition: { x: 0, z: 4 } },
      ],
      gate: { islandId: 'd', localPosition: { x: 0, z: -4 } },
      hazard: 'water',
      decorations: [{ id: 'dec1', type: 'tree', islandId: 'b', localPosition: { x: -2, z: 3 } }],
    };
  }

  it('the baseline draft expands and validates', () => {
    const r = expandDraft(draft(), { seed: 7, worldId: 'w' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(validateSpec(r.spec).issues).toEqual([]);
  });

  it('duplicate relic ids (and ids colliding with derived gate/spawn ids) are DUPLICATE_ID at expansion', () => {
    const d = draft() as { relics: { id: string }[]; decorations: { id: string }[] };
    d.relics[1].id = 'r1';
    const r = expandDraft(d, { seed: 7, worldId: 'w' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codes(r.issues)).toEqual(['DUPLICATE_ID']);
      expect(r.issues[0].objectIds).toEqual(['r1']);
    }
    const d2 = draft() as { decorations: { id: string }[] };
    d2.decorations[0].id = 'gate';
    const r2 = expandDraft(d2, { seed: 7, worldId: 'w' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues.map((i) => i.objectIds[0])).toEqual(['gate']);
  });

  it('gate on an island with no bridge expands fine and fails validation with DISCONNECTED_GOAL', () => {
    const d = draft() as { bridges: { id: string }[] };
    d.bridges = d.bridges.filter((b) => b.id !== 'ad');
    const r = expandDraft(d, { seed: 7, worldId: 'w' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateSpec(r.spec);
    expect(v.ok).toBe(false);
    expect(codes(v.issues)).toEqual(['DISCONNECTED_GOAL']);
  });

  it('references to unknown islands from bridges, spawns, relics, gate and decorations are INVALID_REFERENCE', () => {
    const d = draft() as Record<string, any>;
    d.bridges[0].to = 'nope';
    d.spawns[1].islandId = 'ghost';
    d.relics[2].islandId = 'void';
    d.gate.islandId = 'nowhere';
    d.decorations[0].islandId = 'x';
    const r = expandDraft(d, { seed: 7, worldId: 'w' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(new Set(codes(r.issues))).toEqual(new Set(['INVALID_REFERENCE']));
    const bad = r.issues.flatMap((i) => i.objectIds);
    for (const id of ['nope', 'ghost', 'void', 'nowhere', 'x']) expect(bad).toContain(id);
  });
});

describe('scale, reachability and digests', () => {
  it('validateSpec with 8 islands and 16 valid bridges completes under 100 ms', () => {
    const spec = fixtureWorld('garden5');
    spec.islands.push(
      { id: 'ne', center: { x: 30, z: 30 }, radius: 7, topElevation: 0 },
      { id: 'nw', center: { x: -30, z: 30 }, radius: 7, topElevation: 0 },
      { id: 'se', center: { x: 30, z: -30 }, radius: 7, topElevation: 0 },
    );
    const pairs: [string, string][] = [
      ['east', 'ne'], ['west', 'nw'], ['south', 'se'], ['east', 'se'], ['temple', 'ne'], ['temple', 'nw'],
      ['west', 'south'], ['east', 'south'], ['centre', 'ne'], ['centre', 'nw'], ['centre', 'se'], ['west', 'temple'],
    ];
    const r = applyPatch(spec, { summary: 'dense', ops: pairs.map(([from, to], i) => ({ op: 'add_bridge' as const, id: `b${i}`, from, to })) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.islands).toHaveLength(WORLD_LIMITS.islands.max);
    expect(r.spec.bridges).toHaveLength(WORLD_LIMITS.bridges.max);
    validateSpec(r.spec); // warm
    const t0 = performance.now();
    const v = validateSpec(r.spec);
    const ms = performance.now() - t0;
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(ms).toBeLessThan(100);
  });

  it('garden5 temple interior is reachable only with the gate open; the trigger is reachable either way', () => {
    const c = compileWorld(fixtureWorld('garden5'));
    const from = { x: -2, z: -2 };
    const templeCentre = { x: 0, z: 28 };
    const gate = { x: 0, z: 20.5 };
    expect(reachable(c, from, templeCentre, { gateOpen: false }).reachable).toBe(false);
    const open = reachable(c, from, templeCentre, { gateOpen: true });
    expect(open.reachable).toBe(true);
    expect(open.path!.some((p) => c.nav.gateCells[c.nav.indexOf(p.x, p.z)] === 1)).toBe(true);
    expect(reachable(c, from, gate, { gateOpen: false, goalRadius: GEOMETRY.gateTriggerRadius }).reachable).toBe(true);
    expect(reachable(c, from, gate, { gateOpen: true, goalRadius: GEOMETRY.gateTriggerRadius }).reachable).toBe(true);
    // Starting inside the sealed temple with the gate locked: a walkable start exists but nothing outside is reached.
    const out = reachable(c, templeCentre, from, { gateOpen: false });
    expect(out.reachable).toBe(false);
    expect(out.cells).toBeGreaterThan(0);
  });

  it('structuralDigest ignores a decoration rotation change but changes when a decoration moves', () => {
    const base = fixtureWorld('garden5');
    const d0 = compileWorld(base).structuralDigest;
    const rotated = fixtureWorld('garden5');
    rotated.decorations[0].rotationDeg = 275;
    expect(compileWorld(rotated).structuralDigest).toBe(d0);
    const retitled = applyPatch(base, { summary: 't', ops: [{ op: 'set_title', title: 'other' }] });
    expect(retitled.ok && compileWorld(retitled.spec).structuralDigest).toBe(d0);
    const moved = applyPatch(base, { summary: 'm', ops: [{ op: 'move_decoration', id: 'tree-1', islandId: 'centre', localPosition: { x: 5, z: 4.5 } }] });
    expect(moved.ok && compileWorld(moved.spec).structuralDigest).not.toBe(d0);
    const scaled = fixtureWorld('garden5');
    scaled.decorations[0].scale = 1.5;
    expect(compileWorld(scaled).structuralDigest).not.toBe(d0);
  });
});
