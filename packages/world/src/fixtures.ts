// FIXTURES. Hand-made development worlds for tests, demos and the benchmark. Clearly labelled; never used as a hidden
// switch for prompts. Every fixture is a valid WorldSpec by schema; the named failures are semantic (validator codes).
import { GEOMETRY, MOVEMENT_RULES_VERSION, SCHEMA_VERSION, WORLD_LIMITS, type WorldSpec } from '@beetle/contracts';
import type { FixtureName } from './types.ts';
import { hazardPolicyFor } from './patch.ts';

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
    default: {
      const never: never = name;
      throw new Error(`unknown fixture ${String(never)}`);
    }
  }
}

export const FIXTURE_NAMES: FixtureName[] = ['garden5', 'garden5-gapped-bridge', 'garden5-gate-hides-relic', 'garden5-blocked-path', 'garden4-no-temple-bridge'];
