import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/core/Meshes/instancedMesh'; // side-effect: enables mesh.createInstance (stone chips, planks)
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder';
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
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { GEOMETRY } from '@beetle/contracts';
import type { Bridge, Decoration, Gate, Island, PlayerView, Relic } from '@beetle/contracts';
import type { Materials } from './materials.ts';
import { PALETTE, hash01, seededRandom } from './palette.ts';

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

/** Static scenery never moves after it is built: freezing the world matrices skips per-frame recomputation. */
function freeze(...meshes: AbstractMesh[]) {
  for (const m of meshes) { m.isPickable = false; m.freezeWorldMatrix(); }
}

// ---------------------------------------------------------------- islands

export type IslandBuilt = Built & {
  /** Glowing crust ring, only enabled in lava mode (index.ts toggles it from the hazard blend). */
  crust: Mesh;
  /** Positions the under-shadow and crust just above the hazard plane. */
  setHazardY: (y: number) => void;
};

export function buildIsland(scene: Scene, mats: Materials, island: Island): IslandBuilt {
  const id = island.id;
  const n = (s: string) => `island:${id}:${s}`;
  const r = island.radius;
  const root = new TransformNode(`island:${id}`, scene);
  root.position.set(island.center.x, 0, island.center.z);

  // thick stone slab with a slightly darker rim band at the top edge
  const side = CreateCylinder(n('side'), { height: THICK, diameter: r * 2, tessellation: 64 }, scene);
  side.material = mats.stoneSide;
  side.position.y = -THICK / 2;
  side.parent = root;
  const rim = CreateCylinder(n('rim'), { height: 0.24, diameter: r * 2 + 0.14, tessellation: 64 }, scene);
  rim.material = mats.stoneRim;
  rim.position.y = -0.12;
  rim.parent = root;
  // pale stone walkway ring, then the grass inset (radius - 0.6)
  const top = CreateCylinder(n('top'), { height: 0.06, diameter: r * 2 - 0.2, tessellation: 64 }, scene);
  top.material = mats.stoneTop;
  top.position.y = 0.01;
  top.parent = root;
  const grass = CreateCylinder(n('grass'), { height: 0.1, diameter: (r - 0.6) * 2, tessellation: 56 }, scene);
  grass.material = mats.grass;
  grass.position.y = 0.05;
  grass.parent = root;
  // tapered rocky underside so the slab reads as a floating chunk rather than a flat disc
  const under = CreateCylinder(n('under'), { height: 0.7, diameterTop: r * 2 - 0.3, diameterBottom: r * 1.15, tessellation: 40 }, scene);
  under.material = mats.stoneDark;
  under.position.y = -THICK - 0.35;
  under.parent = root;
  freeze(side, rim, top, grass, under);

  // small stone chips around the rim: one base mesh plus instances, seeded by the island id (stable across rebuilds)
  const rng = seededRandom(id);
  const chipCount = 6 + Math.floor(rng() * 5);
  const chip = CreateIcoSphere(n('chip'), { radius: 0.2, subdivisions: 1, flat: true }, scene);
  chip.material = mats.rock;
  chip.parent = root;
  const placeChip = (m: AbstractMesh) => {
    const ang = rng() * Math.PI * 2;
    const dist = r - 0.32 - rng() * 0.3;
    m.position.set(Math.cos(ang) * dist, 0.1, Math.sin(ang) * dist);
    m.scaling.set(0.7 + rng() * 0.8, 0.45 + rng() * 0.3, 0.7 + rng() * 0.8);
    m.rotation.y = rng() * Math.PI * 2;
    freeze(m);
  };
  placeChip(chip);
  for (let i = 1; i < chipCount; i++) {
    const inst = chip.createInstance(n(`chip${i}`));
    inst.parent = root;
    placeChip(inst);
  }
  // a few tufts of darker grass as low flat discs on the lawn (same instance trick)
  const tuft = CreateDisc(n('tuft'), { radius: 0.55, tessellation: 10 }, scene);
  tuft.material = mats.grassDark;
  tuft.rotation.x = Math.PI / 2;
  tuft.parent = root;
  const placeTuft = (m: AbstractMesh) => {
    const ang = rng() * Math.PI * 2;
    const dist = rng() * (r - 1.6);
    m.position.set(Math.cos(ang) * dist, 0.105, Math.sin(ang) * dist);
    m.scaling.set(0.6 + rng() * 0.9, 0.6 + rng() * 0.9, 1);
    freeze(m);
  };
  placeTuft(tuft);
  const tuftCount = 3 + Math.floor(rng() * 4);
  for (let i = 1; i < tuftCount; i++) {
    const inst = tuft.createInstance(n(`tuft${i}`));
    inst.parent = root;
    placeTuft(inst);
  }

  // soft under-shadow on the hazard plane sells "floating"
  const shadow = CreateDisc(n('shadow'), { radius: r * 1.02, tessellation: 48 }, scene);
  shadow.material = mats.underShadow;
  shadow.rotation.x = Math.PI / 2;
  shadow.isPickable = false;
  shadow.parent = root;
  // lava crust ring (hidden in water mode)
  const crust = CreateTorus(n('crust'), { diameter: r * 2 + 0.5, thickness: 0.55, tessellation: 48 }, scene);
  crust.material = mats.crust;
  crust.isPickable = false;
  crust.parent = root;
  crust.setEnabled(false);

  function setHazardY(y: number) {
    shadow.position.y = y + 0.05;
    crust.position.y = y + 0.08;
  }
  setHazardY(GEOMETRY.hazardPlaneElevation);

  return { root, crust, setHazardY, casters: [side], receivers: [top, grass, rim], dispose: disposeRoot(root) };
}

// ---------------------------------------------------------------- bridges

export function buildBridge(scene: Scene, mats: Materials, bridge: Bridge): Built {
  const [a, b] = bridge.endpoints;
  const dx = b.point.x - a.point.x;
  const dz = b.point.z - a.point.z;
  const length = Math.max(0.5, Math.hypot(dx, dz));
  const yaw = Math.atan2(dx, dz);
  const w = bridge.width;
  const n = (s: string) => `bridge:${bridge.id}:${s}`;
  const root = new TransformNode(`bridge:${bridge.id}`, scene);
  root.position.set((a.point.x + b.point.x) / 2, 0, (a.point.z + b.point.z) / 2);
  root.rotation.y = yaw;

  // planks: two base meshes (two wood tones) and instances for the rest, so a bridge costs two plank draw calls
  const gap = 0.07;
  const count = Math.max(2, Math.round(length / 0.58));
  const step = length / count;
  const plankA = CreateBox(n('plankA'), { width: w, height: 0.16, depth: Math.max(0.1, step - gap) }, scene);
  plankA.material = mats.plankA;
  plankA.parent = root;
  const plankB = CreateBox(n('plankB'), { width: w, height: 0.16, depth: Math.max(0.1, step - gap) }, scene);
  plankB.material = mats.plankB;
  plankB.parent = root;
  for (let i = 0; i < count; i++) {
    const even = i % 2 === 0;
    const m: AbstractMesh = i === 0 ? plankA : i === 1 ? plankB : (even ? plankA : plankB).createInstance(n(`p${i}`));
    m.parent = root;
    m.position.set(0, -0.08, -length / 2 + step * (i + 0.5));
    freeze(m);
  }

  // two support beams under the deck
  const beamL = CreateBox(n('beamL'), { width: 0.18, height: 0.32, depth: length }, scene);
  beamL.material = mats.wood;
  beamL.position.set(-w / 2 + 0.14, -0.33, 0);
  beamL.parent = root;
  const beamR = beamL.clone(n('beamR'));
  beamR.position.x = w / 2 - 0.14;
  beamR.parent = root;
  freeze(beamL, beamR);

  const casters: Mesh[] = [plankA, plankB];
  const railY = 0.9;
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.1);
    const rope = CreateCylinder(n(`rope${sx}`), { height: length, diameter: 0.07, tessellation: 8 }, scene);
    rope.material = mats.rope;
    rope.rotation.x = Math.PI / 2;
    rope.position.set(x, railY, 0);
    rope.parent = root;
    const lower = CreateCylinder(n(`rope2${sx}`), { height: length, diameter: 0.05, tessellation: 6 }, scene);
    lower.material = mats.rope;
    lower.rotation.x = Math.PI / 2;
    lower.position.set(x, railY * 0.5, 0);
    lower.parent = root;
    freeze(rope, lower);
    // two posts per end: the end post and a shorter one a little further in
    for (const sz of [-1, 1]) {
      const post = CreateCylinder(n(`post${sx}${sz}`), { height: 1.1, diameter: 0.18, tessellation: 8 }, scene);
      post.material = mats.woodLight;
      post.position.set(x, 0.55, sz * (length / 2 - 0.2));
      post.parent = root;
      const cap = CreateSphere(n(`cap${sx}${sz}`), { diameter: 0.22, segments: 6 }, scene);
      cap.material = mats.wood;
      cap.position.set(x, 1.12, sz * (length / 2 - 0.2));
      cap.parent = root;
      freeze(post, cap);
      casters.push(post);
      if (length > 3.2) {
        const inner = CreateCylinder(n(`post2${sx}${sz}`), { height: 1.0, diameter: 0.14, tessellation: 8 }, scene);
        inner.material = mats.woodLight;
        inner.position.set(x, 0.5, sz * (length / 2 - 1.1));
        inner.parent = root;
        freeze(inner);
        casters.push(inner);
      }
    }
  }
  return { root, casters, receivers: [plankA, plankB], dispose: disposeRoot(root) };
}

// ---------------------------------------------------------------- decorations

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
      const trunk = CreateCylinder(n('trunk'), { height: 1.3, diameterBottom: 0.42, diameterTop: 0.3, tessellation: 10 }, scene);
      trunk.material = mats.trunk;
      trunk.position.y = 0.65;
      trunk.parent = root;
      casters.push(trunk);
      if (v < 0.6) {
        const c1 = CreateCylinder(n('c1'), { height: 1.6, diameterBottom: 1.9, diameterTop: 0.02, tessellation: 12 }, scene);
        c1.material = mats.leavesDark;
        c1.position.y = 1.8;
        c1.parent = root;
        const c2 = CreateCylinder(n('c2'), { height: 1.3, diameterBottom: 1.3, diameterTop: 0.02, tessellation: 12 }, scene);
        c2.material = mats.leaves;
        c2.position.y = 2.7;
        c2.parent = root;
        casters.push(c1, c2);
        freeze(trunk, c1, c2);
      } else {
        const crown = CreateSphere(n('crown'), { diameter: 2.0, segments: 10 }, scene);
        crown.material = mats.leaves;
        crown.position.y = 2.1;
        crown.scaling.y = 0.9 + 0.3 * v;
        crown.parent = root;
        const crown2 = CreateSphere(n('crown2'), { diameter: 1.2, segments: 8 }, scene);
        crown2.material = mats.leavesDark;
        crown2.position.set(0.5, 1.7, 0.3 - 0.6 * v);
        crown2.parent = root;
        casters.push(crown, crown2);
        freeze(trunk, crown, crown2);
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
      freeze(rock);
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
      const halo = CreateSphere(n('halo'), { diameter: 0.9, segments: 8 }, scene);
      halo.material = mats.relicHalo;
      halo.position.y = 1.56;
      halo.parent = root;
      casters.push(post);
      freeze(post, glow, halo);
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
      freeze(base, shaft, cap);
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
      freeze(b1, b2);
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
      freeze(s1, s2, s3, glow);
      break;
    }
  }
  return { root, casters, receivers: [], dispose: disposeRoot(root) };
}

// ---------------------------------------------------------------- relics

export type RelicBuilt = Built & { gem: Mesh; baseY: number; phase: number };

export function buildRelic(scene: Scene, mats: Materials, relic: Relic, pos: { x: number; z: number }): RelicBuilt {
  const n = (s: string) => `relic:${relic.id}:${s}`;
  const root = new TransformNode(`relic:${relic.id}`, scene);
  root.position.set(pos.x, 0, pos.z);
  const gem = CreatePolyhedron(n('gem'), { type: 1, size: 0.52 }, scene);
  gem.material = mats.relic;
  gem.position.y = 1.15;
  gem.parent = root;
  // translucent halo rides with the gem; no point light needed
  const halo = CreateSphere(n('halo'), { diameter: 1.9, segments: 12 }, scene);
  halo.material = mats.relicHalo;
  halo.parent = gem;
  halo.isPickable = false;
  const pedestal = CreateCylinder(n('pedestal'), { height: 0.22, diameter: 0.9, tessellation: 16 }, scene);
  pedestal.material = mats.stoneDark;
  pedestal.position.y = 0.11;
  pedestal.parent = root;
  const ring = CreateTorus(n('ring'), { diameter: 1.1, thickness: 0.08, tessellation: 24 }, scene);
  ring.material = mats.stoneRim;
  ring.position.y = 0.09;
  ring.parent = root;
  const blob = CreateDisc(n('shadow'), { radius: 0.6, tessellation: 20 }, scene);
  blob.material = mats.underShadow;
  blob.rotation.x = Math.PI / 2;
  blob.position.y = 0.13;
  blob.parent = root;
  freeze(pedestal, ring, blob);
  return { root, gem, baseY: 1.15, phase: hash01(relic.id) * Math.PI * 2, casters: [gem], receivers: [], dispose: disposeRoot(root) };
}

// ---------------------------------------------------------------- gate

export type GateBuilt = Built & { setUnlocked: (unlocked: boolean) => void; animate: (now: number, dtMs: number) => void };

export function buildGate(scene: Scene, mats: Materials, gate: Gate, pos: { x: number; z: number }): GateBuilt {
  const n = (s: string) => `gate:${gate.id}:${s}`;
  const root = new TransformNode(`gate:${gate.id}`, scene);
  root.position.set(pos.x, 0, pos.z);
  const casters: Mesh[] = [];
  const swappable: Mesh[] = [];
  const R = GEOMETRY.gateBlockRadius;
  for (const sx of [-1, 1]) {
    const base = CreateBox(n(`base${sx}`), { width: 1.3, height: 0.3, depth: 1.3 }, scene);
    base.material = mats.stoneDark;
    base.position.set(sx * R, 0.15, 0);
    base.parent = root;
    const shaft = CreateBox(n(`pillar${sx}`), { width: 0.95, height: 3.1, depth: 0.95 }, scene);
    shaft.material = mats.gateLocked;
    shaft.position.set(sx * R, 1.85, 0);
    shaft.parent = root;
    const capital = CreateBox(n(`cap${sx}`), { width: 1.2, height: 0.26, depth: 1.2 }, scene);
    capital.material = mats.stoneTop;
    capital.position.set(sx * R, 3.53, 0);
    capital.parent = root;
    freeze(base, shaft, capital);
    casters.push(shaft, capital);
    swappable.push(shaft);
  }
  const lintelY = 3.95;
  const lintel = CreateBox(n('lintel'), { width: R * 2 + 1.8, height: 0.6, depth: 0.9 }, scene);
  lintel.material = mats.gateLocked;
  lintel.position.y = lintelY;
  lintel.parent = root;
  casters.push(lintel);
  swappable.push(lintel);
  // arch glyph: a standing ring over the lintel with a small keystone gem in its centre
  const glyph = CreateTorus(n('glyph'), { diameter: 1.2, thickness: 0.14, tessellation: 28 }, scene);
  glyph.material = mats.gateLocked;
  glyph.rotation.x = Math.PI / 2;
  glyph.position.y = lintelY + 0.95;
  glyph.parent = root;
  casters.push(glyph);
  swappable.push(glyph);
  const keystone = CreatePolyhedron(n('key'), { type: 1, size: 0.26 }, scene);
  keystone.material = mats.gateLocked;
  keystone.position.y = lintelY + 0.95;
  keystone.parent = root;
  swappable.push(keystone);
  // soft light cone under the lintel, only visible when unlocked
  const cone = CreateCylinder(n('cone'), { height: 3.6, diameterTop: 0.4, diameterBottom: R * 2 + 1.2, tessellation: 24 }, scene);
  cone.material = mats.gateCone;
  cone.position.y = 1.9;
  cone.parent = root;
  cone.isPickable = false;
  cone.setEnabled(false);

  const light = new PointLight(n('light'), new Vector3(0, 2.8, 0), scene);
  light.diffuse = PALETTE.amberBright;
  light.specular = PALETTE.amberBright;
  light.intensity = 0;
  light.range = 14;
  light.parent = root;

  let unlocked = false;
  let targetLift = 0;
  let coneAlpha = 0;
  function setUnlocked(u: boolean) {
    if (u === unlocked) return;
    unlocked = u;
    const m = u ? mats.gateUnlocked : mats.gateLocked;
    for (const c of swappable) c.material = m;
    targetLift = u ? 0.4 : 0;
    if (u) cone.setEnabled(true);
  }
  function animate(now: number, dtMs: number) {
    const k = Math.min(1, dtMs / 250);
    const lift = lintel.position.y - lintelY;
    const newLift = lift + (targetLift - lift) * k;
    lintel.position.y = lintelY + newLift;
    glyph.position.y = lintelY + 0.95 + newLift;
    keystone.position.y = glyph.position.y;
    const targetIntensity = unlocked ? 0.9 + 0.2 * Math.sin(now / 500) : 0;
    light.intensity += (targetIntensity - light.intensity) * k;
    const targetCone = unlocked ? 0.16 + 0.05 * Math.sin(now / 700) : 0;
    coneAlpha += (targetCone - coneAlpha) * k;
    mats.gateCone.alpha = coneAlpha;
    if (!unlocked && coneAlpha < 0.005 && cone.isEnabled()) cone.setEnabled(false);
    if (unlocked) keystone.rotation.y += dtMs * 0.0012;
  }
  return { root, casters, receivers: [], setUnlocked, animate, dispose: disposeRoot(root, [() => light.dispose()]) };
}

// ---------------------------------------------------------------- players

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
  const n = (s: string) => `player:${p.id}:${s}`;
  const root = new TransformNode(`player:${p.id}`, scene);
  const R = GEOMETRY.playerRadius * 1.15;
  const body = CreateCapsule(n('body'), { height: 1.9, radius: R, tessellation: 14, subdivisions: 2, capSubdivisions: 5 }, scene);
  body.material = mats.playerMaterial(p.color);
  body.position.y = 0.95;
  body.parent = root;
  const parts: Mesh[] = [body];
  // darker base ring and a soft drop shadow blob
  const base = CreateTorus(n('base'), { diameter: R * 2 + 0.16, thickness: 0.12, tessellation: 20 }, scene);
  base.material = mats.playerBase;
  base.position.y = 0.08;
  base.parent = root;
  parts.push(base);
  const blob = CreateDisc(n('shadow'), { radius: R * 1.35, tessellation: 20 }, scene);
  blob.material = mats.underShadow;
  blob.rotation.x = Math.PI / 2;
  blob.position.y = 0.025;
  blob.parent = root;
  blob.isPickable = false;
  parts.push(blob);
  // a small nose so the facing reads
  const nose = CreateSphere(n('nose'), { diameter: 0.24, segments: 6 }, scene);
  nose.material = mats.stoneTop;
  nose.position.set(0, 1.2, R);
  nose.parent = root;
  parts.push(nose);
  if (p.slot === 0) {
    const hat = CreateCylinder(n('hat'), { height: 0.8, diameterBottom: 0.9, diameterTop: 0.02, tessellation: 12 }, scene);
    hat.material = mats.hat;
    hat.position.y = 2.22;
    hat.parent = root;
    parts.push(hat);
  } else {
    const halo = CreateTorus(n('halo'), { diameter: 1.0, thickness: 0.09, tessellation: 20 }, scene);
    halo.material = mats.halo;
    halo.position.y = 2.3;
    halo.parent = root;
    parts.push(halo);
  }

  const TW = 512; const TH = 128;
  const tex = new DynamicTexture(n('labeltex'), { width: TW, height: TH }, scene, false);
  tex.hasAlpha = true;
  const labelMat = new StandardMaterial(n('labelmat'), scene);
  labelMat.diffuseTexture = tex;
  labelMat.opacityTexture = tex;
  labelMat.emissiveColor = new Color3(1, 1, 1);
  labelMat.disableLighting = true;
  labelMat.backFaceCulling = false;
  const label = CreatePlane(n('label'), { width: 3.0, height: 0.75 }, scene);
  label.material = labelMat;
  label.billboardMode = Mesh.BILLBOARDMODE_ALL;
  label.isPickable = false;

  function setLabel(text: string) {
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, TW, TH);
    ctx.font = 'bold 64px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // dark outline keeps the name readable over pale stone and bright water from the recording camera
    ctx.lineJoin = 'round';
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(10, 24, 28, 0.85)';
    ctx.strokeText(text, TW / 2, TH / 2 + 2);
    ctx.fillStyle = PALETTE.label;
    ctx.fillText(text, TW / 2, TH / 2 + 2);
    tex.update(false);
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
