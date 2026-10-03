// Connectivity and supported-movement checks: reruns the route checks and drives a Mover along BFS paths at 30 Hz.
import { GEOMETRY, SIMULATION, effectiveSpeed, type PlayabilityCheck, type PlayabilityReport, type Vec2 } from '@beetle/contracts';
import type { CompiledWorld, LiveContext, Mover } from './types.ts';
import { reachable } from './nav.ts';
import { createMover, stepMover } from './movement.ts';

const NOTE: PlayabilityReport['note'] = 'connectivity and supported-movement checks only; not a fun or completeness guarantee';
const TICK_MS = 1000 / SIMULATION.tickHz;

export function runPlayabilityChecks(compiled: CompiledWorld, ctx: LiveContext = {}): Omit<PlayabilityReport, 'candidateId'> {
  const t0 = performance.now();
  const spec = compiled.spec;
  const checks: PlayabilityCheck[] = [];
  const routes: PlayabilityReport['routes'] = [];
  const collected = new Set(ctx.collectedRelicIds ?? []);
  const remaining = spec.relics.filter((r) => !collected.has(r.id));
  const gatePos = compiled.worldPos(spec.gate.supportingSurfaceId, spec.gate.localPosition);

  const spawns = spec.spawns.map((s) => ({ id: s.id, pos: compiled.worldPos(s.supportingSurfaceId, s.localPosition) }));

  // Check 1: spawns stand on walkable ground
  const badSpawns = spawns.filter((s) => !s.pos || reachable(compiled, s.pos, s.pos, { goalRadius: 1.0 }).reachable === false).map((s) => s.id);
  checks.push({
    name: 'spawns stand on walkable ground',
    ok: badSpawns.length === 0,
    detail: badSpawns.length === 0 ? `${spawns.length} spawns have a walkable cell within 1 m` : `no walkable cell near: ${badSpawns.join(', ')}`,
    objectIds: badSpawns,
  });

  // Check 2: every remaining relic reachable from every spawn with the gate locked
  const unreachableRelics: string[] = [];
  for (const s of spawns) {
    if (!s.pos) continue;
    for (const r of remaining) {
      const p = compiled.worldPos(r.supportingSurfaceId, r.localPosition);
      if (!p) { unreachableRelics.push(r.id); routes.push({ fromId: s.id, toId: r.id, reachable: false }); continue; }
      const res = reachable(compiled, s.pos, p, { gateOpen: false, goalRadius: GEOMETRY.relicPickupRadius });
      routes.push({ fromId: s.id, toId: r.id, reachable: res.reachable, cells: res.cells });
      if (!res.reachable) unreachableRelics.push(r.id);
    }
  }
  const uniqUnreachable = [...new Set(unreachableRelics)];
  checks.push({
    name: 'remaining relics reachable with the gate locked',
    ok: uniqUnreachable.length === 0,
    detail: uniqUnreachable.length === 0 ? `${remaining.length} relics reachable from ${spawns.length} spawns` : `unreachable: ${uniqUnreachable.join(', ')}`,
    objectIds: uniqUnreachable,
  });

  // Check 3: gate trigger reachable from every spawn with the gate locked
  const gateBlockedFrom: string[] = [];
  for (const s of spawns) {
    if (!s.pos || !gatePos) { gateBlockedFrom.push(s.id); continue; }
    const res = reachable(compiled, s.pos, gatePos, { gateOpen: false, goalRadius: GEOMETRY.gateTriggerRadius });
    routes.push({ fromId: s.id, toId: spec.gate.id, reachable: res.reachable, cells: res.cells });
    if (!res.reachable) gateBlockedFrom.push(s.id);
  }
  checks.push({
    name: 'gate trigger reachable with the gate locked',
    ok: gateBlockedFrom.length === 0,
    detail: gateBlockedFrom.length === 0 ? `gate "${spec.gate.id}" reachable from all spawns` : `gate unreachable from: ${gateBlockedFrom.join(', ')}`,
    objectIds: gateBlockedFrom.length === 0 ? [] : [spec.gate.id, ...gateBlockedFrom],
  });

  // Check 4: live players (if any) can still reach remaining relics and the gate
  const cutOff: string[] = [];
  for (const pl of ctx.players ?? []) {
    const spawn = spawns.find((s) => s.id === pl.spawnId)?.pos ?? spawns[0]?.pos ?? null;
    const from = pl.status === 'active' ? { x: pl.x, z: pl.z } : spawn;
    if (!from) { cutOff.push(pl.id); continue; }
    let ok = true;
    for (const r of remaining) {
      const p = compiled.worldPos(r.supportingSurfaceId, r.localPosition);
      if (!p || !reachable(compiled, from, p, { goalRadius: GEOMETRY.relicPickupRadius }).reachable) ok = false;
    }
    if (gatePos && !reachable(compiled, from, gatePos, { goalRadius: GEOMETRY.gateTriggerRadius }).reachable) ok = false;
    if (!ok) cutOff.push(pl.id);
  }
  checks.push({
    name: 'live players keep a route to remaining relics and the gate',
    ok: cutOff.length === 0,
    detail: (ctx.players?.length ?? 0) === 0 ? 'no live players' : cutOff.length === 0 ? `${ctx.players!.length} players keep their routes` : `cut off: ${cutOff.join(', ')}`,
    objectIds: cutOff,
  });

  // Check 5: headless walk along the BFS path spawn -> each remaining relic -> gate, at 30 Hz, no fall
  const walkFailures: string[] = [];
  const walkDetails: string[] = [];
  for (const s of spawns) {
    if (!s.pos) continue;
    const targets: { id: string; pos: Vec2; radius: number }[] = [];
    for (const r of remaining) {
      const p = compiled.worldPos(r.supportingSurfaceId, r.localPosition);
      if (p) targets.push({ id: r.id, pos: p, radius: GEOMETRY.relicPickupRadius });
    }
    if (gatePos) targets.push({ id: spec.gate.id, pos: gatePos, radius: GEOMETRY.gateTriggerRadius });
    let cur: Vec2 = s.pos;
    let mover = createMover(s.pos, 0, compiled);
    let now = 0;
    for (const t of targets) {
      const res = reachable(compiled, cur, t.pos, { gateOpen: false, goalRadius: t.radius });
      if (!res.reachable || !res.path) { walkFailures.push(t.id); continue; }
      const walk = walkPath(compiled, mover, res.path, t.pos, t.radius, now, s.pos);
      mover = walk.mover;
      now = walk.now;
      if (!walk.arrived) {
        walkFailures.push(t.id);
        walkDetails.push(`${s.id}->${t.id}: ${walk.reason}`);
      } else {
        walkDetails.push(`${s.id}->${t.id}: ${walk.steps} steps`);
        cur = { x: mover.x, z: mover.z };
      }
    }
  }
  const uniqWalk = [...new Set(walkFailures)];
  checks.push({
    name: 'headless walk follows each route without falling',
    ok: uniqWalk.length === 0,
    detail: walkDetails.join('; ').slice(0, 400) || 'no routes to walk',
    objectIds: uniqWalk,
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    routes,
    durationMs: Math.round(performance.now() - t0),
    note: NOTE,
  };
}

function walkPath(
  compiled: CompiledWorld,
  start: Mover,
  path: Vec2[],
  goal: Vec2,
  goalRadius: number,
  startNow: number,
  spawn: Vec2,
): { mover: Mover; now: number; arrived: boolean; steps: number; reason: string } {
  let mover = start;
  let now = startNow;
  let steps = 0;
  const maxSteps = Math.max(200, path.length * 40);
  let wp = 0;
  const WP_RADIUS = 0.2;
  while (steps < maxSteps) {
    if (Math.hypot(mover.x - goal.x, mover.z - goal.z) <= goalRadius) return { mover, now, arrived: true, steps, reason: '' };
    while (wp < path.length - 1 && Math.hypot(mover.x - path[wp].x, mover.z - path[wp].z) <= WP_RADIUS) wp++;
    const target = path[Math.min(wp, path.length - 1)];
    const dx = target.x - mover.x;
    const dz = target.z - mover.z;
    const d = Math.hypot(dx, dz);
    const stepLen = effectiveSpeed(compiled.spec) * (TICK_MS / 1000);
    // Scale the input down near a waypoint so the walker does not overshoot thin bridges.
    const scale = d < stepLen ? Math.max(DEAD_ZONE_FLOOR, d / stepLen) : 1;
    const axes = d === 0 ? { x: 0, z: 0 } : { x: (dx / d) * scale, z: (dz / d) * scale };
    const res = stepMover(compiled, mover, { axes, active: true }, TICK_MS, now, { gateOpen: false, spawn });
    now += TICK_MS;
    steps++;
    mover = res.mover;
    if (res.events.includes('fell')) return { mover, now, arrived: false, steps, reason: `fell at (${mover.x.toFixed(2)}, ${mover.z.toFixed(2)})` };
    if (mover.vx === 0 && mover.vz === 0 && d > WP_RADIUS && wp < path.length) {
      // Blocked and no slide: nudge to the next waypoint; if we are already on the last one, give up.
      if (wp >= path.length - 1) return { mover, now, arrived: false, steps, reason: `blocked near (${mover.x.toFixed(2)}, ${mover.z.toFixed(2)})` };
      wp++;
    }
  }
  return { mover, now, arrived: false, steps, reason: 'step budget exhausted' };
}

const DEAD_ZONE_FLOOR = 0.1;
