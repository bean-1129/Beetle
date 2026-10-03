import { describe, expect, it } from 'vitest';
import { applyBriefHints, briefHints, validatorRepairPrompt, worldDraftSystemPrompt } from '../../packages/agent/src/prompts.ts';

describe('brief hints', () => {
  it('reads biome, mode and numbers from the director brief', () => {
    expect(briefHints('A desert arena: king of the hill, hold the hill for 8 seconds')).toMatchObject({ biome: 'desert', modeKind: 'king_of_the_hill', holdSeconds: 8, lava: false });
    expect(briefHints('Survival on a night archipelago: the water rises after 30 seconds, survive 120 seconds and reach the gate with 1 relic')).toMatchObject({ biome: 'night', modeKind: 'survival', timeLimitSec: 120, relicsRequired: 1 });
    expect(briefHints('A checkpoint race around a ring of six snowy islands')).toMatchObject({ biome: 'frost', modeKind: 'checkpoint_race' });
    expect(briefHints('A 60 second time trial over lava')).toMatchObject({ modeKind: 'time_trial', timeLimitSec: 60, lava: true, biome: 'volcanic' });
    // "the second island" is not a time limit; "one relic each" is not a relic count.
    expect(briefHints('Spawns on the first island, one relic each on the second and third islands')).toEqual({ lava: false });
  });

  it('a desert brief wins over a volcanic model answer and lava is dropped when the brief never names it', () => {
    const draft: Record<string, unknown> = { biome: 'volcanic', hazard: 'lava', mode: { kind: 'king_of_the_hill', holdSeconds: 10, relicsRequired: 3 } };
    const changed = applyBriefHints(draft, 'A desert arena, king of the hill, hold for 8 seconds');
    expect(draft).toMatchObject({ biome: 'desert', hazard: 'water', mode: { kind: 'king_of_the_hill', holdSeconds: 8 } });
    expect((draft.mode as Record<string, unknown>).relicsRequired).toBeUndefined();
    expect(changed.length).toBeGreaterThan(0);
  });

  it('survival gets a default hazardRise; a matching draft is left untouched', () => {
    const d1: Record<string, unknown> = { hazard: 'water', mode: { kind: 'time_trial' } };
    applyBriefHints(d1, 'Survive the rising water for 90 seconds');
    expect(d1).toMatchObject({ mode: { kind: 'survival', timeLimitSec: 90 }, hazardRise: { afterSec: 30 } });
    const d2: Record<string, unknown> = { biome: 'frost', hazard: 'water', mode: { kind: 'time_trial', timeLimitSec: 90 } };
    expect(applyBriefHints(d2, 'A race across the islands with a 90 second limit, snowy, fast players')).toEqual([]);
  });

  it('the draft prompt asks for short output and the gate rule; the repair prompt explains locked-gate reachability', () => {
    const sys = worldDraftSystemPrompt();
    expect(sys).toContain('0 to 4 decorations');
    expect(sys).toContain('without passing through the gate island');
    expect(sys).toContain('no line breaks');
    const hint = validatorRepairPrompt([{ code: 'UNREACHABLE_RELIC', message: 'relic "r1" on "i3" cannot be reached from spawn-0 with the gate locked', objectIds: ['r1'] }], null);
    expect(hint).toContain('move the relic to an island reachable from the spawns without crossing the gate island');
  });
});

describe('draft normalization for the failures testers hit', () => {
  it('splits a bridge that crosses a third island and drops a decoration standing on a spawn', async () => {
    const { normalizeDraft } = await import('../../packages/world/src/normalize.ts');
    const draft = {
      title: 'Line', hazard: 'water',
      islands: [
        { id: 'i0', name: 'A', center: { x: -30, z: 0 }, radius: 6 },
        { id: 'i1', name: 'B', center: { x: 0, z: 0 }, radius: 6 },
        { id: 'i2', name: 'C', center: { x: 30, z: 0 }, radius: 6 },
        { id: 'i3', name: 'D', center: { x: 0, z: 30 }, radius: 6 },
      ],
      bridges: [{ id: 'b1', from: 'i0', to: 'i2', width: 3 }, { id: 'b2', from: 'i1', to: 'i3', width: 3 }],
      spawns: [{ islandId: 'i0', localPosition: { x: 0, z: 0 } }, { islandId: 'i0', localPosition: { x: 2, z: 0 } }],
      relics: [{ id: 'r1', name: 'R', islandId: 'i1', localPosition: { x: 0, z: 0 } }],
      gate: { islandId: 'i3', localPosition: { x: 0, z: 0 } },
      decorations: [{ id: 'd1', type: 'rock', islandId: 'i0', localPosition: { x: 0, z: 0 } }, { id: 'd2', type: 'bush', islandId: 'i2', localPosition: { x: 0, z: 0 } }],
    };
    const { draft: out } = normalizeDraft(draft) as { draft: { bridges: { from: string; to: string }[]; decorations: { id: string }[] } };
    const pairs = out.bridges.map((b) => [b.from, b.to].sort().join('-')).sort();
    expect(pairs).toEqual(['i0-i1', 'i1-i2', 'i1-i3']);
    expect(out.decorations.map((x) => x.id)).toEqual(['d2']);
  });
});

describe('relic_hunt cue for briefs without a clock', () => {
  it('maps heist and puzzle briefs that collect relics to relic_hunt, and keeps time trials with a clock', () => {
    expect(briefHints('A desert heist: sneak across six islands collecting three relics, then escape through the gate')).toMatchObject({ modeKind: 'relic_hunt', relicsRequired: 3 });
    expect(briefHints('A frost puzzle where players plan the route between relics placed on far islands')).toMatchObject({ modeKind: 'relic_hunt' });
    expect(briefHints('Grab two relics within 60 seconds')).not.toMatchObject({ modeKind: 'relic_hunt' });
    const d: Record<string, unknown> = { hazard: 'water', mode: { kind: 'time_trial', timeLimitSec: 90 } };
    applyBriefHints(d, 'A night heist collecting all relics');
    expect(d.mode).toEqual({ kind: 'relic_hunt' });
  });
});

describe('layout constraints pulled from the brief', () => {
  it('reads an island count and a ring and states them in the user prompt', async () => {
    const { briefUserPrompt } = await import('../../packages/agent/src/prompts.ts');
    expect(briefHints('Six floating islands in a ring around a lava sea, race laps')).toMatchObject({ islandCount: 6, ring: true });
    const u = briefUserPrompt('Six floating islands in a ring around a lava sea, race laps');
    expect(u).toContain('Use exactly 6 islands.');
    expect(u).toContain('closing the ring');
    expect(briefHints('A quiet frost world')).not.toHaveProperty('islandCount');
  });
});
