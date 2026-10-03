import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { HazardKind } from '@beetle/contracts';
import { PALETTE } from './palette.ts';

function mat(scene: Scene, name: string, diffuse: Color3, opts: { emissive?: Color3; specular?: number; alpha?: number } = {}): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = diffuse;
  m.specularColor = new Color3(opts.specular ?? 0.08, opts.specular ?? 0.08, opts.specular ?? 0.08);
  if (opts.emissive) m.emissiveColor = opts.emissive;
  if (opts.alpha !== undefined) m.alpha = opts.alpha;
  return m;
}

export type Materials = ReturnType<typeof createMaterials>;

export function createMaterials(scene: Scene) {
  const playerCache = new Map<string, StandardMaterial>();
  const shared = {
    stoneTop: mat(scene, 'stoneTop', PALETTE.stoneTop),
    stoneSide: mat(scene, 'stoneSide', PALETTE.stoneSide),
    stoneDark: mat(scene, 'stoneDark', PALETTE.stoneDark),
    wood: mat(scene, 'wood', PALETTE.wood, { specular: 0.05 }),
    woodLight: mat(scene, 'woodLight', PALETTE.woodLight, { specular: 0.05 }),
    rope: mat(scene, 'rope', PALETTE.rope),
    trunk: mat(scene, 'trunk', PALETTE.trunk),
    leaves: mat(scene, 'leaves', PALETTE.leaves),
    leavesDark: mat(scene, 'leavesDark', PALETTE.leavesDark),
    bush: mat(scene, 'bush', PALETTE.bush),
    rock: mat(scene, 'rock', PALETTE.rock, { specular: 0.15 }),
    lanternPost: mat(scene, 'lanternPost', PALETTE.lanternPost),
    lanternGlow: mat(scene, 'lanternGlow', PALETTE.lanternGlow, { emissive: PALETTE.lanternGlow.scale(0.75) }),
    relic: mat(scene, 'relic', PALETTE.relic, { emissive: PALETTE.relic.scale(0.45), specular: 0.6 }),
    gateLocked: mat(scene, 'gateLocked', PALETTE.gateLocked),
    gateUnlocked: mat(scene, 'gateUnlocked', PALETTE.gateUnlocked, { emissive: PALETTE.amberBright.scale(0.7), specular: 0.4 }),
    hat: mat(scene, 'hat', PALETTE.amber),
    halo: mat(scene, 'halo', PALETTE.amberBright, { emissive: PALETTE.amberBright.scale(0.6) }),
  };

  const hazard = new StandardMaterial('hazard', scene);
  hazard.diffuseColor = PALETTE.water.clone();
  hazard.specularColor = new Color3(0.5, 0.6, 0.7);
  hazard.specularPower = 64;
  hazard.emissiveColor = new Color3(0, 0, 0);
  hazard.alpha = 0.82;
  hazard.backFaceCulling = true;

  // Material swap with a short blend: we hold one material and lerp its colours toward the target kind.
  let currentKind: HazardKind = 'water';
  let blend = 1; // 0 = fully previous kind, 1 = fully current kind
  let fromDiffuse = PALETTE.water.clone();
  let fromEmissive = new Color3(0, 0, 0);
  let fromAlpha = 0.82;
  const BLEND_MS = 700;
  let blendStart = 0;

  function targetFor(kind: HazardKind) {
    return kind === 'lava'
      ? { diffuse: Color3.Lerp(PALETTE.lavaDeep, PALETTE.lava, 0.45), emissive: PALETTE.lavaGlow.scale(0.45), alpha: 0.98 }
      : { diffuse: PALETTE.water, emissive: new Color3(0, 0, 0), alpha: 0.82 };
  }

  function setHazardKind(kind: HazardKind, now: number) {
    if (kind === currentKind) return;
    fromDiffuse = hazard.diffuseColor.clone();
    fromEmissive = hazard.emissiveColor.clone();
    fromAlpha = hazard.alpha;
    currentKind = kind;
    blend = 0;
    blendStart = now;
  }

  /** Called every frame: finishes blends and runs the water shimmer or lava pulse. */
  function animateHazard(now: number) {
    const t = targetFor(currentKind);
    if (blend < 1) {
      blend = Math.min(1, (now - blendStart) / BLEND_MS);
      const e = blend * blend * (3 - 2 * blend);
      Color3.LerpToRef(fromDiffuse, t.diffuse, e, hazard.diffuseColor);
      Color3.LerpToRef(fromEmissive, t.emissive, e, hazard.emissiveColor);
      hazard.alpha = fromAlpha + (t.alpha - fromAlpha) * e;
      return;
    }
    if (currentKind === 'lava') {
      const pulse = 0.5 + 0.5 * Math.sin(now / 900);
      hazard.emissiveColor.copyFrom(PALETTE.lavaGlow.scale(0.3 + 0.3 * pulse));
      Color3.LerpToRef(PALETTE.lavaDeep, PALETTE.lava, 0.35 + 0.2 * pulse, hazard.diffuseColor);
      hazard.alpha = 0.98;
    } else {
      const shimmer = 0.5 + 0.5 * Math.sin(now / 1400);
      hazard.alpha = 0.76 + 0.08 * shimmer;
      Color3.LerpToRef(PALETTE.waterDeep, PALETTE.water, 0.55 + 0.45 * shimmer, hazard.diffuseColor);
    }
  }

  function playerMaterial(color: string): StandardMaterial {
    let m = playerCache.get(color);
    if (!m) {
      let c: Color3;
      try { c = Color3.FromHexString(/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#9fb7b3'); } catch { c = PALETTE.stoneSide; }
      m = mat(scene, `player:${color}`, c, { emissive: c.scale(0.12), specular: 0.3 });
      playerCache.set(color, m);
    }
    return m;
  }

  return { ...shared, hazard, setHazardKind, animateHazard, playerMaterial, get hazardKind() { return currentKind; } };
}
