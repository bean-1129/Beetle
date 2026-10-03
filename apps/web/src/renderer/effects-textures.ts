// Procedural sprite textures for the effects layer. Everything is painted at runtime into small
// DynamicTextures (no network, no CDN) and cached once per scene; the cache clears itself when the
// scene is disposed.
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';

export type EffectTextures = {
  /** Radial falloff, fully transparent at the edge: dust, mist, steam, trail stamps. */
  softCircle: DynamicTexture;
  /** Thin bright ring with a soft inner and outer edge: ground light rings. */
  ring: DynamicTexture;
  /** Teardrop with a bright core: water splash droplets. */
  droplet: DynamicTexture;
  /** Tight hot core with a short glow: embers and respawn sparkles. */
  spark: DynamicTexture;
  dispose: () => void;
};

const cache = new WeakMap<Scene, EffectTextures>();

type Painter = (ctx: CanvasRenderingContext2D, size: number) => void;

function paint(scene: Scene, name: string, size: number, painter: Painter): DynamicTexture {
  const tex = new DynamicTexture(`fx:${name}`, { width: size, height: size }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  // ICanvasRenderingContext is the engine's narrowed interface; in the browser it is a real 2D context.
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  painter(ctx, size);
  tex.update(false);
  tex.hasAlpha = true;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

function softCircle(ctx: CanvasRenderingContext2D, size: number) {
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

function ring(ctx: CanvasRenderingContext2D, size: number) {
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.62, 'rgba(255,255,255,0)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.86, 'rgba(255,255,255,1)');
  g.addColorStop(0.94, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

function droplet(ctx: CanvasRenderingContext2D, size: number) {
  const c = size / 2;
  // teardrop silhouette: a circle in the lower half tapering to a point at the top
  ctx.beginPath();
  ctx.moveTo(c, size * 0.08);
  ctx.bezierCurveTo(size * 0.84, size * 0.5, size * 0.84, size * 0.9, c, size * 0.92);
  ctx.bezierCurveTo(size * 0.16, size * 0.9, size * 0.16, size * 0.5, c, size * 0.08);
  ctx.closePath();
  const g = ctx.createRadialGradient(c, size * 0.62, 0, c, size * 0.62, size * 0.42);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0.2)');
  ctx.fillStyle = g;
  ctx.fill();
  // specular highlight off-centre, the way a lit drop reads
  const h = ctx.createRadialGradient(size * 0.42, size * 0.56, 0, size * 0.42, size * 0.56, size * 0.14);
  h.addColorStop(0, 'rgba(255,255,255,0.9)');
  h.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, size, size);
}

function spark(ctx: CanvasRenderingContext2D, size: number) {
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.3)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

/** Sprite textures for a scene, created on first use and shared by every effect in that scene. */
export function getEffectTextures(scene: Scene): EffectTextures {
  const hit = cache.get(scene);
  if (hit) return hit;
  const set: EffectTextures = {
    softCircle: paint(scene, 'softCircle', 64, softCircle),
    ring: paint(scene, 'ring', 128, ring),
    droplet: paint(scene, 'droplet', 32, droplet),
    spark: paint(scene, 'spark', 32, spark),
    dispose: () => {
      if (cache.get(scene) !== set) return;
      cache.delete(scene);
      set.softCircle.dispose();
      set.ring.dispose();
      set.droplet.dispose();
      set.spark.dispose();
    },
  };
  cache.set(scene, set);
  scene.onDisposeObservable.addOnce(() => set.dispose());
  return set;
}
