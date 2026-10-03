// FIXTURES. Hand-made development worlds for tests, demos and the benchmark. Clearly labelled; never used as a hidden
// switch for prompts. Every fixture is a valid WorldSpec by schema; the named failures are semantic (validator codes).
import { GEOMETRY, MOVEMENT_RULES_VERSION, SCHEMA_VERSION, WORLD_LIMITS, type WorldSpec } from '@beetle/contracts';
import type { FixtureName } from './types.ts';
import { hazardPolicyFor } from './patch.ts';
import { rimPointToward, round3 } from './geom.ts';

/** Bridge between two islands along their centre line, sockets derived as rim points (same rule as expandDraft/add_bridge). */
function link(islands: WorldSpec['islands'], id: string, from: string, to: string, width = 2.4): WorldSpec['bridges'][number] {
  const a = islands.find((i) => i.id === from)!;
  const b = islands.find((i) => i.id === to)!;
  const pa = rimPointToward(a.center, a.radius, b.center);
  const pb = rimPointToward(b.center, b.radius, a.center);
  return { id, endpoints: [{ islandId: a.id, point: { x: round3(pa.x), z: round3(pa.z) } }, { islandId: b.id, point: { x: round3(pb.x), z: round3(pb.z) } }], width };
}

function base(worldId: string, seed: number, title: string, biome: WorldSpec['biome']): Pick<WorldSpec, 'schemaVersion' | 'worldId' | 'worldVersion' | 'seed' | 'title' | 'biome' | 'bounds' | 'movementRulesVersion' | 'objectiveRules'> {
  return {
    schemaVersion: SCHEMA_VERSION, worldId, worldVersion: 0, seed, title, biome,
    bounds: { halfExtent: WORLD_LIMITS.bounds.halfExtent }, movementRulesVersion: MOVEMENT_RULES_VERSION,
    objectiveRules: ['collect_all_relics_then_enter_gate'],
  };
}

/**
 * FIXTURE race5: valid checkpoint_race, 90 s. A hub with both spawns links east to a loop of four islands
 * (east -> north -> west -> south -> east). The three relics are the ordered checkpoints on east, north and west;
 * the gate (finish) sits on the south island, reachable from both loop neighbours.
 */
function race5(): WorldSpec {
  const islands: WorldSpec['islands'] = [
    { id: 'hub', name: 'Starting Hub', center: { x: 0, z: 0 }, radius: 8, topElevation: 0 },
    { id: 'marker-1', name: 'First Marker', center: { x: 26, z: 0 }, radius: 7, topElevation: 0 },
    { id: 'marker-2', name: 'Second Marker', center: { x: 0, z: 26 }, radius: 7, topElevation: 0 },
    { id: 'marker-3', name: 'Third Marker', center: { x: -26, z: 0 }, radius: 7, topElevation: 0 },
    { id: 'finish', name: 'Finish Line', center: { x: 0, z: -26 }, radius: 7, topElevation: 0 },
  ];
  return {
    ...base('race5', 50501, 'Checkpoint Race on Five Islands (fixture)', 'garden'),
    islands,
    bridges: [
      link(islands, 'bridge-start', 'hub', 'marker-1', 2.4),
      link(islands, 'bridge-loop-1', 'marker-1', 'marker-2', 2.4),
      link(islands, 'bridge-loop-2', 'marker-2', 'marker-3', 2.4),
      link(islands, 'bridge-loop-3', 'marker-3', 'finish', 2.4),
      link(islands, 'bridge-loop-4', 'finish', 'marker-1', 2.4),
    ],
    spawns: [
      { id: 'spawn-0', supportingSurfaceId: 'hub', localPosition: { x: -2, z: -2 }, playerSlot: 0 },
      { id: 'spawn-1', supportingSurfaceId: 'hub', localPosition: { x: -2, z: 2 }, playerSlot: 1 },
    ],
    relics: [
      { id: 'checkpoint-1', name: 'Red Flag', supportingSurfaceId: 'marker-1', localPosition: { x: 1, z: 0 } },
      { id: 'checkpoint-2', name: 'Blue Flag', supportingSurfaceId: 'marker-2', localPosition: { x: 0, z: 1 } },
      { id: 'checkpoint-3', name: 'Gold Flag', supportingSurfaceId: 'marker-3', localPosition: { x: -1, z: 0 } },
    ],
    gate: { id: 'gate', supportingSurfaceId: 'finish', localPosition: { x: 0, z: -1 }, requiredRelicIds: ['checkpoint-1', 'checkpoint-2', 'checkpoint-3'] },
    hazard: { kind: 'water', planeElevation: GEOMETRY.hazardPlaneElevation, policy: hazardPolicyFor('water') },
    decorations: [
      { id: 'tree-hub', type: 'tree', supportingSurfaceId: 'hub', localPosition: { x: 0, z: 5 }, rotationDeg: 30, scale: 1 },
      { id: 'tower-1', type: 'tower', supportingSurfaceId: 'marker-1', localPosition: { x: 4.5, z: 3 }, rotationDeg: 0, scale: 1 },
      { id: 'statue-2', type: 'statue', supportingSurfaceId: 'marker-2', localPosition: { x: 3, z: 4 }, rotationDeg: 180, scale: 1 },
      { id: 'ruin-3', type: 'ruin', supportingSurfaceId: 'marker-3', localPosition: { x: -3, z: -3.5 }, rotationDeg: 90, scale: 1 },
      { id: 'lantern-finish', type: 'lantern', supportingSurfaceId: 'finish', localPosition: { x: 3, z: -4 }, rotationDeg: 0, scale: 1 },
    ],
    mode: { kind: 'checkpoint_race', timeLimitSec: 90, orderedCheckpoints: true },
  };
}

/**
 * FIXTURE hill4: valid king_of_the_hill (hold 10 s), frost biome, four islands. The base holds both spawns and one
 * relic; east and west hold the other relics; the summit to the north holds the gate (the hill zone).
 */
function hill4(): WorldSpec {
  const islands: WorldSpec['islands'] = [
    { id: 'base', name: 'Snowfield Base', center: { x: 0, z: 0 }, radius: 9, topElevation: 0 },
    { id: 'summit', name: 'Frozen Summit', center: { x: 0, z: 24 }, radius: 7, topElevation: 0 },
    { id: 'east', name: 'Icicle Shelf', center: { x: 22, z: 0 }, radius: 6, topElevation: 0 },
    { id: 'west', name: 'Glacier Ledge', center: { x: -22, z: 0 }, radius: 6, topElevation: 0 },
  ];
  return {
    ...base('hill4', 40404, 'King of the Frozen Hill (fixture)', 'frost'),
    islands,
    bridges: [
      link(islands, 'bridge-summit', 'base', 'summit', 2.4),
      link(islands, 'bridge-east', 'base', 'east', 2.4),
      link(islands, 'bridge-west', 'base', 'west', 2.0),
    ],
    spawns: [
      { id: 'spawn-0', supportingSurfaceId: 'base', localPosition: { x: -2, z: -2 }, playerSlot: 0 },
      { id: 'spawn-1', supportingSurfaceId: 'base', localPosition: { x: 2, z: -2 }, playerSlot: 1 },
    ],
    relics: [
      { id: 'relic-east', name: 'Ice Shard', supportingSurfaceId: 'east', localPosition: { x: 1.5, z: 0 } },
      { id: 'relic-west', name: 'Frost Gem', supportingSurfaceId: 'west', localPosition: { x: -1.5, z: 0 } },
      { id: 'relic-base', name: 'Snow Globe', supportingSurfaceId: 'base', localPosition: { x: 0, z: 4 } },
    ],
    gate: { id: 'gate', supportingSurfaceId: 'summit', localPosition: { x: 0, z: 0 }, requiredRelicIds: ['relic-east', 'relic-west', 'relic-base'] },
    hazard: { kind: 'water', planeElevation: GEOMETRY.hazardPlaneElevation, policy: hazardPolicyFor('water') },
    decorations: [
      { id: 'crystal-summit', type: 'crystal', supportingSurfaceId: 'summit', localPosition: { x: 4, z: 3 }, rotationDeg: 0, scale: 1 },
      { id: 'crystal-east', type: 'crystal', supportingSurfaceId: 'east', localPosition: { x: 3, z: 3 }, rotationDeg: 45, scale: 1 },
      { id: 'tower-base', type: 'tower', supportingSurfaceId: 'base', localPosition: { x: -5, z: 4 }, rotationDeg: 0, scale: 1 },
      { id: 'mushroom-west', type: 'mushroom', supportingSurfaceId: 'west', localPosition: { x: -2, z: 3 }, rotationDeg: 0, scale: 1 },
    ],
    mode: { kind: 'king_of_the_hill', holdSeconds: 10 },
  };
}

/** FIXTURE survival5: the garden5 layout as a 120 s survival map: volcanic biome, lava that rises after 20 s. */
function survival5(): WorldSpec {
  const spec = garden5();
  return {
    ...spec,
    ...base('survival5', 55505, 'Survive the Rising Lava (fixture)', 'volcanic'),
    hazard: {
      kind: 'lava', planeElevation: GEOMETRY.hazardPlaneElevation, policy: hazardPolicyFor('lava'),
      rise: { afterSec: 20, metersPerSec: 0.05, maxElevation: -0.7 },
    },
    decorations: [
      { id: 'ruin-1', type: 'ruin', supportingSurfaceId: 'centre', localPosition: { x: 5, z: 5 }, rotationDeg: 20, scale: 1 },
      { id: 'statue-1', type: 'statue', supportingSurfaceId: 'centre', localPosition: { x: -5, z: 5 }, rotationDeg: 200, scale: 1.1 },
      { id: 'rock-1', type: 'rock', supportingSurfaceId: 'east', localPosition: { x: -1, z: 4 }, rotationDeg: 0, scale: 1 },
      { id: 'crystal-1', type: 'crystal', supportingSurfaceId: 'temple', localPosition: { x: 3, z: 3 }, rotationDeg: 0, scale: 1 },
      { id: 'ruin-2', type: 'ruin', supportingSurfaceId: 'temple', localPosition: { x: 0, z: 4 }, rotationDeg: 180, scale: 1 },
      { id: 'rock-2', type: 'rock', supportingSurfaceId: 'south', localPosition: { x: 3, z: -3 }, rotationDeg: 0, scale: 1 },
      { id: 'pillar-1', type: 'pillar', supportingSurfaceId: 'west', localPosition: { x: 2, z: 3.5 }, rotationDeg: 0, scale: 1 },
    ],
    mode: { kind: 'survival', timeLimitSec: 120 },
  };
}

/** FIXTURE trial5: the garden5 layout as a 60 s time trial in the desert, with a faster 5.5 m/s walk. */
function trial5(): WorldSpec {
  const spec = garden5();
  return {
    ...spec,
    ...base('trial5', 50555, 'Desert Dash (fixture)', 'desert'),
    decorations: [
      { id: 'statue-1', type: 'statue', supportingSurfaceId: 'centre', localPosition: { x: 5, z: 5 }, rotationDeg: 20, scale: 1 },
      { id: 'rock-1', type: 'rock', supportingSurfaceId: 'centre', localPosition: { x: -5, z: 5 }, rotationDeg: 200, scale: 1.1 },
      { id: 'rock-2', type: 'rock', supportingSurfaceId: 'east', localPosition: { x: -1, z: 4 }, rotationDeg: 0, scale: 1 },
      { id: 'ruin-1', type: 'ruin', supportingSurfaceId: 'temple', localPosition: { x: 3, z: 3 }, rotationDeg: 0, scale: 1 },
      { id: 'pillar-1', type: 'pillar', supportingSurfaceId: 'temple', localPosition: { x: 0, z: 4 }, rotationDeg: 180, scale: 1 },
      { id: 'bush-1', type: 'bush', supportingSurfaceId: 'south', localPosition: { x: 3, z: -3 }, rotationDeg: 0, scale: 1 },
      { id: 'pillar-2', type: 'pillar', supportingSurfaceId: 'west', localPosition: { x: 2, z: 3.5 }, rotationDeg: 0, scale: 1 },
    ],
    mode: { kind: 'time_trial', timeLimitSec: 60 },
    movement: { speed: 5.5 },
  };
}

/**
 * FIXTURE garden5: valid.
 * Layout (metres, +Z north, +X east):
 *   centre island (0,0) r9 holds both spawns.
 *   temple island (0,28) r8 to the north holds the gate at the mouth of its only bridge (bridge-north), so the locked
 *     gate blocks that bridge entrance; the gate trigger is reachable from the bridge side.
 *   east (24,0) r7, west (-24,0) r7, south (0,-26) r7 each hold one relic.
 *   bridge-east is wide and safe (2.4 m); bridge-west is a narrow 1.6 m risky bridge.
 *   decorations sit away from every route.
 */
function garden5(): WorldSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    worldId: 'garden5',
    worldVersion: 0,
    seed: 12345,
    title: 'Garden of Five Islands (fixture)',
    biome: 'garden',
    bounds: { halfExtent: WORLD_LIMITS.bounds.halfExtent },
    movementRulesVersion: MOVEMENT_RULES_VERSION,
    islands: [
      { id: 'centre', name: 'Hearth Island', center: { x: 0, z: 0 }, radius: 9, topElevation: 0 },
      { id: 'temple', name: 'Temple Island', center: { x: 0, z: 28 }, radius: 8, topElevation: 0 },
      { id: 'east', name: 'Orchard Island', center: { x: 24, z: 0 }, radius: 7, topElevation: 0 },
      { id: 'west', name: 'Mossy Island', center: { x: -24, z: 0 }, radius: 7, topElevation: 0 },
      { id: 'south', name: 'Lantern Island', center: { x: 0, z: -26 }, radius: 7, topElevation: 0 },
    ],
    bridges: [
      { id: 'bridge-north', endpoints: [{ islandId: 'centre', point: { x: 0, z: 9 } }, { islandId: 'temple', point: { x: 0, z: 20 } }], width: 2.4 },
      { id: 'bridge-east', endpoints: [{ islandId: 'centre', point: { x: 9, z: 0 } }, { islandId: 'east', point: { x: 17, z: 0 } }], width: 2.4 },
      { id: 'bridge-west', endpoints: [{ islandId: 'centre', point: { x: -9, z: 0 } }, { islandId: 'west', point: { x: -17, z: 0 } }], width: 1.6 },
      { id: 'bridge-south', endpoints: [{ islandId: 'centre', point: { x: 0, z: -9 } }, { islandId: 'south', point: { x: 0, z: -19 } }], width: 2.4 },
    ],
    spawns: [
      { id: 'spawn-0', supportingSurfaceId: 'centre', localPosition: { x: -2, z: -2 }, playerSlot: 0 },
      { id: 'spawn-1', supportingSurfaceId: 'centre', localPosition: { x: 2, z: -2 }, playerSlot: 1 },
    ],
    relics: [
      { id: 'relic-east', name: 'Sun Relic', supportingSurfaceId: 'east', localPosition: { x: 2, z: 0 } },
      { id: 'relic-west', name: 'Moon Relic', supportingSurfaceId: 'west', localPosition: { x: -2, z: 0 } },
      { id: 'relic-south', name: 'Star Relic', supportingSurfaceId: 'south', localPosition: { x: 0, z: -2 } },
    ],
    gate: { id: 'gate', supportingSurfaceId: 'temple', localPosition: { x: 0, z: -7.5 }, requiredRelicIds: ['relic-east', 'relic-west', 'relic-south'] },
    hazard: { kind: 'water', planeElevation: GEOMETRY.hazardPlaneElevation, policy: hazardPolicyFor('water') },
    decorations: [
      { id: 'tree-1', type: 'tree', supportingSurfaceId: 'centre', localPosition: { x: 5, z: 5 }, rotationDeg: 20, scale: 1 },
      { id: 'tree-2', type: 'tree', supportingSurfaceId: 'centre', localPosition: { x: -5, z: 5 }, rotationDeg: 200, scale: 1.1 },
      { id: 'rock-1', type: 'rock', supportingSurfaceId: 'east', localPosition: { x: -1, z: 4 }, rotationDeg: 0, scale: 1 },
      { id: 'lantern-1', type: 'lantern', supportingSurfaceId: 'temple', localPosition: { x: 3, z: 3 }, rotationDeg: 0, scale: 1 },
      { id: 'shrine-1', type: 'shrine', supportingSurfaceId: 'temple', localPosition: { x: 0, z: 4 }, rotationDeg: 180, scale: 1 },
      { id: 'bush-1', type: 'bush', supportingSurfaceId: 'south', localPosition: { x: 3, z: -3 }, rotationDeg: 0, scale: 1 },
      { id: 'pillar-1', type: 'pillar', supportingSurfaceId: 'west', localPosition: { x: 2, z: 3.5 }, rotationDeg: 0, scale: 1 },
    ],
    objectiveRules: ['collect_all_relics_then_enter_gate'],
  };
}

export function fixtureWorld(name: FixtureName = 'garden5'): WorldSpec {
  const spec = garden5();
  switch (name) {
    case 'garden5':
      return spec;
    case 'garden5-gapped-bridge': {
      // FIXTURE: bridge-east's east endpoint sits 1.5 m short of the east island rim (rim at x=17).
      // The graph says connected; the geometry says gap -> BRIDGE_ENDPOINT_GAP.
      spec.worldId = 'garden5-gapped-bridge';
      spec.title = 'Garden with a gapped bridge (fixture)';
      const b = spec.bridges.find((x) => x.id === 'bridge-east')!;
      b.endpoints[1].point = { x: 15.5, z: 0 };
      return spec;
    }
    case 'garden5-gate-hides-relic': {
      // FIXTURE: the sun relic moves onto the temple island behind the locked gate -> GATE_HIDES_RELIC.
      spec.worldId = 'garden5-gate-hides-relic';
      spec.title = 'Garden where the gate hides a relic (fixture)';
      const r = spec.relics.find((x) => x.id === 'relic-east')!;
      r.supportingSurfaceId = 'temple';
      r.localPosition = { x: 2, z: 1 };
      return spec;
    }
    case 'garden5-blocked-path': {
      // FIXTURE: a shrine and two rocks fully block the south island's bridge mouth, so relic-south is unreachable
      // -> UNREACHABLE_RELIC. The decorations are valid objects on the island (schema and on-surface pass).
      spec.worldId = 'garden5-blocked-path';
      spec.title = 'Garden with a blocked path (fixture)';
      spec.decorations.push(
        { id: 'block-shrine', type: 'shrine', supportingSurfaceId: 'south', localPosition: { x: 0, z: 5.9 }, rotationDeg: 0, scale: 1 },
        { id: 'block-rock-e', type: 'rock', supportingSurfaceId: 'south', localPosition: { x: 1.8, z: 5.8 }, rotationDeg: 0, scale: 1 },
        { id: 'block-rock-w', type: 'rock', supportingSurfaceId: 'south', localPosition: { x: -1.8, z: 5.8 }, rotationDeg: 0, scale: 1 },
      );
      return spec;
    }
    case 'garden4-no-temple-bridge': {
      // FIXTURE: the temple island has no bridge at all -> DISCONNECTED_GOAL (four bridged islands plus a stranded temple).
      spec.worldId = 'garden4-no-temple-bridge';
      spec.title = 'Garden with a stranded temple (fixture)';
      spec.bridges = spec.bridges.filter((b) => b.id !== 'bridge-north');
      return spec;
    }
    case 'race5':
      return race5();
    case 'hill4':
      return hill4();
    case 'survival5':
      return survival5();
    case 'trial5':
      return trial5();
    default: {
      const never: never = name;
      throw new Error(`unknown fixture ${String(never)}`);
    }
  }
}

export const FIXTURE_NAMES: FixtureName[] = ['garden5', 'garden5-gapped-bridge', 'garden5-gate-hides-relic', 'garden5-blocked-path', 'garden4-no-temple-bridge', 'race5', 'hill4', 'survival5', 'trial5'];
