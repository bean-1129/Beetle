// World geometry builders: islands, bridges, decorations, relics, the gate and players. Everything is procedural
// (no asset loads), PBR (geometry-materials.ts), deterministic per object id (terrain.ts PRNG) and bounded in
// draw calls (one body mesh per island, instances for scatter, merged meshes for static clusters).
//
// Invariants the server relies on: the walkable top of every island is flat at Y = 0 over the whole logical disc
// (irregularity only extends outward), and bridge decks are flat at Y = 0 across the full logical rectangle.
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/core/Meshes/instancedMesh'; // side-effect: enables mesh.createInstance
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
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Material } from '@babylonjs/core/Materials/material';
import { GEOMETRY } from '@beetle/contracts';
import type { Bridge, Decoration, Gate, Island, PlayerView, Relic } from '@beetle/contracts';
import type { Materials } from './materials.ts';
import { PALETTE, hash01 } from './palette.ts';
import { buildIslandBody, displaceByNoise, hashString, rngFor } from './terrain.ts';
import { geoMaterials, type GeoMaterials } from './geometry-materials.ts';

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

/** Merge same-material static meshes into one draw call (positions are baked, so parent afterwards). */
function merge(name: string, meshes: Mesh[], material: Material, parent: TransformNode): Mesh {
  const m = Mesh.MergeMeshes(meshes, true, true, undefined, false, false);
  if (!m) throw new Error(`merge produced nothing for ${name}`);
  m.name = name;
  m.material = material;
  m.parent = parent;
  return m;
}

/** A cylinder whose Y axis runs from a to b (ropes, branches, arms). */
function segment(name: string, a: Vector3, b: Vector3, diameter: number, scene: Scene, tessellation = 6): Mesh {
  const dir = b.subtract(a);
  const len = Math.max(0.01, dir.length());
  const m = CreateCylinder(name, { height: len, diameter, tessellation }, scene);
  m.position.copyFrom(a).addInPlace(b).scaleInPlace(0.5);
  const q = new Quaternion();
  Quaternion.FromUnitVectorsToRef(Vector3.Up(), dir.scale(1 / len), q);
  m.rotationQuaternion = q;
  return m;
}

/** Two crossed alpha-tested quads: the base mesh for grass tufts and leaf cards. */
function crossCard(name: string, width: number, height: number, material: Material, scene: Scene): Mesh {
  const a = CreatePlane(`${name}:a`, { width, height }, scene);
  a.position.y = height / 2;
  const b = a.clone(`${name}:b`);
  b.rotation.y = Math.PI / 2;
  const m = Mesh.MergeMeshes([a, b], true, true, undefined, false, false);
  if (!m) throw new Error(`merge produced nothing for ${name}`);
  m.name = name;
  m.material = material;
  return m;
}

/** Scatter `count` instances of a base mesh; the base mesh itself is placed first. */
function scatter(base: Mesh, parent: TransformNode, count: number, place: (m: AbstractMesh, i: number) => void) {
  base.parent = parent;
  place(base, 0);
  freeze(base);
  for (let i = 1; i < count; i++) {
    const inst = base.createInstance(`${base.name}:${i}`);
    inst.parent = parent;
    place(inst, i);
    freeze(inst);
  }
}

// ---------------------------------------------------------------- islands

export type IslandBuilt = Built & {
  /** Glowing crust ring, only enabled in lava mode (index.ts toggles it from the hazard blend). */
  crust: Mesh;
  /** Positions the under-shadow and crust just above the hazard plane. */
  setHazardY: (y: number) => void;
};

export function buildIsland(scene: Scene, _mats: Materials, island: Island): IslandBuilt {
  const gm = geoMaterials(scene);
  const id = island.id;
  const n = (s: string) => `island:${id}:${s}`;
  const r = island.radius;
  const root = new TransformNode(`island:${id}`, scene);
  root.position.set(island.center.x, 0, island.center.z);
  const rng = rngFor(id, 3);
  const seed = hashString(id, 9) % 50000;

  // one mesh: flat top (grass -> earth -> pale path -> rough stone) and the rocky skirt with striations
  const body = buildIslandBody(scene, {
    id, radius: r, thickness: THICK, grass: gm.grass, stone: gm.stone,
    tint: {
      grass: [1.0, 1.04, 0.9], grassAlt: [0.66, 0.6, 0.42], path: [1, 1, 1],
      rim: [0.78, 0.74, 0.68], skirt: [0.52, 0.5, 0.47], tip: [0.34, 0.33, 0.32],
    },
  });
  body.mesh.parent = root;
  freeze(body.mesh);
  // moss darkening near the rim: multiply the grass vertex colours by a radial falloff (keeps the top flat)
  {
    const cols = body.mesh.getVerticesData(VertexBuffer.ColorKind);
    const pos = body.mesh.getVerticesData(VertexBuffer.PositionKind);
    if (cols && pos) {
      for (let i = 0; i < pos.length / 3; i++) {
        if (pos[i * 3 + 1] !== 0) continue;
        const d = Math.hypot(pos[i * 3], pos[i * 3 + 2]) / r;
        if (d > 0.72 && d < 0.94) {
          const k = 1 - 0.28 * Math.sin(((d - 0.72) / 0.22) * Math.PI);
          cols[i * 4] *= k * 0.92; cols[i * 4 + 1] *= k; cols[i * 4 + 2] *= k * 0.9;
        }
      }
      body.mesh.updateVerticesData(VertexBuffer.ColorKind, cols, false, false);
    }
  }

  // boulders on the stone overhang: noise-displaced icospheres, one base + instances
  const boulder = CreateIcoSphere(n('boulder'), { radius: 0.34, subdivisions: 2, flat: true }, scene);
  displaceByNoise(boulder, 0.1, 3, seed + 1);
  boulder.material = gm.rock;
  scatter(boulder, root, 4 + Math.floor(rng() * 4), (m) => {
    const ang = rng() * Math.PI * 2;
    const rim = body.rimRadius(ang);
    const dist = r + 0.25 + rng() * Math.max(0.1, rim - r - 0.5);
    m.position.set(Math.cos(ang) * dist, 0.02, Math.sin(ang) * dist);
    m.scaling.set(0.7 + rng() * 0.9, 0.5 + rng() * 0.5, 0.7 + rng() * 0.9);
    m.rotation.set(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4);
  });
  // pebbles: tiny flat chips along the path edge and the overhang
  const pebble = CreateIcoSphere(n('pebble'), { radius: 0.09, subdivisions: 1, flat: true }, scene);
  pebble.material = gm.pebble;
  scatter(pebble, root, 14 + Math.floor(rng() * 10), (m) => {
    const ang = rng() * Math.PI * 2;
    const dist = r - 0.55 + rng() * (body.rimRadius(ang) - r + 0.4);
    m.position.set(Math.cos(ang) * dist, 0.0, Math.sin(ang) * dist);
    m.scaling.set(0.6 + rng() * 1.2, 0.4 + rng() * 0.4, 0.6 + rng() * 1.2);
    m.rotation.y = rng() * Math.PI * 2;
  });
  // grass tufts: crossed alpha-tested quads on the lawn (instances), denser toward the rim
  const tuft = crossCard(n('tuft'), 0.5, 0.3, gm.tuft, scene);
  scatter(tuft, root, 14 + Math.floor(rng() * 10), (m) => {
    const ang = rng() * Math.PI * 2;
    const dist = Math.sqrt(rng()) * Math.max(0.5, r - 1.1);
    m.position.set(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
    const s = 0.7 + rng() * 0.7;
    m.scaling.set(s, 0.7 + rng() * 0.5, s);
    m.rotation.y = rng() * Math.PI;
  });

  // soft under-shadow on the hazard plane sells "floating"; lava crust ring hugs the rim
  const shadow = CreateDisc(n('shadow'), { radius: body.maxRim * 1.05, tessellation: 48 }, scene);
  shadow.material = gm.underShadow;
  shadow.rotation.x = Math.PI / 2;
  shadow.isPickable = false;
  shadow.parent = root;
  const crust = CreateTorus(n('crust'), { diameter: body.maxRim * 2 + 0.6, thickness: 0.7, tessellation: 56 }, scene);
  crust.material = gm.crust;
  crust.isPickable = false;
  crust.parent = root;
  crust.setEnabled(false);
  const unTheme = gm.onTheme((v) => { if (v > 0.01 && !crust.isEnabled()) crust.setEnabled(true); });

  function setHazardY(y: number) {
    shadow.position.y = y + 0.05;
    crust.position.y = y + 0.1;
  }
  setHazardY(GEOMETRY.hazardPlaneElevation);

  return { root, crust, setHazardY, casters: [body.mesh, boulder], receivers: [body.mesh], dispose: disposeRoot(root, [unTheme]) };
}

// ---------------------------------------------------------------- bridges

export function buildBridge(scene: Scene, _mats: Materials, bridge: Bridge): Built {
  const gm = geoMaterials(scene);
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
  const rng = rngFor(bridge.id, 5);

  // deck planks: flat at Y = 0 across the full logical rectangle, real gaps, slightly uneven widths (always >= w)
  const gap = 0.09;
  const count = Math.max(2, Math.round(length / 0.5));
  const step = length / count;
  const plankDepth = Math.max(0.1, step - gap);
  const plankA = CreateBox(n('plankA'), { width: w + 0.12, height: 0.14, depth: plankDepth }, scene);
  plankA.material = gm.plankA;
  const plankB = CreateBox(n('plankB'), { width: w + 0.12, height: 0.14, depth: plankDepth }, scene);
  plankB.material = gm.plankB;
  plankA.parent = root; plankB.parent = root;
  for (let i = 0; i < count; i++) {
    const even = i % 2 === 0;
    const m: AbstractMesh = i === 0 ? plankA : i === 1 ? plankB : (even ? plankA : plankB).createInstance(n(`p${i}`));
    m.parent = root;
    m.position.set((rng() - 0.5) * 0.04, -0.07, -length / 2 + step * (i + 0.5));
    m.scaling.set(1 + rng() * 0.04, 1, 0.94 + rng() * 0.06);
    freeze(m);
  }

  // two side beams with iron bands
  const beamParts: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const beam = CreateBox(n(`beam${sx}`), { width: 0.2, height: 0.3, depth: length + 0.2 }, scene);
    beam.position.set(sx * (w / 2 - 0.12), -0.3, 0);
    beamParts.push(beam);
  }
  const beams = merge(n('beams'), beamParts, gm.wood, root);
  freeze(beams);
  const band = CreateBox(n('band'), { width: 0.26, height: 0.12, depth: 0.1 }, scene);
  band.material = gm.iron;
  const bandCount = Math.max(2, Math.floor(length / 1.4));
  scatter(band, root, bandCount * 2, (m, i) => {
    const sx = i % 2 === 0 ? -1 : 1;
    const k = Math.floor(i / 2);
    m.position.set(sx * (w / 2 - 0.12), -0.3, -length / 2 + 0.5 + (k / Math.max(1, bandCount - 1)) * (length - 1));
  });

  // posts: at both ends and every ~3 m; ropes sag between them (deck never sags)
  const spans = Math.max(1, Math.round(length / 3.2));
  const postZ: number[] = [];
  for (let i = 0; i <= spans; i++) postZ.push(-length / 2 + 0.25 + (i / spans) * (length - 0.5));
  const railY = 0.95;
  const postParts: Mesh[] = [];
  const capParts: Mesh[] = [];
  const glassParts: Mesh[] = [];
  const ropeParts: Mesh[] = [];
  const casters: Mesh[] = [plankA, plankB, beams];
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.1);
    for (let i = 0; i < postZ.length; i++) {
      const end = i === 0 || i === postZ.length - 1;
      const h = end ? 1.25 : 1.05;
      const post = CreateCylinder(n(`post${sx}${i}`), { height: h, diameterBottom: 0.2, diameterTop: 0.15, tessellation: 8 }, scene);
      post.position.set(x, h / 2, postZ[i]);
      post.rotation.y = rng() * Math.PI;
      postParts.push(post);
      if (end) {
        // lantern caps on the end posts: a small iron cap holding a glowing glass
        const cap = CreateCylinder(n(`cap${sx}${i}`), { height: 0.08, diameter: 0.3, tessellation: 8 }, scene);
        cap.position.set(x, h + 0.24, postZ[i]);
        capParts.push(cap);
        const glass = CreateSphere(n(`glass${sx}${i}`), { diameter: 0.22, segments: 8 }, scene);
        glass.position.set(x, h + 0.1, postZ[i]);
        glassParts.push(glass);
      }
    }
    // ropes: top and mid rail, each span subdivided with a parabolic sag
    for (let i = 0; i < postZ.length - 1; i++) {
      const z0 = postZ[i]; const z1 = postZ[i + 1];
      const span = z1 - z0;
      const sag = Math.min(0.22, span * 0.06);
      for (const [y, d] of [[railY, 0.07], [railY * 0.5, 0.05]] as const) {
        const segs = 6;
        for (let s = 0; s < segs; s++) {
          const t0 = s / segs; const t1 = (s + 1) / segs;
          const ya = y - sag * (1 - (2 * t0 - 1) ** 2);
          const yb = y - sag * (1 - (2 * t1 - 1) ** 2);
          ropeParts.push(segment(n(`rope${sx}${i}${s}`), new Vector3(x, ya, z0 + span * t0), new Vector3(x, yb, z0 + span * t1), d, scene));
        }
      }
      // a vertical tie at mid-span between the two rails
      const zm = (z0 + z1) / 2;
      ropeParts.push(segment(n(`tie${sx}${i}`), new Vector3(x, railY * 0.5 - sag, zm), new Vector3(x, railY - sag, zm), 0.035, scene));
    }
  }
  const posts = merge(n('posts'), postParts, gm.woodLight, root);
  const ropes = merge(n('ropes'), ropeParts, gm.rope, root);
  const caps = merge(n('caps'), capParts, gm.iron, root);
  const glass = merge(n('glass'), glassParts, gm.lanternGlass, root);
  freeze(posts, ropes, caps, glass);
  casters.push(posts);
  return { root, casters, receivers: [plankA, plankB], dispose: disposeRoot(root) };
}

// ---------------------------------------------------------------- decorations

export function buildDecoration(scene: Scene, _mats: Materials, deco: Decoration, pos: { x: number; z: number }, seed: number): Built {
  const gm = geoMaterials(scene);
  const root = new TransformNode(`deco:${deco.id}`, scene);
  root.position.set(pos.x, 0, pos.z);
  root.rotation.y = (deco.rotationDeg * Math.PI) / 180;
  root.scaling.setAll(deco.scale);
  const v = hash01(deco.id, seed);
  const rng = rngFor(deco.id, seed);
  const nseed = hashString(deco.id, seed) % 40000;
  const casters: Mesh[] = [];
  const extra: (() => void)[] = [];
  const n = (s: string) => `deco:${deco.id}:${s}`;
  switch (deco.type) {
    case 'tree': {
      // trunk: tapered, bent a little, bark noise
      const h = 1.6 + 0.5 * v;
      const trunk = CreateCylinder(n('trunk'), { height: h, diameterBottom: 0.5, diameterTop: 0.26, tessellation: 10, subdivisions: 6 }, scene);
      {
        const p = trunk.getVerticesData(VertexBuffer.PositionKind)!;
        const bend = 0.18 + 0.2 * rng();
        const bx = Math.cos(rng() * Math.PI * 2); const bz = Math.sin(rng() * Math.PI * 2);
        for (let i = 0; i < p.length; i += 3) {
          const t = (p[i + 1] + h / 2) / h;
          p[i] += bx * bend * t * t; p[i + 2] += bz * bend * t * t;
        }
        trunk.updateVerticesData(VertexBuffer.PositionKind, p, false, false);
        displaceByNoise(trunk, 0.03, 4, nseed);
      }
      trunk.material = gm.trunk;
      trunk.position.y = h / 2;
      trunk.parent = root;
      casters.push(trunk);
      freeze(trunk);
      // branches (visible once the canopy thins in the volcanic theme) with ember tips
      const branchParts: Mesh[] = [];
      const tipParts: Mesh[] = [];
      const topY = h - 0.1;
      const clusters = 3 + Math.floor(rng() * 3);
      const lightParts: Mesh[] = [];
      const darkParts: Mesh[] = [];
      const cardParts: Mesh[] = [];
      for (let i = 0; i < clusters; i++) {
        const ang = (i / clusters) * Math.PI * 2 + rng() * 0.8;
        const spread = i === 0 ? 0 : 0.45 + rng() * 0.5;
        const cx = Math.cos(ang) * spread; const cz = Math.sin(ang) * spread;
        const cy = topY + 0.5 + rng() * 0.7 + (i === 0 ? 0.35 : 0);
        const tip = new Vector3(cx, cy, cz);
        branchParts.push(segment(n(`br${i}`), new Vector3(0, topY - 0.3, 0), tip, 0.08, scene, 5));
        const ember = CreateSphere(n(`tip${i}`), { diameter: 0.12, segments: 5 }, scene);
        ember.position.copyFrom(tip);
        tipParts.push(ember);
        const sphere = CreateSphere(n(`c${i}`), { diameter: 1.1 + rng() * 0.6, segments: 10 }, scene);
        displaceByNoise(sphere, 0.2, 2.6, nseed + i);
        sphere.position.copyFrom(tip);
        sphere.scaling.y = 0.8 + rng() * 0.3;
        (i % 2 === 0 ? lightParts : darkParts).push(sphere);
        // leaf cards around the cluster for a broken silhouette
        for (let k = 0; k < 2; k++) {
          const card = CreatePlane(n(`lc${i}${k}`), { width: 0.9, height: 0.7 }, scene);
          const ca = rng() * Math.PI * 2;
          card.position.set(cx + Math.cos(ca) * 0.5, cy + (rng() - 0.5) * 0.5, cz + Math.sin(ca) * 0.5);
          card.rotation.set((rng() - 0.5) * 0.8, ca + Math.PI / 2, (rng() - 0.5) * 0.4);
          cardParts.push(card);
        }
      }
      const branches = merge(n('branches'), branchParts, gm.trunk, root);
      const tips = merge(n('tips'), tipParts, gm.emberTip, root);
      const light = merge(n('canopyA'), lightParts, gm.leaves, root);
      const cards = merge(n('cards'), cardParts, gm.leafCard, root);
      const dark = darkParts.length ? merge(n('canopyB'), darkParts, gm.leavesDark, root) : null;
      const canopy = dark ? [light, dark, cards] : [light, cards];
      freeze(branches, tips, ...canopy);
      casters.push(light, branches);
      if (dark) casters.push(dark);
      // volcanic: canopy thins to bare branches, ember tips glow
      extra.push(gm.onTheme((t) => {
        const s = 1 - 0.9 * t;
        for (const m of canopy) { m.unfreezeWorldMatrix(); m.scaling.setAll(Math.max(0.05, s)); m.freezeWorldMatrix(); }
        tips.setEnabled(t > 0.02);
      }));
      break;
    }
    case 'rock': {
      const rock = CreateIcoSphere(n('rock'), { radius: 0.8, subdivisions: 2, flat: true }, scene);
      displaceByNoise(rock, 0.2, 1.6, nseed);
      rock.material = gm.rock;
      rock.scaling.set(1, 0.6, 0.85 + 0.2 * v);
      rock.rotation.set(0.15 * v, v * Math.PI * 2, 0.1);
      rock.position.y = 0.3;
      rock.parent = root;
      const chip = CreateIcoSphere(n('chip'), { radius: 0.3, subdivisions: 1, flat: true }, scene);
      displaceByNoise(chip, 0.08, 3, nseed + 2);
      chip.material = gm.pebble;
      chip.position.set(0.7, 0.1, 0.3 - 0.6 * v);
      chip.scaling.set(1, 0.6, 1);
      chip.parent = root;
      casters.push(rock);
      freeze(rock, chip);
      break;
    }
    case 'lantern': {
      const post = CreateCylinder(n('post'), { height: 1.5, diameterBottom: 0.14, diameterTop: 0.1, tessellation: 8 }, scene);
      post.position.y = 0.75;
      const arm = CreateBox(n('arm'), { width: 0.08, height: 0.06, depth: 0.5 }, scene);
      arm.position.set(0, 1.5, 0.2);
      const foot = CreateCylinder(n('foot'), { height: 0.08, diameter: 0.36, tessellation: 10 }, scene);
      foot.position.y = 0.04;
      const frame = merge(n('frame'), [post, arm, foot], gm.lanternPost, root);
      const glass = CreateBox(n('glass'), { width: 0.26, height: 0.34, depth: 0.26 }, scene);
      glass.material = gm.lanternGlass;
      glass.position.set(0, 1.28, 0.4);
      glass.parent = root;
      const halo = CreateSphere(n('halo'), { diameter: 1.0, segments: 8 }, scene);
      halo.material = gm.halo;
      halo.position.set(0, 1.28, 0.4);
      halo.parent = root;
      casters.push(frame);
      freeze(frame, glass, halo);
      break;
    }
    case 'pillar': {
      const base = CreateBox(n('base'), { width: 1.2, height: 0.18, depth: 1.2 }, scene);
      base.position.y = 0.09;
      const plinth = CreateBox(n('plinth'), { width: 1.0, height: 0.14, depth: 1.0 }, scene);
      plinth.position.y = 0.25;
      const shaft = CreateCylinder(n('shaft'), { height: 2.1, diameterBottom: 0.9, diameterTop: 0.78, tessellation: 16 }, scene);
      displaceByNoise(shaft, 0.015, 4, nseed);
      shaft.position.y = 1.37;
      const cap = CreateBox(n('cap'), { width: 1.1, height: 0.2, depth: 1.1 }, scene);
      cap.position.y = 2.52;
      const pillar = merge(n('pillar'), [base, plinth, shaft, cap], gm.stone, root);
      casters.push(pillar);
      freeze(pillar);
      break;
    }
    case 'bush': {
      const parts: Mesh[] = [];
      const lobes = 3;
      for (let i = 0; i < lobes; i++) {
        const s = CreateSphere(n(`b${i}`), { diameter: 0.7 + rng() * 0.5, segments: 8 }, scene);
        displaceByNoise(s, 0.08, 3, nseed + i);
        s.position.set((rng() - 0.5) * 0.7, 0.28 + rng() * 0.15, (rng() - 0.5) * 0.7);
        s.scaling.y = 0.75;
        parts.push(s);
      }
      const bush = merge(n('bush'), parts, gm.bush, root);
      const cards: Mesh[] = [];
      for (let k = 0; k < 3; k++) {
        const card = CreatePlane(n(`bc${k}`), { width: 0.8, height: 0.6 }, scene);
        const ca = rng() * Math.PI * 2;
        card.position.set(Math.cos(ca) * 0.4, 0.35, Math.sin(ca) * 0.4);
        card.rotation.set((rng() - 0.5) * 0.6, ca + Math.PI / 2, 0);
        cards.push(card);
      }
      const bushCards = merge(n('bushCards'), cards, gm.leafCard, root);
      casters.push(bush);
      freeze(bush, bushCards);
      extra.push(gm.onTheme((t) => { bushCards.unfreezeWorldMatrix(); bushCards.scaling.setAll(Math.max(0.05, 1 - 0.8 * t)); bushCards.freezeWorldMatrix(); }));
      break;
    }
    case 'shrine': {
      const s1 = CreateBox(n('s1'), { width: 2.0, height: 0.4, depth: 2.0 }, scene);
      s1.position.y = 0.2;
      const s2 = CreateBox(n('s2'), { width: 1.4, height: 0.6, depth: 1.4 }, scene);
      s2.position.y = 0.7;
      const s3 = CreateBox(n('s3'), { width: 0.8, height: 0.8, depth: 0.8 }, scene);
      s3.position.y = 1.4;
      const roof = CreateCylinder(n('roof'), { height: 0.3, diameterBottom: 1.3, diameterTop: 0.2, tessellation: 4 }, scene);
      roof.position.y = 1.95;
      roof.rotation.y = Math.PI / 4;
      const shrine = merge(n('shrine'), [s1, s2, s3, roof], gm.stone, root);
      const glow = CreateSphere(n('glow'), { diameter: 0.3, segments: 8 }, scene);
      glow.material = gm.lanternGlass;
      glow.position.y = 1.45;
      glow.position.z = 0.42;
      glow.parent = root;
      const halo = CreateSphere(n('halo'), { diameter: 0.9, segments: 8 }, scene);
      halo.material = gm.halo;
      halo.position.copyFrom(glow.position);
      halo.parent = root;
      casters.push(shrine);
      freeze(shrine, glow, halo);
      break;
    }
  }
  return { root, casters, receivers: [], dispose: disposeRoot(root, extra) };
}

// ---------------------------------------------------------------- relics

export type RelicBuilt = Built & { gem: Mesh; baseY: number; phase: number };

export function buildRelic(scene: Scene, _mats: Materials, relic: Relic, pos: { x: number; z: number }): RelicBuilt {
  const gm = geoMaterials(scene);
  const n = (s: string) => `relic:${relic.id}:${s}`;
  const root = new TransformNode(`relic:${relic.id}`, scene);
  root.position.set(pos.x, 0, pos.z);
  const index = Math.floor(hash01(relic.id, 77) * 5);
  const rm = gm.relicMaterials(index);
  const baseY = 1.2;
  // crystal: a translucent outer shell with a bright emissive core inside, plus a faint halo
  const gem = CreatePolyhedron(n('gem'), { type: 1, size: 0.55 }, scene);
  gem.material = rm.shell;
  gem.position.y = baseY;
  gem.parent = root;
  const core = CreatePolyhedron(n('core'), { type: 1, size: 0.3 }, scene);
  core.material = rm.core;
  core.parent = gem;
  core.isPickable = false;
  const halo = CreateSphere(n('halo'), { diameter: 2.0, segments: 12 }, scene);
  halo.material = rm.halo;
  halo.parent = gem;
  halo.isPickable = false;
  // stone pedestal with a carved rim and a soft light pool on top
  const pedestal = CreateCylinder(n('pedestal'), { height: 0.26, diameterBottom: 1.1, diameterTop: 0.9, tessellation: 18 }, scene);
  displaceByNoise(pedestal, 0.012, 5, 311);
  pedestal.material = gm.stoneDark;
  pedestal.position.y = 0.13;
  pedestal.parent = root;
  const ring = CreateTorus(n('ring'), { diameter: 1.0, thickness: 0.08, tessellation: 24 }, scene);
  ring.material = gm.stone;
  ring.position.y = 0.26;
  ring.parent = root;
  const pool = CreateDisc(n('pool'), { radius: 0.9, tessellation: 24 }, scene);
  pool.material = rm.pool;
  pool.rotation.x = Math.PI / 2;
  pool.position.y = 0.285;
  pool.parent = root;
  freeze(pedestal, ring, pool);
  // sparkles rising around the gem (runtime circle sprite)
  const ps = new ParticleSystem(n('sparkle'), 48, scene);
  ps.particleTexture = gm.tex.sparkle;
  ps.emitter = gem;
  ps.createSphereEmitter(0.55, 0.4);
  ps.minSize = 0.06; ps.maxSize = 0.16;
  ps.minLifeTime = 0.8; ps.maxLifeTime = 1.7;
  ps.emitRate = 26;
  ps.minEmitPower = 0.15; ps.maxEmitPower = 0.4;
  ps.gravity = new Vector3(0, 0.35, 0);
  ps.color1 = new Color4(rm.color.r, rm.color.g, rm.color.b, 1);
  ps.color2 = new Color4(1, 1, 1, 1);
  ps.colorDead = new Color4(rm.color.r, rm.color.g, rm.color.b, 0);
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.start();
  // the root is disabled when the relic is collected: follow that with the particle system
  const obs = scene.onBeforeRenderObservable.add(() => {
    const on = root.isEnabled();
    if (on && !ps.isStarted()) ps.start();
    else if (!on && ps.isStarted()) ps.stop();
  });
  return {
    root, gem, baseY, phase: hash01(relic.id) * Math.PI * 2, casters: [gem], receivers: [],
    dispose: disposeRoot(root, [() => { scene.onBeforeRenderObservable.remove(obs); ps.dispose(false); }]),
  };
}

// ---------------------------------------------------------------- gate

export type GateBuilt = Built & { setUnlocked: (unlocked: boolean) => void; animate: (now: number, dtMs: number) => void };

function makeFlame(name: string, scene: Scene, gm: GeoMaterials, emitter: Mesh): ParticleSystem {
  const ps = new ParticleSystem(name, 60, scene);
  ps.particleTexture = gm.tex.flame;
  ps.emitter = emitter;
  ps.minEmitBox = new Vector3(-0.12, 0, -0.12);
  ps.maxEmitBox = new Vector3(0.12, 0.1, 0.12);
  ps.direction1 = new Vector3(-0.15, 1, -0.15);
  ps.direction2 = new Vector3(0.15, 1.6, 0.15);
  ps.minSize = 0.18; ps.maxSize = 0.4;
  ps.minLifeTime = 0.35; ps.maxLifeTime = 0.8;
  ps.emitRate = 45;
  ps.minEmitPower = 0.5; ps.maxEmitPower = 1.0;
  ps.color1 = new Color4(1, 0.75, 0.3, 1);
  ps.color2 = new Color4(1, 0.4, 0.1, 0.9);
  ps.colorDead = new Color4(0.5, 0.1, 0, 0);
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.updateSpeed = 0.02;
  return ps;
}

export function buildGate(scene: Scene, _mats: Materials, gate: Gate, pos: { x: number; z: number }): GateBuilt {
  const gm = geoMaterials(scene);
  const n = (s: string) => `gate:${gate.id}:${s}`;
  const root = new TransformNode(`gate:${gate.id}`, scene);
  root.position.set(pos.x, 0, pos.z);
  const casters: Mesh[] = [];
  const R = GEOMETRY.gateBlockRadius;
  // the rune stone is per gate so its glow can be driven without touching other stone
  const stone = gm.gateStone;
  const plain = gm.stoneDark;
  for (const sx of [-1, 1]) {
    const base = CreateBox(n(`base${sx}`), { width: 1.4, height: 0.3, depth: 1.4 }, scene);
    base.position.set(sx * R, 0.15, 0);
    const plinth = CreateBox(n(`plinth${sx}`), { width: 1.1, height: 0.2, depth: 1.1 }, scene);
    plinth.position.set(sx * R, 0.4, 0);
    const capital = CreateBox(n(`cap${sx}`), { width: 1.25, height: 0.26, depth: 1.25 }, scene);
    capital.position.set(sx * R, 3.6, 0);
    const foot = merge(n(`foot${sx}`), [base, plinth, capital], plain, root);
    // carved rune column: three stacked blocks sharing the rune texture (uv per block face)
    const blocks: Mesh[] = [];
    for (let k = 0; k < 3; k++) {
      const blk = CreateBox(n(`blk${sx}${k}`), { width: 0.95 - k * 0.03, height: 1.0, depth: 0.95 - k * 0.03 }, scene);
      blk.position.set(sx * R, 1.0 + k * 1.0, 0);
      blocks.push(blk);
    }
    const shaft = merge(n(`pillar${sx}`), blocks, stone, root);
    freeze(foot, shaft);
    casters.push(shaft, foot);
  }
  const lintelY = 3.98;
  const lintel = CreateBox(n('lintel'), { width: R * 2 + 1.9, height: 0.6, depth: 0.95 }, scene);
  lintel.material = stone;
  lintel.position.y = lintelY;
  lintel.parent = root;
  casters.push(lintel);
  // arch glyph: a standing ring over the lintel with a keystone crystal in its centre
  const glyph = CreateTorus(n('glyph'), { diameter: 1.2, thickness: 0.14, tessellation: 28 }, scene);
  glyph.material = stone;
  glyph.rotation.x = Math.PI / 2;
  glyph.position.y = lintelY + 0.95;
  glyph.parent = root;
  casters.push(glyph);
  const keyMats = gm.relicMaterials(0);
  const keystone = CreatePolyhedron(n('key'), { type: 1, size: 0.26 }, scene);
  keystone.material = keyMats.shell;
  keystone.position.y = lintelY + 0.95;
  keystone.parent = root;
  const keyCore = CreatePolyhedron(n('keycore'), { type: 1, size: 0.14 }, scene);
  keyCore.material = keyMats.core;
  keyCore.parent = keystone;
  keyCore.setEnabled(false);
  // braziers either side: a short stand, an iron bowl, embers and flames when unlocked
  const flames: ParticleSystem[] = [];
  const bowlParts: Mesh[] = [];
  const emberParts: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const x = sx * (R + 1.35);
    const stand = CreateCylinder(n(`stand${sx}`), { height: 0.8, diameterBottom: 0.36, diameterTop: 0.2, tessellation: 10 }, scene);
    stand.position.set(x, 0.4, 0.2);
    const bowl = CreateCylinder(n(`bowl${sx}`), { height: 0.3, diameterBottom: 0.3, diameterTop: 0.7, tessellation: 12 }, scene);
    bowl.position.set(x, 0.92, 0.2);
    bowlParts.push(stand, bowl);
    const ember = CreateSphere(n(`ember${sx}`), { diameter: 0.4, segments: 6 }, scene);
    ember.position.set(x, 1.02, 0.2);
    ember.scaling.y = 0.4;
    emberParts.push(ember);
  }
  const braziers = merge(n('braziers'), bowlParts, gm.brazier, root);
  const embers = merge(n('embers'), emberParts, gm.emberTip, root);
  freeze(braziers, embers);
  casters.push(braziers);
  for (const sx of [-1, 1]) {
    const anchor = CreateBox(n(`flameAnchor${sx}`), { size: 0.01 }, scene);
    anchor.position.set(sx * (R + 1.35), 1.05, 0.2);
    anchor.parent = root;
    anchor.isVisible = false;
    flames.push(makeFlame(n(`flame${sx}`), scene, gm, anchor));
  }
  // soft light cone under the lintel, only visible when unlocked
  const coneMat = gm.gateCone.clone(n('coneMat'));
  const cone = CreateCylinder(n('cone'), { height: 3.7, diameterTop: 0.5, diameterBottom: R * 2 + 1.4, tessellation: 24 }, scene);
  cone.material = coneMat;
  cone.position.y = 1.95;
  cone.parent = root;
  cone.isPickable = false;
  cone.setEnabled(false);

  const light = new PointLight(n('light'), new Vector3(0, 2.8, 0), scene);
  light.diffuse = PALETTE.amberBright;
  light.specular = PALETTE.amberBright;
  light.intensity = 0;
  light.range = 14;
  light.parent = root;

  const warm = Color3.FromHexString('#ffb050');
  let unlocked = false;
  let targetLift = 0;
  let coneAlpha = 0;
  let glow = 0;
  function setUnlocked(u: boolean) {
    if (u === unlocked) return;
    unlocked = u;
    targetLift = u ? 0.4 : 0;
    if (u) { cone.setEnabled(true); keyCore.setEnabled(true); for (const f of flames) f.start(); }
    else { for (const f of flames) f.stop(); }
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
    const targetCone = unlocked ? 0.14 + 0.05 * Math.sin(now / 700) : 0;
    coneAlpha += (targetCone - coneAlpha) * k;
    coneMat.alpha = coneAlpha;
    const targetGlow = unlocked ? 0.85 + 0.15 * Math.sin(now / 420) : 0;
    glow += (targetGlow - glow) * k;
    // warm emissive runes (the rune glow mask is the emissive texture) on the shared gate stone
    stone.emissiveColor.copyFrom(warm).scaleInPlace(glow);
    stone.emissiveIntensity = 1.4;
    embers.visibility = Math.max(gm.volcanic(), glow);
    if (!unlocked && coneAlpha < 0.005 && cone.isEnabled()) { cone.setEnabled(false); keyCore.setEnabled(false); }
    if (unlocked) keystone.rotation.y += dtMs * 0.0012;
  }
  return {
    root, casters, receivers: [], setUnlocked, animate,
    dispose: disposeRoot(root, [() => light.dispose(), () => { for (const f of flames) f.dispose(false); }, () => coneMat.dispose(), () => { stone.emissiveColor.set(0, 0, 0); }]),
  };
}

// ---------------------------------------------------------------- players

export type PlayerBuilt = {
  root: TransformNode;
  parts: Mesh[];
  label: Mesh;
  casters: Mesh[];
  setLabel: (text: string) => void;
  setVisibility: (v: number) => void;
  /** Walk bob, lean, arm swing, cape sway, falling tumble; speed in m/s, called every frame by index.ts. */
  animate: (nowMs: number, speed: number, facingDeg: number, status: PlayerView['status']) => void;
  dispose: () => void;
};

export function buildPlayer(scene: Scene, _mats: Materials, p: PlayerView): PlayerBuilt {
  const gm = geoMaterials(scene);
  const n = (s: string) => `player:${p.id}:${s}`;
  const root = new TransformNode(`player:${p.id}`, scene);
  const pm = gm.playerMaterials(p.color);
  const R = GEOMETRY.playerRadius * 0.95;
  // rig: a pivot at the feet for lean/tumble, the body hangs under it
  const rig = new TransformNode(n('rig'), scene);
  rig.parent = root;
  const bodyY = 1.05;
  const body = CreateCapsule(n('body'), { height: 1.25, radius: R, tessellation: 14, subdivisions: 2, capSubdivisions: 6 }, scene);
  body.material = pm.body;
  body.position.y = bodyY;
  body.parent = rig;
  const parts: Mesh[] = [body];
  const head = CreateSphere(n('head'), { diameter: 0.5, segments: 12 }, scene);
  head.material = gm.skin;
  head.position.y = bodyY + 0.95;
  head.parent = rig;
  parts.push(head);
  // legs: two short cylinders so the silhouette reads as a figure
  const legs: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const leg = CreateCylinder(n(`leg${sx}`), { height: 0.5, diameterTop: 0.2, diameterBottom: 0.16, tessellation: 8 }, scene);
    leg.material = gm.playerBase;
    leg.position.set(sx * 0.16, 0.25, 0);
    leg.parent = rig;
    legs.push(leg);
    parts.push(leg);
  }
  // arms pivot at the shoulders
  const arms: TransformNode[] = [];
  for (const sx of [-1, 1]) {
    const shoulder = new TransformNode(n(`shoulder${sx}`), scene);
    shoulder.position.set(sx * (R + 0.06), bodyY + 0.45, 0);
    shoulder.parent = rig;
    const arm = CreateCylinder(n(`arm${sx}`), { height: 0.75, diameterTop: 0.16, diameterBottom: 0.12, tessellation: 8 }, scene);
    arm.material = pm.body;
    arm.position.y = -0.37;
    arm.parent = shoulder;
    const hand = CreateSphere(n(`hand${sx}`), { diameter: 0.16, segments: 6 }, scene);
    hand.material = gm.skin;
    hand.position.y = -0.76;
    hand.parent = shoulder;
    arms.push(shoulder);
    parts.push(arm, hand);
  }
  // cape hangs from the shoulders and trails behind (-Z is behind: facing is +Z in local space)
  const capePivot = new TransformNode(n('capePivot'), scene);
  capePivot.position.set(0, bodyY + 0.55, -R * 0.75);
  capePivot.parent = rig;
  const cape = CreatePlane(n('cape'), { width: 0.8, height: 1.15 }, scene);
  cape.material = pm.cape;
  cape.position.y = -0.575;
  cape.parent = capePivot;
  parts.push(cape);
  if (p.slot === 0) {
    // cloth hood: a soft cone over the head, peak folded back
    const hood = CreateCylinder(n('hood'), { height: 0.6, diameterBottom: 0.62, diameterTop: 0.1, tessellation: 12 }, scene);
    displaceByNoise(hood, 0.02, 5, 17);
    hood.material = gm.hood;
    hood.position.set(0, bodyY + 1.1, -0.04);
    hood.rotation.x = -0.25;
    hood.parent = rig;
    parts.push(hood);
  } else {
    const crown = CreateTorus(n('crown'), { diameter: 0.5, thickness: 0.07, tessellation: 20 }, scene);
    crown.material = gm.crown;
    crown.position.y = bodyY + 1.18;
    crown.parent = rig;
    parts.push(crown);
    const jewel = CreatePolyhedron(n('jewel'), { type: 1, size: 0.07 }, scene);
    jewel.material = gm.relicMaterials(0).core;
    jewel.position.set(0, bodyY + 1.2, 0.25);
    jewel.parent = rig;
    parts.push(jewel);
  }
  // darker base ring and a soft drop shadow blob
  const base = CreateTorus(n('base'), { diameter: R * 2 + 0.3, thickness: 0.1, tessellation: 20 }, scene);
  base.material = gm.playerBase;
  base.position.y = 0.05;
  base.parent = root;
  parts.push(base);
  const blob = CreateDisc(n('shadow'), { radius: R * 1.5, tessellation: 20 }, scene);
  blob.material = gm.underShadow;
  blob.rotation.x = Math.PI / 2;
  blob.position.y = 0.025;
  blob.parent = root;
  blob.isPickable = false;
  parts.push(blob);

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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, TW, TH);
    // the billboard plane shows its back to the camera, so draw mirrored to read left-to-right
    ctx.setTransform(-1, 0, 0, 1, TW, 0);
    ctx.font = 'bold 60px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // dark pill behind the name keeps it readable over pale stone, bright water and lava
    const tw = Math.min(TW - 16, ctx.measureText(text).width + 56);
    ctx.fillStyle = 'rgba(8, 18, 22, 0.62)';
    ctx.beginPath();
    ctx.roundRect((TW - tw) / 2, 18, tw, TH - 36, 46);
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(10, 24, 28, 0.9)';
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

  let phase = hash01(p.id) * Math.PI * 2;
  let lastNow = 0;
  let lean = 0;
  let tumble = 0;
  function animate(nowMs: number, speed: number, facingDeg: number, status: PlayerView['status']) {
    const dt = lastNow > 0 ? Math.min(100, Math.max(0, nowMs - lastNow)) : 16;
    lastNow = nowMs;
    const ratio = Math.max(0, Math.min(1.3, (Number.isFinite(speed) ? speed : 0) / GEOMETRY.playerSpeed));
    if (Number.isFinite(facingDeg)) root.rotation.y = (facingDeg * Math.PI) / 180;
    phase += dt * 0.0105 * (0.25 + ratio);
    const swing = Math.sin(phase);
    const targetLean = status === 'falling' ? 0 : 0.16 * ratio;
    lean += (targetLean - lean) * Math.min(1, dt / 120);
    if (status === 'falling') {
      tumble += dt * 0.004;
      rig.rotation.x = tumble;
      rig.rotation.z = Math.sin(tumble * 0.7) * 0.4;
    } else {
      tumble = 0;
      rig.rotation.x = lean;
      rig.rotation.z = Math.sin(phase * 0.5) * 0.03 * ratio;
    }
    const bob = Math.abs(swing) * 0.07 * ratio + (status === 'respawning' ? 0.05 * Math.sin(nowMs / 90) : 0);
    body.position.y = bodyY + bob;
    head.position.y = bodyY + 0.95 + bob;
    arms[0].rotation.x = swing * 0.7 * ratio;
    arms[1].rotation.x = -swing * 0.7 * ratio;
    arms[0].position.y = arms[1].position.y = bodyY + 0.45 + bob;
    legs[0].rotation.x = -swing * 0.55 * ratio;
    legs[1].rotation.x = swing * 0.55 * ratio;
    capePivot.rotation.x = -(0.25 + 0.55 * ratio + 0.05 * Math.sin(phase * 0.5 + 1));
    capePivot.rotation.z = Math.sin(phase * 0.5) * 0.08 * ratio;
    capePivot.position.y = bodyY + 0.55 + bob;
  }
  animate(0, 0, 0, p.status);

  return {
    root, parts, label, casters: [body], setLabel, setVisibility, animate,
    dispose: () => { label.dispose(false, true); tex.dispose(); labelMat.dispose(); root.dispose(false, true); },
  };
}
