import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { WorldSpec } from '@beetle/contracts';

export type CameraMode = 'cinematic' | 'debug';

export const CAMERA_ALPHA = -Math.PI / 2; // camera south of the islands, looking north: screen up is +Z
const DEBUG_BETA = 0.95;
const CINE_BETA = 1.1;            // breath keeps it within 1.088..1.112 rad
const GOLDEN_Y = 0.38;            // players' midpoint sits 0.38 of the frame height from the bottom
const FILL_MIN = 0.6;             // islands span 60..70 % of the frame width
const FILL_MAX = 0.7;
const BASE_FOV = 0.8;
const FOV_WIDEN = 0.13;         // extra radians at full separation
const RADIUS_BASE = 17;
const RADIUS_PER_SEP = 0.78;
const RADIUS_MIN = 15;

/** Unity-style critically damped smoothing. state = [value, velocity]. */
function smoothDamp(state: Float64Array, target: number, smoothTime: number, dt: number): number {
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const current = state[0];
  let change = current - target;
  const originalTo = target;
  const temp = (state[1] + omega * change) * dt;
  state[1] = (state[1] - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  if ((originalTo - current > 0) === (out > originalTo)) {
    out = originalTo;
    state[1] = (out - originalTo) / Math.max(dt, 1e-6);
  }
  state[0] = out;
  return out;
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return !!el.isContentEditable;
}

export type Cameras = ReturnType<typeof createCameras>;

export function createCameras(scene: Scene, getAspect: () => number) {
  const cinematic = new ArcRotateCamera('camera:cinematic', CAMERA_ALPHA, CINE_BETA, 40, new Vector3(0, 0, 0), scene);
  const debug = new ArcRotateCamera('camera:debug', CAMERA_ALPHA, DEBUG_BETA, 48, new Vector3(0, 0, 0), scene);
  for (const c of [cinematic, debug]) {
    c.inputs.clear();
    c.minZ = 0.5;
    c.maxZ = 1500;
    c.fov = BASE_FOV;
    c.lowerBetaLimit = 0.2;
    c.upperBetaLimit = 1.5;
  }
  let mode: CameraMode = 'cinematic';
  scene.activeCamera = cinematic;

  // ---- world fit (used by the debug camera and as the fallback framing) ----
  let fitRadius = 48;
  let fitHalfW = 20;
  let fitHalfD = 20;
  const fitCenter = new Vector3(0, 0, 0);
  let islandsCentroidX = 0; let islandsCentroidZ = 0;
  function fitWorld(s: WorldSpec) {
    if (s.islands.length === 0) return;
    let cx = 0; let cz = 0;
    for (const i of s.islands) { cx += i.center.x; cz += i.center.z; }
    cx /= s.islands.length; cz /= s.islands.length;
    islandsCentroidX = cx; islandsCentroidZ = cz;
    let halfW = 0; let halfD = 0;
    for (const i of s.islands) {
      halfW = Math.max(halfW, Math.abs(i.center.x - cx) + i.radius);
      halfD = Math.max(halfD, Math.abs(i.center.z - cz) + i.radius);
    }
    halfW += 3; halfD += 3;
    fitHalfW = halfW;
    fitHalfD = halfD;
    const aspect = Math.max(0.3, getAspect());
    const vfov = BASE_FOV;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const foreshorten = Math.sin(Math.PI / 2 - DEBUG_BETA);
    const dH = halfW / (0.84 * Math.tan(hfov / 2));
    const dV = (halfD * foreshorten) / (0.66 * Math.tan(vfov / 2));
    fitRadius = Math.max(18, Math.max(dH, dV) + 2);
    fitCenter.set(cx, 0, cz - halfD * 0.1);
  }

  // ---- cinematic state ----
  const sx = new Float64Array([0, 0]); const sy = new Float64Array([0, 0]); const sz = new Float64Array([0, 0]);
  const sr = new Float64Array([40, 0]); const sf = new Float64Array([BASE_FOV, 0]);
  let wantX = 0; let wantY = 0; let wantZ = 0; let wantRadius = 40; let wantFov = BASE_FOV;
  let shakeFrames = 0;
  let shakeSeed = 1;
  const MAX_PLAYERS = 8;
  const px = new Float64Array(MAX_PLAYERS); const py = new Float64Array(MAX_PLAYERS); const pz = new Float64Array(MAX_PLAYERS);
  let playerCount = 0;

  /** Called before update with this frame's connected player positions (no allocation: fills fixed arrays). */
  function beginPlayers() { playerCount = 0; }
  function addPlayer(x: number, y: number, z: number) {
    if (playerCount >= MAX_PLAYERS) return;
    px[playerCount] = x; py[playerCount] = y; pz[playerCount] = z; playerCount++;
  }

  function update(now: number, dtMs: number) {
    const dt = Math.min(0.1, Math.max(0.001, dtMs / 1000));
    if (mode === 'debug') {
      const k = Math.min(1, dtMs / 350);
      debug.radius += (fitRadius - debug.radius) * k;
      debug.target.x += (fitCenter.x - debug.target.x) * k;
      debug.target.z += (fitCenter.z - debug.target.z) * k;
      debug.target.y = 0;
      debug.alpha = CAMERA_ALPHA;
      debug.beta = DEBUG_BETA;
      debug.fov = BASE_FOV;
      return;
    }
    // desired framing
    let sep = 0;
    if (playerCount > 0) {
      let mx = 0; let my = 0; let mz = 0;
      for (let i = 0; i < playerCount; i++) { mx += px[i]; my += py[i]; mz += pz[i]; }
      wantX = mx / playerCount; wantY = Math.max(-1, Math.min(1.5, my / playerCount)) * 0.5; wantZ = mz / playerCount;
      for (let i = 0; i < playerCount; i++) {
        for (let j = i + 1; j < playerCount; j++) sep = Math.max(sep, Math.hypot(px[i] - px[j], pz[i] - pz[j]));
      }
      // a bias toward the islands' centroid keeps the world readable when players huddle at an edge
      wantX += (islandsCentroidX - wantX) * 0.12;
      wantZ += (islandsCentroidZ - wantZ) * 0.12;
    }
    const aspectFactor = Math.max(0.6, Math.min(1.4, 1.6 / Math.max(0.3, getAspect())));
    const maxRadius = Math.max(fitRadius + 8, 40);
    // distance at which the islands' half-width fills a given fraction of the half-frame width
    const halfTanH = Math.tan(BASE_FOV / 2) * Math.max(0.3, getAspect());
    const fillRadius = (fill: number) => fitHalfW / (fill * halfTanH);
    // every island's bounding circle stays in frame front to back: the ground depth is foreshortened by
    // cos(beta) and must fit in 75 % of the half-frame height
    const depthRadius = (fitHalfD * Math.cos(CINE_BETA)) / (0.75 * Math.tan(BASE_FOV / 2)) + 2;
    if (playerCount > 0) {
      const playersRadius = (RADIUS_BASE + sep * RADIUS_PER_SEP) * aspectFactor;
      // never closer than the 70 % fill; further only when the players' spread needs it
      wantRadius = Math.max(RADIUS_MIN, Math.min(maxRadius, Math.max(playersRadius, fillRadius(FILL_MAX), depthRadius)));
      wantFov = BASE_FOV + FOV_WIDEN * Math.max(0, Math.min(1, sep / 55));
    } else {
      // no players: the islands fill 65 % of the width, centred on the world
      wantX = fitCenter.x; wantY = 0; wantZ = fitCenter.z;
      wantRadius = Math.max(RADIUS_MIN, Math.min(maxRadius, Math.max(depthRadius, fillRadius((FILL_MIN + FILL_MAX) / 2))));
      wantFov = BASE_FOV;
    }

    // critically damped glide, time constants 0.65..0.9 s: no retarget ever reads as a cut
    const tx = smoothDamp(sx, wantX, 0.65, dt);
    const ty = smoothDamp(sy, wantY, 0.8, dt);
    const tz = smoothDamp(sz, wantZ, 0.65, dt);
    const r = smoothDamp(sr, wantRadius, 0.9, dt);
    const f = smoothDamp(sf, wantFov, 0.9, dt);

    // very slow alpha drift (peak 0.0037 rad/s) and a breath on beta
    const alpha = CAMERA_ALPHA + Math.sin(now / 23000) * 0.055 + Math.sin(now / 9100) * 0.012;
    const beta = CINE_BETA + Math.sin(now / 15000) * 0.012;
    cinematic.alpha = alpha;
    cinematic.beta = beta;
    cinematic.radius = r;
    cinematic.fov = f;
    // golden-ratio placement: the orbit target is the screen centre, so push it up the screen-up axis by the
    // distance that puts the players' midpoint GOLDEN_Y of the frame height from the bottom
    const lift = (0.5 - GOLDEN_Y) * 2 * r * Math.tan(f / 2);
    const upX = -Math.cos(alpha) * Math.cos(beta);
    const upY = Math.sin(beta);
    const upZ = -Math.sin(alpha) * Math.cos(beta);
    let ox = 0; let oy = 0; let oz = 0;
    if (shakeFrames > 0) {
      shakeFrames--;
      shakeSeed = (shakeSeed * 16807) % 2147483647;
      const a = (shakeSeed / 2147483647) * Math.PI * 2;
      const amp = 0.09;
      ox = Math.cos(a) * amp; oy = Math.sin(a * 1.7) * amp * 0.5; oz = Math.sin(a) * amp;
    }
    cinematic.target.set(tx + ox + upX * lift, ty + oy + upY * lift, tz + oz + upZ * lift);
  }

  /** Two-frame micro shake (world commit). */
  function punch() { shakeFrames = 2; }

  function setMode(m: CameraMode) {
    if (m === mode) return;
    mode = m;
    scene.activeCamera = m === 'cinematic' ? cinematic : debug;
  }
  function toggle() { setMode(mode === 'cinematic' ? 'debug' : 'cinematic'); }

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.key !== 'c' && e.key !== 'C') return;
    if (isEditable(e.target)) return;
    toggle();
  };
  window.addEventListener('keydown', onKey);

  function dispose() {
    window.removeEventListener('keydown', onKey);
  }

  return {
    cinematic, debug, fitWorld, beginPlayers, addPlayer, update, punch, setMode, toggle, dispose,
    get active(): ArcRotateCamera { return mode === 'cinematic' ? cinematic : debug; },
    get mode(): CameraMode { return mode; },
    get fitRadius() { return fitRadius; },
    get fitCenter() { return fitCenter; },
  };
}
