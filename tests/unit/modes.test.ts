// Game-mode expansion: mode fixtures, MODE_INVALID rules, set_mode/set_biome/set_movement patches, draft mode and biome
// words, movement speed through effectiveSpeed, and the session summary's mode and biome fields. Owner: world package.
import { describe, expect, it } from 'vitest';
import { MODE_LIMITS, SIMULATION, effectiveMode, effectiveSpeed, type PlayerState, type WorldSpec } from '@beetle/contracts';
import {
  FIXTURE_NAMES, applyPatch, buildSessionSummary, compileWorld, createMover, expandDraft, fixtureWorld, normalizeDraft,
  resolveBiome, resolveModeKind, runPlayabilityChecks, stepMover, validateSpec,
} from '@beetle/world';

const TICK = 1000 / SIMULATION.tickHz;
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

function draftBase(): Record<string, unknown> {
  return {
    title: 'Mode draft', hazard: 'water',
    islands: [
      { id: 'a', name: 'Hearth', center: { x: 0, z: 0 }, radius: 9 },
      { id: 'b', name: 'Temple', center: { x: 0, z: 26 }, radius: 8 },
      { id: 'c', name: 'East', center: { x: 24, z: 0 }, radius: 7 },
      { id: 'd', name: 'West', center: { x: -24, z: 0 }, radius: 7 },
    ],
    bridges: [
      { id: 'ab', from: 'a', to: 'b', width: 2.4 },
      { id: 'ac', from: 'a', to: 'c', width: 2.4 },
      { id: 'ad', from: 'a', to: 'd', width: 2.4 },
    ],
    spawns: [{ islandId: 'a', localPosition: { x: 1, z: -1 } }, { islandId: 'a', localPosition: { x: -1, z: -1 } }],
    relics: [
      { id: 'r1', name: 'Sun', islandId: 'c', localPosition: { x: 1, z: 0 } },
      { id: 'r2', name: 'Moon', islandId: 'd', localPosition: { x: -1, z: 0 } },
      { id: 'r3', name: 'Star', islandId: 'a', localPosition: { x: 0, z: 4 } },
    ],
    gate: { islandId: 'b', localPosition: { x: 0, z: 0 } },
    decorations: [{ id: 'tree-1', type: 'tree', islandId: 'a', localPosition: { x: 5, z: -5 } }],
  };
}

function player(id: string, x: number, z: number): PlayerState {
  return {
    id, slot: 0, label: 'Amber', color: '#ffb347', x, z, y: 0, vx: 0, vz: 0, facingDeg: 0, status: 'active', connected: true,
    lastInputSeq: 0, lastInputAtMs: 0, supportId: null, respawns: 0, lavaFalls: 0,
  };
}

describe('mode fixtures', () => {
  const expected: Record<string, { kind: string; biome: string; hazard: string }> = {
    race5: { kind: 'checkpoint_race', biome: 'garden', hazard: 'water' },
    hill4: { kind: 'king_of_the_hill', biome: 'frost', hazard: 'water' },
    survival5: { kind: 'survival', biome: 'volcanic', hazard: 'lava' },
    trial5: { kind: 'time_trial', biome: 'desert', hazard: 'water' },
  };

  for (const [name, want] of Object.entries(expected)) {
    it(`${name} validates, is playable and carries ${want.kind} in the ${want.biome} biome`, () => {
      expect(FIXTURE_NAMES).toContain(name);
      const spec = fixtureWorld(name as 'race5');
      expect(spec.worldId).toBe(name);
      expect(spec.biome).toBe(want.biome);
      expect(spec.hazard.kind).toBe(want.hazard);
      expect(spec.mode?.kind).toBe(want.kind);
      const v = validateSpec(spec);
      expect(v.issues).toEqual([]);
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      const p = runPlayabilityChecks(v.compiled);
      expect(p.checks.filter((c) => !c.ok)).toEqual([]);
      expect(p.ok).toBe(true);
    });
  }

  it('race5 is an ordered three-checkpoint loop with a 90 s limit', () => {
    const spec = fixtureWorld('race5');
    const m = effectiveMode(spec);
    expect(m).toMatchObject({ kind: 'checkpoint_race', orderedCheckpoints: true, timeLimitSec: 90, relicsRequired: 3 });
    expect(spec.islands.length).toBe(5);
    expect(spec.relics.map((r) => r.supportingSurfaceId)).toEqual(['marker-1', 'marker-2', 'marker-3']);
    // Loop: each marker island and the finish have two loop bridges, so every checkpoint has an alternative route.
    const degree = (id: string) => spec.bridges.filter((b) => b.endpoints.some((e) => e.islandId === id)).length;
    expect(degree('marker-2')).toBe(2);
    expect(degree('marker-3')).toBe(2);
    expect(degree('finish')).toBe(2);
    expect(degree('marker-1')).toBe(3);
  });

  it('hill4 holds for 10 s on four frost islands; survival5 rises after 20 s; trial5 is a 60 s desert dash', () => {
    const hill = fixtureWorld('hill4');
    expect(hill.islands.length).toBe(4);
    expect(effectiveMode(hill)).toMatchObject({ kind: 'king_of_the_hill', holdSeconds: 10, timeLimitSec: null });

    const surv = fixtureWorld('survival5');
    expect(surv.hazard.rise).toEqual({ afterSec: 20, metersPerSec: 0.05, maxElevation: -0.7 });
    expect(effectiveMode(surv)).toMatchObject({ kind: 'survival', timeLimitSec: 120 });

    const trial = fixtureWorld('trial5');
    expect(effectiveMode(trial)).toMatchObject({ kind: 'time_trial', timeLimitSec: 60 });
    expect(effectiveSpeed(trial)).toBe(5.5);
  });

  it('garden5 is unchanged: no mode, no movement override, garden biome, relic_hunt defaults', () => {
    const spec = fixtureWorld('garden5');
    expect(spec.mode).toBeUndefined();
    expect(spec.movement).toBeUndefined();
    expect(spec.biome).toBe('garden');
    expect(spec.hazard.rise).toBeUndefined();
    expect(effectiveMode(spec)).toEqual({ kind: 'relic_hunt', relicsRequired: 3, orderedCheckpoints: false, timeLimitSec: null, holdSeconds: MODE_LIMITS.holdSeconds.default });
    expect(effectiveSpeed(spec)).toBe(MODE_LIMITS.movementSpeed.default);
    expect(validateSpec(spec).ok).toBe(true);
  });

  it('every fixture name round-trips through fixtureWorld with a matching worldId', () => {
    for (const name of FIXTURE_NAMES) expect(fixtureWorld(name).worldId).toBe(name);
  });
});

describe('MODE_INVALID', () => {
  it('survival without hazard.rise is MODE_INVALID; adding a rise fixes it', () => {
    const spec: WorldSpec = { ...fixtureWorld('garden5'), mode: { kind: 'survival', timeLimitSec: 90 } };
    const bad = validateSpec(spec);
    expect(bad.ok).toBe(false);
    expect(codes(bad)).toEqual(['MODE_INVALID']);
    expect(bad.issues[0].objectIds).toContain('hazard');
    const good = validateSpec({ ...spec, hazard: { ...spec.hazard, rise: { afterSec: 10, metersPerSec: 0.1, maxElevation: -1 } } });
    expect(good.ok).toBe(true);
  });

  it('survival rise maxElevation above -0.6 (or below the plane) is rejected', () => {
    const spec: WorldSpec = { ...fixtureWorld('garden5'), mode: { kind: 'survival' } };
    const high = validateSpec({ ...spec, hazard: { ...spec.hazard, rise: { afterSec: 10, metersPerSec: 0.1, maxElevation: -0.3 } } });
    expect(high.ok).toBe(false);
    expect(codes(high)).toContain('INVALID_SCHEMA');
    // At the plane itself the hazard would never rise: MODE_INVALID (schema allows -2 .. -0.6; plane is -2.5 by default,
    // so lift the plane to meet the rise ceiling).
    const flat = validateSpec({ ...spec, hazard: { ...spec.hazard, planeElevation: -2, rise: { afterSec: 10, metersPerSec: 0.1, maxElevation: -2 } } });
    expect(flat.ok).toBe(false);
    expect(codes(flat)).toEqual(['MODE_INVALID']);
  });

  it('relicsRequired above the relic count cannot pass: the schema caps it at the relic limit and set_mode refuses it', () => {
    const base = fixtureWorld('garden5');
    expect(validateSpec({ ...base, mode: { kind: 'relic_hunt', relicsRequired: 3 } }).ok).toBe(true);
    const over = validateSpec({ ...base, mode: { kind: 'relic_hunt', relicsRequired: 4 } });
    expect(over.ok).toBe(false);
    expect(codes(over)).toContain('INVALID_SCHEMA');
    // A world with fewer relics than relicsRequired is reported by applyPatch as MODE_INVALID before validation.
    const fewer = { ...base, relics: base.relics.slice(0, 2) } as unknown as WorldSpec;
    const r = applyPatch(fewer, { summary: 'needs three', ops: [{ op: 'set_mode', mode: { kind: 'relic_hunt', relicsRequired: 3 } }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(codes(r)).toEqual(['MODE_INVALID']);
  });

  it('checkpoint_race on three ordered relics is fine; a lone relic would be MODE_INVALID', () => {
    const spec: WorldSpec = { ...fixtureWorld('garden5'), mode: { kind: 'checkpoint_race', orderedCheckpoints: true, timeLimitSec: 60 } };
    expect(validateSpec(spec).ok).toBe(true);
    expect(effectiveMode(spec).orderedCheckpoints).toBe(true);
    expect(effectiveMode({ ...spec, mode: { kind: 'checkpoint_race' } }).orderedCheckpoints).toBe(true);
  });

  it('time_trial without a timeLimitSec validates and takes the default limit', () => {
    const spec: WorldSpec = { ...fixtureWorld('garden5'), mode: { kind: 'time_trial' } };
    expect(validateSpec(spec).ok).toBe(true);
    expect(effectiveMode(spec).timeLimitSec).toBe(MODE_LIMITS.timeLimitSec.default);
    expect(effectiveMode({ ...spec, mode: { kind: 'king_of_the_hill' } }).timeLimitSec).toBeNull();
  });

  it('king_of_the_hill, time_trial and survival still need the gate reachable (DISCONNECTED_GOAL)', () => {
    const stranded = fixtureWorld('garden4-no-temple-bridge');
    const rise = { afterSec: 10, metersPerSec: 0.1, maxElevation: -1 };
    for (const mode of [{ kind: 'king_of_the_hill' as const }, { kind: 'time_trial' as const, timeLimitSec: 60 }, { kind: 'survival' as const }]) {
      const spec: WorldSpec = { ...stranded, mode, hazard: { ...stranded.hazard, rise } };
      const v = validateSpec(spec);
      expect(v.ok).toBe(false);
      expect(codes(v)).toContain('DISCONNECTED_GOAL');
      expect(codes(v)).not.toContain('MODE_INVALID');
    }
  });
});

describe('set_mode, set_biome and set_movement patches', () => {
  const base = fixtureWorld('garden5');

  it('set_mode applies, reports the changed id and validates', () => {
    const r = applyPatch(base, { summary: 'race', ops: [{ op: 'set_mode', mode: { kind: 'checkpoint_race', timeLimitSec: 75, orderedCheckpoints: true } }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.mode).toEqual({ kind: 'checkpoint_race', timeLimitSec: 75, orderedCheckpoints: true });
    expect(r.changedIds).toEqual(['mode']);
    expect(base.mode).toBeUndefined(); // base untouched
    expect(validateSpec(r.spec).ok).toBe(true);
  });

  it('set_mode with a mode word and out-of-range numbers is normalized and recorded', () => {
    const r = applyPatch(base, { summary: 'hold the hill', ops: [{ op: 'set_mode', mode: { kind: 'king of the hill', holdSeconds: 200 } as never }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.mode).toEqual({ kind: 'king_of_the_hill', holdSeconds: MODE_LIMITS.holdSeconds.max });
    expect(r.normalizations.map((n) => n.path).sort()).toEqual(['ops[0].mode.holdSeconds', 'ops[0].mode.kind']);
    expect(validateSpec(r.spec).ok).toBe(true);

    const s = applyPatch(base, { summary: 'sprint', ops: [{ op: 'set_mode', mode: 'a quick sprint' as never }] });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.spec.mode).toEqual({ kind: 'time_trial' });
    expect(effectiveMode(s.spec).timeLimitSec).toBe(MODE_LIMITS.timeLimitSec.default);
  });

  it('set_mode survival applies but the world then fails validation until a rise exists', () => {
    const r = applyPatch(base, { summary: 'survive', ops: [{ op: 'set_mode', mode: { kind: 'survival', timeLimitSec: 100 } }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateSpec(r.spec);
    expect(v.ok).toBe(false);
    expect(codes(v)).toEqual(['MODE_INVALID']);
  });

  it('set_biome applies exact and fuzzy biome words and validates', () => {
    const r = applyPatch(base, { summary: 'frost', ops: [{ op: 'set_biome', biome: 'frost' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.biome).toBe('frost');
    expect(r.changedIds).toEqual(['biome']);
    expect(validateSpec(r.spec).ok).toBe(true);

    const fuzzy = applyPatch(base, { summary: 'moonlit', ops: [{ op: 'set_biome', biome: 'a moonlit sky' as never }] });
    expect(fuzzy.ok).toBe(true);
    if (!fuzzy.ok) return;
    expect(fuzzy.spec.biome).toBe('night');
    expect(fuzzy.normalizations[0]).toMatchObject({ path: 'ops[0].biome', from: 'a moonlit sky', to: 'night' });

    const unknown = applyPatch(base, { summary: 'nonsense', ops: [{ op: 'set_biome', biome: 'plaid' as never }] });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(codes(unknown)).toContain('INVALID_SCHEMA');
  });

  it('set_movement applies, clamps into MODE_LIMITS and validates', () => {
    const r = applyPatch(base, { summary: 'faster', ops: [{ op: 'set_movement', speed: 6 }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.movement).toEqual({ speed: 6 });
    expect(effectiveSpeed(r.spec)).toBe(6);
    expect(r.changedIds).toEqual(['movement']);
    expect(validateSpec(r.spec).ok).toBe(true);

    const fast = applyPatch(base, { summary: 'too fast', ops: [{ op: 'set_movement', speed: 12 }] });
    expect(fast.ok).toBe(true);
    if (!fast.ok) return;
    expect(fast.spec.movement?.speed).toBe(MODE_LIMITS.movementSpeed.max);
    expect(fast.normalizations[0]).toMatchObject({ path: 'ops[0].speed', from: 12, to: MODE_LIMITS.movementSpeed.max });
  });

  it('one patch can switch mode, biome and speed together', () => {
    const r = applyPatch(base, { summary: 'survival on lava', ops: [
      { op: 'set_hazard', kind: 'lava' },
      { op: 'set_biome', biome: 'volcanic' },
      { op: 'set_movement', speed: 5 },
      { op: 'set_mode', mode: { kind: 'time_trial', timeLimitSec: 45 } },
    ] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changedIds).toEqual(['hazard', 'biome', 'movement', 'mode']);
    expect(r.spec).toMatchObject({ biome: 'volcanic', movement: { speed: 5 }, mode: { kind: 'time_trial', timeLimitSec: 45 }, hazard: { kind: 'lava' } });
    expect(validateSpec(r.spec).ok).toBe(true);
  });
});

describe('expandDraft mode, biome, speed and rise', () => {
  it('resolves mode words to the closest game mode', () => {
    expect(resolveModeKind('checkpoint_race')).toBe('checkpoint_race');
    expect(resolveModeKind('a race around the islands')).toBe('checkpoint_race');
    expect(resolveModeKind('Checkpoint')).toBe('checkpoint_race');
    expect(resolveModeKind('king of the hill')).toBe('king_of_the_hill');
    expect(resolveModeKind('hold the zone')).toBe('king_of_the_hill');
    expect(resolveModeKind('hill')).toBe('king_of_the_hill');
    expect(resolveModeKind('time trial')).toBe('time_trial');
    expect(resolveModeKind('sprint')).toBe('time_trial');
    expect(resolveModeKind('timed')).toBe('time_trial');
    expect(resolveModeKind('survive')).toBe('survival');
    expect(resolveModeKind('Survival')).toBe('survival');
    expect(resolveModeKind('rising lava')).toBe('survival');
    expect(resolveModeKind('capture the flag')).toBe('king_of_the_hill');
    expect(resolveModeKind('relic hunt')).toBe('relic_hunt');
    expect(resolveModeKind('something else entirely')).toBe('relic_hunt');
    expect(resolveModeKind(42)).toBe('relic_hunt');
  });

  it('resolves biome words to the closest biome', () => {
    expect(resolveBiome('frost')).toBe('frost');
    expect(resolveBiome('snowy peaks')).toBe('frost');
    expect(resolveBiome('ice')).toBe('frost');
    expect(resolveBiome('sand')).toBe('desert');
    expect(resolveBiome('dunes')).toBe('desert');
    expect(resolveBiome('dark')).toBe('night');
    expect(resolveBiome('moon garden')).toBe('night');
    expect(resolveBiome('lava')).toBe('volcanic');
    expect(resolveBiome('ash fields')).toBe('volcanic');
    expect(resolveBiome('volcano')).toBe('volcanic');
    expect(resolveBiome('plaid')).toBeUndefined();
  });

  it('carries a normalized mode object, biome, movement speed and hazard rise into the spec', () => {
    const draft = {
      ...draftBase(),
      mode: { kind: 'race', timeLimitSec: 5, orderedCheckpoints: true },
      biome: 'snowy',
      movementSpeed: 12,
      hazardRise: { afterSec: 2, metersPerSec: 0.9, maxElevation: -0.1 },
    };
    const n = normalizeDraft(draft);
    const paths = n.normalizations.map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(['mode.kind', 'mode.timeLimitSec', 'biome', 'movementSpeed', 'hazardRise.afterSec', 'hazardRise.metersPerSec', 'hazardRise.maxElevation']));
    const r = expandDraft(draft, { seed: 3, worldId: 'mode-draft' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.mode).toEqual({ kind: 'checkpoint_race', timeLimitSec: MODE_LIMITS.timeLimitSec.min, orderedCheckpoints: true });
    expect(r.spec.biome).toBe('frost');
    expect(r.spec.movement).toEqual({ speed: MODE_LIMITS.movementSpeed.max });
    expect(r.spec.hazard.rise).toEqual({ afterSec: MODE_LIMITS.hazardRise.afterSec.min, metersPerSec: MODE_LIMITS.hazardRise.metersPerSec.max, maxElevation: MODE_LIMITS.hazardRise.maxElevation.max });
    expect(r.normalizations.length).toBeGreaterThanOrEqual(7);
    expect(validateSpec(r.spec).ok).toBe(true);
  });

  it('accepts a bare mode word, defaults the biome to garden and leaves movement and rise absent', () => {
    const r = expandDraft({ ...draftBase(), mode: 'king of the hill' }, { seed: 4, worldId: 'hill-draft' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.mode).toEqual({ kind: 'king_of_the_hill' });
    expect(r.spec.biome).toBe('garden');
    expect(r.spec.movement).toBeUndefined();
    expect(r.spec.hazard.rise).toBeUndefined();
    expect(r.normalizations).toEqual([{ path: 'mode', from: 'king of the hill', to: { kind: 'king_of_the_hill' }, reason: expect.any(String) }]);
    expect(validateSpec(r.spec).ok).toBe(true);

    const plain = expandDraft(draftBase(), { seed: 5, worldId: 'plain-draft' });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.spec.mode).toBeUndefined();
    expect(plain.spec.biome).toBe('garden');
    expect(plain.normalizations).toEqual([]);
  });

  it('a lava draft with no biome becomes volcanic; an unknown biome word is dropped to the default', () => {
    const lava = expandDraft({ ...draftBase(), hazard: 'lava' }, { seed: 6, worldId: 'lava-draft' });
    expect(lava.ok).toBe(true);
    if (!lava.ok) return;
    expect(lava.spec.biome).toBe('volcanic');
    expect(lava.spec.hazard.kind).toBe('lava');
    expect(lava.normalizations).toEqual([{ path: 'biome', from: undefined, to: 'volcanic', reason: expect.any(String) }]);

    const keep = expandDraft({ ...draftBase(), hazard: 'lava', biome: 'night' }, { seed: 6, worldId: 'lava-night' });
    expect(keep.ok).toBe(true);
    if (!keep.ok) return;
    expect(keep.spec.biome).toBe('night');

    const odd = expandDraft({ ...draftBase(), biome: 'plaid' }, { seed: 7, worldId: 'odd-biome' });
    expect(odd.ok).toBe(true);
    if (!odd.ok) return;
    expect(odd.spec.biome).toBe('garden');
    expect(odd.normalizations[0]).toMatchObject({ path: 'biome', from: 'plaid' });
  });

  it('a survival draft with words and a rise expands to a world that validates as survival', () => {
    const r = expandDraft({
      ...draftBase(), hazard: 'lava', mode: { kind: 'survive the rising lava', timeLimitSec: 90.4 },
      hazardRise: { afterSec: 15, metersPerSec: 0.05, maxElevation: -0.7 },
    }, { seed: 8, worldId: 'survive-draft' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.mode).toEqual({ kind: 'survival', timeLimitSec: 90 });
    expect(r.spec.biome).toBe('volcanic');
    expect(r.spec.hazard.rise?.afterSec).toBe(15);
    const v = validateSpec(r.spec);
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
  });
});

describe('effectiveSpeed drives stepMover', () => {
  const spawn = { x: -2, z: -2 };
  const distanceAfterOneTick = (spec: WorldSpec) => {
    const compiled = compileWorld(spec);
    const start = createMover({ x: 0, z: 0 }, 0, compiled);
    const r = stepMover(compiled, start, { axes: { x: 1, z: 0 }, active: true }, TICK, TICK, { gateOpen: false, spawn });
    expect(r.events).toEqual([]);
    return Math.hypot(r.mover.x - start.x, r.mover.z - start.z);
  };

  it('a world without movement walks at the default speed; set_movement scales the distance per step', () => {
    const base = fixtureWorld('garden5');
    const d0 = distanceAfterOneTick(base);
    expect(d0).toBeCloseTo(MODE_LIMITS.movementSpeed.default * (TICK / 1000), 9);

    const faster = applyPatch(base, { summary: 'fast', ops: [{ op: 'set_movement', speed: 6 }] });
    expect(faster.ok).toBe(true);
    if (!faster.ok) return;
    expect(distanceAfterOneTick(faster.spec)).toBeCloseTo(6 * (TICK / 1000), 9);
    expect(distanceAfterOneTick(faster.spec) / d0).toBeCloseTo(6 / MODE_LIMITS.movementSpeed.default, 9);

    const slower = applyPatch(base, { summary: 'slow', ops: [{ op: 'set_movement', speed: 3 }] });
    expect(slower.ok).toBe(true);
    if (!slower.ok) return;
    expect(distanceAfterOneTick(slower.spec)).toBeCloseTo(3 * (TICK / 1000), 9);
  });

  it('trial5 walks at its 5.5 m/s and the velocity magnitude follows the spec speed', () => {
    const spec = fixtureWorld('trial5');
    expect(distanceAfterOneTick(spec)).toBeCloseTo(5.5 * (TICK / 1000), 9);
    const compiled = compileWorld(spec);
    const r = stepMover(compiled, createMover({ x: 0, z: 0 }, 0, compiled), { axes: { x: 0.6, z: 0.8 }, active: true }, TICK, TICK, { gateOpen: false, spawn });
    expect(Math.hypot(r.mover.vx, r.mover.vz)).toBeCloseTo(5.5, 9);
  });
});

describe('buildSessionSummary', () => {
  it('reports the effective mode and the biome', () => {
    const session = { worldVersion: 2, elapsedMs: 12345, players: [player('p0', 0, 0)], collectedRelicIds: [], gateUnlocked: false, won: false, score: 0 };
    const trial = buildSessionSummary(compileWorld(fixtureWorld('trial5')), session);
    expect(trial.mode).toEqual({ kind: 'time_trial', timeLimitSec: 60, holdSeconds: MODE_LIMITS.holdSeconds.default, relicsRequired: 3 });
    expect(trial.biome).toBe('desert');

    const garden = buildSessionSummary(compileWorld(fixtureWorld('garden5')), session);
    expect(garden.mode).toEqual({ kind: 'relic_hunt', timeLimitSec: null, holdSeconds: MODE_LIMITS.holdSeconds.default, relicsRequired: 3 });
    expect(garden.biome).toBe('garden');

    const hill = buildSessionSummary(compileWorld(fixtureWorld('hill4')), session);
    expect(hill.mode).toMatchObject({ kind: 'king_of_the_hill', holdSeconds: 10 });
    expect(hill.biome).toBe('frost');
    expect(hill.islands.map((i) => i.id)).toEqual(['base', 'summit', 'east', 'west']);
  });
});
