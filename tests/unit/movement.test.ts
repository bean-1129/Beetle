// Movement rules: support transitions, falling and respawn, sliding, stale input. Owner: world package.
import { describe, expect, it } from 'vitest';
import { GEOMETRY, SIMULATION } from '@beetle/contracts';
import { compileWorld, createMover, fixtureWorld, stepMover, type Mover, type StepEvent } from '@beetle/world';

const TICK = 1000 / SIMULATION.tickHz;
const spawn = { x: -2, z: -2 };

function run(
  compiled: ReturnType<typeof compileWorld>,
  start: Mover,
  axes: { x: number; z: number },
  ticks: number,
  active = true,
  gateOpen = false,
  stopOnEvent = false,
): { mover: Mover; events: StepEvent[]; supports: (string | null)[]; now: number; ticks: number } {
  let mover = start;
  let now = start.statusSinceMs;
  const events: StepEvent[] = [];
  const supports: (string | null)[] = [];
  let used = 0;
  for (let i = 0; i < ticks; i++) {
    now += TICK;
    const r = stepMover(compiled, mover, { axes, active }, TICK, now, { gateOpen, spawn });
    mover = r.mover;
    used++;
    events.push(...r.events);
    supports.push(mover.supportId);
    if (stopOnEvent && r.events.length > 0) break;
  }
  return { mover, events, supports, now, ticks: used };
}

describe('stepMover', () => {
  const compiled = compileWorld(fixtureWorld('garden5'));

  it('walking across a bridge moves supportId island -> bridge -> island', () => {
    const start = createMover({ x: 0, z: 0 }, 0, compiled);
    expect(start.supportId).toBe('centre');
    const { mover, supports, events } = run(compiled, start, { x: 1, z: 0 }, 200);
    expect(events).toEqual([]);
    expect(mover.status).toBe('active');
    expect(mover.x).toBeGreaterThan(17);
    const sequence = supports.filter((s, i) => i === 0 || s !== supports[i - 1]);
    expect(sequence).toEqual(['centre', 'bridge-east', 'east']);
    expect(mover.facingDeg).toBeCloseTo(90, 5);
  });

  it('walking off an island edge produces fell, hazard_contact, respawned at the spawn', () => {
    const start = createMover({ x: 0, z: 0 }, 0, compiled);
    // south-east: no bridge and no decoration in that direction
    const first = run(compiled, start, { x: 1, z: -1 }, 120, true, false, true);
    expect(first.events).toEqual(['fell']);
    expect(first.ticks).toBeLessThan(120);
    expect(first.mover.status).toBe('falling');
    expect(first.mover.supportId).toBeNull();
    expect(first.mover.vx).toBe(0);
    expect(first.mover.vz).toBe(0);
    const fellAt = { x: first.mover.x, z: first.mover.z };
    expect(Math.hypot(fellAt.x, fellAt.z)).toBeGreaterThan(9);

    // keep pushing the stick: falling ignores input and the position does not change until hazard contact
    const ticksToContact = Math.ceil(GEOMETRY.fallDurationMs / TICK) + 1;
    const second = run(compiled, first.mover, { x: 1, z: -1 }, ticksToContact, true, false, true);
    expect(second.events).toEqual(['hazard_contact']);
    expect(second.now - first.now).toBeGreaterThanOrEqual(GEOMETRY.fallDurationMs);
    expect(second.mover.status).toBe('respawning');
    expect(second.mover.x).toBe(spawn.x);
    expect(second.mover.z).toBe(spawn.z);
    expect(second.mover.supportId).toBe('centre');

    const ticksToActive = Math.ceil(GEOMETRY.respawnDurationMs / TICK) + 1;
    const third = run(compiled, second.mover, { x: 1, z: -1 }, ticksToActive, true, false, true);
    expect(third.events).toEqual(['respawned']);
    expect(third.now - second.now).toBeGreaterThanOrEqual(GEOMETRY.respawnDurationMs);
    expect(third.mover.status).toBe('active');
    // respawning ignores input, so the mover is still on the spawn point
    expect(third.mover.x).toBe(spawn.x);
    expect(third.mover.z).toBe(spawn.z);
  });

  it('a decoration in the way causes a slide rather than a stop', () => {
    // tree-1 sits at (5, 5) with block radius 0.7 + playerRadius = 1.15
    const start = createMover({ x: 3.8, z: 5.0 }, 0, compiled);
    const r = stepMover(compiled, start, { axes: { x: 1, z: -0.4 }, active: true }, TICK, TICK, { gateOpen: false, spawn });
    expect(r.events).toEqual([]);
    expect(r.mover.x).toBe(3.8); // X is blocked by the tree
    expect(r.mover.z).toBeLessThan(5.0); // slides along Z (toward the island interior)
    expect(r.mover.vx).toBe(0);
    expect(r.mover.vz).toBeLessThan(0);
    // over several ticks the mover hugs the tree and gets past it instead of stalling
    const walk = run(compiled, start, { x: 1, z: -0.4 }, 24);
    expect(walk.events).toEqual([]);
    expect(walk.mover.z).toBeLessThan(4.4);
    expect(walk.mover.x).toBeGreaterThan(4.5);
    expect(walk.mover.supportId).toBe('centre');
    // a head-on hit with no sideways component simply stops
    const headOn = stepMover(compiled, createMover({ x: 3.8, z: 5.0 }, 0, compiled), { axes: { x: 1, z: 0 }, active: true }, TICK, TICK, { gateOpen: false, spawn });
    expect(headOn.mover.x).toBe(3.8);
    expect(headOn.mover.vx).toBe(0);
    expect(headOn.mover.vz).toBe(0);
  });

  it('the locked gate blocks and slides; the open gate does not', () => {
    const start = createMover({ x: 0, z: 17.5 }, 0, compiled); // on bridge-north heading to the temple
    const locked = run(compiled, start, { x: 0, z: 1 }, 60, true, false);
    expect(locked.mover.z).toBeLessThan(19.0);
    expect(locked.events).toEqual([]);
    const open = run(compiled, start, { x: 0, z: 1 }, 60, true, true);
    expect(open.mover.z).toBeGreaterThan(22);
    expect(open.mover.supportId).toBe('temple');
  });

  it('stale input (active false) zeroes velocity and holds position; dead zone and normalisation apply', () => {
    const moving: Mover = { ...createMover({ x: 0, z: 0 }, 0, compiled), vx: 3, vz: 1, facingDeg: 45 };
    const stale = stepMover(compiled, moving, { axes: { x: 1, z: 1 }, active: false }, TICK, TICK, { gateOpen: false, spawn });
    expect(stale.mover.vx).toBe(0);
    expect(stale.mover.vz).toBe(0);
    expect(stale.mover.x).toBe(0);
    expect(stale.mover.z).toBe(0);
    expect(stale.mover.facingDeg).toBe(45); // facing only follows non-zero velocity

    const dead = stepMover(compiled, moving, { axes: { x: 0.05, z: 0.05 }, active: true }, TICK, TICK, { gateOpen: false, spawn });
    expect(dead.mover.vx).toBe(0);
    expect(dead.mover.vz).toBe(0);

    const diag = stepMover(compiled, moving, { axes: { x: 1, z: 1 }, active: true }, TICK, TICK, { gateOpen: false, spawn });
    expect(Math.hypot(diag.mover.vx, diag.mover.vz)).toBeCloseTo(GEOMETRY.playerSpeed, 6);
    const small = stepMover(compiled, moving, { axes: { x: 0.5, z: 0 }, active: true }, TICK, TICK, { gateOpen: false, spawn });
    expect(small.mover.vx).toBeCloseTo(GEOMETRY.playerSpeed * 0.5, 6);

    const gone: Mover = { ...moving, status: 'disconnected' };
    const dc = stepMover(compiled, gone, { axes: { x: 1, z: 0 }, active: true }, TICK, TICK, { gateOpen: false, spawn });
    expect(dc.mover.x).toBe(0);
    expect(dc.mover.vx).toBe(0);
    expect(dc.mover.status).toBe('disconnected');
  });

  it('does not mutate the input mover', () => {
    const start = createMover({ x: 0, z: 0 }, 0, compiled);
    const snapshot = { ...start };
    stepMover(compiled, start, { axes: { x: 1, z: 0 }, active: true }, TICK, TICK, { gateOpen: false, spawn });
    expect(start).toEqual(snapshot);
  });
});
