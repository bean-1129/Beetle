import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { GEOMETRY, SIMULATION } from '@beetle/contracts';
import type { PlayerView, TickMessage, WorldMessage, WorldSpec } from '@beetle/contracts';
import { createMaterials } from './materials.ts';
import { PALETTE } from './palette.ts';
import {
  buildBridge, buildDecoration, buildGate, buildIsland, buildPlayer, buildRelic,
  type Built, type GateBuilt, type PlayerBuilt, type RelicBuilt,
} from './builders.ts';

export type RendererStats = { fps: number; tickAgeMs: number | null; meshes: number; worldVersion: number };

export type BeetleRenderer = {
  applyWorld: (msg: WorldMessage) => void;
  applyTick: (tick: TickMessage) => void;
  stats: () => RendererStats;
  resize: () => void;
  dispose: () => void;
  /** Inspection only. */
  debug: { engine: Engine; scene: Scene; camera: ArcRotateCamera };
};

type Entry = { json: string; built: Built };
type Sample = { x: number; z: number; y: number; facing: number; t: number };
type PlayerEntry = {
  built: PlayerBuilt;
  json: string;
  prev: Sample;
  next: Sample;
  status: PlayerView['status'];
  statusSince: number;
  connected: boolean;
};

const CAMERA_BETA = 0.95;
const CAMERA_ALPHA = -Math.PI / 2; // camera south of the islands, looking north: screen up is +Z

export function createRenderer(canvas: HTMLCanvasElement): BeetleRenderer {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false, adaptToDeviceRatio: true, antialias: true });
  const scene = new Scene(engine);
  scene.clearColor = PALETTE.clear;
  scene.ambientColor = new Color3(0.25, 0.3, 0.3);

  const camera = new ArcRotateCamera('camera', CAMERA_ALPHA, CAMERA_BETA, 48, new Vector3(0, 0, 0), scene);
  camera.inputs.clear();
  camera.minZ = 0.5;
  camera.maxZ = 600;
  camera.fov = 0.8;

  const hemi = new HemisphericLight('hemi', new Vector3(0.1, 1, 0.1), scene);
  hemi.intensity = 0.55;
  hemi.diffuse = new Color3(0.9, 0.95, 1.0);
  hemi.groundColor = new Color3(0.2, 0.3, 0.32);
  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, 0.35), scene);
  sun.intensity = 0.95;
  sun.diffuse = new Color3(1.0, 0.9, 0.75);
  sun.specular = new Color3(0.6, 0.5, 0.4);
  sun.position = new Vector3(30, 50, -25);
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 200;
  const shadows = new ShadowGenerator(1024, sun);
  shadows.useBlurExponentialShadowMap = true;
  shadows.blurKernel = 12;
  shadows.darkness = 0.45;
  shadows.bias = 0.002;

  const mats = createMaterials(scene);

  const hazardPlane = CreateGround('hazard', { width: 600, height: 600, subdivisions: 2 }, scene);
  hazardPlane.material = mats.hazard;
  hazardPlane.position.y = GEOMETRY.hazardPlaneElevation;
  hazardPlane.isPickable = false;

  // ---- world objects, diffed by id ----
  const entries = new Map<string, Entry>();
  let gateEntry: { json: string; built: GateBuilt } | null = null;
  const relicEntries = new Map<string, RelicBuilt>();
  let spec: WorldSpec | null = null;
  let worldVersion = -1;

  function addBuilt(b: Built) {
    for (const c of b.casters) shadows.addShadowCaster(c, true);
    for (const r of b.receivers) r.receiveShadows = true;
  }
  function removeBuilt(b: Built) {
    for (const c of b.casters) shadows.removeShadowCaster(c);
    b.dispose();
  }

  function surfacePos(s: WorldSpec, surfaceId: string, local: { x: number; z: number }): { x: number; z: number } | null {
    const island = s.islands.find((i) => i.id === surfaceId);
    if (island) return { x: island.center.x + local.x, z: island.center.z + local.z };
    const bridge = s.bridges.find((b) => b.id === surfaceId);
    if (bridge) {
      const [a, b] = bridge.endpoints;
      return { x: (a.point.x + b.point.x) / 2 + local.x, z: (a.point.z + b.point.z) / 2 + local.z };
    }
    return null;
  }

  function sync(key: string, json: string, build: () => Built | null) {
    const existing = entries.get(key);
    if (existing && existing.json === json) return;
    if (existing) { removeBuilt(existing.built); entries.delete(key); }
    const built = build();
    if (!built) return;
    addBuilt(built);
    entries.set(key, { json, built });
  }

  function applyWorld(msg: WorldMessage) {
    const s = msg.spec;
    if (!s || !Array.isArray(s.islands)) return;
    spec = s;
    worldVersion = msg.version;
    const wanted = new Set<string>();

    for (const island of s.islands) {
      const key = `island:${island.id}`;
      wanted.add(key);
      sync(key, JSON.stringify(island), () => buildIsland(scene, mats, island));
    }
    for (const bridge of s.bridges) {
      const key = `bridge:${bridge.id}`;
      wanted.add(key);
      sync(key, JSON.stringify(bridge), () => buildBridge(scene, mats, bridge));
    }
    for (const deco of s.decorations) {
      const key = `deco:${deco.id}`;
      wanted.add(key);
      const pos = surfacePos(s, deco.supportingSurfaceId, deco.localPosition);
      const island = s.islands.find((i) => i.id === deco.supportingSurfaceId);
      // include the island centre so a moved island moves its props
      sync(key, JSON.stringify([deco, island?.center ?? null, s.seed]), () => (pos ? buildDecoration(scene, mats, deco, pos, s.seed) : null));
    }
    for (const relic of s.relics) {
      const key = `relic:${relic.id}`;
      wanted.add(key);
      const pos = surfacePos(s, relic.supportingSurfaceId, relic.localPosition);
      const island = s.islands.find((i) => i.id === relic.supportingSurfaceId);
      const json = JSON.stringify([relic, island?.center ?? null]);
      const existing = entries.get(key);
      if (!existing || existing.json !== json) {
        if (existing) { removeBuilt(existing.built); entries.delete(key); relicEntries.delete(relic.id); }
        if (pos) {
          const built = buildRelic(scene, mats, relic, pos);
          addBuilt(built);
          entries.set(key, { json, built });
          relicEntries.set(relic.id, built);
          if (lastTick && lastTick.relics[relic.id] === 'collected') built.root.setEnabled(false);
        }
      }
    }
    for (const [key, entry] of entries) {
      if (wanted.has(key)) continue;
      removeBuilt(entry.built);
      entries.delete(key);
      if (key.startsWith('relic:')) relicEntries.delete(key.slice(6));
    }

    // gate: rebuilt only when its definition changes, state comes from ticks
    {
      const island = s.islands.find((i) => i.id === s.gate.supportingSurfaceId);
      const json = JSON.stringify([s.gate, island?.center ?? null]);
      if (!gateEntry || gateEntry.json !== json) {
        if (gateEntry) removeBuilt(gateEntry.built);
        gateEntry = null;
        const pos = surfacePos(s, s.gate.supportingSurfaceId, s.gate.localPosition);
        if (pos) {
          const built = buildGate(scene, mats, s.gate, pos);
          addBuilt(built);
          gateEntry = { json, built };
          if (lastTick) built.setUnlocked(lastTick.gate.unlocked);
        }
      }
    }

    // hazard: material swap only, never a mesh change
    mats.setHazardKind(s.hazard.kind, performance.now());
    hazardPlane.position.y = s.hazard.planeElevation;

    fitCamera(s);
  }

  // ---- camera fit ----
  let targetRadius = 48;
  const targetCenter = new Vector3(0, 0, 0);
  function fitCamera(s: WorldSpec) {
    if (s.islands.length === 0) return;
    // bounding box of the islands, centred on the islands' centroid, plus a margin
    let cx = 0; let cz = 0;
    for (const i of s.islands) { cx += i.center.x; cz += i.center.z; }
    cx /= s.islands.length; cz /= s.islands.length;
    let halfW = 0; let halfD = 0;
    for (const i of s.islands) {
      halfW = Math.max(halfW, Math.abs(i.center.x - cx) + i.radius);
      halfD = Math.max(halfD, Math.abs(i.center.z - cz) + i.radius);
    }
    halfW += 3; halfD += 3;
    const aspect = Math.max(0.3, engine.getAspectRatio(camera));
    const vfov = camera.fov;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    // the walk plane is seen at elevation (pi/2 - beta), so depth is foreshortened by sin of that angle
    const foreshorten = Math.sin(Math.PI / 2 - CAMERA_BETA);
    const dH = halfW / (0.84 * Math.tan(hfov / 2));
    const dV = (halfD * foreshorten) / (0.66 * Math.tan(vfov / 2));
    targetRadius = Math.max(18, Math.max(dH, dV) + 2);
    // perspective makes the near (south) edge larger, so aim a little south of the centroid
    targetCenter.set(cx, 0, cz - halfD * 0.1);
  }

  // ---- players ----
  const players = new Map<string, PlayerEntry>();
  let lastTick: TickMessage | null = null;
  let lastTickAt = 0;
  let tickIntervalMs = 1000 / SIMULATION.tickHz;

  function sampleOf(p: PlayerView, t: number): Sample {
    return { x: p.x, z: p.z, y: Number.isFinite(p.y) ? p.y : 0, facing: p.facingDeg, t };
  }

  function applyTick(tick: TickMessage) {
    const now = performance.now();
    if (lastTickAt > 0) {
      const gap = now - lastTickAt;
      if (gap > 5 && gap < 500) tickIntervalMs = tickIntervalMs * 0.9 + gap * 0.1;
    }
    lastTick = tick;
    lastTickAt = now;
    const seen = new Set<string>();
    for (const p of tick.players ?? []) {
      if (!p || typeof p.id !== 'string') continue;
      seen.add(p.id);
      const staticJson = `${p.slot}|${p.color}|${p.label}`;
      let entry = players.get(p.id);
      if (entry && entry.json !== staticJson) {
        shadows.removeShadowCaster(entry.built.casters[0]);
        entry.built.dispose();
        players.delete(p.id);
        entry = undefined;
      }
      if (!entry) {
        const built = buildPlayer(scene, mats, p);
        for (const c of built.casters) shadows.addShadowCaster(c, true);
        const s = sampleOf(p, now);
        entry = { built, json: staticJson, prev: { ...s, t: now - tickIntervalMs }, next: s, status: p.status, statusSince: now, connected: p.connected };
        built.root.position.set(p.x, p.y, p.z);
        players.set(p.id, entry);
      } else {
        entry.prev = entry.next;
        entry.next = sampleOf(p, now);
        // a respawn teleports: do not slide across the map
        if (Math.hypot(entry.next.x - entry.prev.x, entry.next.z - entry.prev.z) > GEOMETRY.playerSpeed * 0.5) {
          entry.prev = { ...entry.next, t: now - tickIntervalMs };
        }
      }
      if (entry.status !== p.status) { entry.status = p.status; entry.statusSince = now; }
      entry.connected = p.connected;
    }
    for (const [id, entry] of players) {
      if (seen.has(id)) continue;
      shadows.removeShadowCaster(entry.built.casters[0]);
      entry.built.dispose();
      players.delete(id);
    }
    for (const [id, relic] of relicEntries) {
      const state = tick.relics?.[id];
      relic.root.setEnabled(state !== 'collected');
    }
    gateEntry?.built.setUnlocked(!!tick.gate?.unlocked);
  }

  // ---- per frame ----
  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    const dt = engine.getDeltaTime();
    mats.animateHazard(now);

    // camera glide toward the fitted framing
    const k = Math.min(1, dt / 350);
    camera.radius += (targetRadius - camera.radius) * k;
    camera.target.x += (targetCenter.x - camera.target.x) * k;
    camera.target.z += (targetCenter.z - camera.target.z) * k;
    camera.alpha = CAMERA_ALPHA;
    camera.beta = CAMERA_BETA;

    for (const relic of relicEntries.values()) {
      relic.gem.rotation.y += dt * 0.0015;
      relic.gem.position.y = relic.baseY + Math.sin(now / 600 + relic.phase) * 0.15;
    }
    gateEntry?.built.animate(now, dt);

    // render one tick behind the newest sample and interpolate between the last two ticks
    const renderTime = now - tickIntervalMs * 1.25;
    for (const entry of players.values()) {
      const { prev, next, built } = entry;
      const span = next.t - prev.t;
      let a = span > 0 ? (renderTime - prev.t) / span : 1;
      a = Math.max(0, Math.min(1, a));
      const x = prev.x + (next.x - prev.x) * a;
      const z = prev.z + (next.z - prev.z) * a;
      let y = prev.y + (next.y - prev.y) * a;
      let facing = prev.facing + shortestAngle(prev.facing, next.facing) * a;
      if (!Number.isFinite(facing)) facing = 0;
      let visibility = 1;
      const since = now - entry.statusSince;
      if (entry.status === 'falling') {
        const f = Math.min(1, since / GEOMETRY.fallDurationMs);
        y -= f * f * 3.2;
      } else if (entry.status === 'respawning') {
        const f = Math.min(1, since / GEOMETRY.respawnDurationMs);
        visibility = 0.2 + 0.8 * f;
        y += (1 - f) * 0.6;
      } else if (entry.status === 'disconnected') {
        visibility = 0.35;
      }
      if (!entry.connected && entry.status !== 'disconnected') visibility = Math.min(visibility, 0.5);
      built.root.position.set(x, y, z);
      built.root.rotation.y = (facing * Math.PI) / 180;
      built.setVisibility(visibility);
      built.label.position.set(x, y + 2.55, z);
    }
  });

  engine.runRenderLoop(() => { scene.render(); });

  function resize() {
    engine.resize();
    if (spec) fitCamera(spec);
  }
  const onResize = () => resize();
  window.addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);

  function stats(): RendererStats {
    return {
      fps: engine.getFps(),
      tickAgeMs: lastTickAt > 0 ? performance.now() - lastTickAt : null,
      meshes: scene.meshes.length,
      worldVersion,
    };
  }

  function dispose() {
    window.removeEventListener('resize', onResize);
    ro?.disconnect();
    engine.stopRenderLoop();
    scene.dispose();
    engine.dispose();
  }

  return { applyWorld, applyTick, stats, resize, dispose, debug: { engine, scene, camera } };
}

function shortestAngle(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export type { Mesh };
