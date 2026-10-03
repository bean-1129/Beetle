// Single source of truth for player movement: used by the server simulation and the headless playability walk.
// Rules (docs/ARCHITECTURE.md):
//   active: v = normalize(axes) * effectiveSpeed(spec) (zero when !active or axes inside the dead zone); candidate = pos + v*dt;
//     if blockedAt(candidate) try X-only then Z-only slide; if supportAt(final) is null -> 'falling', event 'fell'.
//   falling: after GEOMETRY.fallDurationMs -> event 'hazard_contact', status 'respawning', position = spawn, velocity 0.
//   respawning: after GEOMETRY.respawnDurationMs -> status 'active', event 'respawned'.
//   disconnected: no movement. facingDeg follows non-zero velocity (0 = north/+Z, 90 = east/+X). supportId updated every step.
import { GEOMETRY, effectiveSpeed, type Vec2 } from '@beetle/contracts';
import type { CompiledWorld, MoveInput, Mover, StepEvent, StepResult } from './types.ts';

export const DEAD_ZONE = 0.08;
/** Largest dt one stepMover call integrates (ms). Larger values are clamped; the server ticks at 33 ms. */
export const MAX_STEP_MS = 250;
/** Largest displacement per internal sub-step (m): well under the smallest blocking radius (lantern 0.3 + player 0.45). */
export const MAX_SUBSTEP_M = 0.2;

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
  // Non-finite dt is treated as 0 (never produces NaN positions); dt is clamped to MAX_STEP_MS so a stalled caller cannot
  // teleport a player with one enormous step.
  const dt = Number.isFinite(dtMs) ? Math.min(Math.max(0, dtMs), MAX_STEP_MS) / 1000 : 0;

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
  let ax = input.active ? Number(input.axes?.x) : 0;
  let az = input.active ? Number(input.axes?.z) : 0;
  if (!Number.isFinite(ax) || !Number.isFinite(az)) { ax = 0; az = 0; } // NaN/Infinity axes are ignored, never propagated
  const mag = Math.hypot(ax, az);
  if (mag < DEAD_ZONE) { ax = 0; az = 0; }
  else if (mag > 1) { ax /= mag; az /= mag; }
  // Speed comes from the compiled spec (movement.speed, default MODE_LIMITS.movementSpeed.default) so set_movement
  // patches change the walk speed without touching the stepMover signature.
  const scale = Number.isFinite(input.speedScale) && (input.speedScale as number) > 0 ? Math.min(2, input.speedScale as number) : 1;
  const speed = effectiveSpeed(compiled.spec) * scale;
  let vx = ax * speed;
  let vz = az * speed;

  let nx = m.x;
  let nz = m.z;
  let fell = false;
  if (vx !== 0 || vz !== 0) {
    // Sub-step so one call never moves more than MAX_SUBSTEP_M: a huge or bunched dt cannot tunnel through a prop,
    // the locked gate, or across the hazard between two surfaces. Support is checked after every sub-step.
    const total = Math.hypot(vx, vz) * dt;
    const n = Math.max(1, Math.ceil(total / MAX_SUBSTEP_M));
    const sdt = dt / n;
    for (let k = 0; k < n; k++) {
      const px = nx; const pz = nz;
      const cx = nx + vx * sdt;
      const cz = nz + vz * sdt;
      if (compiled.blockedAt(cx, cz, opts) === null) {
        nx = cx; nz = cz;
      } else if (vx !== 0 && compiled.blockedAt(cx, nz, opts) === null) {
        nx = cx; vz = 0; // slide along X
      } else if (vz !== 0 && compiled.blockedAt(nx, cz, opts) === null) {
        nz = cz; vx = 0; // slide along Z
      } else {
        vx = 0; vz = 0; // fully blocked: stop
        break;
      }
      if (compiled.supportAt(nx, nz) === null) {
        // Ground worlds have nothing to fall into: the edge of a plateau or path blocks like a wall and the player slides.
        if (compiled.spec.terrain === 'ground') { nx = px; nz = pz; vx = 0; vz = 0; break; }
        fell = true; break;
      }
    }
  }
  m.x = nx; m.z = nz; m.vx = vx; m.vz = vz;
  if (vx !== 0 || vz !== 0) m.facingDeg = facingFrom(vx, vz);

  m.supportId = compiled.supportAt(m.x, m.z);
  if (fell || m.supportId === null) {
    m.supportId = null;
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
