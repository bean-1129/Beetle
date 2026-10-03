// Integration tests for the game modes against the real server over real HTTP and WebSocket controllers.
// Each describe block starts its own in-process server (port 0) so the mode clocks start fresh per test.
// Worlds come from the packages/world fixtures (race5, hill4, survival5) when present, else from garden5 plus a mode.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GEOMETRY, SCORING, type TickMessage, type WorldSpec } from '@beetle/contracts';
import {
  agentWorld, awaitTicks, collectRelic, currentPlayer, holdInput, playerIn, posOf, standOnBridge, startServer,
  type ServerHandle,
} from '../support/server-harness.ts';
import {
  HILL_HOLD_SECONDS, TRIAL_TIME_LIMIT_SEC, closePair, commitPatch, driveIntoGateZone, holdSecOf, joinPair, leaveGateZone, maxTickGapMs,
  modeWorld, pressNearRelic, secondsUntilSubmerged, standNearRelic, startServerWithSpec, type Pair,
} from '../support/modes-helpers.ts';
import { dist, gatePos, relicPos, relicsByRouteLength } from '../support/world-geom.ts';

const TICK_MS = 1000 / 30;

function speed(p: { vx: number; vz: number }): number {
  return Math.hypot(p.vx, p.vz);
}

// ---------------------------------------------------------------------------------------------------------
// 1. time_trial via set_mode on garden5
// ---------------------------------------------------------------------------------------------------------
describe('1. set_mode time_trial on garden5', () => {
  let server: ServerHandle;
  let spec: WorldSpec;
  let p1: Pair;
  let p2: Pair;

  beforeAll(async () => {
    server = await startServer({ startWorld: 'fixture' });
    spec = (await agentWorld(server)).spec;
    [p1, p2] = await joinPair(server);
  }, 120_000);

  afterAll(async () => {
    await closePair([p1, p2].filter(Boolean));
    if (server) await server.stop();
  });

  it('ticks count remainingSec down, players keep ids and relics across the commit, and after expiry lost is true and interact does not collect', async () => {
    // Before the mode change: p1 collects its nearest relic; p2 parks next to another relic without pressing interact.
    const start1 = await currentPlayer(p1.ws, p1.c.playerId);
    const options = relicsByRouteLength(spec, posOf(start1));
    expect(options.length).toBeGreaterThanOrEqual(2);
    const collectedId = options[0].relic.id;
    const parkedId = options[options.length - 1].relic.id;
    expect(parkedId).not.toBe(collectedId);
    const [collectedTick] = await Promise.all([
      collectRelic(p1.ws, spec, p1.c.playerId, collectedId, 60_000),
      standNearRelic(p2.ws, spec, p2.c.playerId, parkedId, 60_000),
    ]);
    expect(collectedTick.relics[collectedId]).toBe('collected');
    const before = await awaitTicks(p1.ws, 2);
    expect(before.score).toBe(SCORING.relic);
    const ids = before.players.map((p) => p.id).sort();
    const pos1Before = posOf(playerIn(before, p1.c.playerId)!);
    const pos2Before = posOf(playerIn(before, p2.c.playerId)!);

    // Commit the mode change as an ordinary patch through the agent API.
    const since1 = p1.ws.cursor();
    const since2 = p2.ws.cursor();
    const commitAt = Date.now();
    const { worldVersion } = await commitPatch(server, 'trial', `Time trial, ${TRIAL_TIME_LIMIT_SEC} s`, [{ op: 'set_mode', mode: { kind: 'time_trial', timeLimitSec: TRIAL_TIME_LIMIT_SEC } }]);
    expect(worldVersion).toBe(before.worldVersion + 1);
    const world = await agentWorld(server);
    expect(world.spec.mode?.kind).toBe('time_trial');
    expect(world.spec.mode?.timeLimitSec).toBe(TRIAL_TIME_LIMIT_SEC);

    // The first tick at the new version carries the objective and preserved session state.
    const first = await p1.ws.waitFor<TickMessage>((m) => m.type === 'tick' && m.worldVersion === worldVersion, 10_000, { since: since1, label: 'tick at new version' });
    const first2 = await p2.ws.waitFor<TickMessage>((m) => m.type === 'tick' && m.worldVersion === worldVersion, 10_000, { since: since2, label: 'tick at new version on p2' });
    for (const t of [first, first2]) {
      expect(t.players.map((p) => p.id).sort()).toEqual(ids);
      expect(playerIn(t, p1.c.playerId)?.connected).toBe(true);
      expect(playerIn(t, p2.c.playerId)?.connected).toBe(true);
      expect(t.relics[collectedId]).toBe('collected');
      expect(t.relics[parkedId]).toBe('present');
      expect(t.score).toBe(SCORING.relic);
    }
    expect(dist(pos1Before, posOf(playerIn(first, p1.c.playerId)!))).toBeLessThan(0.5);
    expect(dist(pos2Before, posOf(playerIn(first, p2.c.playerId)!))).toBeLessThan(0.5);

    // objective.remainingSec is present and counts down. The mode clock runs once a controller sends input after the
    // commit, so p1 keeps sending a zero input (standing still) while the countdown is observed.
    const withObjective = await p1.ws.waitForTick((t) => t.objective?.kind === 'time_trial' && typeof t.objective.remainingSec === 'number', 10_000, 'time_trial objective on tick');
    const r0 = withObjective.objective!.remainingSec!;
    expect(r0).toBeGreaterThan(0);
    expect(r0).toBeLessThanOrEqual(TRIAL_TIME_LIMIT_SEC + 0.5);
    expect(withObjective.objective!.lost ?? false).toBe(false);
    const stillP1 = holdInput(p1.ws, { x: 0, z: 0 });
    let later: TickMessage;
    try {
      later = await p1.ws.waitForTick((t) => typeof t.objective?.remainingSec === 'number' && t.objective.remainingSec <= r0 - 2, 15_000, 'remainingSec decreased by 2 s');
    } finally {
      stillP1.stop();
    }
    const elapsedSec = (later.serverMs - withObjective.serverMs) / 1000;
    expect(r0 - later.objective!.remainingSec!).toBeGreaterThanOrEqual(2);
    expect(r0 - later.objective!.remainingSec!).toBeLessThanOrEqual(elapsedSec + 1.5);
    // The zero input did not move anyone.
    expect(dist(pos1Before, posOf(playerIn(later, p1.c.playerId)!))).toBeLessThan(0.5);
    // Monotone: no tick in between went up.
    let prev = Infinity;
    for (const t of p1.ws.ticksSince(since1)) {
      if (typeof t.objective?.remainingSec !== 'number') continue;
      expect(t.objective.remainingSec).toBeLessThanOrEqual(prev + 1e-9);
      prev = t.objective.remainingSec;
    }

    // Expiry: lost becomes true no later than the time limit (plus slack) after the commit.
    const lost = await p1.ws.waitForTick((t) => t.objective?.lost === true, (TRIAL_TIME_LIMIT_SEC + 15) * 1000, 'objective.lost after expiry');
    const sinceCommitSec = (Date.now() - commitAt) / 1000;
    expect(sinceCommitSec).toBeGreaterThanOrEqual(TRIAL_TIME_LIMIT_SEC - 3);
    expect(lost.objective!.remainingSec ?? 0).toBeLessThanOrEqual(0.5);
    expect(lost.gate.won).toBe(false);
    expect(lost.relics[parkedId]).toBe('present');

    // Interact next to a relic after expiry does not collect it.
    const parked = await currentPlayer(p2.ws, p2.c.playerId);
    expect(dist(posOf(parked), options[options.length - 1].pos)).toBeLessThanOrEqual(GEOMETRY.relicPickupRadius);
    const attempt = await pressNearRelic(p2.ws, p2.c.playerId, parkedId);
    expect(attempt.collected).toBe(false);
    expect(attempt.tick.relics[parkedId]).toBe('present');
    expect(attempt.tick.score).toBe(SCORING.relic);
    expect(attempt.tick.objective?.lost).toBe(true);
    const summary = (await agentWorld(server)).summary;
    expect(summary.collectedRelicIds).toEqual([collectedId]);
    expect(summary.score).toBe(SCORING.relic);
    // Both players are still known and connected after the whole run.
    expect(attempt.tick.players.map((p) => p.id).sort()).toEqual(ids);
    expect(playerIn(attempt.tick, p1.c.playerId)?.connected).toBe(true);
  }, 170_000);
});

// ---------------------------------------------------------------------------------------------------------
// 2. king_of_the_hill
// ---------------------------------------------------------------------------------------------------------
describe('2. king_of_the_hill (hill4 or garden5 + set_mode)', () => {
  let server: ServerHandle;
  let spec: WorldSpec;
  let p1: Pair;
  let p2: Pair;

  beforeAll(async () => {
    const world = modeWorld('hill4');
    // eslint-disable-next-line no-console
    console.log(`[modes] hill4 world source: ${world.source}`);
    server = await startServerWithSpec(world.spec);
    spec = (await agentWorld(server)).spec;
    expect(spec.mode?.kind).toBe('king_of_the_hill');
    [p1, p2] = await joinPair(server);
  }, 120_000);

  afterAll(async () => {
    await closePair([p1, p2].filter(Boolean));
    if (server) await server.stop();
  });

  it('a player in the gate trigger zone accumulates holdSec, wins after holdSeconds with SCORING.win, and a second holder does not double-award', async () => {
    const holdTarget = spec.mode?.holdSeconds ?? HILL_HOLD_SECONDS;
    const initial = await awaitTicks(p1.ws, 2);
    expect(initial.objective?.kind).toBe('king_of_the_hill');
    if (initial.objective?.holdTarget !== undefined) expect(initial.objective.holdTarget).toBe(holdTarget);
    expect(initial.gate.won).toBe(false);
    const scoreBefore = initial.score;
    expect(holdSecOf(initial, p1.c.playerId)).toBe(0);

    // p1 enters the zone and stays still.
    const inZone = await driveIntoGateZone(p1.ws, spec, p1.c.playerId);
    const enteredAt = Date.now();
    expect(dist(posOf(inZone), gatePos(spec))).toBeLessThanOrEqual(GEOMETRY.gateTriggerRadius);
    const still = holdInput(p1.ws, { x: 0, z: 0 });
    try {
      const holding = await p1.ws.waitForTick((t) => holdSecOf(t, p1.c.playerId) > 0, 10_000, 'holdSec accumulating for p1');
      expect(holding.gate.won).toBe(false);
      // holdSec keeps growing with time.
      const more = await p1.ws.waitForTick((t) => holdSecOf(t, p1.c.playerId) >= Math.min(1, holdTarget / 2), 10_000, 'holdSec >= 1');
      expect(holdSecOf(more, p1.c.playerId)).toBeGreaterThan(holdSecOf(holding, p1.c.playerId));
      expect(holdSecOf(more, p2.c.playerId)).toBe(0);

      const won = await p1.ws.waitForTick((t) => t.gate.won === true, (holdTarget + 10) * 1000, 'gate.won after holding');
      const heldFor = (Date.now() - enteredAt) / 1000;
      expect(heldFor).toBeGreaterThanOrEqual(holdTarget - 0.5);
      expect(heldFor).toBeLessThanOrEqual(holdTarget + 6);
      expect(holdSecOf(won, p1.c.playerId)).toBeGreaterThanOrEqual(holdTarget - 2 * TICK_MS / 1000);
      expect(won.score).toBe(scoreBefore + SCORING.win);
      // The win is reported once and the score does not keep growing while p1 stays in the zone.
      const after = await awaitTicks(p1.ws, 30);
      expect(after.gate.won).toBe(true);
      expect(after.score).toBe(scoreBefore + SCORING.win);
    } finally {
      still.stop();
    }
    // p2 also sees the result on its own socket.
    const t2 = await p2.ws.waitForTick((t) => t.gate.won === true, 5000, 'p2 sees the win');
    expect(t2.score).toBe(scoreBefore + SCORING.win);
    const summary = (await agentWorld(server)).summary;
    expect(summary.won).toBe(true);
    expect(summary.score).toBe(scoreBefore + SCORING.win);

    // p1 leaves, p2 holds the zone for longer than holdSeconds: no second award.
    await leaveGateZone(p1.ws, spec, p1.c.playerId);
    const inZone2 = await driveIntoGateZone(p2.ws, spec, p2.c.playerId);
    expect(dist(posOf(inZone2), gatePos(spec))).toBeLessThanOrEqual(GEOMETRY.gateTriggerRadius);
    const still2 = holdInput(p2.ws, { x: 0, z: 0 });
    try {
      const sinceHold = p2.ws.cursor();
      const holdStartMs = p2.ws.lastTick()!.serverMs;
      const settled = await p2.ws.waitForTick((t) => t.serverMs - holdStartMs >= (holdTarget + 1.5) * 1000, (holdTarget + 12) * 1000, 'p2 held past holdSeconds');
      expect(settled.gate.won).toBe(true);
      expect(settled.score).toBe(scoreBefore + SCORING.win);
      for (const t of p2.ws.ticksSince(sinceHold)) expect(t.score).toBe(scoreBefore + SCORING.win);
    } finally {
      still2.stop();
    }
    const final = (await agentWorld(server)).summary;
    expect(final.score).toBe(scoreBefore + SCORING.win);
    expect(final.players.map((p) => p.id).sort()).toEqual([p1.c.playerId, p2.c.playerId].sort());
  }, 170_000);
});

// ---------------------------------------------------------------------------------------------------------
// 3. checkpoint_race
// ---------------------------------------------------------------------------------------------------------
describe('3. checkpoint_race (race5 or garden5 + set_mode)', () => {
  let server: ServerHandle;
  let spec: WorldSpec;
  let p1: Pair;
  let p2: Pair;

  beforeAll(async () => {
    const world = modeWorld('race5');
    // eslint-disable-next-line no-console
    console.log(`[modes] race5 world source: ${world.source}`);
    server = await startServerWithSpec(world.spec);
    spec = (await agentWorld(server)).spec;
    expect(spec.mode?.kind).toBe('checkpoint_race');
    [p1, p2] = await joinPair(server);
  }, 120_000);

  afterAll(async () => {
    await closePair([p1, p2].filter(Boolean));
    if (server) await server.stop();
  });

  it('out-of-order pickup does nothing; first, second, third in order open the gate and nextCheckpointId advances', async () => {
    const initial = await p1.ws.waitForTick((t) => t.objective?.kind === 'checkpoint_race' && typeof t.objective.nextCheckpointId === 'string', 10_000, 'checkpoint_race objective');
    const relicIds = spec.relics.map((r) => r.id);
    expect(relicIds.length).toBe(3);
    const first = initial.objective!.nextCheckpointId!;
    expect(relicIds).toContain(first);
    // The expected order: the gate's requiredRelicIds when they start with the first checkpoint, else spec relic order.
    const order = spec.gate.requiredRelicIds[0] === first ? spec.gate.requiredRelicIds : relicIds;
    const laterRelic = order.find((id) => id !== first)!;
    expect(laterRelic).toBeDefined();

    // p2 reaches a later checkpoint first and presses interact: nothing happens.
    await standNearRelic(p2.ws, spec, p2.c.playerId, laterRelic, 60_000);
    const attempt = await pressNearRelic(p2.ws, p2.c.playerId, laterRelic);
    expect(attempt.collected).toBe(false);
    expect(attempt.tick.relics[laterRelic]).toBe('present');
    expect(attempt.tick.score).toBe(initial.score);
    expect(attempt.tick.objective?.nextCheckpointId).toBe(first);
    expect(attempt.tick.gate.unlocked).toBe(false);

    // p1 collects the first checkpoint: it is collected and the objective advances to a different relic.
    const t1 = await collectRelic(p1.ws, spec, p1.c.playerId, first, 60_000);
    expect(t1.relics[first]).toBe('collected');
    expect(t1.score).toBe(initial.score + SCORING.relic);
    const advanced = await p1.ws.waitForTick((t) => t.objective?.nextCheckpointId !== first, 5000, 'nextCheckpointId advanced past the first');
    const second = advanced.objective!.nextCheckpointId!;
    expect(typeof second).toBe('string');
    expect(relicIds).toContain(second);
    expect(second).not.toBe(first);
    expect(advanced.gate.unlocked).toBe(false);

    // The second checkpoint (p2 is already next to it when the order matched; otherwise it walks there).
    const t2 = await collectRelic(p2.ws, spec, p2.c.playerId, second, 60_000);
    expect(t2.relics[second]).toBe('collected');
    expect(t2.score).toBe(initial.score + 2 * SCORING.relic);
    const advanced2 = await p2.ws.waitForTick((t) => t.objective?.nextCheckpointId !== second, 5000, 'nextCheckpointId advanced past the second');
    const third = advanced2.objective!.nextCheckpointId!;
    expect(relicIds).toContain(third);
    expect([first, second]).not.toContain(third);
    expect(advanced2.gate.unlocked).toBe(false);

    // The third checkpoint opens the gate; whichever player is closer walks there.
    const thirdPos = relicPos(spec, third);
    const d1 = dist(posOf(await currentPlayer(p1.ws, p1.c.playerId)), thirdPos);
    const d2 = dist(posOf(await currentPlayer(p2.ws, p2.c.playerId)), thirdPos);
    const collector = d1 <= d2 ? p1 : p2;
    const t3 = await collectRelic(collector.ws, spec, collector.c.playerId, third, 60_000);
    expect(t3.relics[third]).toBe('collected');
    expect(t3.score).toBe(initial.score + 3 * SCORING.relic);
    const open = await collector.ws.waitForTick((t) => t.gate.unlocked === true, 5000, 'gate unlocked after the last checkpoint');
    expect(open.objective?.nextCheckpointId ?? null).toBeNull();
    const summary = (await agentWorld(server)).summary;
    expect(summary.gateUnlocked).toBe(true);
    expect([...summary.collectedRelicIds].sort()).toEqual([...relicIds].sort());
  }, 170_000);
});

// ---------------------------------------------------------------------------------------------------------
// 4. survival
// ---------------------------------------------------------------------------------------------------------
describe('4. survival (survival5 or garden5 + lava + hazard.rise)', () => {
  let server: ServerHandle;
  let spec: WorldSpec;
  let p1: Pair;
  let p2: Pair;
  let startedAt = 0;

  beforeAll(async () => {
    const world = modeWorld('survival5');
    // eslint-disable-next-line no-console
    console.log(`[modes] survival5 world source: ${world.source}`);
    server = await startServerWithSpec(world.spec);
    startedAt = Date.now();
    spec = (await agentWorld(server)).spec;
    expect(spec.mode?.kind).toBe('survival');
    expect(spec.hazard.rise).toBeDefined();
    [p1, p2] = await joinPair(server);
  }, 120_000);

  afterAll(async () => {
    await closePair([p1, p2].filter(Boolean));
    if (server) await server.stop();
  });

  it('hazardElevation rises after afterSec and a player on a bridge falls and respawns when the plane passes -1.0', async () => {
    const rise = spec.hazard.rise!;
    const plane0 = spec.hazard.planeElevation;
    const submergeAfterSec = secondsUntilSubmerged(spec)!;
    const initial = await p1.ws.waitForTick((t) => t.objective?.kind === 'survival', 10_000, 'survival objective');
    expect(initial.objective!.hazardElevation ?? plane0).toBeCloseTo(plane0, 1);

    // p1 walks to the middle of a bridge from its spawn island and stays there; p2 stays on its island.
    const bridgeId = spec.bridges.find((b) => b.endpoints.some((e) => e.islandId === spec.spawns[0].supportingSurfaceId))!.id;
    const onBridge = await standOnBridge(p1.ws, spec, p1.c.playerId, bridgeId);
    expect(onBridge.supportId).toBe(bridgeId);
    expect(onBridge.status).toBe('active');
    const sinceWalked = (Date.now() - startedAt) / 1000;
    expect(sinceWalked).toBeLessThan(submergeAfterSec);
    const still = holdInput(p1.ws, { x: 0, z: 0 });
    const island2 = (await currentPlayer(p2.ws, p2.c.playerId)).supportId;
    expect(island2).toBe(spec.spawns.find((s) => s.playerSlot === 1)!.supportingSurfaceId);

    try {
      // The plane stays put until afterSec, then rises.
      const rising = await p1.ws.waitForTick((t) => typeof t.objective?.hazardElevation === 'number' && t.objective.hazardElevation > plane0 + 0.05, (rise.afterSec + 20) * 1000, 'hazardElevation rising');
      const risingAtSec = (Date.now() - startedAt) / 1000;
      expect(risingAtSec).toBeGreaterThanOrEqual(rise.afterSec - 1);
      const higher = await p1.ws.waitForTick((t) => (t.objective?.hazardElevation ?? plane0) > rising.objective!.hazardElevation! + 0.1, 10_000, 'hazardElevation keeps rising');
      const dt = (higher.serverMs - rising.serverMs) / 1000;
      const dz = higher.objective!.hazardElevation! - rising.objective!.hazardElevation!;
      expect(dz / dt).toBeGreaterThan(rise.metersPerSec * 0.5);
      expect(dz / dt).toBeLessThan(rise.metersPerSec * 1.5 + 0.05);

      // When the plane passes -1.0 the bridge submerges: the player on it falls and respawns on its spawn island.
      const fell = await p1.ws.waitForTick((t) => playerIn(t, p1.c.playerId)?.status === 'falling' || playerIn(t, p1.c.playerId)?.status === 'respawning', ((-1.0 - plane0) / rise.metersPerSec + 20) * 1000, 'player falling after the bridge submerged');
      expect(fell.objective!.hazardElevation!).toBeGreaterThanOrEqual(-1.0 - 0.05);
      const respawned = await p1.ws.waitForTick((t) => {
        const p = playerIn(t, p1.c.playerId);
        return Boolean(p && p.status === 'active' && p.supportId !== bridgeId && p.supportId !== null);
      }, (GEOMETRY.fallDurationMs + GEOMETRY.respawnDurationMs) * 4 + 5000, 'player respawned on an island');
      const p = playerIn(respawned, p1.c.playerId)!;
      expect(p.supportId).toBe(spec.spawns.find((s) => s.playerSlot === 0)!.supportingSurfaceId);
      expect(p.id).toBe(onBridge.id);
      // The plane never exceeds maxElevation.
      for (const t of p1.ws.ticksSince(0)) {
        if (typeof t.objective?.hazardElevation === 'number') expect(t.objective.hazardElevation).toBeLessThanOrEqual(rise.maxElevation + 1e-6);
      }
      // p2 on its island is unaffected.
      const q = await currentPlayer(p2.ws, p2.c.playerId);
      expect(q.status).toBe('active');
      expect(q.supportId).toBe(island2);
      const summary = (await agentWorld(server)).summary;
      expect(summary.players.find((x) => x.id === p1.c.playerId)?.connected).toBe(true);
    } finally {
      still.stop();
    }
  }, 170_000);
});

// ---------------------------------------------------------------------------------------------------------
// 5. set_biome and set_movement as ordinary patches
// ---------------------------------------------------------------------------------------------------------
describe('5. set_biome frost and set_movement 6 with players connected', () => {
  let server: ServerHandle;
  let p1: Pair;
  let p2: Pair;

  beforeAll(async () => {
    server = await startServer({ startWorld: 'fixture' });
    [p1, p2] = await joinPair(server);
  }, 120_000);

  afterAll(async () => {
    await closePair([p1, p2].filter(Boolean));
    if (server) await server.stop();
  });

  it('both patches commit, ids and positions are preserved, the tick stream has no gap over 1 s, and the new speed applies', async () => {
    const before = await awaitTicks(p1.ws, 2);
    const ids = before.players.map((p) => p.id).sort();
    const positions = new Map(before.players.map((p) => [p.id, posOf(p)] as const));
    const since1 = p1.ws.cursor();
    const since2 = p2.ws.cursor();

    const biome = await commitPatch(server, 'biome', 'Frost biome', [{ op: 'set_biome', biome: 'frost' }]);
    expect(biome.worldVersion).toBe(before.worldVersion + 1);
    const tb = await p1.ws.waitFor<TickMessage>((m) => m.type === 'tick' && m.worldVersion === biome.worldVersion, 10_000, { since: since1, label: 'tick after set_biome' });
    expect(tb.players.map((p) => p.id).sort()).toEqual(ids);
    for (const p of tb.players) {
      expect(p.connected).toBe(true);
      expect(dist(posOf(p), positions.get(p.id)!)).toBeLessThan(1e-6);
    }
    let world = await agentWorld(server);
    expect(world.spec.biome).toBe('frost');
    expect(world.version).toBe(biome.worldVersion);

    const movement = await commitPatch(server, 'movement', 'Walk speed 6', [{ op: 'set_movement', speed: 6 }]);
    expect(movement.worldVersion).toBe(biome.worldVersion + 1);
    const tm = await p2.ws.waitFor<TickMessage>((m) => m.type === 'tick' && m.worldVersion === movement.worldVersion, 10_000, { since: since2, label: 'tick after set_movement' });
    expect(tm.players.map((p) => p.id).sort()).toEqual(ids);
    for (const p of tm.players) {
      expect(p.connected).toBe(true);
      expect(dist(posOf(p), positions.get(p.id)!)).toBeLessThan(1e-6);
    }
    world = await agentWorld(server);
    expect(world.spec.movement?.speed).toBe(6);
    expect(world.spec.biome).toBe('frost');
    expect(world.summary.players.filter((p) => p.connected).length).toBe(2);

    // The tick stream on both sockets never paused for more than a second across the two commits: observe 1.5 s more
    // after the second commit and check every consecutive serverMs gap in the window, plus the expected tick density.
    await awaitTicks(p1.ws, 45, 10_000);
    const ticks1 = p1.ws.ticksSince(since1);
    const ticks2 = p2.ws.ticksSince(since2);
    expect(ticks1.length).toBeGreaterThanOrEqual(40);
    expect(ticks2.length).toBeGreaterThanOrEqual(40);
    expect(maxTickGapMs(ticks1)).toBeLessThan(1000);
    expect(maxTickGapMs(ticks2)).toBeLessThan(1000);
    const windowMs = ticks1[ticks1.length - 1].serverMs - ticks1[0].serverMs;
    expect(ticks1.length).toBeGreaterThanOrEqual(Math.floor((windowMs / TICK_MS) * 0.8));
    for (let i = 1; i < ticks1.length; i++) expect(ticks1[i].tick).toBeGreaterThan(ticks1[i - 1].tick);
    // Both commits happened inside the window (the tick stream carried each version bump).
    expect(ticks1.some((t) => t.worldVersion === biome.worldVersion)).toBe(true);
    expect(ticks1.some((t) => t.worldVersion === movement.worldVersion)).toBe(true);

    // The new movement speed is live: a held input moves p1 at about 6 m/s.
    const me = await currentPlayer(p1.ws, p1.c.playerId);
    const spec = world.spec;
    const island = spec.islands.find((i) => i.id === me.supportId) ?? spec.islands[0];
    const d = { x: island.center.x - me.x, z: island.center.z - me.z };
    const l = Math.hypot(d.x, d.z);
    const dir = l > 0.5 ? { x: d.x / l, z: d.z / l } : { x: 1, z: 0 };
    const hold = holdInput(p1.ws, p1.ws.axesFor(dir));
    try {
      const moving = await p1.ws.waitForTick((t) => speed(playerIn(t, p1.c.playerId)!) > 5.5, 5000, 'p1 moving at the new speed');
      expect(speed(playerIn(moving, p1.c.playerId)!)).toBeCloseTo(6, 0);
    } finally {
      hold.stop();
    }
    await awaitTicks(p1.ws, 3);
    expect(speed(await currentPlayer(p1.ws, p1.c.playerId))).toBe(0);
  }, 120_000);
});
