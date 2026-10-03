// Case 1: schema rejections and DUPLICATE_ID. Owner: world package.
import { describe, expect, it } from 'vitest';
import { PatchDraftSchema, WORLD_LIMITS, WorldSpecSchema, type WorldSpec } from '@beetle/contracts';
import { applyPatch, fixtureWorld, validateSpec } from '@beetle/world';

const base = (): WorldSpec => fixtureWorld('garden5');

function expectReject(spec: unknown, pathHint: string): void {
  const r = WorldSpecSchema.safeParse(spec);
  expect(r.success, `expected rejection for ${pathHint}`).toBe(false);
  if (!r.success) {
    // zod reports an unknown key at the parent path with the key names in `keys`, so match either.
    const mentions = r.error.issues.map((i) => [i.path.join('.'), ...((i as { keys?: string[] }).keys ?? [])].join('.'));
    expect(mentions.some((m) => m.includes(pathHint)), `issue should mention ${pathHint}; got ${mentions.join(' | ')}`).toBe(true);
  }
}

describe('case 1: WorldSpecSchema rejections', () => {
  it('accepts the garden5 fixture', () => {
    expect(WorldSpecSchema.safeParse(base()).success).toBe(true);
  });

  it('rejects NaN and Infinity coordinates', () => {
    const nan = base();
    nan.islands[0].center.x = Number.NaN;
    expectReject(nan, 'islands.0.center.x');
    const inf = base();
    inf.bridges[0].endpoints[1].point.z = Number.POSITIVE_INFINITY;
    expectReject(inf, 'bridges.0.endpoints.1.point.z');
    const negInf = base();
    negInf.relics[0].localPosition.x = Number.NEGATIVE_INFINITY;
    expectReject(negInf, 'relics.0.localPosition.x');
    const v = validateSpec(nan);
    expect(v.ok).toBe(false);
    expect(v.issues.every((i) => i.code === 'INVALID_SCHEMA')).toBe(true);
  });

  it('rejects 25 islands', () => {
    const s = base();
    for (let i = 0; s.islands.length < WORLD_LIMITS.islands.max + 1; i++) s.islands.push({ id: `extra-${i}`, center: { x: -50 + (i % 6) * 20, z: i < 6 ? 50 : -50 }, radius: 4, topElevation: 0 });
    expect(s.islands.length).toBe(25);
    expectReject(s, 'islands');
    s.islands.pop();
    expect(WorldSpecSchema.safeParse(s).success).toBe(true);
  });

  it('rejects 49 bridges', () => {
    const s = base();
    while (s.bridges.length < WORLD_LIMITS.bridges.max + 1) {
      const n = s.bridges.length;
      s.bridges.push({ id: `b-${n}`, endpoints: [{ islandId: 'centre', point: { x: 0, z: 9 } }, { islandId: 'temple', point: { x: 0, z: 20 } }], width: 2.4 });
    }
    expect(s.bridges.length).toBe(49);
    expectReject(s, 'bridges');
    s.bridges.pop();
    expect(WorldSpecSchema.safeParse(s).success).toBe(true);
  });

  it('accepts 2 islands (both spawns sharing one) and rejects 1', () => {
    const two = fixtureWorld('seed2');
    expect(two.islands).toHaveLength(2);
    expect(WorldSpecSchema.safeParse(two).success).toBe(true);
    expect(validateSpec(two).ok).toBe(true);
    const one = fixtureWorld('seed2');
    one.islands = one.islands.slice(0, 1);
    expectReject(one, 'islands');
  });

  it('rejects 3 spawns', () => {
    const s = base();
    s.spawns.push({ id: 'spawn-2', supportingSurfaceId: 'centre', localPosition: { x: 0, z: 0 }, playerSlot: 0 });
    expectReject(s, 'spawns');
  });

  it('rejects unknown properties at every level', () => {
    const top = { ...base(), surprise: true };
    expectReject(top, 'surprise');
    const nested = base() as unknown as { islands: Record<string, unknown>[] };
    nested.islands[0].elevation = 3;
    expectReject(nested, 'islands.0.elevation');
  });

  it('rejects bad ids', () => {
    for (const bad of ['Bad', '1abc', 'has space', 'a'.repeat(33), '', 'ünï']) {
      const s = base();
      s.relics[0].id = bad;
      expectReject(s, 'relics.0.id');
    }
  });

  it('rejects an unknown patch op in the schema and in applyPatch', () => {
    const draft = { summary: 'teleport', ops: [{ op: 'teleport', id: 'relic-east' }] };
    expect(PatchDraftSchema.safeParse(draft).success).toBe(false);
    const r = applyPatch(base(), draft as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].code).toBe('UNKNOWN_OPERATION');
  });

  it('validator reports DUPLICATE_ID across object kinds', () => {
    const s = base();
    s.relics[0].id = 'east'; // same id as an island
    s.gate.requiredRelicIds = ['east', 'relic-west', 'relic-south'];
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    const dup = r.issues.find((i) => i.code === 'DUPLICATE_ID');
    expect(dup).toBeDefined();
    expect(dup!.objectIds).toContain('east');
    expect(dup!.evidence).toMatchObject({ kinds: ['island', 'relic'] });
  });
});
