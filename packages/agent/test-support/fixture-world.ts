// FIXTURE for agent tests and the fake Beetle server: a small valid WorldSpec (five garden islands, temple to the north).
// Hand-written so the agent package never imports @beetle/world.
import { GEOMETRY, SCORING, compassName, type SessionSummary, type WorldSpec } from '@beetle/contracts';

export function fixtureSpec(): WorldSpec {
  return {
    schemaVersion: 1,
    worldId: 'world-fixture',
    worldVersion: 1,
    seed: 42,
    title: 'Garden of Five (fixture)',
    biome: 'garden',
    bounds: { halfExtent: 60 },
    movementRulesVersion: 1,
    islands: [
      { id: 'isle-centre', name: 'Hearth', center: { x: 0, z: 0 }, radius: 8, topElevation: 0 },
      { id: 'isle-temple', name: 'Temple', center: { x: 0, z: 24 }, radius: 7, topElevation: 0 },
      { id: 'isle-east', name: 'Orchard', center: { x: 24, z: 0 }, radius: 6, topElevation: 0 },
      { id: 'isle-west', name: 'Quarry', center: { x: -24, z: 0 }, radius: 6, topElevation: 0 },
      { id: 'isle-south', name: 'Pond', center: { x: 0, z: -22 }, radius: 6, topElevation: 0 },
    ],
    bridges: [
      { id: 'bridge-temple', endpoints: [{ islandId: 'isle-centre', point: { x: 0, z: 8 } }, { islandId: 'isle-temple', point: { x: 0, z: 17 } }], width: 2.4 },
      { id: 'bridge-east', endpoints: [{ islandId: 'isle-centre', point: { x: 8, z: 0 } }, { islandId: 'isle-east', point: { x: 18, z: 0 } }], width: 2.4 },
      { id: 'bridge-west', endpoints: [{ islandId: 'isle-centre', point: { x: -8, z: 0 } }, { islandId: 'isle-west', point: { x: -18, z: 0 } }], width: 1.6 },
      { id: 'bridge-south', endpoints: [{ islandId: 'isle-centre', point: { x: 0, z: -8 } }, { islandId: 'isle-south', point: { x: 0, z: -16 } }], width: 2.4 },
    ],
    spawns: [
      { id: 'spawn-0', supportingSurfaceId: 'isle-centre', localPosition: { x: -2, z: -2 }, playerSlot: 0 },
      { id: 'spawn-1', supportingSurfaceId: 'isle-centre', localPosition: { x: 2, z: -2 }, playerSlot: 1 },
    ],
    relics: [
      { id: 'relic-sun', name: 'Sun Shard', supportingSurfaceId: 'isle-east', localPosition: { x: 1, z: 1 } },
      { id: 'relic-moon', name: 'Moon Shard', supportingSurfaceId: 'isle-west', localPosition: { x: -1, z: 1 } },
      { id: 'relic-star', name: 'Star Shard', supportingSurfaceId: 'isle-south', localPosition: { x: 0, z: -1 } },
    ],
    gate: { id: 'gate', supportingSurfaceId: 'isle-temple', localPosition: { x: 0, z: -5.5 }, requiredRelicIds: ['relic-sun', 'relic-moon', 'relic-star'] },
    hazard: { kind: 'water', planeElevation: GEOMETRY.hazardPlaneElevation, policy: { onContact: 'respawn', scorePenalty: 0 } },
    decorations: [
      { id: 'tree-1', type: 'tree', supportingSurfaceId: 'isle-centre', localPosition: { x: 4, z: 4 }, rotationDeg: 0, scale: 1 },
      { id: 'lantern-1', type: 'lantern', supportingSurfaceId: 'isle-temple', localPosition: { x: 3, z: 2 }, rotationDeg: 0, scale: 1 },
    ],
    objectiveRules: ['collect_all_relics_then_enter_gate'],
  };
}

export function fixtureSummary(spec: WorldSpec, collected: string[] = []): SessionSummary {
  return {
    worldVersion: spec.worldVersion,
    worldTitle: spec.title,
    elapsedSec: 12,
    players: [
      { id: 'p-0', label: 'Amber', onSurfaceId: 'isle-centre', status: 'active', connected: true },
      { id: 'p-1', label: 'Azure', onSurfaceId: null, status: 'disconnected', connected: false },
    ],
    collectedRelicIds: collected,
    remainingRelicIds: spec.relics.map((r) => r.id).filter((id) => !collected.includes(id)),
    gateUnlocked: false,
    won: false,
    score: collected.length * SCORING.relic,
    islands: spec.islands.map((i) => ({
      id: i.id,
      name: i.name ?? compassName(i.center),
      compass: compassName(i.center),
      bridgeIds: spec.bridges.filter((b) => b.endpoints.some((e) => e.islandId === i.id)).map((b) => b.id),
    })),
  };
}
