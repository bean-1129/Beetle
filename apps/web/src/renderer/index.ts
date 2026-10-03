import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent';
import '@babylonjs/core/Rendering/prePassRendererSceneComponent';
import '@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline';
import { VolumetricLightScatteringPostProcess } from '@babylonjs/core/PostProcesses/volumetricLightScatteringPostProcess';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Node } from '@babylonjs/core/node';
import { GEOMETRY, SIMULATION } from '@beetle/contracts';
import type { PlayerView, TickMessage, WorldMessage, WorldSpec } from '@beetle/contracts';
import { createMaterials } from './materials.ts';
import { createEnvironment, themeForHazard, type ThemeName } from './environment.ts';
import { createParticles } from './particles.ts';
import { createCameras, type CameraMode } from './camera.ts';
import * as fx from './effects.ts';
import {
  buildBridge, buildDecoration, buildGate, buildIsland, buildPlayer, buildRelic,
  type Built, type GateBuilt, type IslandBuilt, type PlayerBuilt, type RelicBuilt,
} from './builders.ts';

export type Quality = 'high' | 'low';
export type RendererStats = {
  fps: number; tickAgeMs: number | null; meshes: number; worldVersion: number;
  theme: ThemeName; cameraMode: CameraMode; quality: Quality;
};

export type BeetleRenderer = {
  applyWorld: (msg: WorldMessage) => void;
  applyTick: (tick: TickMessage) => void;
  stats: () => RendererStats;
  resize: () => void;
  dispose: () => void;
  /** 'low' disables bloom, glow, SSAO, god rays and MSAA for weak GPUs. */
  setQuality: (q: Quality) => void;
  setCameraMode: (m: CameraMode) => void;
  /** Debug helper: force a theme blend without a world message. */
  setTheme: (t: ThemeName) => void;
  /** Inspection only. */
  debug: { engine: Engine; scene: Scene; readonly camera: ArcRotateCamera };
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

type Effects = {
  onWorldApplied?: (changedIds: string[], nodesById: Map<string, Node>, reason: WorldMessage['reason']) => void;
  onPlayerUpdate?: (id: string, view: PlayerView, speed: number, dtMs: number) => void;
  onThemeChange?: (theme: ThemeName) => void;
  update?: (dtMs: number) => void;
  dispose?: () => void;
};

export function createRenderer(canvas: HTMLCanvasElement): BeetleRenderer {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false, adaptToDeviceRatio: true, antialias: true });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.47, 0.72, 0.81, 1);
  scene.ambientColor = new Color3(0.2, 0.25, 0.28);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.0075;

  const cameras = createCameras(scene, () => engine.getAspectRatio(cameras.active));

  const hemi = new HemisphericLight('hemi', new Vector3(0.1, 1, 0.1), scene);
  hemi.intensity = 0.55;
  const sun = new DirectionalLight('sun', new Vector3(-0.42, -0.78, 0.46), scene);
  sun.intensity = 2.4;
  sun.position = new Vector3(38, 70, -41);
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 320;
  sun.autoCalcShadowZBounds = true;
  const shadows = new ShadowGenerator(2048, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.darkness = 0.32;
  shadows.bias = 0.0012;
  shadows.normalBias = 0.02;
  shadows.transparencyShadow = false;

  const mats = createMaterials(scene);
  const env = createEnvironment(scene, mats, sun, hemi);
  const particles = createParticles(scene);
  const effects: Effects = (fx as { createEffects?: (s: Scene) => Effects }).createEffects?.(scene) ?? {};

  const hazardPlane = CreateGround('hazard', { width: 600, height: 600, subdivisions: 48 }, scene);
  hazardPlane.material = mats.hazard;
  hazardPlane.position.y = GEOMETRY.hazardPlaneElevation;
  hazardPlane.isPickable = false;
  hazardPlane.receiveShadows = false; // custom shader: shadows are not sampled on the hazard surface
  hazardPlane.alwaysSelectAsActiveMesh = true;
  hazardPlane.freezeWorldMatrix();

  // ---- post pipeline ----
  const caps = engine.getCaps();
  const msaa = Math.min(4, Math.max(1, caps.maxMSAASamples || 1));
  const godRays = new VolumetricLightScatteringPostProcess('godrays', 0.4, cameras.cinematic, env.sunDisc, 40, Texture.BILINEAR_SAMPLINGMODE, engine, false, scene);
  godRays.exposure = 0.16;
  godRays.decay = 0.965;
  godRays.weight = 0.25;
  godRays.density = 0.45;
  // the sun sits above the frame, so only the sun disc needs to go through the occlusion pass (saves a full
  // scene re-render per frame); world geometry never overlaps it from the gameplay cameras
  godRays.includedMeshes = [env.sunDisc];
  const bothCameras = [cameras.cinematic, cameras.debug];
  const ssao = new SSAO2RenderingPipeline('ssao', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, bothCameras, true);
  ssao.radius = 2.4;
  ssao.totalStrength = 0.9;
  ssao.base = 0.12;
  ssao.maxZ = 160;
  ssao.samples = 12;
  ssao.expensiveBlur = false;
  const pipeline = new DefaultRenderingPipeline('beetle', true, scene, bothCameras);
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.8;
  pipeline.bloomWeight = 0.25;
  pipeline.bloomKernel = 64;
  pipeline.bloomScale = 0.5;
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.exposure = 1.1;
  pipeline.imageProcessing.contrast = 1.15;
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 1.6;
  pipeline.imageProcessing.vignetteStretch = 0.5;
  pipeline.imageProcessing.vignetteColor = new Color4(0.02, 0.02, 0.04, 0);
  pipeline.samples = msaa;
  try { godRays.samples = msaa; } catch { /* not all targets support multisampled post-process textures */ }

  const glow = new GlowLayer('glow', scene, { mainTextureRatio: 0.5, blurKernelSize: 48, mainTextureSamples: msaa });
  glow.intensity = 0.55;
  glow.addExcludedMesh(env.skyDome);
  glow.addExcludedMesh(env.cloudSheet);
  glow.addExcludedMesh(env.sunDisc);
  // the hazard shader has its own emissive branch for the glow pass
  glow.referenceMeshToUseItsOwnMaterial(hazardPlane);
  glow.onBeforeRenderMeshToEffect.add((m) => { if (m === hazardPlane) mats.setGlowPass(true); });
  glow.onAfterRenderMeshToEffect.add((m) => { if (m === hazardPlane) mats.setGlowPass(false); });

  let quality: Quality = 'high';
  // Q toggles render quality (high/low) for weak GPUs; ignored while typing. C is the camera toggle (camera.ts).
  const onQualityKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.key !== 'q' && e.key !== 'Q') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    setQuality(quality === 'high' ? 'low' : 'high');
  };
  window.addEventListener('keydown', onQualityKey);
  function setQuality(q: Quality) {
    if (q === quality) return;
    quality = q;
    const high = q === 'high';
    pipeline.bloomEnabled = high;
    pipeline.samples = high ? msaa : 1;
    glow.isEnabled = high;
    shadows.filteringQuality = high ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW;
    particles.setQuality(q);
    if (high) {
      scene.postProcessRenderPipelineManager.attachCamerasToRenderPipeline('ssao', bothCameras);
      cameras.cinematic.attachPostProcess(godRays, 0);
    } else {
      scene.postProcessRenderPipelineManager.detachCamerasFromRenderPipeline('ssao', bothCameras);
      cameras.cinematic.detachPostProcess(godRays);
    }
  }

  function applyThemeToPost() {
    const live = env.live;
    pipeline.bloomWeight = live.bloomWeight;
    pipeline.imageProcessing.exposure = live.exposure;
    pipeline.imageProcessing.contrast = live.contrast;
    pipeline.imageProcessing.vignetteWeight = live.vignetteWeight;
    glow.intensity = live.glowIntensity;
    godRays.weight = live.godRayWeight;
    godRays.density = live.godRayDensity;
    ssao.totalStrength = live.ssaoStrength;
  }

  // ---- world objects, diffed by id ----
  const entries = new Map<string, Entry>();
  let gateEntry: { json: string; built: GateBuilt } | null = null;
  const relicEntries = new Map<string, RelicBuilt>();
  const islandEntries = new Map<string, IslandBuilt>();
  const nodesById = new Map<string, Node>();
  let spec: WorldSpec | null = null;
  let worldVersion = -1;
  let changedIds: string[] = [];

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

  function sync(key: string, id: string, json: string, build: () => Built | null) {
    const existing = entries.get(key);
    if (existing && existing.json === json) return;
    if (existing) { removeBuilt(existing.built); entries.delete(key); nodesById.delete(id); }
    const built = build();
    changedIds.push(id);
    if (!built) return;
    addBuilt(built);
    entries.set(key, { json, built });
    nodesById.set(id, built.root);
  }

  function applyWorld(msg: WorldMessage) {
    const s = msg.spec;
    if (!s || !Array.isArray(s.islands)) return;
    const now = performance.now();
    spec = s;
    worldVersion = msg.version;
    changedIds = [];
    const wanted = new Set<string>();

    for (const island of s.islands) {
      const key = `island:${island.id}`;
      wanted.add(key);
      sync(key, island.id, JSON.stringify(island), () => {
        const built = buildIsland(scene, mats, island);
        islandEntries.set(island.id, built);
        return built;
      });
      islandEntries.get(island.id)?.setHazardY(s.hazard.planeElevation);
    }
    for (const bridge of s.bridges) {
      const key = `bridge:${bridge.id}`;
      wanted.add(key);
      sync(key, bridge.id, JSON.stringify(bridge), () => buildBridge(scene, mats, bridge));
    }
    for (const deco of s.decorations) {
      const key = `deco:${deco.id}`;
      wanted.add(key);
      const pos = surfacePos(s, deco.supportingSurfaceId, deco.localPosition);
      const island = s.islands.find((i) => i.id === deco.supportingSurfaceId);
      sync(key, deco.id, JSON.stringify([deco, island?.center ?? null, s.seed]), () => (pos ? buildDecoration(scene, mats, deco, pos, s.seed) : null));
    }
    for (const relic of s.relics) {
      const key = `relic:${relic.id}`;
      wanted.add(key);
      const pos = surfacePos(s, relic.supportingSurfaceId, relic.localPosition);
      const island = s.islands.find((i) => i.id === relic.supportingSurfaceId);
      const json = JSON.stringify([relic, island?.center ?? null]);
      const existing = entries.get(key);
      if (!existing || existing.json !== json) {
        if (existing) { removeBuilt(existing.built); entries.delete(key); relicEntries.delete(relic.id); nodesById.delete(relic.id); }
        changedIds.push(relic.id);
        if (pos) {
          const built = buildRelic(scene, mats, relic, pos);
          addBuilt(built);
          entries.set(key, { json, built });
          relicEntries.set(relic.id, built);
          nodesById.set(relic.id, built.root);
          if (lastTick && lastTick.relics[relic.id] === 'collected') built.root.setEnabled(false);
        }
      }
    }
    for (const [key, entry] of entries) {
      if (wanted.has(key)) continue;
      removeBuilt(entry.built);
      entries.delete(key);
      const id = key.slice(key.indexOf(':') + 1);
      nodesById.delete(id);
      changedIds.push(id);
      if (key.startsWith('relic:')) relicEntries.delete(id);
      if (key.startsWith('island:')) islandEntries.delete(id);
    }

    // gate: rebuilt only when its definition changes, state comes from ticks
    {
      const island = s.islands.find((i) => i.id === s.gate.supportingSurfaceId);
      const json = JSON.stringify([s.gate, island?.center ?? null]);
      if (!gateEntry || gateEntry.json !== json) {
        if (gateEntry) { removeBuilt(gateEntry.built); nodesById.delete(s.gate.id); }
        gateEntry = null;
        changedIds.push(s.gate.id);
        const pos = surfacePos(s, s.gate.supportingSurfaceId, s.gate.localPosition);
        if (pos) {
          const built = buildGate(scene, mats, s.gate, pos);
          addBuilt(built);
          gateEntry = { json, built };
          nodesById.set(s.gate.id, built.root);
          if (lastTick) built.setUnlocked(lastTick.gate.unlocked);
        }
      }
    }

    // hazard: material/theme blend only, never a mesh change
    hazardPlane.unfreezeWorldMatrix();
    hazardPlane.position.y = s.hazard.planeElevation;
    hazardPlane.freezeWorldMatrix();
    mats.setHazardIslands(s);
    particles.setBounds(s);
    const theme = themeForHazard(s.hazard.kind);
    if (theme !== env.theme) {
      env.setTheme(theme, now);
      effects.onThemeChange?.(theme);
    }

    cameras.fitWorld(s);
    if (msg.reason === 'commit') {
      cameras.punch();
      env.pulseLight(now);
    }
    effects.onWorldApplied?.(changedIds, nodesById, msg.reason);
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
    let gapMs = tickIntervalMs;
    if (lastTickAt > 0) {
      const gap = now - lastTickAt;
      if (gap > 5 && gap < 500) { tickIntervalMs = tickIntervalMs * 0.9 + gap * 0.1; gapMs = gap; }
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
        for (const c of entry.built.casters) shadows.removeShadowCaster(c);
        entry.built.dispose();
        players.delete(p.id);
        nodesById.delete(p.id);
        entry = undefined;
      }
      if (!entry) {
        const built = buildPlayer(scene, mats, p);
        for (const c of built.casters) shadows.addShadowCaster(c, true);
        const s = sampleOf(p, now);
        entry = { built, json: staticJson, prev: { ...s, t: now - tickIntervalMs }, next: s, status: p.status, statusSince: now, connected: p.connected };
        built.root.position.set(p.x, p.y, p.z);
        players.set(p.id, entry);
        nodesById.set(p.id, built.root);
      } else {
        entry.prev = entry.next;
        entry.next = sampleOf(p, now);
        if (Math.hypot(entry.next.x - entry.prev.x, entry.next.z - entry.prev.z) > GEOMETRY.playerSpeed * 0.5) {
          entry.prev = { ...entry.next, t: now - tickIntervalMs };
        }
      }
      if (entry.status !== p.status) { entry.status = p.status; entry.statusSince = now; }
      entry.connected = p.connected;
      const speed = Math.hypot(Number.isFinite(p.vx) ? p.vx : 0, Number.isFinite(p.vz) ? p.vz : 0);
      effects.onPlayerUpdate?.(p.id, p, speed, gapMs);
    }
    for (const [id, entry] of players) {
      if (seen.has(id)) continue;
      for (const c of entry.built.casters) shadows.removeShadowCaster(c);
      entry.built.dispose();
      players.delete(id);
      nodesById.delete(id);
    }
    for (const [id, relic] of relicEntries) {
      const state = tick.relics?.[id];
      relic.root.setEnabled(state !== 'collected');
    }
    gateEntry?.built.setUnlocked(!!tick.gate?.unlocked);
  }

  // ---- per frame ----
  const camPos = new Vector3();
  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    const dt = engine.getDeltaTime();

    // render one tick behind the newest sample and interpolate between the last two ticks
    const renderTime = now - tickIntervalMs * 1.25;
    cameras.beginPlayers();
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
      built.label.position.set(x, y + 2.95, z);
      // interpolated ground speed in m/s drives the walk cycle
      const speed = span > 0 ? (Math.hypot(next.x - prev.x, next.z - prev.z) * 1000) / span : 0;
      built.animate(now, speed, facing, entry.status);
      if (entry.connected && entry.status !== 'disconnected') cameras.addPlayer(x, Math.max(y, 0), z);
    }

    cameras.update(now, dt);
    const cam = cameras.active;
    // the camera position is only refreshed in the view matrix pass; derive it from the orbit so the sky/water
    // shaders and the god-ray source use this frame's values
    const sb = Math.sin(cam.beta);
    camPos.set(
      cam.target.x + cam.radius * Math.cos(cam.alpha) * sb,
      cam.target.y + cam.radius * Math.cos(cam.beta),
      cam.target.z + cam.radius * Math.sin(cam.alpha) * sb,
    );
    if (env.update(now, camPos)) applyThemeToPost();
    particles.update(env.live);
    mats.animateHazard(now);

    // island crust rings are enabled by the geometry theme callback (setGeometryTheme), not forced here
    for (const relic of relicEntries.values()) {
      relic.gem.rotation.y += dt * 0.0015;
      relic.gem.position.y = relic.baseY + Math.sin(now / 600 + relic.phase) * 0.15;
    }
    gateEntry?.built.animate(now, dt);
  });

  engine.runRenderLoop(() => {
    effects.update?.(engine.getDeltaTime());
    scene.render();
  });

  function resize() {
    engine.resize();
    if (spec) cameras.fitWorld(spec);
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
      theme: env.theme,
      cameraMode: cameras.mode,
      quality,
    };
  }

  function setTheme(t: ThemeName) {
    if (t === env.theme) return;
    env.setTheme(t, performance.now());
    effects.onThemeChange?.(t);
  }

  function dispose() {
    window.removeEventListener('keydown', onQualityKey);
    window.removeEventListener('resize', onResize);
    ro?.disconnect();
    engine.stopRenderLoop();
    effects.dispose?.();
    cameras.dispose();
    particles.dispose();
    env.dispose();
    scene.dispose();
    engine.dispose();
  }

  return {
    applyWorld, applyTick, stats, resize, dispose, setQuality, setCameraMode: cameras.setMode, setTheme,
    debug: { engine, scene, get camera() { return cameras.active; } },
  };
}

function shortestAngle(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export type { Mesh };
