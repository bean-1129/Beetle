// Integration tests for streaming generation against the real server (in-process, port 0) and a real WebSocket
// controller. With spec.streaming true, a connected active player within STREAMING.frontierMeters of its island's rim,
// on a side with no crossing within 45 degrees, makes the server queue an automatic `edit` request (auto true,
// autoReason { islandId, direction, playerId }); at most one is in flight and they are STREAMING.cooldownMs apart;
// POST /api/director/settings { autoExpand: false } turns it off. No agent worker runs here: requests are observed
// through GET /api/director/activity and GET /api/director/requests/:id only, and the add_island commit in (d) goes
// through the agent HTTP API (stage, validate, commit) exactly like modes-helpers.commitPatch.
//
// World: fixture seed2 when present, else an inline two-island world with the same layout (streaming-helpers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GEOMETRY, STREAMING, type WorldSpec } from '@beetle/contracts';
import {
  awaitTicks, collectRelic, currentPlayer, driveTo, navigateTo, playerIn, posOf, sleep,
  type ServerHandle,
} from '../support/server-harness.ts';
import { closePair, commitPatch, startServerWithSpec } from '../support/modes-helpers.ts';
import {
  autoRequests, claimAndCancel, collectedOf, getRequest, islandReachable, openHeading, patrol, publicWorld, rimDistance, rimPoint,
  setAutoExpand, streamingWorld, ticksAroundVersion, waitForNewAutoRequest, directionMatches, type Solo, joinSolo,
} from '../support/streaming-helpers.ts';
import { dist, islandOf } from '../support/world-geom.ts';

const world = streamingWorld();
// eslint-disable-next-line no-console
console.log(`[streaming] world: ${world.source} (${world.note})`);

const SPAWN_ISLAND = world.spec.spawns[0].supportingSurfaceId;
/** Detection budget: the server checks the frontier on its tick; allow generous slack for scheduling. */
const DETECT_MS = 5000;

function spawnIslandOf(spec: WorldSpec) {
  return islandOf(spec, SPAWN_ISLAND);
}

// ---------------------------------------------------------------------------------------------------------
// (a) + (b): centre stays quiet; a rim approach on the open side creates exactly one request; cooldown holds.
// ---------------------------------------------------------------------------------------------------------
describe('streaming (a, b): frontier detection and cooldown', () => {
  let server: ServerHandle;
  let spec: WorldSpec;
  let p: Solo;

  beforeAll(async () => {
    server = await startServerWithSpec(world.spec);
    spec = (await publicWorld(server)).spec;
    p = await joinSolo(server);
  }, 120_000);

  afterAll(async () => {
    if (p) await closePair([p]);
    if (server) await server.stop();
  });

  it('(a) no automatic request while the player stays in the island centre', async () => {
    expect(spec.streaming).toBe(true);
    const island = spawnIslandOf(spec);
    const a = { x: island.center.x - 2, z: island.center.z - 1 };
    const b = { x: island.center.x + 2, z: island.center.z - 1 };
    await driveTo(p.ws, p.c.playerId, a, { tolerance: 0.4, timeoutMs: 15_000 });
    const since = p.ws.cursor();
    const walk = patrol(p.ws, p.c.playerId, a, b);
    try {
      await sleep(4000);
    } finally {
      walk.stop();
    }
    const ticks = p.ws.ticksSince(since);
    expect(ticks.length).toBeGreaterThan(60);
    const minRim = Math.min(...ticks.map((t) => rimDistance(island, posOf(playerIn(t, p.c.playerId)!))));
    expect(minRim).toBeGreaterThan(STREAMING.frontierMeters); // never entered the frontier band
    expect(walk.legs()).toBeGreaterThanOrEqual(1); // the player really moved
    expect(await autoRequests(server)).toEqual([]);
  });

  it('(b) a rim approach away from the only bridge creates exactly one automatic request; a second approach within the cooldown creates none', async () => {
    const island = spawnIslandOf(spec);
    const heading = openHeading(spec, island.id);
    const target = rimPoint(island, heading, 1.5, 1.2);
    expect(rimDistance(island, target)).toBeLessThan(STREAMING.frontierMeters);

    await driveTo(p.ws, p.c.playerId, target, { tolerance: 0.35, timeoutMs: 20_000 });
    const arrivedAt = Date.now();
    const req = await waitForNewAutoRequest(server, [], DETECT_MS);
    expect(req, `no automatic request within ${DETECT_MS} ms of reaching (${target.x.toFixed(1)}, ${target.z.toFixed(1)}) on ${island.id}`).not.toBeNull();
    const firstSeenAt = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[streaming] auto request ${req!.id} seen ${firstSeenAt - arrivedAt} ms after arrival: ${JSON.stringify({ autoReason: req!.autoReason, prompt: req!.prompt })}`);

    expect(req!.kind).toBe('edit');
    expect(req!.auto).toBe(true);
    expect(req!.autoReason?.islandId).toBe(island.id);
    expect(req!.autoReason?.playerId).toBe(p.c.playerId);
    expect(typeof req!.autoReason?.direction).toBe('string');
    expect(directionMatches(req!.autoReason!.direction, heading), `direction "${req!.autoReason!.direction}" vs expected heading ${heading} deg`).toBe(true);
    expect(req!.prompt).toMatch(/island/i);
    expect(req!.prompt.toLowerCase()).toContain(req!.autoReason!.direction.toLowerCase());
    // (e) no worker: the request just sits in the queue and is visible by id.
    const byId = await getRequest(server, req!.id);
    expect(byId?.id).toBe(req!.id);
    expect(byId?.status).toBe('queued');
    expect(byId?.claimedBy).toBeUndefined();

    // Still at the rim: no duplicate.
    await sleep(1500);
    expect((await autoRequests(server)).map((r) => r.id)).toEqual([req!.id]);

    // Take it out of flight so only the cooldown can hold the next one back, then approach again.
    await claimAndCancel(server, req!.id);
    expect((await getRequest(server, req!.id))?.status).toBe('cancelled');
    await driveTo(p.ws, p.c.playerId, { x: island.center.x, z: island.center.z - 1 }, { tolerance: 0.5, timeoutMs: 15_000 });
    await driveTo(p.ws, p.c.playerId, rimPoint(island, heading, 1.5, -1.2), { tolerance: 0.35, timeoutMs: 15_000 });
    const back = await currentPlayer(p.ws, p.c.playerId);
    expect(rimDistance(island, posOf(back))).toBeLessThan(STREAMING.frontierMeters);
    const holdUntil = firstSeenAt + STREAMING.cooldownMs - 1500;
    expect(Date.now(), 'second approach took longer than the cooldown').toBeLessThan(holdUntil);
    while (Date.now() < holdUntil) {
      expect((await autoRequests(server)).map((r) => r.id)).toEqual([req!.id]);
      await sleep(400);
    }
    expect((await autoRequests(server)).map((r) => r.id)).toEqual([req!.id]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// (c) autoExpand false
// ---------------------------------------------------------------------------------------------------------
describe('streaming (c): director switch', () => {
  let server: ServerHandle;
  let spec: WorldSpec;
  let p: Solo;

  beforeAll(async () => {
    server = await startServerWithSpec(world.spec);
    spec = (await publicWorld(server)).spec;
    p = await joinSolo(server);
  }, 120_000);

  afterAll(async () => {
    if (p) await closePair([p]);
    if (server) await server.stop();
  });

  it('(c) with autoExpand false no request is created at the frontier; switching it back on resumes detection', async () => {
    const off = await setAutoExpand(server, false);
    expect(off.status, off.text).toBe(200);
    if (off.autoExpand !== null) expect(off.autoExpand).toBe(false);

    const island = spawnIslandOf(spec);
    const heading = openHeading(spec, island.id);
    await driveTo(p.ws, p.c.playerId, rimPoint(island, heading, 1.5, 1.2), { tolerance: 0.35, timeoutMs: 20_000 });
    const at = await currentPlayer(p.ws, p.c.playerId);
    expect(rimDistance(island, posOf(at))).toBeLessThan(STREAMING.frontierMeters);
    expect(await waitForNewAutoRequest(server, [], 4000)).toBeNull();
    // Walk along the rim band too: still nothing.
    await driveTo(p.ws, p.c.playerId, rimPoint(island, heading, 1.5, -1.5), { tolerance: 0.35, timeoutMs: 10_000 });
    await sleep(1000);
    expect(await autoRequests(server)).toEqual([]);

    // Control: on again, leave and re-enter the band, and the request appears (the check above was not vacuous).
    const on = await setAutoExpand(server, true);
    expect(on.status, on.text).toBe(200);
    await driveTo(p.ws, p.c.playerId, { x: island.center.x, z: island.center.z - 1 }, { tolerance: 0.5, timeoutMs: 15_000 });
    await driveTo(p.ws, p.c.playerId, rimPoint(island, heading, 1.5, 1.2), { tolerance: 0.35, timeoutMs: 15_000 });
    const req = await waitForNewAutoRequest(server, [], DETECT_MS);
    expect(req, 'no automatic request after autoExpand was switched back on').not.toBeNull();
    expect(req!.autoReason?.islandId).toBe(island.id);
  });
});

// ---------------------------------------------------------------------------------------------------------
// (d) add_island commit while walking
// ---------------------------------------------------------------------------------------------------------
describe('streaming (d): add_island committed while the player walks', () => {
  let server: ServerHandle;
  let spec: WorldSpec;
  let p: Solo;

  beforeAll(async () => {
    server = await startServerWithSpec(world.spec);
    spec = (await publicWorld(server)).spec;
    p = await joinSolo(server);
  }, 120_000);

  afterAll(async () => {
    if (p) await closePair([p]);
    if (server) await server.stop();
  });

  it('(d) version +1, same player id and continuous position, relics and score kept, and the new island is reachable', async () => {
    const island = spawnIslandOf(spec);
    // Collect a relic first (the nearest one on the spawn island when there is one) so preservation means something.
    const relic = spec.relics.find((r) => r.supportingSurfaceId === island.id) ?? spec.relics[0];
    await collectRelic(p.ws, spec, p.c.playerId, relic.id, 60_000);

    const a = { x: island.center.x - 3, z: island.center.z - 1 };
    const b = { x: island.center.x + 3, z: island.center.z - 1 };
    await navigateTo(p.ws, spec, p.c.playerId, a, { tolerance: 0.4, timeoutMs: 30_000 });
    const walk = patrol(p.ws, p.c.playerId, a, b);
    let since = 0;
    let commitVersion = 0;
    let before = { version: 0, score: 0, collected: [] as string[], ids: [] as string[] };
    try {
      const t0 = Date.now();
      while (walk.legs() < 1 && Date.now() - t0 < 8000) await sleep(100);
      expect(walk.legs()).toBeGreaterThanOrEqual(1); // walking before the commit
      const base = p.ws.lastTick()!;
      before = { version: base.worldVersion, score: base.score, collected: collectedOf(base), ids: base.players.map((x) => x.id).sort() };
      expect(before.collected).toContain(relic.id);
      expect(before.score).toBeGreaterThan(0);

      const heading = openHeading(spec, island.id);
      const rad = (heading * Math.PI) / 180;
      const reach = island.radius + 8 + 7;
      since = p.ws.cursor();
      const result = await commitPatch(server, 'stream-add', 'Extend the world with a new island', [{
        op: 'add_island', id: 'stream-reach', name: 'Streaming Reach', radius: 7, bridgeFrom: island.id,
        center: { x: Math.round(island.center.x + Math.cos(rad) * reach), z: Math.round(island.center.z + Math.sin(rad) * reach) },
      }]);
      commitVersion = result.worldVersion;
      expect(commitVersion).toBe(before.version + 1);
      await p.ws.waitForTick((t) => t.worldVersion === commitVersion, 10_000, 'tick at the new version');
      await awaitTicks(p.ws, 10); // keep walking across the commit
    } finally {
      walk.stop();
    }

    // Tick stream around the version change: same player, no teleport, still connected and active.
    const { before: tb, after: ta } = ticksAroundVersion(p.ws, since, commitVersion);
    expect(tb && ta).toBeTruthy();
    const pb = playerIn(tb!, p.c.playerId)!;
    const pa = playerIn(ta!, p.c.playerId)!;
    expect(pa).toBeDefined();
    expect(ta!.players.map((x) => x.id).sort()).toEqual(before.ids);
    expect(pa.connected).toBe(true);
    expect(pa.status).toBe('active');
    expect(Math.hypot(pb.vx, pb.vz) + Math.hypot(pa.vx, pa.vz)).toBeGreaterThan(0.5); // moving across the commit
    const gapS = Math.max(1, ta!.serverMs - tb!.serverMs) / 1000;
    expect(dist(posOf(pb), posOf(pa))).toBeLessThan(GEOMETRY.playerSpeed * 1.6 * gapS + 0.3);
    expect(collectedOf(ta!)).toEqual(before.collected);
    expect(ta!.score).toBe(before.score);
    expect(ta!.relics[relic.id]).toBe('collected');

    // The public world has the island and a crossing that touches both rims and joins the bridge graph.
    const live = await publicWorld(server);
    expect(live.version).toBe(commitVersion);
    expect(live.spec.islands.map((i) => i.id)).toContain('stream-reach');
    expect(live.spec.islands.length).toBe(spec.islands.length + 1);
    for (const r of spec.relics) expect(live.spec.relics.find((x) => x.id === r.id)?.supportingSurfaceId).toBe(r.supportingSurfaceId);
    const reach = islandReachable(live.spec, 'stream-reach', island.id);
    expect(reach.ok, reach.detail).toBe(true);

    // And it is walkable: the player crosses onto the new island.
    const newIsland = islandOf(live.spec, 'stream-reach');
    const there = await navigateTo(p.ws, live.spec, p.c.playerId, { x: newIsland.center.x, z: newIsland.center.z }, { tolerance: 0.5, timeoutMs: 40_000 });
    const settled = playerIn(await awaitTicks(p.ws, 2), p.c.playerId) ?? there;
    expect(settled.supportId).toBe('stream-reach');
    expect(settled.id).toBe(p.c.playerId);
  });
});
