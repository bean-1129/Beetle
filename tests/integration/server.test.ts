// Integration tests against the real Beetle server with the garden5 fixture world.
// Covers cases 8, 9, 10, 11, 12, 13 and 16 from docs/ARCHITECTURE.md over real HTTP and WebSocket traffic.
// The tests in this file share one server and run in order: later tests build on the session state of earlier ones.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROUTES, SCORING, SIMULATION, type CommitResult, type TickMessage, type WorldMessage, type WorldSpec,
} from '@beetle/contracts';
import {
  TICK_MS, WsClient, agentFetch, agentWorld, anonFetch, apiFetch, awaitTicks, collectRelic, commitCandidate, commitUntilSettled,
  controllerFetch, currentPlayer, directorFetch, driveTo, holdInput, joinController, navigateTo, playerIn, posOf, requestIdFor,
  sleep, stageAndValidate, stagePatchOk, standOnBridge, startServer, validateCandidate,
  type Controller, type ServerHandle, type StagedPatch,
} from '../support/server-harness.ts';
import {
  bridgeOf, bridgesTouching, dist, importantIslandIds, islandNear, islandOf, islandRoute, otherEnd, relicPos, relicsByRouteLength,
} from '../support/world-geom.ts';

let server: ServerHandle;
let spec: WorldSpec;
let baseVersion: number;
let c1: Controller;
let c2: Controller;
let ws1: WsClient;
let ws2: WsClient;
let display: WsClient | null = null;

// State handed from one test to the next.
let firstRelicId: string | null = null;
let occupiedBridgeId: string | null = null;
let staleCandidate: (StagedPatch & { proofId: string }) | null = null;
let committed: { candidateId: string; proofId: string; result: CommitResult } | null = null;
let versionAfterCommit: number | null = null;

function speed(p: { vx: number; vz: number }): number {
  return Math.hypot(p.vx, p.vz);
}

beforeAll(async () => {
  server = await startServer({ startWorld: 'fixture' });
  const world = await agentWorld(server);
  spec = world.spec;
  baseVersion = world.version;
}, 120_000);

afterAll(async () => {
  for (const c of [ws1, ws2, display]) {
    if (c) await c.close().catch(() => undefined);
  }
  if (server) await server.stop();
});

describe('server boots with the fixture world', () => {
  it('answers /api/health and serves the fixture spec to the agent', async () => {
    const health = await anonFetch(server, ROUTES.health);
    expect(health.status).toBe(200);
    expect(health.json.ok).toBe(true);
    expect(health.json.hasWorld).toBe(true);
    expect(spec.islands.length).toBeGreaterThanOrEqual(4);
    expect(spec.bridges.length).toBeGreaterThan(0);
    expect(spec.relics.length).toBe(3);
    expect(baseVersion).toBeGreaterThanOrEqual(1);
    expect(spec.worldVersion).toBe(baseVersion);
  });
});

describe('case 12: two controllers', () => {
  it('join via invites and receive distinct player ids over the socket', async () => {
    c1 = await joinController(server);
    c2 = await joinController(server);
    expect(c1.playerId).not.toBe(c2.playerId);
    expect(c1.controllerToken).not.toBe(c2.controllerToken);
    expect(c1.inviteUrl).toContain('/controller?invite=');

    ws1 = await WsClient.connect(server, { name: 'p1' });
    ws2 = await WsClient.connect(server, { name: 'p2' });
    const w1 = await ws1.helloController(c1.controllerToken);
    const w2 = await ws2.helloController(c2.controllerToken);
    expect(w1.role).toBe('controller');
    expect(w1.playerId).toBe(c1.playerId);
    expect(w2.playerId).toBe(c2.playerId);
    expect(w1.worldVersion).toBe(baseVersion);
    expect(w1.tickHz).toBe(SIMULATION.tickHz);

    const tick = await ws1.waitForTick((t) => {
      const a = playerIn(t, c1.playerId);
      const b = playerIn(t, c2.playerId);
      return Boolean(a?.connected && b?.connected);
    }, 5000, 'both players connected');
    expect(tick.worldVersion).toBe(baseVersion);
    expect(playerIn(tick, c1.playerId)?.status).toBe('active');
    expect(playerIn(tick, c2.playerId)?.status).toBe('active');
    // Both players start on a surface (their spawn island).
    expect(playerIn(tick, c1.playerId)?.supportId).not.toBeNull();
    expect(playerIn(tick, c2.playerId)?.supportId).not.toBeNull();
  });

  it('move independently: inputs from one socket move only that socket\'s player', async () => {
    await ws1.calibrateAxes(c1.playerId);
    await ws2.calibrateAxes(c2.playerId);
    await awaitTicks(ws1, 3);

    // P1 moves toward its island centre while P2 is idle.
    const p1Start = await currentPlayer(ws1, c1.playerId);
    const p2Start = await currentPlayer(ws2, c2.playerId);
    const island1 = islandNear(spec, posOf(p1Start));
    const toCentre = { x: island1.center.x - p1Start.x, z: island1.center.z - p1Start.z };
    const len = Math.hypot(toCentre.x, toCentre.z) || 1;
    const since = ws2.cursor();
    const hold = holdInput(ws1, ws1.axesFor({ x: toCentre.x / len, z: toCentre.z / len }));
    await sleep(450);
    hold.stop();
    await awaitTicks(ws1, 3);

    const p1End = await currentPlayer(ws1, c1.playerId);
    const p2End = await currentPlayer(ws2, c2.playerId);
    expect(dist(posOf(p1Start), posOf(p1End))).toBeGreaterThan(0.8);
    expect(dist(posOf(p2Start), posOf(p2End))).toBeLessThan(1e-6);
    // P2 never had a velocity while P1 moved.
    for (const t of ws2.ticksSince(since)) {
      const p2 = playerIn(t, c2.playerId)!;
      expect(speed(p2)).toBe(0);
    }
    // One tick in the window shows P1 moving at the configured speed.
    const moving = ws1.ticksSince(since).filter((t) => speed(playerIn(t, c1.playerId)!) > 0);
    expect(moving.length).toBeGreaterThan(3);

    // Now P2 moves and P1 stays still.
    const q1Start = await currentPlayer(ws1, c1.playerId);
    const q2Start = await currentPlayer(ws2, c2.playerId);
    const island2 = islandNear(spec, posOf(q2Start));
    const d2 = { x: island2.center.x - q2Start.x, z: island2.center.z - q2Start.z };
    const l2 = Math.hypot(d2.x, d2.z) || 1;
    const hold2 = holdInput(ws2, ws2.axesFor({ x: d2.x / l2, z: d2.z / l2 }));
    await sleep(450);
    hold2.stop();
    await awaitTicks(ws2, 3);
    const q1End = await currentPlayer(ws1, c1.playerId);
    const q2End = await currentPlayer(ws2, c2.playerId);
    expect(dist(posOf(q2Start), posOf(q2End))).toBeGreaterThan(0.8);
    expect(dist(posOf(q1Start), posOf(q1End))).toBeLessThan(1e-6);
  });

  it('cannot move another player: inputs naming a different player are rejected and the other player stays put', async () => {
    const p1Before = await currentPlayer(ws1, c1.playerId);
    const since = ws2.cursor();
    // The protocol has no way to address another player; a message that tries is not a valid input shape.
    ws2.send({ type: 'input', seq: ws2.seq + 1, axes: { x: 1, z: 0 }, interact: false, playerId: c1.playerId });
    ws2.send({ type: 'input', seq: ws2.seq + 2, axes: { x: 1, z: 0 }, interact: false, target: c1.playerId, token: c1.controllerToken });
    await sleep(400);
    await awaitTicks(ws1, 2);
    const p1After = await currentPlayer(ws1, c1.playerId);
    expect(dist(posOf(p1Before), posOf(p1After))).toBeLessThan(1e-6);
    for (const t of ws1.ticksSince(since)) expect(speed(playerIn(t, c1.playerId)!)).toBe(0);
    // The server either ignored the message or answered with an error; either way the socket survives.
    expect(ws2.isOpen).toBe(true);
    const p2 = await currentPlayer(ws2, c2.playerId);
    expect(p2.connected).toBe(true);
  });

  it(`clears velocity within inputTimeoutMs (${SIMULATION.inputTimeoutMs} ms) plus two ticks after a controller stops sending input`, async () => {
    const p1 = await currentPlayer(ws1, c1.playerId);
    const island = islandNear(spec, posOf(p1));
    const d = { x: island.center.x - p1.x, z: island.center.z - p1.z };
    const l = Math.hypot(d.x, d.z);
    const dir = l > 0.5 ? { x: d.x / l, z: d.z / l } : { x: 1, z: 0 };
    const hold = holdInput(ws1, ws1.axesFor(dir), { intervalMs: 50 });
    await ws1.waitForTick((t) => speed(playerIn(t, c1.playerId)!) > 1, 3000, 'player moving');
    await sleep(300);
    const since = ws1.cursor();
    hold.stop(false); // stop sending, without an explicit zero input
    const stoppedAt = hold.lastSentAt;
    const lastMoving = ws1.lastTick()!;
    expect(speed(playerIn(lastMoving, c1.playerId)!)).toBeGreaterThan(1);

    const cleared = await ws1.waitFor<TickMessage>((m) => m.type === 'tick' && speed(playerIn(m, c1.playerId)!) === 0, 3000, { since, label: 'velocity cleared' });
    const elapsed = Date.now() - stoppedAt;
    const bound = SIMULATION.inputTimeoutMs + 2 * TICK_MS;
    // 150 ms of slack for socket delivery and event-loop scheduling in the test process.
    expect(elapsed).toBeLessThanOrEqual(bound + 150);
    expect(elapsed).toBeGreaterThanOrEqual(SIMULATION.inputTimeoutMs - TICK_MS - 60);
    // And the player stays still afterwards.
    const at = playerIn(cleared, c1.playerId)!;
    const later = await awaitTicks(ws1, 6);
    const p = playerIn(later, c1.playerId)!;
    expect(dist(posOf(at), posOf(p))).toBeLessThan(1e-6);
    expect(speed(p)).toBe(0);
  });

  it('a controller walks to a relic and collects it (score = SCORING.relic)', async () => {
    const p1 = await currentPlayer(ws1, c1.playerId);
    const candidates = relicsByRouteLength(spec, posOf(p1));
    expect(candidates.length).toBeGreaterThan(0);
    const target = candidates[0];
    firstRelicId = target.relic.id;
    const before = ws1.lastTick()!;
    expect(before.relics[firstRelicId]).toBe('present');
    const tick = await collectRelic(ws1, spec, c1.playerId, firstRelicId, 60_000);
    expect(tick.relics[firstRelicId]).toBe('collected');
    expect(tick.score).toBe(before.score + SCORING.relic);
    const summary = (await agentWorld(server)).summary;
    expect(summary.collectedRelicIds).toContain(firstRelicId);
    expect(summary.score).toBe(before.score + SCORING.relic);
  }, 120_000);

  it('reconnecting with the same controller token restores the same player id and keeps collected relics', async () => {
    expect(firstRelicId).not.toBeNull();
    const before = await currentPlayer(ws1, c1.playerId);
    const scoreBefore = ws1.lastTick()!.score;
    await ws1.close();
    await ws2.waitForTick((t) => playerIn(t, c1.playerId)?.connected === false, 5000, 'player 1 reported disconnected');

    const again = await WsClient.connect(server, { name: 'p1-again' });
    const welcome = await again.helloController(c1.controllerToken, ws1.seq);
    expect(welcome.playerId).toBe(c1.playerId);
    expect(welcome.playerLabel).toBe(c1.label);
    ws1 = again;
    const tick = await ws1.waitForTick((t) => playerIn(t, c1.playerId)?.connected === true, 5000, 'player 1 reconnected');
    const p = playerIn(tick, c1.playerId)!;
    expect(p.id).toBe(before.id);
    expect(p.slot).toBe(before.slot);
    expect(tick.relics[firstRelicId!]).toBe('collected');
    expect(tick.score).toBe(scoreBefore);
    expect(Object.values(tick.relics).filter((v) => v === 'collected').length).toBe(1);
    // Still the same session for the second player too.
    expect(playerIn(tick, c2.playerId)?.connected).toBe(true);
  });
});

describe('case 13: tokens and routes', () => {
  it('a controller token cannot create director requests (401/403)', async () => {
    const res = await controllerFetch(server, c1.controllerToken, ROUTES.directorRequest, { method: 'POST', body: { kind: 'edit', prompt: 'make it lava' } });
    expect([401, 403]).toContain(res.status);
  });

  it('a controller token cannot read the agent world (401/403)', async () => {
    const res = await controllerFetch(server, c1.controllerToken, ROUTES.agentWorld);
    expect([401, 403]).toContain(res.status);
  });

  it('the director token is refused on agent routes', async () => {
    const res = await directorFetch(server, ROUTES.agentWorld);
    expect([401, 403]).toContain(res.status);
    const propose = await directorFetch(server, ROUTES.agentProposePatch, { method: 'POST', body: { requestId: 'req-x', patch: { summary: 'x', ops: [{ op: 'set_hazard', kind: 'lava' }] } } });
    expect([401, 403]).toContain(propose.status);
  });

  it('a missing token is 401 on director and agent routes', async () => {
    expect((await anonFetch(server, ROUTES.directorInvite, { method: 'POST', body: {} })).status).toBe(401);
    expect((await anonFetch(server, ROUTES.agentWorld)).status).toBe(401);
  });

  it('the agent token works on /api/agent/world from loopback', async () => {
    const res = await agentFetch(server, ROUTES.agentWorld);
    expect(res.status).toBe(200);
    expect(res.json.version).toBe(baseVersion);
    expect(res.json.spec.worldId).toBe(spec.worldId);
    expect(res.json.summary.players.map((p: { id: string }) => p.id).sort()).toEqual([c1.playerId, c2.playerId].sort());
  });

  it('the controller token is not accepted as a director on the socket', async () => {
    const sock = await WsClient.connect(server, { name: 'fake-director' });
    await expect(sock.helloDirector(c1.controllerToken)).rejects.toThrow(/rejected|AUTH/i);
    await sock.close().catch(() => undefined);
  });
});

describe('cases 8 and 9: occupied support, stale version, idempotent commit', () => {
  it('a patch removing the bridge a player stands on is deferred and then rejected with OCCUPIED_SUPPORT; it commits once the player moves off', async () => {
    // Park P1 on a central island (its spawn island) so validation with live context passes.
    const spawnIsland = islandOf(spec, spec.spawns.find((s) => s.playerSlot === 0)!.supportingSurfaceId);
    await navigateTo(ws1, spec, c1.playerId, { x: spawnIsland.center.x + 1, z: spawnIsland.center.z + 1 }, { tolerance: 0.4, timeoutMs: 60_000 });

    // Pick a bridge on that island whose removal keeps every spawn, uncollected relic and the gate connected.
    const collected = (await agentWorld(server)).summary.collectedRelicIds;
    const stillImportant = (s: WorldSpec) => importantIslandIds({ ...s, relics: s.relics.filter((r) => !collected.includes(r.id)) });
    const bridges = bridgesTouching(spec, spawnIsland.id);
    const removable = bridges.filter((b) => {
      const ids = stillImportant(spec);
      return ids.every((id) => islandRoute(spec, ids[0], id, { excludeBridgeIds: [b.id] }) !== null);
    });
    const bridge = removable[0] ?? bridges[0];
    occupiedBridgeId = bridge.id;
    const ops: unknown[] = [{ op: 'remove_bridge', id: bridge.id }];
    if (!removable.length) {
      // No cycle in the island graph: replace the bridge with a new one between the same islands.
      ops.push({ op: 'add_bridge', id: `${bridge.id}-r`.slice(0, 32), from: bridge.endpoints[0].islandId, to: bridge.endpoints[1].islandId, width: bridge.width });
    }

    // Stage a second candidate at the same base version for the stale-version test later.
    staleCandidate = await stageAndValidate(server, requestIdFor('stale'), { summary: 'Rename the world (will become stale)', ops: [{ op: 'set_title', title: 'Stale title' }] });
    expect(staleCandidate.baseWorldVersion).toBe(baseVersion);

    const staged = await stageAndValidate(server, requestIdFor('occupied'), { summary: `Remove ${bridge.id}`, ops });
    expect(staged.baseWorldVersion).toBe(baseVersion);
    expect(staged.changedIds).toContain(bridge.id);

    // Walk onto the bridge and confirm the server reports it as the player's support.
    const onBridge = await standOnBridge(ws1, spec, c1.playerId, bridge.id);
    expect(onBridge.supportId).toBe(bridge.id);
    expect(onBridge.status).toBe('active');
    const keepStill = holdInput(ws1, { x: 0, z: 0 });

    // Controllers do not render the world, so commit broadcasts are observed on a display socket.
    if (!display) {
      display = await WsClient.connect(server, { name: 'display' });
      await display.helloDisplay(baseVersion);
    }
    const t0 = Date.now();
    const sinceWorld = display.cursor();
    const rejected = await commitUntilSettled(server, staged.candidateId, staged.proofId, SIMULATION.commitDeferMaxMs + 10_000);
    const waited = Date.now() - t0;
    keepStill.stop();
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe('OCCUPIED_SUPPORT');
    expect(rejected.objectIds).toContain(c1.playerId);
    expect(rejected.retryable).toBe(true);
    // It was deferred (not rejected immediately) for about commitDeferMaxMs.
    expect(waited).toBeGreaterThanOrEqual(SIMULATION.commitDeferMaxMs - 2 * TICK_MS);
    // The world did not change and nobody received a commit.
    expect((await agentWorld(server)).version).toBe(baseVersion);
    expect(display.since(sinceWorld).some((m) => m.type === 'world')).toBe(false);
    const still = await currentPlayer(ws1, c1.playerId);
    expect(still.supportId).toBe(bridge.id);

    // Move off the bridge onto the island and commit again with the same proof.
    const entryIsland = islandOf(spec, bridge.endpoints[0].islandId);
    const safeSpot = { x: entryIsland.center.x + 1.5, z: entryIsland.center.z + 1.5 };
    await navigateTo(ws1, spec, c1.playerId, safeSpot, { tolerance: 0.4, timeoutMs: 60_000 });
    const parked = await currentPlayer(ws1, c1.playerId);
    expect(parked.supportId).toBe(entryIsland.id);

    const sinceCommit = display.cursor();
    const sinceTick1 = ws1.cursor();
    const sinceTick2 = ws2.cursor();
    let result = await commitUntilSettled(server, staged.candidateId, staged.proofId);
    if (!result.ok && (result.code === 'NOT_VALIDATED' || result.code === 'VALIDATION_EXPIRED')) {
      const again = await validateCandidate(server, staged.candidateId);
      expect(again.ok).toBe(true);
      result = await commitUntilSettled(server, staged.candidateId, again.proof!.proofId);
      staged.proofId = again.proof!.proofId;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.worldVersion).toBe(baseVersion + 1);
    expect(result.idempotentReplay).toBe(false);
    committed = { candidateId: staged.candidateId, proofId: staged.proofId, result };
    versionAfterCommit = result.worldVersion;

    const world1 = await display.waitFor<WorldMessage>((m) => m.type === 'world' && m.reason === 'commit', 5000, { since: sinceCommit, label: 'world commit on display' });
    expect(world1.version).toBe(baseVersion + 1);
    expect(world1.spec.bridges.find((b) => b.id === bridge.id)).toBeUndefined();
    expect(world1.changedIds).toContain(bridge.id);
    display.ack(world1.version);
    // Both controller sockets stay open and learn the new version from the tick stream.
    const tick1 = await ws1.waitFor<TickMessage>((m) => m.type === 'tick' && m.worldVersion === baseVersion + 1, 5000, { since: sinceTick1, label: 'tick at new version on p1' });
    const tick2 = await ws2.waitFor<TickMessage>((m) => m.type === 'tick' && m.worldVersion === baseVersion + 1, 5000, { since: sinceTick2, label: 'tick at new version on p2' });
    expect(playerIn(tick1, c1.playerId)?.connected).toBe(true);
    expect(playerIn(tick2, c2.playerId)?.connected).toBe(true);
    expect((await agentWorld(server)).version).toBe(baseVersion + 1);
  }, 170_000);

  it('a candidate staged against the old version is rejected with STALE_WORLD_VERSION after a commit', async () => {
    expect(staleCandidate).not.toBeNull();
    expect(versionAfterCommit).toBe(baseVersion + 1);
    const validation = await validateCandidate(server, staleCandidate!.candidateId);
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((i) => i.code)).toContain('STALE_WORLD_VERSION');
    const commit = await commitCandidate(server, staleCandidate!.candidateId, staleCandidate!.proofId);
    expect(commit.ok).toBe(false);
    if (commit.ok) return;
    expect(commit.code).toBe('STALE_WORLD_VERSION');
    expect((await agentWorld(server)).version).toBe(baseVersion + 1);
  });

  it('committing the same proof twice is an idempotent replay and bumps the version only once', async () => {
    expect(committed).not.toBeNull();
    const replay = await commitCandidate(server, committed!.candidateId, committed!.proofId);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.worldVersion).toBe(committed!.result.ok ? committed!.result.worldVersion : -1);
    const world = await agentWorld(server);
    expect(world.version).toBe(baseVersion + 1);
    expect(world.spec.worldVersion).toBe(baseVersion + 1);
    // A fresh patch after the commit is based on the new version.
    const next = await stagePatchOk(server, requestIdFor('after'), { summary: 'title only', ops: [{ op: 'set_title', title: 'After the commit' }] });
    expect(next.baseWorldVersion).toBe(baseVersion + 1);
  });
});

describe('case 10: a commit preserves identity, relics and connections', () => {
  it('both controllers keep receiving ticks with the new worldVersion, same player ids, same collected relics and score', async () => {
    expect(versionAfterCommit).toBe(baseVersion + 1);
    const t1 = await ws1.waitForTick((t) => t.worldVersion === versionAfterCommit, 5000, 'tick at new version on p1');
    const t2 = await ws2.waitForTick((t) => t.worldVersion === versionAfterCommit, 5000, 'tick at new version on p2');
    expect(t1.players.map((p) => p.id).sort()).toEqual([c1.playerId, c2.playerId].sort());
    expect(t2.players.map((p) => p.id).sort()).toEqual([c1.playerId, c2.playerId].sort());
    expect(playerIn(t1, c1.playerId)?.connected).toBe(true);
    expect(playerIn(t1, c2.playerId)?.connected).toBe(true);
    expect(t1.relics[firstRelicId!]).toBe('collected');
    expect(t1.score).toBe(SCORING.relic);
    expect(t1.lastInputSeq).toBeDefined();
    // Players still move after the commit (the new compiled world is live).
    const before = await currentPlayer(ws2, c2.playerId);
    const island = islandNear(spec, posOf(before));
    const d = { x: island.center.x - before.x, z: island.center.z - before.z };
    const l = Math.hypot(d.x, d.z) || 1;
    const hold = holdInput(ws2, ws2.axesFor(l > 0.5 ? { x: d.x / l, z: d.z / l } : { x: 1, z: 0 }));
    await sleep(300);
    hold.stop();
    await awaitTicks(ws2, 2);
    const after = await currentPlayer(ws2, c2.playerId);
    expect(dist(posOf(before), posOf(after))).toBeGreaterThan(0.4);
    const summary = (await agentWorld(server)).summary;
    expect(summary.players.filter((p) => p.connected).length).toBe(2);
    expect(summary.collectedRelicIds).toEqual([firstRelicId]);
  });
});

describe('case 16: a display behind on versions resyncs', () => {
  it('a display that sends resync haveVersion 0 after a commit receives a world message with the current version and spec', async () => {
    expect(versionAfterCommit).toBe(baseVersion + 1);
    // A display that connects late and only knows version 0.
    const late = await WsClient.connect(server, { name: 'late-display' });
    const welcome = await late.helloDisplay(0);
    expect(welcome.role).toBe('display');
    expect(welcome.worldVersion).toBe(versionAfterCommit);
    const since = late.cursor();
    late.resync(0);
    const world = await late.waitFor<WorldMessage>((m) => m.type === 'world' && m.reason === 'resync', 5000, { since, label: 'world resync' });
    expect(world.version).toBe(versionAfterCommit);
    expect(world.spec.worldVersion).toBe(versionAfterCommit);
    expect(world.spec.worldId).toBe(spec.worldId);
    expect(world.spec.islands.length).toBe(spec.islands.length);
    expect(world.spec.bridges.find((b) => b.id === occupiedBridgeId)).toBeUndefined();
    late.ack(world.version);
    const tick = await late.nextTick();
    expect(tick.worldVersion).toBe(versionAfterCommit);
    expect(tick.lastInputSeq).toBeUndefined();
    await late.close();
  });
});

describe('case 11: simultaneous pickup', () => {
  it('two controllers pressing interact near the same relic in the same tick award it once', async () => {
    const current = await agentWorld(server);
    spec = current.spec;
    const collected = current.summary.collectedRelicIds;
    const p1 = await currentPlayer(ws1, c1.playerId);
    const options = relicsByRouteLength(spec, posOf(p1), collected);
    expect(options.length).toBeGreaterThan(0);
    const relicId = options[0].relic.id;
    const target = relicPos(spec, relicId);
    // Both walk next to the relic (within relicPickupRadius 1.0, on opposite sides).
    await Promise.all([
      navigateTo(ws1, spec, c1.playerId, { x: target.x + 0.45, z: target.z }, { tolerance: 0.2, timeoutMs: 60_000 }),
      navigateTo(ws2, spec, c2.playerId, { x: target.x - 0.45, z: target.z }, { tolerance: 0.2, timeoutMs: 60_000 }),
    ]);
    const a = await currentPlayer(ws1, c1.playerId);
    const b = await currentPlayer(ws2, c2.playerId);
    expect(dist(posOf(a), target)).toBeLessThan(1.0);
    expect(dist(posOf(b), target)).toBeLessThan(1.0);
    const before = await awaitTicks(ws1, 2);
    expect(before.relics[relicId]).toBe('present');

    // Release, then press on both sockets back to back so the presses land in the same tick.
    ws1.input({ x: 0, z: 0 }, false);
    ws2.input({ x: 0, z: 0 }, false);
    await awaitTicks(ws1, 2);
    const since = ws1.cursor();
    ws1.input({ x: 0, z: 0 }, true);
    ws2.input({ x: 0, z: 0 }, true);
    const picked = await ws1.waitFor<TickMessage>((m) => m.type === 'tick' && m.relics[relicId] === 'collected', 3000, { since, label: 'relic collected' });
    ws1.input({ x: 0, z: 0 }, false);
    ws2.input({ x: 0, z: 0 }, false);
    expect(picked.score).toBe(before.score + SCORING.relic);
    const later = await awaitTicks(ws1, 15);
    expect(later.score).toBe(before.score + SCORING.relic);
    expect(Object.values(later.relics).filter((v) => v === 'collected').length).toBe(collected.length + 1);
    const summary = (await agentWorld(server)).summary;
    expect(summary.score).toBe(before.score + SCORING.relic);
    expect(summary.collectedRelicIds.filter((id) => id === relicId).length).toBe(1);
  }, 170_000);

  it('undo restores the previous layout but cannot duplicate collected relics or score', async () => {
    const before = await agentWorld(server);
    const scoreBefore = before.summary.score;
    const collectedBefore = [...before.summary.collectedRelicIds].sort();
    expect(display).not.toBeNull();
    const since = display!.cursor();
    const res = await directorFetch<CommitResult>(server, ROUTES.directorUndo, { method: 'POST', body: {}, timeoutMs: 30_000 });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    if (!res.json.ok) return;
    expect(res.json.worldVersion).toBe(before.version + 1);
    const world = await display!.waitFor<WorldMessage>((m) => m.type === 'world' && m.version === before.version + 1, 5000, { since, label: 'undo world message' });
    expect(world.spec.bridges.find((b) => b.id === occupiedBridgeId)).toBeDefined();
    const tick = await ws1.waitForTick((t) => t.worldVersion === before.version + 1, 5000, 'tick after undo');
    expect(tick.score).toBe(scoreBefore);
    const after = await agentWorld(server);
    expect([...after.summary.collectedRelicIds].sort()).toEqual(collectedBefore);
    expect(after.summary.score).toBe(scoreBefore);
    expect(after.summary.players.map((p) => p.id).sort()).toEqual([c1.playerId, c2.playerId].sort());
    expect(playerIn(tick, c1.playerId)?.connected).toBe(true);
    expect(playerIn(tick, c2.playerId)?.connected).toBe(true);
  }, 60_000);
});

describe('socket hygiene', () => {
  it('an unknown message shape gets one error reply and the socket stays open', async () => {
    const since = ws2.cursor();
    ws2.send({ type: 'bogus', hello: 'world' });
    const err = await ws2.waitFor((m) => m.type === 'error', 3000, { since, label: 'error reply' });
    expect(err.type).toBe('error');
    await awaitTicks(ws2, 2);
    expect(ws2.isOpen).toBe(true);
  });

  it('ping is answered with pong', async () => {
    const since = ws1.cursor();
    ws1.ping();
    const pong = await ws1.waitFor((m) => m.type === 'pong', 3000, { since, label: 'pong' });
    expect(pong.type).toBe('pong');
  });
});

// Keep unused-import lint quiet for helpers that are useful when debugging a failing run.
void apiFetch;
void driveTo;
void bridgeOf;
void otherEnd;
