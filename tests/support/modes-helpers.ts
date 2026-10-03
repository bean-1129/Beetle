// Helpers for the game-mode integration tests (tests/integration/modes.test.ts). Builds mode worlds from the
// packages/world fixtures when they exist (race5, hill4, survival5, trial5) and otherwise derives them from garden5,
// starts the real server with a given spec, joins two controllers, and drives players into the gate trigger zone.
import { GEOMETRY, SCORING, type TickMessage, type WorldSpec } from '@beetle/contracts';
import { fixtureWorld } from '@beetle/world';
import {
  WsClient, awaitTicks, commitUntilSettled, currentPlayer, driveTo, joinController, navigateTo, playerIn, posOf, pressInteract,
  requestIdFor, stageAndValidate, startServer, validateCandidate,
  type Controller, type ServerHandle,
} from './server-harness.ts';
import { bridgesTouching, dist, endpointOn, gatePos, islandOf, moveToward, otherEnd, relicPos } from './world-geom.ts';

export type ModeWorldName = 'race5' | 'hill4' | 'survival5' | 'trial5';

/** Survival timing used for the garden5-derived world: the plane passes -1.0 m at afterSec + 0.8 s. */
export const SURVIVAL_RISE = { afterSec: 20, metersPerSec: 0.5, maxElevation: -0.6 } as const;
export const SURVIVAL_PLANE = -1.4;
export const HILL_HOLD_SECONDS = 3;
export const TRIAL_TIME_LIMIT_SEC = 20;

/** The packages/world fixture when the world owner has added it, else null. */
export function fixtureIfPresent(name: ModeWorldName): WorldSpec | null {
  try {
    return fixtureWorld(name as never) as WorldSpec;
  } catch {
    return null;
  }
}

/** garden5 with the mode (and for survival the hazard rise) applied, as a plain spec object. */
export function derivedModeWorld(name: ModeWorldName): WorldSpec {
  const base = fixtureWorld('garden5') as WorldSpec;
  const spec: WorldSpec = JSON.parse(JSON.stringify(base));
  spec.worldId = name;
  switch (name) {
    case 'race5':
      spec.title = 'Checkpoint race (derived from garden5)';
      spec.mode = { kind: 'checkpoint_race', orderedCheckpoints: true };
      break;
    case 'hill4':
      spec.title = 'King of the hill (derived from garden5)';
      spec.mode = { kind: 'king_of_the_hill', holdSeconds: HILL_HOLD_SECONDS };
      break;
    case 'survival5':
      spec.title = 'Survival (derived from garden5)';
      spec.mode = { kind: 'survival' };
      spec.hazard = {
        kind: 'lava', planeElevation: SURVIVAL_PLANE, policy: { onContact: 'respawn', scorePenalty: SCORING.lavaFallPenalty },
        rise: { ...SURVIVAL_RISE },
      };
      break;
    case 'trial5':
      spec.title = 'Time trial (derived from garden5)';
      spec.mode = { kind: 'time_trial', timeLimitSec: TRIAL_TIME_LIMIT_SEC };
      break;
  }
  return spec;
}

/** Bridges submerge once the hazard plane rises above this elevation (HazardSchema: "bridges below -1.0 m submerge"). */
export const BRIDGE_SUBMERGE_ELEVATION = -1.0;

/**
 * Seconds until the survival plane passes -1.0 m, counted from when the rise clock starts; null when the world has no
 * rise or its maxElevation never lets the plane reach -1.0 (bridges would never submerge).
 */
export function secondsUntilSubmerged(spec: WorldSpec): number | null {
  const rise = spec.hazard.rise;
  if (!rise) return null;
  if (rise.maxElevation <= BRIDGE_SUBMERGE_ELEVATION) return null;
  const metres = BRIDGE_SUBMERGE_ELEVATION - spec.hazard.planeElevation;
  if (metres <= 0) return rise.afterSec;
  return rise.afterSec + metres / rise.metersPerSec;
}

/**
 * The world for a mode test: the owner's fixture when present and usable for the test's timing, else the derived
 * garden5 variant. The result says which so the test log is honest about what ran.
 */
export function modeWorld(name: ModeWorldName): { spec: WorldSpec; source: 'fixture' | 'derived-garden5' } {
  const fixture = fixtureIfPresent(name);
  if (fixture) {
    if (name === 'survival5') {
      const budget = secondsUntilSubmerged(fixture);
      // Players need roughly 10 s to join, calibrate and walk onto a bridge; a faster fixture would be a flaky test.
      if (budget !== null && budget >= 15 && budget <= 120) return { spec: fixture, source: 'fixture' };
    } else {
      return { spec: fixture, source: 'fixture' };
    }
  }
  return { spec: derivedModeWorld(name), source: 'derived-garden5' };
}

/** Starts the real server in-process with the given spec installed as version 1. */
export async function startServerWithSpec(spec: WorldSpec): Promise<ServerHandle> {
  // The harness forwards startWorld to createBeetleServer unchanged, which accepts a WorldSpec in-process.
  return startServer({ startWorld: spec as unknown as 'fixture', mode: 'in-process' });
}

export type Pair = { c: Controller; ws: WsClient };

/** Two controllers joined over HTTP and connected over WebSocket, both reported connected, axes calibrated. */
export async function joinPair(server: ServerHandle, calibrate = true): Promise<[Pair, Pair]> {
  const c1 = await joinController(server);
  const c2 = await joinController(server);
  const ws1 = await WsClient.connect(server, { name: 'p1' });
  const ws2 = await WsClient.connect(server, { name: 'p2' });
  const w1 = await ws1.helloController(c1.controllerToken);
  const w2 = await ws2.helloController(c2.controllerToken);
  if (w1.playerId !== c1.playerId || w2.playerId !== c2.playerId) throw new Error('welcome playerId mismatch');
  await ws1.waitForTick((t) => Boolean(playerIn(t, c1.playerId)?.connected && playerIn(t, c2.playerId)?.connected), 10_000, 'both players connected');
  await ws2.waitForTick((t) => Boolean(playerIn(t, c2.playerId)?.connected), 10_000, 'p2 connected');
  if (calibrate) {
    await ws1.calibrateAxes(c1.playerId);
    await ws2.calibrateAxes(c2.playerId);
    await awaitTicks(ws1, 2);
  }
  return [{ c: c1, ws: ws1 }, { c: c2, ws: ws2 }];
}

export async function closePair(pairs: Pair[]): Promise<void> {
  for (const p of pairs) await p.ws.close().catch(() => undefined);
}

/** Stage, validate and commit a patch through the agent HTTP API; throws with the server's answer on failure. */
export async function commitPatch(server: ServerHandle, label: string, summary: string, ops: unknown[]): Promise<{ worldVersion: number; candidateId: string }> {
  const staged = await stageAndValidate(server, requestIdFor(label), { summary, ops });
  let result = await commitUntilSettled(server, staged.candidateId, staged.proofId);
  if (!result.ok && (result.code === 'NOT_VALIDATED' || result.code === 'VALIDATION_EXPIRED')) {
    const again = await validateCandidate(server, staged.candidateId);
    if (!again.ok || !again.proof) throw new Error(`re-validation failed: ${JSON.stringify(again.issues)}`);
    result = await commitUntilSettled(server, staged.candidateId, again.proof.proofId);
  }
  if (!result.ok) throw new Error(`commit of ${label} failed: ${result.code} ${result.message} (objects ${result.objectIds.join(',')})`);
  return { worldVersion: result.worldVersion, candidateId: staged.candidateId };
}

/** Walks next to a relic (without pressing interact) and returns the player's view there. */
export async function standNearRelic(ws: WsClient, spec: WorldSpec, playerId: string, relicId: string, timeoutMs = 60_000) {
  const target = relicPos(spec, relicId);
  const view = await navigateTo(ws, spec, playerId, target, { tolerance: 0.35, timeoutMs });
  const settled = await awaitTicks(ws, 2);
  const p = playerIn(settled, playerId) ?? view;
  if (dist(posOf(p), target) > GEOMETRY.relicPickupRadius) throw new Error(`player ${playerId} is ${dist(posOf(p), target).toFixed(2)} m from ${relicId}, outside the pickup radius`);
  return p;
}

/**
 * Presses interact next to a relic and reports whether the tick stream shows it collected within a short window.
 * Used for the "must NOT collect" checks; the caller asserts on the result.
 */
export async function pressNearRelic(ws: WsClient, playerId: string, relicId: string, windowTicks = 15): Promise<{ collected: boolean; tick: TickMessage }> {
  const me = await currentPlayer(ws, playerId);
  if (me.status !== 'active') await ws.waitForTick((t) => playerIn(t, playerId)?.status === 'active', 10_000, 'player active');
  const since = ws.cursor();
  await pressInteract(ws);
  const hit = await ws.waitFor<TickMessage>((m) => m.type === 'tick' && m.relics[relicId] === 'collected', Math.max(1000, windowTicks * (1000 / 30) + 300), { since, label: `relic ${relicId} collected` }).catch(() => null);
  if (hit) return { collected: true, tick: hit };
  const tick = await awaitTicks(ws, 2);
  return { collected: false, tick };
}

/** The bridge on the gate island whose endpoint is nearest to the gate (the side the trigger zone is reached from). */
export function gateApproach(spec: WorldSpec): { gate: { x: number; z: number }; zone: { x: number; z: number }; entry: { x: number; z: number }; bridgeId: string } {
  const gate = gatePos(spec);
  const gateIslandId = spec.gate.supportingSurfaceId;
  const bridges = bridgesTouching(spec, gateIslandId);
  if (!bridges.length) throw new Error(`gate island ${gateIslandId} has no bridge`);
  const bridge = bridges.slice().sort((a, b) => dist(endpointOn(a, gateIslandId), gate) - dist(endpointOn(b, gateIslandId), gate))[0];
  const ep = endpointOn(bridge, gateIslandId);
  // 1.7 m from the gate centre toward the bridge: inside gateTriggerRadius (2.0), outside gateBlockRadius + playerRadius (1.55).
  const zone = moveToward(gate, ep, 1.7);
  const farIsland = islandOf(spec, otherEnd(bridge, gateIslandId));
  const entry = moveToward(endpointOn(bridge, farIsland.id), farIsland.center, 0.8);
  return { gate, zone, entry, bridgeId: bridge.id };
}

/** Drives the player onto the bridge mouth in front of the gate, inside the trigger radius; returns the settled view. */
export async function driveIntoGateZone(ws: WsClient, spec: WorldSpec, playerId: string, timeoutMs = 60_000) {
  const { gate, zone, entry } = gateApproach(spec);
  await navigateTo(ws, spec, playerId, entry, { tolerance: 0.3, timeoutMs });
  await driveTo(ws, playerId, zone, { tolerance: 0.15, timeoutMs });
  const settled = await awaitTicks(ws, 2);
  const p = playerIn(settled, playerId)!;
  const d = dist(posOf(p), gate);
  if (d > GEOMETRY.gateTriggerRadius) throw new Error(`player ${playerId} is ${d.toFixed(2)} m from the gate, outside the trigger radius ${GEOMETRY.gateTriggerRadius}`);
  return p;
}

/** Drives the player back out of the zone to the bridge entry on the far island. */
export async function leaveGateZone(ws: WsClient, spec: WorldSpec, playerId: string, timeoutMs = 60_000) {
  const { entry } = gateApproach(spec);
  await driveTo(ws, playerId, entry, { tolerance: 0.3, timeoutMs });
  return awaitTicks(ws, 2);
}

/** Largest serverMs gap between consecutive ticks (ms), or 0 for fewer than two ticks. */
export function maxTickGapMs(ticks: TickMessage[]): number {
  let max = 0;
  for (let i = 1; i < ticks.length; i++) max = Math.max(max, ticks[i].serverMs - ticks[i - 1].serverMs);
  return max;
}

export function holdSecOf(tick: TickMessage, playerId: string): number {
  return tick.objective?.holdSec?.[playerId] ?? 0;
}
