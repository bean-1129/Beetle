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

export type ParticleWeights = { fireflies: number; pollen: number; embers: number; ash: number; snow: number; shimmer: number };
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
  const fireflies = make('fx:fireflies', 80, ParticleSystem.BLENDMODE_ADD, 14); // ~80 alive (14/s x 5.75 s)
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
    ps.addColorGradient(0.45, new Color4(0.45, 0.5, 0.2, 1)); // soft blink: never off, no flicker
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
  const embers = make('fx:embers', 160, ParticleSystem.BLENDMODE_ADD, 48); // ~155 alive (48/s x 3.2 s)
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

  // --- frost: snow drifting down over the islands ---
  const snow = make('fx:snow', 140, ParticleSystem.BLENDMODE_STANDARD, 12); // ~130 alive (12/s x 11 s)
  {
    const ps = snow.ps;
    ps.minSize = 0.06; ps.maxSize = 0.14;
    ps.minLifeTime = 9; ps.maxLifeTime = 13;
    ps.minEmitPower = 0.3; ps.maxEmitPower = 0.7;
    ps.direction1 = new Vector3(-0.35, -1, -0.2); ps.direction2 = new Vector3(0.35, -0.7, 0.2);
    ps.minEmitBox = new Vector3(-30, 10, -30); ps.maxEmitBox = new Vector3(30, 16, 30);
    ps.gravity = new Vector3(0, -0.1, 0);
    ps.addColorGradient(0, new Color4(1, 1, 1, 0));
    ps.addColorGradient(0.1, new Color4(0.98, 0.99, 1, 0.9));
    ps.addColorGradient(0.85, new Color4(0.95, 0.97, 1, 0.8));
    ps.addColorGradient(1, new Color4(0.95, 0.97, 1, 0));
    ps.minAngularSpeed = -0.5; ps.maxAngularSpeed = 0.5;
  }
  // --- desert: sparse heat shimmer motes rising off the ground (additive, nearly transparent) ---
  const shimmer = make('fx:shimmer', 70, ParticleSystem.BLENDMODE_ADD, 9);
  {
    const ps = shimmer.ps;
    ps.minSize = 0.4; ps.maxSize = 0.9;
    ps.minLifeTime = 2.5; ps.maxLifeTime = 4.5;
    ps.minEmitPower = 0.25; ps.maxEmitPower = 0.6;
    ps.direction1 = new Vector3(-0.1, 1, -0.1); ps.direction2 = new Vector3(0.1, 1, 0.1);
    ps.minEmitBox = new Vector3(-20, 0.1, -20); ps.maxEmitBox = new Vector3(20, 0.6, 20);
    ps.gravity = new Vector3(0, 0.05, 0);
    ps.addColorGradient(0, new Color4(1, 0.95, 0.8, 0));
    ps.addColorGradient(0.4, new Color4(1, 0.95, 0.8, 0.07));
    ps.addColorGradient(1, new Color4(1, 0.9, 0.75, 0));
  }
  // --- survival: steam where a rising hazard meets island skirts and submerged bridge decks ---
  const steam = make('fx:steam', 220, ParticleSystem.BLENDMODE_STANDARD, 60);
  type Segment = { x0: number; z0: number; x1: number; z1: number };
  const rims: { x: number; z: number; r: number }[] = [];
  const decks: Segment[] = [];
  let steamY = -2.5;
  {
    const ps = steam.ps;
    ps.minSize = 0.5; ps.maxSize = 1.3;
    ps.minLifeTime = 1.4; ps.maxLifeTime = 2.6;
    ps.minEmitPower = 0.5; ps.maxEmitPower = 1.1;
    ps.direction1 = new Vector3(-0.2, 1, -0.2); ps.direction2 = new Vector3(0.2, 1.4, 0.2);
    ps.gravity = new Vector3(0, 0.2, 0);
    ps.addColorGradient(0, new Color4(0.9, 0.92, 0.95, 0));
    ps.addColorGradient(0.25, new Color4(0.9, 0.92, 0.95, 0.35));
    ps.addColorGradient(1, new Color4(0.85, 0.88, 0.92, 0));
    ps.addSizeGradient(0, 0.5); ps.addSizeGradient(1, 1.6);
    ps.startPositionFunction = (_w, pos) => {
      const n = rims.length + decks.length;
      if (n === 0) { pos.set(0, steamY, 0); return; }
      const k = Math.floor(Math.random() * n);
      if (k < rims.length) {
        const rim = rims[k];
        const a = Math.random() * Math.PI * 2;
        const d = rim.r + 0.3 + Math.random() * 1.2;
        pos.set(rim.x + Math.cos(a) * d, steamY, rim.z + Math.sin(a) * d);
      } else {
        const sgm = decks[k - rims.length];
        const t = Math.random();
        pos.set(sgm.x0 + (sgm.x1 - sgm.x0) * t + (Math.random() - 0.5) * 1.2, steamY, sgm.z0 + (sgm.z1 - sgm.z0) * t + (Math.random() - 0.5) * 1.2);
      }
    };
  }

  const all: Record<keyof ParticleWeights, Sys> = { fireflies, pollen, embers, ash, snow, shimmer };

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
    snow.ps.minEmitBox.set(minX - 6, 10, minZ - 6); snow.ps.maxEmitBox.set(maxX + 6, 16, maxZ + 6);
    shimmer.ps.minEmitBox.set(minX, 0.1, minZ); shimmer.ps.maxEmitBox.set(maxX, 0.6, maxZ);
    rims.length = 0;
    for (const i of spec.islands) rims.push({ x: i.center.x, z: i.center.z, r: i.radius + 0.8 });
    decks.length = 0;
    for (const b of spec.bridges) decks.push({ x0: b.endpoints[0].point.x, z0: b.endpoints[0].point.z, x1: b.endpoints[1].point.x, z1: b.endpoints[1].point.z });
    setHazardY(hy);
  }

  /** Live hazard plane height (survival rise): embers and steam follow it. */
  function setHazardY(y: number) {
    steamY = y + 0.05;
    const e = embers.ps;
    e.minEmitBox.y = y + 0.1; e.maxEmitBox.y = y + 0.4;
  }

  /** Steam intensity 0..1 (rim steam while the hazard rises; bridges submerge and hiss). */
  function setSteam(weight: number, bridgesSubmerged: boolean) {
    const w = Math.max(0, Math.min(1, weight)) * qualityScale * (bridgesSubmerged ? 1.4 : 1);
    steam.ps.emitRate = steam.baseRate * w;
    if (w > 0.01) { if (!steam.running) { steam.ps.start(); steam.running = true; } }
    else if (steam.running && steam.ps.getActiveCount() === 0) { steam.ps.stop(); steam.running = false; }
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
    steam.ps.dispose(false);
    sprite.dispose();
  }

  return { setBounds, setHazardY, setSteam, update, setQuality, dispose, systems: all, steam: steam.ps };
}
