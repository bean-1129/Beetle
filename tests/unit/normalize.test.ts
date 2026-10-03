import { describe, expect, it } from 'vitest';
import { applyPatch, expandDraft, fixtureWorld, normalizeDraft, resolveIslandRef, validateSpec } from '@beetle/world';

const spec = fixtureWorld('garden5');

describe('model output normalization', () => {
  it('resolves island references by display name, stripped id and compass direction', () => {
    expect(resolveIslandRef(spec.islands, 'centre')).toBe('centre');
    expect(resolveIslandRef(spec.islands, 'Hearth Island')).toBe('centre');
    expect(resolveIslandRef(spec.islands, 'hearth-island')).toBe('centre');
    expect(resolveIslandRef(spec.islands, 'temple-island')).toBe('temple');
    expect(resolveIslandRef(spec.islands, 'northern island')).toBe('temple');
    expect(resolveIslandRef(spec.islands, 'the north isle')).toBe('temple');
    expect(resolveIslandRef(spec.islands, 'nowhere-at-all')).toBeUndefined();
  });

  it('applyPatch accepts a model patch that names islands instead of ids and records the normalization', () => {
    const r = applyPatch(spec, { summary: 'lava and a new crossing', ops: [
      { op: 'set_hazard', kind: 'lava' },
      { op: 'add_bridge', id: 'bridge-northern', from: 'hearth-island', to: 'temple-island' },
    ] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.hazard.kind).toBe('lava');
    const b = r.spec.bridges.find((x) => x.id === 'bridge-northern');
    expect(b?.endpoints.map((e) => e.islandId).sort()).toEqual(['centre', 'temple']);
    expect(r.normalizations.length).toBe(2);
    expect(validateSpec(r.spec).ok).toBe(true);
  });

  it('leaves ambiguous references alone so the validator reports INVALID_REFERENCE', () => {
    const r = applyPatch(spec, { summary: 'x', ops: [{ op: 'add_bridge', id: 'b-x', from: 'centre', to: 'island' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].code).toBe('INVALID_REFERENCE');
  });

  it('expandDraft converts world coordinates and over-radius offsets into island offsets', () => {
    const draft = {
      title: 'Normalized', hazard: 'water',
      islands: [
        { id: 'a', name: 'Hearth', center: { x: 0, z: 0 }, radius: 9 },
        { id: 'b', name: 'Temple', center: { x: 0, z: 26 }, radius: 8 },
        { id: 'c', name: 'East', center: { x: 24, z: 0 }, radius: 7 },
        { id: 'd', name: 'West', center: { x: -24, z: 0 }, radius: 7 },
      ],
      bridges: [
        { id: 'ab', from: 'Hearth', to: 'Temple', width: 2.4 },
        { id: 'ac', from: 'a', to: 'east', width: 9 },
        { id: 'ad', from: 'a', to: 'western island', width: 2 },
      ],
      spawns: [{ islandId: 'a', localPosition: { x: 1, z: 1 } }, { islandId: 'a', localPosition: { x: -1, z: 1 } }],
      relics: [
        { id: 'r1', name: 'Sun', islandId: 'c', localPosition: { x: 24, z: 0 } },
        { id: 'r2', name: 'Moon', islandId: 'd', localPosition: { x: 30, z: 0 } },
        { id: 'r3', name: 'Star', islandId: 'b', localPosition: { x: 0, z: 2 } },
      ],
      gate: { islandId: 'b', localPosition: { x: 0, z: 30 } },
      decorations: [{ id: 'tree-1', type: 'tree', islandId: 'a', localPosition: { x: 40, z: 40 } }],
    };
    const n = normalizeDraft(draft);
    expect(n.normalizations.length).toBeGreaterThanOrEqual(5);
    const r = expandDraft(draft, { seed: 7, worldId: 'norm-test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.bridges.every((b) => b.width <= 4)).toBe(true);
    for (const rel of r.spec.relics) expect(Math.hypot(rel.localPosition.x, rel.localPosition.z)).toBeLessThan(9);
    expect(validateSpec(r.spec).ok).toBe(true);
  });

  it('expandDraft separates overlapping islands so the draft validates, keeping ids and bridges', () => {
    const draft = {
      title: 'Crowded', hazard: 'water',
      islands: [
        { id: 'a', name: 'Hearth', center: { x: 0, z: 0 }, radius: 9 },
        { id: 'b', name: 'Temple', center: { x: 0, z: 12 }, radius: 8 },   // overlaps a by 6 m
        { id: 'c', name: 'East', center: { x: 14, z: 0 }, radius: 7 },     // overlaps a by 3 m
        { id: 'd', name: 'West', center: { x: -24, z: 0 }, radius: 7 },
        { id: 'e', name: 'South', center: { x: 0, z: -22 }, radius: 6 },
      ],
      bridges: [
        { id: 'ab', from: 'a', to: 'b', width: 2.4 }, { id: 'ac', from: 'a', to: 'c', width: 2.4 },
        { id: 'ad', from: 'a', to: 'd', width: 2.4 }, { id: 'ae', from: 'a', to: 'e', width: 1.6 },
      ],
      spawns: [{ islandId: 'a', localPosition: { x: 1, z: 1 } }, { islandId: 'a', localPosition: { x: -1, z: 1 } }],
      relics: [
        { id: 'r1', name: 'Sun', islandId: 'c', localPosition: { x: 0, z: 0 } },
        { id: 'r2', name: 'Moon', islandId: 'd', localPosition: { x: 0, z: 0 } },
        { id: 'r3', name: 'Star', islandId: 'e', localPosition: { x: 0, z: 0 } },
      ],
      gate: { islandId: 'b', localPosition: { x: 0, z: 2 } },
      decorations: [],
    };
    const r = expandDraft(draft, { seed: 3, worldId: 'crowded' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.normalizations.some((n) => n.reason.includes('apart'))).toBe(true);
    const v = validateSpec(r.spec);
    expect(v.issues.map((i) => i.code)).not.toContain('ISLAND_OVERLAP');
    expect(v.ok).toBe(true);
  });
});
