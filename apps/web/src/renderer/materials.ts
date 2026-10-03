import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { HazardKind } from '@beetle/contracts';
import { PALETTE } from './palette.ts';

type MatOpts = { emissive?: Color3; specular?: number; alpha?: number; unlit?: boolean; twoSided?: boolean };

function mat(scene: Scene, name: string, diffuse: Color3, opts: MatOpts = {}): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = diffuse;
  m.specularColor = new Color3(opts.specular ?? 0.08, opts.specular ?? 0.08, opts.specular ?? 0.08);
  if (opts.emissive) m.emissiveColor = opts.emissive;
  if (opts.alpha !== undefined) m.alpha = opts.alpha;
  if (opts.unlit) m.disableLighting = true;
  if (opts.twoSided) m.backFaceCulling = false;
  return m;
}

/**
 * A small tileable value-noise texture generated once on a canvas. Scrolled over the hazard plane it reads as
 * water shimmer, and multiplied into the lava emissive it reads as slow glowing veins. Grey, so it only
 * modulates the palette colour.
 */
function makeNoiseTexture(scene: Scene): DynamicTexture {
  const size = 128;
  const tex = new DynamicTexture('hazard:noise', { width: size, height: size }, scene, false);
  const ctx = tex.getContext();
  const img = ctx.getImageData(0, 0, size, size);
  const lattice = (n: number, seed: number) => {
    const g: number[] = [];
    let a = seed >>> 0;
    for (let i = 0; i < n * n; i++) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      g.push(((t ^ (t >>> 14)) >>> 0) / 4294967296);
    }
    return (x: number, y: number) => {
      // wrap so the texture tiles
      const fx = (x * n) / size; const fy = (y * n) / size;
      const x0 = Math.floor(fx) % n; const y0 = Math.floor(fy) % n;
      const x1 = (x0 + 1) % n; const y1 = (y0 + 1) % n;
      const sx = fx - Math.floor(fx); const sy = fy - Math.floor(fy);
      const ux = sx * sx * (3 - 2 * sx); const uy = sy * sy * (3 - 2 * sy);
      const a0 = g[y0 * n + x0] + (g[y0 * n + x1] - g[y0 * n + x0]) * ux;
      const a1 = g[y1 * n + x0] + (g[y1 * n + x1] - g[y1 * n + x0]) * ux;
      return a0 + (a1 - a0) * uy;
    };
  };
  const n1 = lattice(6, 1234); const n2 = lattice(12, 5678); const n3 = lattice(24, 9012);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 0.55 * n1(x, y) + 0.3 * n2(x, y) + 0.15 * n3(x, y);
      const grey = Math.round(200 + 52 * v); // gentle: the plane keeps the palette colour, the noise only shimmers
      const i = (y * size + x) * 4;
      img.data[i] = grey; img.data[i + 1] = grey; img.data[i + 2] = grey; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.uScale = 22;
  tex.vScale = 22;
  return tex;
}

export type Materials = ReturnType<typeof createMaterials>;

export function createMaterials(scene: Scene) {
  const playerCache = new Map<string, StandardMaterial>();
  const shared = {
    stoneTop: mat(scene, 'stoneTop', PALETTE.stoneTop),
    stoneSide: mat(scene, 'stoneSide', PALETTE.stoneSide),
    stoneRim: mat(scene, 'stoneRim', PALETTE.stoneRim),
    stoneDark: mat(scene, 'stoneDark', PALETTE.stoneDark),
    grass: mat(scene, 'grass', PALETTE.grass, { specular: 0.03 }),
    grassDark: mat(scene, 'grassDark', PALETTE.grassDark, { specular: 0.03 }),
    wood: mat(scene, 'wood', PALETTE.wood, { specular: 0.05 }),
    woodLight: mat(scene, 'woodLight', PALETTE.woodLight, { specular: 0.05 }),
    plankA: mat(scene, 'plankA', PALETTE.plankA, { specular: 0.05 }),
    plankB: mat(scene, 'plankB', PALETTE.plankB, { specular: 0.05 }),
    rope: mat(scene, 'rope', PALETTE.rope),
    trunk: mat(scene, 'trunk', PALETTE.trunk),
    leaves: mat(scene, 'leaves', PALETTE.leaves),
    leavesDark: mat(scene, 'leavesDark', PALETTE.leavesDark),
    bush: mat(scene, 'bush', PALETTE.bush),
    rock: mat(scene, 'rock', PALETTE.rock, { specular: 0.15 }),
    lanternPost: mat(scene, 'lanternPost', PALETTE.lanternPost),
    lanternGlow: mat(scene, 'lanternGlow', PALETTE.lanternGlow, { emissive: PALETTE.lanternGlow.scale(0.75) }),
    relic: mat(scene, 'relic', PALETTE.relic, { emissive: PALETTE.relic.scale(0.55), specular: 0.7 }),
    relicHalo: mat(scene, 'relicHalo', PALETTE.relicHalo, { emissive: PALETTE.relicHalo, alpha: 0.22, unlit: true }),
    gateLocked: mat(scene, 'gateLocked', PALETTE.gateLocked),
    gateUnlocked: mat(scene, 'gateUnlocked', PALETTE.gateUnlocked, { emissive: PALETTE.amberBright.scale(0.7), specular: 0.4 }),
    gateCone: mat(scene, 'gateCone', PALETTE.amberBright, { emissive: PALETTE.amberBright, alpha: 0.0, unlit: true }),
    hat: mat(scene, 'hat', PALETTE.amber),
    halo: mat(scene, 'halo', PALETTE.amberBright, { emissive: PALETTE.amberBright.scale(0.6) }),
    playerBase: mat(scene, 'playerBase', PALETTE.stoneDark.scale(0.6), { specular: 0.2 }),
    // soft contact / under shadows: unlit, translucent, drawn from either side
    underShadow: mat(scene, 'underShadow', PALETTE.shadow, { alpha: 0.38, unlit: true, twoSided: true }),
    // thin glowing crust ring under each island; alpha driven by the hazard blend (0 in water mode)
    crust: mat(scene, 'crust', PALETTE.lavaDeep, { emissive: PALETTE.lavaCrust, alpha: 0, unlit: true }),
  };
  shared.gateCone.backFaceCulling = false;
  shared.crust.backFaceCulling = false;

  const noise = makeNoiseTexture(scene);
  const hazard = new StandardMaterial('hazard', scene);
  hazard.diffuseColor = PALETTE.water.clone();
  hazard.diffuseTexture = noise; // (emissiveTexture is additive in StandardMaterial, so the noise only modulates diffuse)
  hazard.specularColor = new Color3(0.35, 0.42, 0.5);
  hazard.specularPower = 40;
  hazard.emissiveColor = new Color3(0, 0, 0);
  hazard.alpha = 0.84;
  hazard.backFaceCulling = true;

  // Material swap with a short blend: we hold one material and lerp its colours toward the target kind.
  let currentKind: HazardKind = 'water';
  let blend = 1; // 0 = fully previous kind, 1 = fully current kind
  let fromDiffuse = PALETTE.water.clone();
  let fromEmissive = new Color3(0, 0, 0);
  let fromAlpha = 0.84;
  let fromCrust = 0;
  const BLEND_MS = 700;
  let blendStart = 0;

  function targetFor(kind: HazardKind) {
    return kind === 'lava'
      ? { diffuse: Color3.Lerp(PALETTE.lavaDeep, PALETTE.lava, 0.3), emissive: PALETTE.lavaGlow.scale(0.4), alpha: 0.98, crust: 0.85 }
      : { diffuse: PALETTE.water, emissive: new Color3(0, 0, 0), alpha: 0.84, crust: 0 };
  }

  function setHazardKind(kind: HazardKind, now: number) {
    if (kind === currentKind) return;
    fromDiffuse = hazard.diffuseColor.clone();
    fromEmissive = hazard.emissiveColor.clone();
    fromAlpha = hazard.alpha;
    fromCrust = shared.crust.alpha;
    currentKind = kind;
    blend = 0;
    blendStart = now;
  }

  /** Called every frame: scrolls the shimmer, finishes blends and runs the lava pulse. */
  function animateHazard(now: number) {
    const t = targetFor(currentKind);
    // scrolling procedural noise: quick for water, slow and heavy for lava
    const speed = currentKind === 'lava' ? 0.0000045 : 0.000016;
    noise.uOffset = (now * speed) % 1;
    noise.vOffset = (now * speed * 0.63) % 1;
    if (blend < 1) {
      blend = Math.min(1, (now - blendStart) / BLEND_MS);
      const e = blend * blend * (3 - 2 * blend);
      Color3.LerpToRef(fromDiffuse, t.diffuse, e, hazard.diffuseColor);
      Color3.LerpToRef(fromEmissive, t.emissive, e, hazard.emissiveColor);
      hazard.alpha = fromAlpha + (t.alpha - fromAlpha) * e;
      shared.crust.alpha = fromCrust + (t.crust - fromCrust) * e;
      return;
    }
    if (currentKind === 'lava') {
      const pulse = 0.5 + 0.5 * Math.sin(now / 900);
      hazard.emissiveColor.copyFrom(PALETTE.lavaGlow.scale(0.28 + 0.24 * pulse));
      Color3.LerpToRef(PALETTE.lavaDeep, PALETTE.lava, 0.22 + 0.18 * pulse, hazard.diffuseColor);
      hazard.alpha = 0.98;
      shared.crust.alpha = 0.7 + 0.25 * pulse;
    } else {
      const shimmer = 0.5 + 0.5 * Math.sin(now / 1400);
      hazard.alpha = 0.8 + 0.06 * shimmer;
      Color3.LerpToRef(PALETTE.waterDeep, PALETTE.water, 0.6 + 0.4 * shimmer, hazard.diffuseColor);
      shared.crust.alpha = 0;
    }
  }

  function playerMaterial(color: string): StandardMaterial {
    let m = playerCache.get(color);
    if (!m) {
      let c: Color3;
      try { c = Color3.FromHexString(/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#9fb7b3'); } catch { c = PALETTE.stoneSide; }
      m = mat(scene, `player:${color}`, c, { emissive: c.scale(0.14), specular: 0.35 });
      playerCache.set(color, m);
    }
    return m;
  }

  return { ...shared, hazard, setHazardKind, animateHazard, playerMaterial, get hazardKind() { return currentKind; } };
}
