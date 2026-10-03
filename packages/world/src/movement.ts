// Single source of truth for player movement: used by the server simulation and the headless playability walk.
// Rules (docs/ARCHITECTURE.md):
//   active: v = normalize(axes) * playerSpeed (zero when !active or axes inside the dead zone); candidate = pos + v*dt;
//     if blockedAt(candidate) try X-only then Z-only slide; if supportAt(final) is null -> 'falling', event 'fell'.
//   falling: after GEOMETRY.fallDurationMs -> event 'hazard_contact', status 'respawning', position = spawn, velocity 0.
//   respawning: after GEOMETRY.respawnDurationMs -> status 'active', event 'respawned'.
//   disconnected: no movement. facingDeg follows non-zero velocity (0 = north/+Z, 90 = east/+X). supportId updated every step.
import { GEOMETRY, type Vec2 } from '@beetle/contracts';
import type { CompiledWorld, MoveInput, Mover, StepEvent, StepResult } from './types.ts';

export const DEAD_ZONE = 0.08;

export function createMover(pos: Vec2, nowMs: number, compiled?: CompiledWorld): Mover {
  return {
    x: pos.x, z: pos.z, vx: 0, vz: 0, facingDeg: 0,
    status: 'active', statusSinceMs: nowMs,
    supportId: compiled ? compiled.supportAt(pos.x, pos.z) : null,
  };
}

export function stepMover(
  compiled: CompiledWorld,
  mover: Mover,
  input: MoveInput,
  dtMs: number,
  nowMs: number,
  opts: { gateOpen: boolean; spawn: Vec2 },
): StepResult {
  const m: Mover = { ...mover };
  const events: StepEvent[] = [];
  const dt = Math.max(0, dtMs) / 1000;

  if (m.status === 'disconnected') {
    m.vx = 0; m.vz = 0;
    m.supportId = compiled.supportAt(m.x, m.z);
    return { mover: m, events };
  }

  if (m.status === 'falling') {
    m.vx = 0; m.vz = 0;
    if (nowMs - m.statusSinceMs >= GEOMETRY.fallDurationMs) {
      events.push('hazard_contact');
      m.status = 'respawning';
      m.statusSinceMs = nowMs;
      m.x = opts.spawn.x; m.z = opts.spawn.z;
    }
    m.supportId = compiled.supportAt(m.x, m.z);
    return { mover: m, events };
  }

  if (m.status === 'respawning') {
    m.vx = 0; m.vz = 0;
    if (nowMs - m.statusSinceMs >= GEOMETRY.respawnDurationMs) {
      events.push('respawned');
      m.status = 'active';
      m.statusSinceMs = nowMs;
    }
    m.supportId = compiled.supportAt(m.x, m.z);
    return { mover: m, events };
  }

  // active
  let ax = input.active ? input.axes.x : 0;
  let az = input.active ? input.axes.z : 0;
  if (!Number.isFinite(ax) || !Number.isFinite(az)) { ax = 0; az = 0; }
  const mag = Math.hypot(ax, az);
  if (mag < DEAD_ZONE) { ax = 0; az = 0; }
  else if (mag > 1) { ax /= mag; az /= mag; }
  let vx = ax * GEOMETRY.playerSpeed;
  let vz = az * GEOMETRY.playerSpeed;

  let nx = m.x;
  let nz = m.z;
  if (vx !== 0 || vz !== 0) {
    const cx = m.x + vx * dt;
    const cz = m.z + vz * dt;
    if (compiled.blockedAt(cx, cz, opts) === null) {
      nx = cx; nz = cz;
    } else if (vx !== 0 && compiled.blockedAt(cx, m.z, opts) === null) {
      nx = cx; vz = 0; // slide along X
    } else if (vz !== 0 && compiled.blockedAt(m.x, cz, opts) === null) {
      nz = cz; vx = 0; // slide along Z
    } else {
      vx = 0; vz = 0; // fully blocked: stop
    }
  }
  m.x = nx; m.z = nz; m.vx = vx; m.vz = vz;
  if (vx !== 0 || vz !== 0) m.facingDeg = facingFrom(vx, vz);

  m.supportId = compiled.supportAt(m.x, m.z);
  if (m.supportId === null) {
    m.status = 'falling';
    m.statusSinceMs = nowMs;
    m.vx = 0; m.vz = 0;
    events.push('fell');
  }
  return { mover: m, events };
}

/** Degrees clockwise from north (+Z): 0 = north, 90 = east (+X), 180 = south, 270 = west. */
export function facingFrom(vx: number, vz: number): number {
  const deg = (Math.atan2(vx, vz) * 180) / Math.PI;
  return (deg + 360) % 360;
}
