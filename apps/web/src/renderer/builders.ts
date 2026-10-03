import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateIcoSphere } from '@babylonjs/core/Meshes/Builders/icoSphereBuilder';
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder';
import { CreateCapsule } from '@babylonjs/core/Meshes/Builders/capsuleBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { GEOMETRY } from '@beetle/contracts';
import type { Bridge, Decoration, Gate, Island, PlayerView, Relic } from '@beetle/contracts';
import type { Materials } from './materials.ts';
import { PALETTE, hash01 } from './palette.ts';

export type Built = {
  root: TransformNode;
  casters: Mesh[];
  receivers: Mesh[];
  dispose: () => void;
};

const THICK = GEOMETRY.platformThickness;

function disposeRoot(root: TransformNode, extra: (() => void)[] = []) {
  return () => {
    for (const fn of extra) { try { fn(); } catch { /* ignore */ } }
    root.dispose(false, true);
  };
}

export function buildIsland(scene: Scene, mats: Materials, island: Island): Built {
  const root = new TransformNode(`island:${island.id}`, scene);
  root.position.set(island.center.x, 0, island.center.z);
  const side = CreateCylinder(`island:${island.id}:side`, { height: THICK, diameter: island.radius * 2, tessellation: 56 }, scene);
  side.material = mats.stoneSide;
  side.position.y = -THICK / 2;
  side.parent = root;
  const top = CreateCylinder(`island:${island.id}:top`, { height: 0.06, diameter: island.radius * 2 - 0.08, tessellation: 56 }, scene);
  top.material = mats.stoneTop;
  top.position.y = 0;
  top.parent = root;
  top.receiveShadows = true;
  // a darker underside lip so the platform reads as a slab from the elevated camera
  const lip = CreateCylinder(`island:${island.id}:lip`, { height: 0.3, diameter: island.radius * 2 - 0.5, tessellation: 40 }, scene);
  lip.material = mats.stoneDark;
  lip.position.y = -THICK - 0.1;
  lip.parent = root;
  return { root, casters: [], receivers: [top, side], dispose: disposeRoot(root) };
}

export function buildBridge(scene: Scene, mats: Materials, bridge: Bridge): Built {
  const [a, b] = bridge.endpoints;
  const dx = b.point.x - a.point.x;
  const dz = b.point.z - a.point.z;
  const length = Math.max(0.5, Math.hypot(dx, dz));
  const yaw = Math.atan2(dx, dz);
  const w = bridge.width;
  const root = new TransformNode(`bridge:${bridge.id}`, scene);
  root.position.set((a.point.x + b.point.x) / 2, 0, (a.point.z + b.point.z) / 2);
  root.rotation.y = yaw;

  // plank texture, one per bridge so vScale can follow its length
  const tex = new DynamicTexture(`bridge:${bridge.id}:planks`, { width: 64, height: 64 }, scene, false);
  const ctx = tex.getContext();
  ctx.fillStyle = '#8c5a2b';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#a56a33';
  ctx.fillRect(0, 4, 64, 24);
  ctx.fillStyle = '#5a3717';
  ctx.fillRect(0, 0, 64, 4);
  ctx.fillRect(0, 30, 64, 4);
  ctx.fillStyle = '#6e4420';
  ctx.fillRect(0, 34, 64, 30);
  tex.update(false);
  tex.vScale = Math.max(1, Math.round(length / 0.7));
  const deckMat = new StandardMaterial(`bridge:${bridge.id}:mat`, scene);
  deckMat.diffuseTexture = tex;
  deckMat.specularColor = new Color3(0.05, 0.05, 0.05);

  const deck = CreateBox(`bridge:${bridge.id}:deck`, { width: w, height: 0.24, depth: length }, scene);
  deck.material = deckMat;
  deck.position.y = -0.12;
  deck.parent = root;
  deck.receiveShadows = true;

  // slight sag: two support beams under the deck
  const beamL = CreateBox(`bridge:${bridge.id}:beamL`, { width: 0.16, height: 0.3, depth: length }, scene);
  beamL.material = mats.wood;
  beamL.position.set(-w / 2 + 0.12, -0.35, 0);
  beamL.parent = root;
  const beamR = beamL.clone(`bridge:${bridge.id}:beamR`);
  beamR.position.x = w / 2 - 0.12;
  beamR.parent = root;

  const casters: Mesh[] = [];
  const railY = 0.85;
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.08);
    const rope = CreateCylinder(`bridge:${bridge.id}:rope${sx}`, { height: length, diameter: 0.07, tessellation: 8 }, scene);
    rope.material = mats.rope;
    rope.rotation.x = Math.PI / 2;
    rope.position.set(x, railY, 0);
    rope.parent = root;
    const lower = CreateCylinder(`bridge:${bridge.id}:rope2${sx}`, { height: length, diameter: 0.05, tessellation: 6 }, scene);
    lower.material = mats.rope;
    lower.rotation.x = Math.PI / 2;
    lower.position.set(x, railY * 0.5, 0);
    lower.parent = root;
    for (const sz of [-1, 1]) {
      const post = CreateCylinder(`bridge:${bridge.id}:post${sx}${sz}`, { height: 1.0, diameter: 0.16, tessellation: 8 }, scene);
      post.material = mats.woodLight;
      post.position.set(x, 0.5, sz * (length / 2 - 0.2));
      post.parent = root;
      casters.push(post);
    }
  }
  return { root, casters, receivers: [deck], dispose: disposeRoot(root, [() => tex.dispose(), () => deckMat.dispose()]) };
}

export function buildDecoration(scene: Scene, mats: Materials, deco: Decoration, pos: { x: number; z: number }, seed: number): Built {
  const root = new TransformNode(`deco:${deco.id}`, scene);
  root.position.set(pos.x, 0, pos.z);
  root.rotation.y = (deco.rotationDeg * Math.PI) / 180;
  root.scaling.setAll(deco.scale);
  const v = hash01(deco.id, seed);
  const casters: Mesh[] = [];
  const n = (s: string) => `deco:${deco.id}:${s}`;
  switch (deco.type) {
    case 'tree': {
      const trunk = CreateCylinder(n('trunk'), { height: 1.2, diameter: 0.34, tessellation: 10 }, scene);
      trunk.material = mats.trunk;
      trunk.position.y = 0.6;
      trunk.parent = root;
      casters.push(trunk);
      if (v < 0.6) {
        const c1 = CreateCylinder(n('c1'), { height: 1.5, diameterBottom: 1.7, diameterTop: 0.02, tessellation: 12 }, scene);
        c1.material = mats.leavesDark;
        c1.position.y = 1.7;
        c1.parent = root;
        const c2 = CreateCylinder(n('c2'), { height: 1.2, diameterBottom: 1.2, diameterTop: 0.02, tessellation: 12 }, scene);
        c2.material = mats.leaves;
        c2.position.y = 2.55;
        c2.parent = root;
        casters.push(c1, c2);
      } else {
        const crown = CreateSphere(n('crown'), { diameter: 1.8, segments: 10 }, scene);
        crown.material = mats.leaves;
        crown.position.y = 1.95;
        crown.scaling.y = 0.9 + 0.3 * v;
        crown.parent = root;
        casters.push(crown);
      }
      break;
    }
    case 'rock': {
      const rock = CreateIcoSphere(n('rock'), { radius: 0.8, subdivisions: 1, flat: true }, scene);
      rock.material = mats.rock;
      rock.scaling.set(1, 0.55, 0.85 + 0.2 * v);
      rock.rotation.set(0.15 * v, v * Math.PI * 2, 0.1);
      rock.position.y = 0.28;
      rock.parent = root;
      casters.push(rock);
      break;
    }
    case 'lantern': {
      const post = CreateCylinder(n('post'), { height: 1.4, diameter: 0.12, tessellation: 8 }, scene);
      post.material = mats.lanternPost;
      post.position.y = 0.7;
      post.parent = root;
      const glow = CreateSphere(n('glow'), { diameter: 0.38, segments: 10 }, scene);
      glow.material = mats.lanternGlow;
      glow.position.y = 1.56;
      glow.parent = root;
      casters.push(post);
      break;
    }
    case 'pillar': {
      const base = CreateBox(n('base'), { width: 1.2, height: 0.16, depth: 1.2 }, scene);
      base.material = mats.stoneDark;
      base.position.y = 0.08;
      base.parent = root;
      const shaft = CreateCylinder(n('shaft'), { height: 2.2, diameter: 0.9, tessellation: 14 }, scene);
      shaft.material = mats.stoneTop;
      shaft.position.y = 1.26;
      shaft.parent = root;
      const cap = CreateBox(n('cap'), { width: 1.1, height: 0.2, depth: 1.1 }, scene);
      cap.material = mats.stoneSide;
      cap.position.y = 2.46;
      cap.parent = root;
      casters.push(shaft, cap);
      break;
    }
    case 'bush': {
      const b1 = CreateSphere(n('b1'), { diameter: 1.1, segments: 8 }, scene);
      b1.material = mats.bush;
      b1.scaling.y = 0.7;
      b1.position.y = 0.36;
      b1.parent = root;
      const b2 = CreateSphere(n('b2'), { diameter: 0.7, segments: 8 }, scene);
      b2.material = mats.leaves;
      b2.scaling.y = 0.75;
      b2.position.set(0.35, 0.3, 0.2 - 0.4 * v);
      b2.parent = root;
      casters.push(b1, b2);
      break;
    }
    case 'shrine': {
      const s1 = CreateBox(n('s1'), { width: 2.0, height: 0.4, depth: 2.0 }, scene);
      s1.material = mats.stoneSide;
      s1.position.y = 0.2;
      s1.parent = root;
      const s2 = CreateBox(n('s2'), { width: 1.4, height: 0.6, depth: 1.4 }, scene);
      s2.material = mats.stoneTop;
      s2.position.y = 0.7;
      s2.parent = root;
      const s3 = CreateBox(n('s3'), { width: 0.8, height: 0.8, depth: 0.8 }, scene);
      s3.material = mats.stoneDark;
      s3.position.y = 1.4;
      s3.parent = root;
      const glow = CreateSphere(n('glow'), { diameter: 0.3, segments: 8 }, scene);
      glow.material = mats.lanternGlow;
      glow.position.y = 2.0;
      glow.parent = root;
      casters.push(s1, s2, s3);
      break;
    }
  }
  return { root, casters, receivers: [], dispose: disposeRoot(root) };
}

export type RelicBuilt = Built & { gem: Mesh; baseY: number; phase: number };

export function buildRelic(scene: Scene, mats: Materials, relic: Relic, pos: { x: number; z: number }): RelicBuilt {
  const root = new TransformNode(`relic:${relic.id}`, scene);
  root.position.set(pos.x, 0, pos.z);
  const gem = CreatePolyhedron(`relic:${relic.id}:gem`, { type: 1, size: 0.36 }, scene);
  gem.material = mats.relic;
  gem.position.y = 1.0;
  gem.parent = root;
  const pedestal = CreateCylinder(`relic:${relic.id}:pedestal`, { height: 0.18, diameter: 0.7, tessellation: 12 }, scene);
  pedestal.material = mats.stoneDark;
  pedestal.position.y = 0.09;
  pedestal.parent = root;
  return { root, gem, baseY: 1.0, phase: hash01(relic.id) * Math.PI * 2, casters: [gem], receivers: [], dispose: disposeRoot(root) };
}

export type GateBuilt = Built & { setUnlocked: (unlocked: boolean) => void; animate: (now: number, dtMs: number) => void };

export function buildGate(scene: Scene, mats: Materials, gate: Gate, pos: { x: number; z: number }): GateBuilt {
  const root = new TransformNode(`gate:${gate.id}`, scene);
  root.position.set(pos.x, 0, pos.z);
  const casters: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const p = CreateCylinder(`gate:${gate.id}:pillar${sx}`, { height: 3.2, diameter: 0.7, tessellation: 14 }, scene);
    p.material = mats.gateLocked;
    p.position.set(sx * GEOMETRY.gateBlockRadius, 1.6, 0);
    p.parent = root;
    casters.push(p);
  }
  const arch = CreateBox(`gate:${gate.id}:arch`, { width: GEOMETRY.gateBlockRadius * 2 + 0.8, height: 0.5, depth: 0.6 }, scene);
  arch.material = mats.gateLocked;
  arch.position.y = 3.3;
  arch.parent = root;
  casters.push(arch);
  const keystone = CreateBox(`gate:${gate.id}:key`, { width: 0.5, height: 0.5, depth: 0.5 }, scene);
  keystone.material = mats.gateLocked;
  keystone.position.y = 3.75;
  keystone.rotation.y = Math.PI / 4;
  keystone.parent = root;

  const light = new PointLight(`gate:${gate.id}:light`, new Vector3(0, 2.6, 0), scene);
  light.diffuse = PALETTE.amberBright;
  light.specular = PALETTE.amberBright;
  light.intensity = 0;
  light.range = 12;
  light.parent = root;

  let unlocked = false;
  let targetArchY = 3.3;
  function setUnlocked(u: boolean) {
    if (u === unlocked) return;
    unlocked = u;
    const m = u ? mats.gateUnlocked : mats.gateLocked;
    for (const c of casters) c.material = m;
    keystone.material = m;
    targetArchY = u ? 3.7 : 3.3;
  }
  function animate(now: number, dtMs: number) {
    const k = Math.min(1, dtMs / 250);
    arch.position.y += (targetArchY - arch.position.y) * k;
    keystone.position.y = arch.position.y + 0.45;
    const targetIntensity = unlocked ? 0.9 + 0.2 * Math.sin(now / 500) : 0;
    light.intensity += (targetIntensity - light.intensity) * k;
    if (unlocked) keystone.rotation.y += dtMs * 0.0012;
  }
  return { root, casters, receivers: [], setUnlocked, animate, dispose: disposeRoot(root, [() => light.dispose()]) };
}

export type PlayerBuilt = {
  root: TransformNode;
  parts: Mesh[];
  label: Mesh;
  casters: Mesh[];
  setLabel: (text: string) => void;
  setVisibility: (v: number) => void;
  dispose: () => void;
};

export function buildPlayer(scene: Scene, mats: Materials, p: PlayerView): PlayerBuilt {
  const root = new TransformNode(`player:${p.id}`, scene);
  const body = CreateCapsule(`player:${p.id}:body`, { height: 1.6, radius: GEOMETRY.playerRadius, tessellation: 12, subdivisions: 2, capSubdivisions: 4 }, scene);
  body.material = mats.playerMaterial(p.color);
  body.position.y = 0.8;
  body.parent = root;
  const parts: Mesh[] = [body];
  // a small nose so the facing reads
  const nose = CreateSphere(`player:${p.id}:nose`, { diameter: 0.22, segments: 6 }, scene);
  nose.material = mats.stoneTop;
  nose.position.set(0, 1.05, GEOMETRY.playerRadius);
  nose.parent = root;
  parts.push(nose);
  if (p.slot === 0) {
    const hat = CreateCylinder(`player:${p.id}:hat`, { height: 0.7, diameterBottom: 0.8, diameterTop: 0.02, tessellation: 12 }, scene);
    hat.material = mats.hat;
    hat.position.y = 1.9;
    hat.parent = root;
    parts.push(hat);
  } else {
    const halo = CreateTorus(`player:${p.id}:halo`, { diameter: 0.9, thickness: 0.08, tessellation: 20 }, scene);
    halo.material = mats.halo;
    halo.position.y = 2.0;
    halo.parent = root;
    parts.push(halo);
  }

  const tex = new DynamicTexture(`player:${p.id}:labeltex`, { width: 256, height: 64 }, scene, false);
  tex.hasAlpha = true;
  const labelMat = new StandardMaterial(`player:${p.id}:labelmat`, scene);
  labelMat.diffuseTexture = tex;
  labelMat.opacityTexture = tex;
  labelMat.emissiveColor = new Color3(1, 1, 1);
  labelMat.disableLighting = true;
  labelMat.backFaceCulling = false;
  const label = CreatePlane(`player:${p.id}:label`, { width: 2.0, height: 0.5 }, scene);
  label.material = labelMat;
  label.billboardMode = Mesh.BILLBOARDMODE_ALL;
  label.isPickable = false;

  function setLabel(text: string) {
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 256, 64);
    tex.drawText(text, null, 46, 'bold 38px system-ui, sans-serif', PALETTE.label, 'transparent', true, true);
  }
  setLabel(p.label);

  function setVisibility(v: number) {
    for (const m of parts) m.visibility = v;
    label.visibility = v;
  }

  return {
    root, parts, label, casters: [body], setLabel, setVisibility,
    dispose: () => { label.dispose(false, true); tex.dispose(); labelMat.dispose(); root.dispose(false, true); },
  };
}
