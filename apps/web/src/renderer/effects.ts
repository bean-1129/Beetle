// Cinematic transitions and movement-feel effects for the Beetle renderer.
//
// Everything here is cosmetic and procedural: pooled particle systems fed from fixed-size queues,
// pooled ground quads, and in-place tweens that restore the exact values they touched. Nothing
// allocates per frame once the pools exist, and nothing here changes protocol or gameplay state.
//
// Hook contract (called by index.ts behind a feature guard):
//   onWorldApplied(changedIds, nodesById, reason)  after a world message is applied
//   onPlayerUpdate(id, view, speed, dtMs)           once per rendered player per frame
//   onThemeChange(theme)                            when the hazard theme flips
//   update(dtMs)                                    once per frame, before the scene renders
//   dispose()                                       on renderer teardown
import type { Scene } from '@babylonjs/core/scene';
import type { Node } from '@babylonjs/core/node';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Constants } from '@babylonjs/core/Engines/constants';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import '@babylonjs/core/Rendering/outlineRenderer'; // side-effect: mesh.renderOverlay / overlayColor / overlayAlpha
import { GEOMETRY } from '@beetle/contracts';
import type { PlayerView } from '@beetle/contracts';
import { getEffectTextures } from './effects-textures.ts';

export type EffectsTheme = 'serene' | 'volcanic';
export type WorldReason = 'snapshot' | 'commit' | 'resync';

export type Effects = {
  onWorldApplied(changedIds: string[], nodesById: Map<string, Node>, reason: WorldReason): void;
  /** `speed` is the interpolated ground speed in m/s. */
  onPlayerUpdate(id: string, view: PlayerView, speed: number, dtMs: number): void;
  onThemeChange(theme: EffectsTheme | string): void;
  update(dtMs: number): void;
  dispose(): void;
};

// ---------------------------------------------------------------- tuning

const RING_MS = 750;
const PULSE_MS = 550;
const PULSE_OVERLAY_PEAK = 0.26;
const PULSE_EMISSIVE_PEAK = 1.1;
const ASSEMBLE_MS = 600;
const ASSEMBLE_DROP = 1.5;
const ASSEMBLE_SCALE = 0.9;
const STRIDE_M = 0.72; // one dust puff per stride
const TRAIL_SPACING_M = 0.42;
const TRAIL_MS = 900;
const TRAIL_ALPHA = 0.16;
const SHIMMER_MS = 800;
const SHIMMER_PER_S = 48;
const SPLASH_DROPLETS = 28;
const SPLASH_EMBERS = 36;
const PLAYER_STALE_MS = 10_000;
const MAX_DT_MS = 100;

type Rgb = { r: number; g: number; b: number };
const THEME = {
  serene: {
    ring: { r: 0.92, g: 0.96, b: 1.0 },
    overlay: { r: 1.0, g: 0.96, b: 0.86 },
    trail: { r: 0.12, g: 0.17, b: 0.14 },
    dust: new Color4(0.74, 0.68, 0.56, 0.22),
    dust2: new Color4(0.66, 0.62, 0.52, 0.16),
  },
  volcanic: {
    ring: { r: 1.0, g: 0.74, b: 0.48 },
    overlay: { r: 1.0, g: 0.72, b: 0.44 },
    trail: { r: 0.16, g: 0.12, b: 0.1 },
    dust: new Color4(0.36, 0.34, 0.33, 0.24),
    dust2: new Color4(0.28, 0.26, 0.26, 0.18),
  },
} as const;

// ---------------------------------------------------------------- easing

const easeOutCubic = (k: number) => 1 - (1 - k) * (1 - k) * (1 - k);
const easeOutQuad = (k: number) => 1 - (1 - k) * (1 - k);
/** Fast attack, long decay: a flash of light. */
const flash = (k: number) => (k < 0.15 ? k / 0.15 : (1 - (k - 0.15) / 0.85) ** 2);
const clamp01 = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

// ---------------------------------------------------------------- burst particle systems

const Q_STRIDE = 6; // x y z dx dy dz

/**
 * A long-lived particle system that only emits on demand. Emission requests queue into a fixed
 * ring buffer; `flush()` hands the queue length to Babylon as `manualEmitCount` and the start
 * functions pop one entry per created particle, so several bursts can land in the same frame at
 * different positions without any per-burst system or allocation.
 */
class Burst {
  readonly ps: ParticleSystem;
  private readonly q: Float32Array;
  private readonly cap: number;
  private head = 0;
  private len = 0;
  private cur = -1;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;

  constructor(scene: Scene, name: string, capacity: number, texture: Texture, blend: number) {
    this.cap = capacity;
    this.q = new Float32Array(capacity * Q_STRIDE);
    const ps = new ParticleSystem(`fx:${name}`, capacity, scene);
    ps.particleTexture = texture;
    ps.emitter = new Vector3(0, 0, 0);
    ps.emitRate = 0;
    ps.manualEmitCount = 0;
    ps.updateSpeed = 1 / 60; // lifetimes in seconds, directions in m/s, gravity in m/s^2
    ps.minEmitPower = 1;
    ps.maxEmitPower = 1;
    ps.blendMode = blend;
    ps.disposeOnStop = false;
    ps.preventAutoStart = true;
    ps.startPositionFunction = (_w, pos) => this.popPosition(pos);
    ps.startDirectionFunction = (_w, dir) => this.readDirection(dir);
    this.ps = ps;
    ps.start();
  }

  emit(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
    let slot: number;
    if (this.len < this.cap) {
      slot = (this.head + this.len) % this.cap;
      this.len++;
    } else {
      slot = this.head; // full: the oldest pending request is dropped
      this.head = (this.head + 1) % this.cap;
    }
    const o = slot * Q_STRIDE;
    const q = this.q;
    q[o] = x; q[o + 1] = y; q[o + 2] = z; q[o + 3] = dx; q[o + 4] = dy; q[o + 5] = dz;
  }

  private popPosition(pos: Vector3) {
    if (this.len === 0) {
      this.cur = -1;
      pos.copyFromFloats(this.lastX, this.lastY, this.lastZ);
      return;
    }
    const slot = this.head;
    this.head = (this.head + 1) % this.cap;
    this.len--;
    this.cur = slot;
    const o = slot * Q_STRIDE;
    this.lastX = this.q[o]; this.lastY = this.q[o + 1]; this.lastZ = this.q[o + 2];
    pos.copyFromFloats(this.lastX, this.lastY, this.lastZ);
  }

  private readDirection(dir: Vector3) {
    if (this.cur < 0) { dir.copyFromFloats(0.02, 0.4, 0.02); return; }
    const o = this.cur * Q_STRIDE;
    dir.copyFromFloats(this.q[o + 3], this.q[o + 4], this.q[o + 5]);
  }

  /** Once per frame: request as many particles as are queued (Babylon caps at free capacity; the rest wait). */
  flush() {
    if (this.len > 0) this.ps.manualEmitCount = this.len;
  }

  dispose() { this.ps.dispose(false); }
}

/** A box-emitter system that runs at a rate for a fixed time: theme bursts over the hazard plane. */
class Region {
  readonly ps: ParticleSystem;
  private left = 0;

  constructor(scene: Scene, name: string, capacity: number, texture: Texture, blend: number) {
    const ps = new ParticleSystem(`fx:${name}`, capacity, scene);
    ps.particleTexture = texture;
    ps.emitter = new Vector3(0, 0, 0);
    ps.emitRate = 0;
    ps.updateSpeed = 1 / 60;
    ps.minEmitPower = 1;
    ps.maxEmitPower = 1;
    ps.blendMode = blend;
    ps.disposeOnStop = false;
    ps.preventAutoStart = true;
    this.ps = ps;
    ps.start();
  }

  fire(ms: number, rate: number, cx: number, cy: number, cz: number, hw: number, hd: number) {
    (this.ps.emitter as Vector3).copyFromFloats(cx, cy, cz);
    this.ps.minEmitBox.copyFromFloats(-hw, 0, -hd);
    this.ps.maxEmitBox.copyFromFloats(hw, 0.25, hd);
    this.ps.emitRate = rate;
    this.left = ms;
  }

  update(dtMs: number) {
    if (this.left <= 0) return;
    this.left -= dtMs;
    if (this.left <= 0) { this.left = 0; this.ps.emitRate = 0; }
  }

  dispose() { this.ps.dispose(false); }
}

// ---------------------------------------------------------------- pooled ground quads

type Quad = { mesh: Mesh; active: boolean; t: number; dur: number; size: number; alpha: number };

class QuadPool {
  readonly items: Quad[] = [];
  private next = 0;

  constructor(scene: Scene, name: string, count: number, material: StandardMaterial) {
    for (let i = 0; i < count; i++) {
      const mesh = CreatePlane(`fx:${name}:${i}`, { size: 1 }, scene);
      mesh.material = material;
      mesh.rotation.x = Math.PI / 2; // lie flat, facing up
      mesh.isPickable = false;
      mesh.receiveShadows = false;
      mesh.setEnabled(false);
      this.items.push({ mesh, active: false, t: 0, dur: 1, size: 1, alpha: 1 });
    }
  }

  /** Takes a free quad, or recycles the one spawned longest ago. */
  spawn(x: number, y: number, z: number, yaw: number, sx: number, sy: number, dur: number, size: number, alpha: number): Quad {
    let q: Quad | null = null;
    for (let i = 0; i < this.items.length; i++) {
      const c = this.items[(this.next + i) % this.items.length];
      if (!c.active) { q = c; break; }
    }
    if (!q) q = this.items[this.next];
    this.next = (this.items.indexOf(q) + 1) % this.items.length;
    q.active = true; q.t = 0; q.dur = dur; q.size = size; q.alpha = alpha;
    q.mesh.position.copyFromFloats(x, y, z);
    q.mesh.rotation.y = yaw;
    q.mesh.scaling.copyFromFloats(sx, sy, 1);
    q.mesh.visibility = 0;
    q.mesh.setEnabled(true);
    return q;
  }

  dispose() {
    for (const q of this.items) q.mesh.dispose(false, false);
    this.items.length = 0;
  }
}

function groundMaterial(scene: Scene, name: string, texture: Texture, alphaMode: number): StandardMaterial {
  const m = new StandardMaterial(`fx:${name}`, scene);
  m.disableLighting = true;
  m.emissiveColor = new Color3(1, 1, 1);
  m.diffuseTexture = texture;
  m.useAlphaFromDiffuseTexture = true;
  m.alphaMode = alphaMode;
  m.backFaceCulling = false;
  m.disableDepthWrite = true;
  m.zOffset = -1; // sits on top of the slab it marks
  return m;
}

// ---------------------------------------------------------------- tweens

type OverlayPulse = {
  mesh: AbstractMesh; t: number;
  prevOn: boolean; prevAlpha: number; prevR: number; prevG: number; prevB: number;
};
type EmissivePulse = { mat: { emissiveIntensity: number }; base: number; t: number };
type Assemble = { node: TransformNode; t: number; baseY: number; sx: number; sy: number; sz: number; frozen: AbstractMesh[] };

type PlayerFx = {
  lastSeen: number;
  status: PlayerView['status'];
  statusSince: number;
  stepAcc: number;
  trailAcc: number;
  side: number;
  splashed: boolean;
  shimmerLeft: number;
  shimmerAcc: number;
  hx: number;
  hz: number;
};

function hasEmissiveIntensity(m: unknown): m is { emissiveIntensity: number } {
  return !!m && typeof (m as { emissiveIntensity?: unknown }).emissiveIntensity === 'number';
}

function looksLikeBridge(id: string, node: Node): boolean {
  if (id.startsWith('bridge')) return true;
  const name = node.name ?? '';
  if (name.startsWith('bridge')) return true;
  const meta = node.metadata as { kind?: unknown } | null | undefined;
  return !!meta && meta.kind === 'bridge';
}

// ---------------------------------------------------------------- effects

export function createEffects(scene: Scene): Effects {
  const tex = getEffectTextures(scene);
  let theme: EffectsTheme = 'serene';
  let clock = 0; // ms, advanced by update()
  let disposed = false;

  // ---- materials and pools
  const ringMat = groundMaterial(scene, 'ringMat', tex.ring, Constants.ALPHA_ADD);
  const trailMat = groundMaterial(scene, 'trailMat', tex.softCircle, Constants.ALPHA_COMBINE);
  const rings = new QuadPool(scene, 'ring', 10, ringMat);
  const trails = new QuadPool(scene, 'trail', 32, trailMat);

  // ---- burst systems (created on first use so an idle scene pays nothing)
  let dust: Burst | null = null;
  let sparkle: Burst | null = null;
  let droplets: Burst | null = null;
  let embers: Burst | null = null;
  let steam: Region | null = null;
  let mist: Region | null = null;
  let ignite: Region | null = null;

  function getDust(): Burst {
    if (dust) return dust;
    dust = new Burst(scene, 'dust', 96, tex.softCircle, ParticleSystem.BLENDMODE_STANDARD);
    const ps = dust.ps;
    ps.isBillboardBased = false; // quad normal follows the (mostly vertical) direction: lies on the ground
    ps.minLifeTime = 0.45; ps.maxLifeTime = 0.75;
    ps.addSizeGradient(0, 0.22);
    ps.addSizeGradient(1, 0.6);
    ps.minScaleX = 0.8; ps.maxScaleX = 1.25;
    ps.minScaleY = 0.8; ps.maxScaleY = 1.25;
    ps.minAngularSpeed = -0.6; ps.maxAngularSpeed = 0.6;
    ps.minInitialRotation = 0; ps.maxInitialRotation = Math.PI * 2;
    ps.gravity.copyFromFloats(0, -0.08, 0);
    tintDust();
    return dust;
  }
  function tintDust() {
    if (!dust) return;
    const t = THEME[theme];
    dust.ps.color1.copyFrom(t.dust);
    dust.ps.color2.copyFrom(t.dust2);
    dust.ps.colorDead.copyFromFloats(t.dust2.r, t.dust2.g, t.dust2.b, 0);
  }
  function getSparkle(): Burst {
    if (sparkle) return sparkle;
    sparkle = new Burst(scene, 'sparkle', 160, tex.spark, ParticleSystem.BLENDMODE_ADD);
    const ps = sparkle.ps;
    ps.minLifeTime = 0.45; ps.maxLifeTime = 0.8;
    ps.minSize = 0.05; ps.maxSize = 0.11;
    ps.addColorGradient(0, new Color4(1, 0.95, 0.8, 0));
    ps.addColorGradient(0.15, new Color4(1, 0.96, 0.82, 1));
    ps.addColorGradient(1, new Color4(0.7, 0.85, 1, 0));
    ps.gravity.copyFromFloats(0, 0.4, 0); // sparks accelerate gently upward as they fade
    return sparkle;
  }
  function getDroplets(): Burst {
    if (droplets) return droplets;
    droplets = new Burst(scene, 'droplets', 120, tex.droplet, ParticleSystem.BLENDMODE_STANDARD);
    const ps = droplets.ps;
    ps.minLifeTime = 0.5; ps.maxLifeTime = 0.85;
    ps.minSize = 0.08; ps.maxSize = 0.16;
    ps.color1.copyFromFloats(0.86, 0.94, 1, 0.9);
    ps.color2.copyFromFloats(0.74, 0.88, 0.98, 0.8);
    ps.colorDead.copyFromFloats(0.8, 0.9, 1, 0);
    ps.gravity.copyFromFloats(0, -9.8, 0);
    return droplets;
  }
  function getEmbers(): Burst {
    if (embers) return embers;
    embers = new Burst(scene, 'embers', 160, tex.spark, ParticleSystem.BLENDMODE_ADD);
    const ps = embers.ps;
    ps.minLifeTime = 0.5; ps.maxLifeTime = 1.0;
    ps.minSize = 0.06; ps.maxSize = 0.14;
    ps.color1.copyFromFloats(1, 0.58, 0.22, 1);
    ps.color2.copyFromFloats(1, 0.42, 0.12, 1);
    ps.colorDead.copyFromFloats(0.5, 0.08, 0, 0);
    ps.gravity.copyFromFloats(0, -4, 0);
    return embers;
  }
  function getSteam(): Region {
    if (steam) return steam;
    steam = new Region(scene, 'steam', 400, tex.softCircle, ParticleSystem.BLENDMODE_STANDARD);
    const ps = steam.ps;
    ps.minLifeTime = 1.6; ps.maxLifeTime = 2.6;
    ps.addSizeGradient(0, 0.6);
    ps.addSizeGradient(1, 2.4);
    ps.minScaleX = 0.8; ps.maxScaleX = 1.3;
    ps.minScaleY = 0.8; ps.maxScaleY = 1.3;
    ps.addColorGradient(0, new Color4(0.9, 0.9, 0.92, 0));
    ps.addColorGradient(0.2, new Color4(0.9, 0.9, 0.92, 0.32));
    ps.addColorGradient(1, new Color4(0.95, 0.95, 0.97, 0));
    ps.direction1.copyFromFloats(-0.2, 0.6, -0.2);
    ps.direction2.copyFromFloats(0.2, 1.3, 0.2);
    ps.minAngularSpeed = -0.3; ps.maxAngularSpeed = 0.3;
    ps.minInitialRotation = 0; ps.maxInitialRotation = Math.PI * 2;
    return steam;
  }
  function getMist(): Region {
    if (mist) return mist;
    mist = new Region(scene, 'mist', 400, tex.softCircle, ParticleSystem.BLENDMODE_STANDARD);
    const ps = mist.ps;
    ps.minLifeTime = 1.8; ps.maxLifeTime = 3.0;
    ps.addSizeGradient(0, 1.0);
    ps.addSizeGradient(1, 2.8);
    ps.minScaleX = 0.8; ps.maxScaleX = 1.3;
    ps.minScaleY = 0.8; ps.maxScaleY = 1.3;
    ps.addColorGradient(0, new Color4(0.82, 0.9, 1, 0));
    ps.addColorGradient(0.25, new Color4(0.84, 0.92, 1, 0.22));
    ps.addColorGradient(1, new Color4(0.9, 0.95, 1, 0));
    ps.direction1.copyFromFloats(-0.25, 0.12, -0.25);
    ps.direction2.copyFromFloats(0.25, 0.4, 0.25);
    ps.minAngularSpeed = -0.2; ps.maxAngularSpeed = 0.2;
    ps.minInitialRotation = 0; ps.maxInitialRotation = Math.PI * 2;
    return mist;
  }
  function getIgnite(): Region {
    if (ignite) return ignite;
    ignite = new Region(scene, 'ignite', 220, tex.spark, ParticleSystem.BLENDMODE_ADD);
    const ps = ignite.ps;
    ps.minLifeTime = 1.0; ps.maxLifeTime = 1.9;
    ps.minSize = 0.05; ps.maxSize = 0.12;
    ps.addColorGradient(0, new Color4(1, 0.6, 0.25, 0));
    ps.addColorGradient(0.1, new Color4(1, 0.62, 0.25, 1));
    ps.addColorGradient(0.7, new Color4(1, 0.35, 0.1, 0.8));
    ps.addColorGradient(1, new Color4(0.5, 0.08, 0, 0));
    ps.direction1.copyFromFloats(-0.35, 0.5, -0.35);
    ps.direction2.copyFromFloats(0.35, 1.8, 0.35);
    ps.gravity.copyFromFloats(0, -0.6, 0);
    return ignite;
  }

  // ---- world bookkeeping
  const known = new Set<string>();
  let hazardMesh: AbstractMesh | null = null;
  const bounds = { cx: 0, cz: 0, hw: 18, hd: 18 };

  function hazardY(): number {
    if (!hazardMesh || hazardMesh.isDisposed()) hazardMesh = scene.getMeshByName('hazard');
    return hazardMesh ? hazardMesh.position.y : GEOMETRY.hazardPlaneElevation;
  }

  function measureBounds(nodesById: Map<string, Node>) {
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const node of nodesById.values()) {
      if (!(node instanceof TransformNode) || node.isDisposed()) continue;
      const p = node.getAbsolutePosition();
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    if (!Number.isFinite(minX)) return;
    bounds.cx = (minX + maxX) / 2;
    bounds.cz = (minZ + maxZ) / 2;
    bounds.hw = (maxX - minX) / 2 + 7;
    bounds.hd = (maxZ - minZ) / 2 + 7;
  }

  // ---- tween lists (swap-remove, no per-frame allocation)
  const overlays: OverlayPulse[] = [];
  const overlayByMesh = new Map<AbstractMesh, OverlayPulse>();
  const emissives: EmissivePulse[] = [];
  const emissiveByMat = new Map<{ emissiveIntensity: number }, EmissivePulse>();
  const assembles: Assemble[] = [];
  const assembleByNode = new Map<TransformNode, Assemble>();

  function ringAt(x: number, y: number, z: number, radius: number) {
    rings.spawn(x, y, z, 0, 1, 1, RING_MS, radius * 2, 0.7);
  }

  function pulseNode(node: Node) {
    const meshes = node.getChildMeshes(false);
    for (const mesh of meshes) {
      if (mesh.isDisposed()) continue;
      const existing = overlayByMesh.get(mesh);
      if (existing) { existing.t = 0; continue; }
      const prevColor = mesh.overlayColor;
      const p: OverlayPulse = {
        mesh, t: 0,
        prevOn: mesh.renderOverlay, prevAlpha: mesh.overlayAlpha,
        prevR: prevColor ? prevColor.r : 1, prevG: prevColor ? prevColor.g : 0, prevB: prevColor ? prevColor.b : 0,
      };
      const c = THEME[theme].overlay;
      if (prevColor) prevColor.set(c.r, c.g, c.b); else mesh.overlayColor = new Color3(c.r, c.g, c.b);
      mesh.renderOverlay = true;
      mesh.overlayAlpha = 0;
      overlays.push(p);
      overlayByMesh.set(mesh, p);
      const mat = mesh.material;
      if (hasEmissiveIntensity(mat)) {
        const e = emissiveByMat.get(mat);
        if (e) { e.t = 0; continue; }
        const ep: EmissivePulse = { mat, base: mat.emissiveIntensity, t: 0 };
        emissives.push(ep);
        emissiveByMat.set(mat, ep);
      }
    }
  }

  function finishOverlay(p: OverlayPulse) {
    const m = p.mesh;
    if (!m.isDisposed()) {
      m.renderOverlay = p.prevOn;
      m.overlayAlpha = p.prevAlpha;
      if (m.overlayColor) m.overlayColor.set(p.prevR, p.prevG, p.prevB);
    }
    overlayByMesh.delete(m);
  }
  function finishEmissive(p: EmissivePulse) {
    p.mat.emissiveIntensity = p.base;
    emissiveByMat.delete(p.mat);
  }

  function assembleNode(node: TransformNode) {
    if (assembleByNode.has(node)) return;
    const frozen: AbstractMesh[] = [];
    for (const m of node.getChildMeshes(false)) {
      if (m.isWorldMatrixFrozen) { m.unfreezeWorldMatrix(); frozen.push(m); }
    }
    const a: Assemble = {
      node, t: 0, baseY: node.position.y,
      sx: node.scaling.x, sy: node.scaling.y, sz: node.scaling.z, frozen,
    };
    assembles.push(a);
    assembleByNode.set(node, a);
    applyAssemble(a, 0);
  }
  function applyAssemble(a: Assemble, k: number) {
    const e = easeOutCubic(k);
    a.node.position.y = a.baseY - ASSEMBLE_DROP * (1 - e);
    const s = ASSEMBLE_SCALE + (1 - ASSEMBLE_SCALE) * e;
    a.node.scaling.copyFromFloats(a.sx * s, a.sy * s, a.sz * s);
  }
  function finishAssemble(a: Assemble) {
    const n = a.node;
    assembleByNode.delete(n);
    if (n.isDisposed()) return;
    n.position.y = a.baseY;
    n.scaling.copyFromFloats(a.sx, a.sy, a.sz);
    n.computeWorldMatrix(true);
    for (const m of a.frozen) if (!m.isDisposed()) m.freezeWorldMatrix();
  }

  function nodeRadius(node: Node): number {
    try {
      const bv = node.getHierarchyBoundingVectors(true);
      const dx = bv.max.x - bv.min.x;
      const dz = bv.max.z - bv.min.z;
      if (!Number.isFinite(dx) || !Number.isFinite(dz)) return 1.8;
      return Math.max(1.2, Math.max(dx, dz) * 0.5) + 0.6;
    } catch {
      return 1.8;
    }
  }

  // ---- players
  const players = new Map<string, PlayerFx>();
  let nextSweep = 1000;

  function splashAt(x: number, z: number) {
    const y = hazardY() + 0.05;
    const t = THEME[theme].ring;
    ringMat.emissiveColor.set(t.r, t.g, t.b);
    if (theme === 'volcanic') {
      const e = getEmbers();
      for (let i = 0; i < SPLASH_EMBERS; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = rand(0.4, 2.4);
        e.emit(x + rand(-0.2, 0.2), y, z + rand(-0.2, 0.2), Math.cos(a) * r, rand(2.4, 5.2), Math.sin(a) * r);
      }
      const d = getDust(); // a few dark puffs of ash with the embers
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        d.emit(x + Math.cos(a) * 0.3, y + 0.1, z + Math.sin(a) * 0.3, Math.cos(a) * 0.3, rand(0.5, 0.9), Math.sin(a) * 0.3);
      }
      ringAt(x, y + 0.02, z, 1.1);
    } else {
      const d = getDroplets();
      for (let i = 0; i < SPLASH_DROPLETS; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = rand(0.5, 2.2);
        d.emit(x + rand(-0.15, 0.15), y, z + rand(-0.15, 0.15), Math.cos(a) * r, rand(2.6, 4.8), Math.sin(a) * r);
      }
      ringAt(x, y + 0.02, z, 1.3);
    }
  }

  function dustAt(x: number, y: number, z: number, hx: number, hz: number, side: number, speed: number) {
    const d = getDust();
    // behind the moving foot, offset to the stepping side
    const px = -hz * 0.14 * side; const pz = hx * 0.14 * side;
    const back = 0.12;
    const n = speed > 3 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const lat = rand(0.05, 0.14);
      const a = Math.random() * Math.PI * 2;
      d.emit(
        x - hx * back + px + rand(-0.06, 0.06), y + 0.03, z - hz * back + pz + rand(-0.06, 0.06),
        -hx * 0.18 + Math.cos(a) * lat, rand(0.16, 0.3), -hz * 0.18 + Math.sin(a) * lat,
      );
    }
  }

  function trailAt(x: number, y: number, z: number, hx: number, hz: number) {
    const yaw = Math.atan2(hx, hz); // the quad's long axis is its local +Y, which yaw maps onto the heading
    trails.spawn(x, y + 0.015, z, yaw, 0.42, 1.5, TRAIL_MS, 1, TRAIL_ALPHA);
  }

  function shimmerAt(x: number, y: number, z: number, n: number) {
    const s = getSparkle();
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.1, 0.5);
      s.emit(x + Math.cos(a) * r, y + rand(0, 1.6), z + Math.sin(a) * r, rand(-0.2, 0.2), rand(0.8, 1.6), rand(-0.2, 0.2));
    }
  }

  // ---------------------------------------------------------------- hooks

  function onWorldApplied(changedIds: string[], nodesById: Map<string, Node>, reason: WorldReason) {
    if (disposed) return;
    measureBounds(nodesById);
    if (reason === 'commit' && known.size > 0) {
      const t = THEME[theme].ring;
      ringMat.emissiveColor.set(t.r, t.g, t.b);
      for (const id of changedIds) {
        const node = nodesById.get(id);
        if (!node || node.isDisposed()) continue;
        const isNew = !known.has(id);
        if (isNew && node instanceof TransformNode && looksLikeBridge(id, node)) assembleNode(node);
        pulseNode(node);
        if (node instanceof TransformNode) {
          const p = node.getAbsolutePosition();
          const a = assembleByNode.get(node);
          const groundY = a ? a.baseY : p.y;
          ringAt(p.x, groundY + 0.04, p.z, nodeRadius(node));
        }
      }
    }
    known.clear();
    for (const id of nodesById.keys()) known.add(id);
  }

  function onPlayerUpdate(id: string, view: PlayerView, speed: number, dtMs: number) {
    if (disposed) return;
    const dt = dtMs > MAX_DT_MS ? MAX_DT_MS : dtMs < 0 ? 0 : dtMs;
    let s = players.get(id);
    if (!s) {
      s = {
        lastSeen: clock, status: view.status, statusSince: clock, stepAcc: 0, trailAcc: 0, side: 1,
        splashed: view.status !== 'falling', shimmerLeft: 0, shimmerAcc: 0, hx: 0, hz: 1,
      };
      players.set(id, s);
    }
    s.lastSeen = clock;
    const x = view.x; const z = view.z; const y = Number.isFinite(view.y) ? view.y : 0;

    // status transitions
    if (view.status !== s.status) {
      const prev = s.status;
      s.status = view.status;
      s.statusSince = clock;
      if (prev === 'falling' && !s.splashed) { splashAt(x, z); s.splashed = true; }
      if (view.status === 'falling') s.splashed = false;
      if (view.status === 'respawning' || (view.status === 'active' && prev === 'respawning')) {
        s.shimmerLeft = SHIMMER_MS;
        s.shimmerAcc = 0;
      }
    }

    // heading from velocity, else from facing
    const vLen = Math.hypot(view.vx, view.vz);
    if (vLen > 0.05) { s.hx = view.vx / vLen; s.hz = view.vz / vLen; }
    else if (Number.isFinite(view.facingDeg)) { const f = (view.facingDeg * Math.PI) / 180; s.hx = Math.sin(f); s.hz = Math.cos(f); }

    if (s.status === 'falling' && !s.splashed) {
      // mirror the renderer's fall curve to meet the hazard surface, with a hard stop at the fall's end
      const since = clock - s.statusSince;
      const f = Math.min(1, since / GEOMETRY.fallDurationMs);
      const yRender = y - f * f * 3.2;
      if (yRender <= hazardY() + 0.25 || f >= 1) { splashAt(x, z); s.splashed = true; }
    }

    if (s.shimmerLeft > 0) {
      s.shimmerLeft -= dt;
      s.shimmerAcc += (dt / 1000) * SHIMMER_PER_S;
      const n = Math.floor(s.shimmerAcc);
      if (n > 0) { s.shimmerAcc -= n; shimmerAt(x, y, z, n); }
    }

    if (s.status === 'active' && speed > 0.5) {
      const travelled = speed * (dt / 1000);
      s.stepAcc += travelled;
      s.trailAcc += travelled;
      if (s.stepAcc >= STRIDE_M) {
        s.stepAcc -= STRIDE_M;
        if (s.stepAcc > STRIDE_M) s.stepAcc = 0;
        s.side = -s.side;
        dustAt(x, y, z, s.hx, s.hz, s.side, speed);
      }
      if (s.trailAcc >= TRAIL_SPACING_M) {
        s.trailAcc -= TRAIL_SPACING_M;
        if (s.trailAcc > TRAIL_SPACING_M) s.trailAcc = 0;
        trailAt(x, y, z, s.hx, s.hz);
      }
    } else {
      // keep the first puff after a stop from firing instantly, but never let the accumulator run away
      if (s.stepAcc > STRIDE_M * 0.5) s.stepAcc = STRIDE_M * 0.5;
      if (s.trailAcc > TRAIL_SPACING_M * 0.5) s.trailAcc = TRAIL_SPACING_M * 0.5;
    }
  }

  function onThemeChange(raw: EffectsTheme | string) {
    // biome themes map onto the two effect palettes: anything carrying the lava overlay is 'volcanic'
    const next: EffectsTheme = raw === 'volcanic' || raw.endsWith('_lava') ? 'volcanic' : 'serene';
    if (disposed || next === theme) return;
    theme = next;
    const t = THEME[theme];
    ringMat.emissiveColor.set(t.ring.r, t.ring.g, t.ring.b);
    trailMat.emissiveColor.set(t.trail.r, t.trail.g, t.trail.b);
    tintDust();
    const y = hazardY() + 0.1;
    const area = bounds.hw * 2 * bounds.hd * 2;
    if (theme === 'volcanic') {
      getSteam().fire(2000, Math.min(150, Math.max(30, area * 0.1)), bounds.cx, y, bounds.cz, bounds.hw, bounds.hd);
      getIgnite().fire(1500, Math.min(110, Math.max(24, area * 0.07)), bounds.cx, y, bounds.cz, bounds.hw, bounds.hd);
    } else {
      getMist().fire(2000, Math.min(150, Math.max(30, area * 0.1)), bounds.cx, y, bounds.cz, bounds.hw, bounds.hd);
    }
  }

  function update(dtMs: number) {
    if (disposed) return;
    const dt = dtMs > MAX_DT_MS ? MAX_DT_MS : dtMs < 0 ? 0 : dtMs;
    clock += dt;

    // ground quads
    for (const q of rings.items) {
      if (!q.active) continue;
      q.t += dt;
      const k = clamp01(q.t / q.dur);
      if (k >= 1) { q.active = false; q.mesh.setEnabled(false); continue; }
      const sc = q.size * (0.25 + 0.75 * easeOutCubic(k));
      q.mesh.scaling.copyFromFloats(sc, sc, 1);
      q.mesh.visibility = q.alpha * (1 - easeOutQuad(k));
    }
    for (const q of trails.items) {
      if (!q.active) continue;
      q.t += dt;
      const k = clamp01(q.t / q.dur);
      if (k >= 1) { q.active = false; q.mesh.setEnabled(false); continue; }
      q.mesh.visibility = q.alpha * (1 - k);
    }

    // commit pulses
    for (let i = overlays.length - 1; i >= 0; i--) {
      const p = overlays[i];
      p.t += dt;
      const k = p.t / PULSE_MS;
      if (k >= 1 || p.mesh.isDisposed()) {
        finishOverlay(p);
        overlays[i] = overlays[overlays.length - 1];
        overlays.pop();
        continue;
      }
      p.mesh.overlayAlpha = PULSE_OVERLAY_PEAK * flash(k);
    }
    for (let i = emissives.length - 1; i >= 0; i--) {
      const p = emissives[i];
      p.t += dt;
      const k = p.t / PULSE_MS;
      if (k >= 1) {
        finishEmissive(p);
        emissives[i] = emissives[emissives.length - 1];
        emissives.pop();
        continue;
      }
      p.mat.emissiveIntensity = p.base + PULSE_EMISSIVE_PEAK * flash(k);
    }

    // bridge assembly
    for (let i = assembles.length - 1; i >= 0; i--) {
      const a = assembles[i];
      a.t += dt;
      const k = a.t / ASSEMBLE_MS;
      if (k >= 1 || a.node.isDisposed()) {
        finishAssemble(a);
        assembles[i] = assembles[assembles.length - 1];
        assembles.pop();
        continue;
      }
      applyAssemble(a, k);
    }

    // theme bursts
    steam?.update(dt);
    mist?.update(dt);
    ignite?.update(dt);

    // queued bursts
    dust?.flush();
    sparkle?.flush();
    droplets?.flush();
    embers?.flush();

    // forget players that stopped updating
    nextSweep -= dt;
    if (nextSweep <= 0) {
      nextSweep = 1000;
      for (const [id, s] of players) if (clock - s.lastSeen > PLAYER_STALE_MS) players.delete(id);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const p of overlays) finishOverlay(p);
    overlays.length = 0;
    for (const p of emissives) finishEmissive(p);
    emissives.length = 0;
    for (const a of assembles) finishAssemble(a);
    assembles.length = 0;
    players.clear();
    known.clear();
    rings.dispose();
    trails.dispose();
    ringMat.dispose();
    trailMat.dispose();
    dust?.dispose(); sparkle?.dispose(); droplets?.dispose(); embers?.dispose();
    steam?.dispose(); mist?.dispose(); ignite?.dispose();
    dust = sparkle = droplets = embers = null;
    steam = mist = ignite = null;
  }

  return { onWorldApplied, onPlayerUpdate, onThemeChange, update, dispose };
}
