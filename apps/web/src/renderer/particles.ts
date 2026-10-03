import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { WorldSpec } from '@beetle/contracts';

/** Soft radial sprite generated at runtime (no asset loads). */
function makeSoftCircle(scene: Scene): DynamicTexture {
  const size = 64;
  const tex = new DynamicTexture('tex:softCircle', { width: size, height: size }, scene, false);
  const ctx = tex.getContext();
  const img = ctx.getImageData(0, 0, size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      const a = Math.max(0, 1 - d);
      const soft = a * a * (3 - 2 * a);
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(soft * soft * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.hasAlpha = true;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE; tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

export type ParticleWeights = { fireflies: number; pollen: number; embers: number; ash: number };
export type Particles = ReturnType<typeof createParticles>;

type Sys = { ps: ParticleSystem; baseRate: number; running: boolean };

export function createParticles(scene: Scene) {
  const sprite = makeSoftCircle(scene);
  const origin = new Vector3(0, 0, 0);
  let qualityScale = 1;

  function make(name: string, capacity: number, blend: number, baseRate: number): Sys {
    const ps = new ParticleSystem(name, capacity, scene);
    ps.particleTexture = sprite;
    ps.blendMode = blend;
    ps.emitter = origin;
    ps.emitRate = 0;
    ps.updateSpeed = 0.012;
    ps.isLocal = false;
    ps.preventAutoStart = true;
    ps.applyFog = blend !== ParticleSystem.BLENDMODE_ADD;
    return { ps, baseRate, running: false };
  }

  // --- serene: fireflies (additive, blinking) and pollen (soft, slow) ---
  const fireflies = make('fx:fireflies', 110, ParticleSystem.BLENDMODE_ADD, 16);
  {
    const ps = fireflies.ps;
    ps.minSize = 0.09; ps.maxSize = 0.2;
    ps.minLifeTime = 4; ps.maxLifeTime = 7.5;
    ps.minEmitPower = 0.15; ps.maxEmitPower = 0.5;
    ps.direction1 = new Vector3(-0.4, -0.15, -0.4); ps.direction2 = new Vector3(0.4, 0.3, 0.4);
    ps.minEmitBox = new Vector3(-20, 0.5, -20); ps.maxEmitBox = new Vector3(20, 2.6, 20);
    ps.gravity = new Vector3(0, 0, 0);
    ps.addColorGradient(0, new Color4(0, 0, 0, 0));
    ps.addColorGradient(0.2, new Color4(1, 0.85, 0.35, 1));
    ps.addColorGradient(0.45, new Color4(0.2, 0.25, 0.05, 1));
    ps.addColorGradient(0.65, new Color4(0.9, 1, 0.45, 1));
    ps.addColorGradient(1, new Color4(0, 0, 0, 0));
    ps.minAngularSpeed = 0; ps.maxAngularSpeed = 0;
  }
  const pollen = make('fx:pollen', 60, ParticleSystem.BLENDMODE_STANDARD, 7);
  {
    const ps = pollen.ps;
    ps.minSize = 0.05; ps.maxSize = 0.11;
    ps.minLifeTime = 6; ps.maxLifeTime = 10;
    ps.minEmitPower = 0.1; ps.maxEmitPower = 0.35;
    ps.direction1 = new Vector3(-0.5, 0.1, -0.5); ps.direction2 = new Vector3(0.5, 0.4, 0.5);
    ps.minEmitBox = new Vector3(-20, 0.8, -20); ps.maxEmitBox = new Vector3(20, 4, 20);
    ps.gravity = new Vector3(0, -0.04, 0);
    ps.addColorGradient(0, new Color4(1, 1, 0.85, 0));
    ps.addColorGradient(0.25, new Color4(1, 0.98, 0.85, 0.45));
    ps.addColorGradient(1, new Color4(1, 0.95, 0.8, 0));
  }

  // --- volcanic: embers rising from the lava plane, sparse ash falling ---
  const embers = make('fx:embers', 260, ParticleSystem.BLENDMODE_ADD, 70);
  {
    const ps = embers.ps;
    ps.minSize = 0.07; ps.maxSize = 0.17;
    ps.minLifeTime = 2.2; ps.maxLifeTime = 4.2;
    ps.minEmitPower = 0.8; ps.maxEmitPower = 1.9;
    ps.direction1 = new Vector3(-0.35, 1, -0.35); ps.direction2 = new Vector3(0.35, 1.8, 0.35);
    ps.minEmitBox = new Vector3(-28, -2.4, -28); ps.maxEmitBox = new Vector3(28, -2.1, 28);
    ps.gravity = new Vector3(0, -0.12, 0);
    ps.addColorGradient(0, new Color4(1, 0.75, 0.3, 1));
    ps.addColorGradient(0.6, new Color4(1, 0.4, 0.08, 0.9));
    ps.addColorGradient(1, new Color4(0.25, 0.04, 0, 0));
    ps.addSizeGradient(0, 1); ps.addSizeGradient(1, 0.35);
  }
  const ash = make('fx:ash', 150, ParticleSystem.BLENDMODE_STANDARD, 18);
  {
    const ps = ash.ps;
    ps.minSize = 0.07; ps.maxSize = 0.15;
    ps.minLifeTime = 7; ps.maxLifeTime = 10;
    ps.minEmitPower = 0.4; ps.maxEmitPower = 0.9;
    ps.direction1 = new Vector3(-0.25, -1, -0.25); ps.direction2 = new Vector3(0.25, -0.6, 0.25);
    ps.minEmitBox = new Vector3(-30, 16, -30); ps.maxEmitBox = new Vector3(30, 24, 30);
    ps.gravity = new Vector3(0, -0.05, 0);
    ps.addColorGradient(0, new Color4(0.3, 0.26, 0.24, 0));
    ps.addColorGradient(0.2, new Color4(0.32, 0.28, 0.26, 0.65));
    ps.addColorGradient(1, new Color4(0.2, 0.17, 0.16, 0));
  }

  const all: Record<keyof ParticleWeights, Sys> = { fireflies, pollen, embers, ash };

  /** Emitter boxes follow the islands' bounding box; embers hug the hazard plane. */
  function setBounds(spec: WorldSpec) {
    if (spec.islands.length === 0) return;
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const i of spec.islands) {
      minX = Math.min(minX, i.center.x - i.radius); maxX = Math.max(maxX, i.center.x + i.radius);
      minZ = Math.min(minZ, i.center.z - i.radius); maxZ = Math.max(maxZ, i.center.z + i.radius);
    }
    const hy = spec.hazard.planeElevation;
    fireflies.ps.minEmitBox.set(minX, 0.5, minZ); fireflies.ps.maxEmitBox.set(maxX, 2.6, maxZ);
    pollen.ps.minEmitBox.set(minX, 0.8, minZ); pollen.ps.maxEmitBox.set(maxX, 4, maxZ);
    embers.ps.minEmitBox.set(minX - 8, hy + 0.1, minZ - 8); embers.ps.maxEmitBox.set(maxX + 8, hy + 0.4, maxZ + 8);
    ash.ps.minEmitBox.set(minX - 10, 16, minZ - 10); ash.ps.maxEmitBox.set(maxX + 10, 24, maxZ + 10);
  }

  /** Weights 0..1 per preset (blended by the environment). Emission fades; live particles age out. */
  function update(w: ParticleWeights) {
    for (const key of Object.keys(all) as (keyof ParticleWeights)[]) {
      const s = all[key];
      const weight = Math.max(0, Math.min(1, w[key])) * qualityScale;
      s.ps.emitRate = s.baseRate * weight;
      if (weight > 0.01) {
        if (!s.running) { s.ps.start(); s.running = true; }
      } else if (s.running && s.ps.getActiveCount() === 0) {
        s.ps.stop(); s.running = false;
      }
    }
  }

  function setQuality(q: 'high' | 'low') { qualityScale = q === 'high' ? 1 : 0.45; }

  function dispose() {
    for (const s of Object.values(all)) s.ps.dispose(false);
    sprite.dispose();
  }

  return { setBounds, update, setQuality, dispose, systems: all };
}
