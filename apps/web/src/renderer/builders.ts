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
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Material } from '@babylonjs/core/Materials/material';
import '@babylonjs/core/Rendering/outlineRenderer'; // side-effect: mesh.renderOverlay for submerged bridges
import { GEOMETRY, DECORATION_RADIUS } from '@beetle/contracts';
import type { Bridge, Decoration, Gate, Island, PlayerView, Relic } from '@beetle/contracts';
import type { Materials } from './materials.ts';
import { PALETTE, hash01 } from './palette.ts';
import { buildIslandBody, displaceByNoise, hashString, mulberry32, rngFor } from './terrain.ts';
import { geoMaterials, type GeoMaterials } from './geometry-materials.ts';

export type Built = {
  root: TransformNode;
  casters: Mesh[];
  receivers: Mesh[];
  dispose: () => void;
};

const THICK = GEOMETRY.platformThickness;

// ---------------------------------------------------------------- per-instance variation
//
// Assets are reused across games under the same ids ("island-1", "bridge-a"...), so every instance seeds its
// look from a stable hash of its id, the world seed and its own placement: the same object in the same world always
// rebuilds identically, but no two worlds produce copies. Variation comes only from parameters, instancing and a
// bounded set of material variants (at most three of any material), never from per-object materials.
let worldSeed = 0;
/** Optional: the renderer may pass the world seed before building a world (decorations already receive it). */
export function setWorldSeed(seed: number): void { worldSeed = (Number(seed) | 0) >>> 0; }

function variantSeed(id: string, salt: number, ...placement: number[]): number {
  let h = hashString(id, salt ^ worldSeed);
  for (const f of placement) h = hashString(String(Math.round(f * 100)), h);
  return h >>> 0;
}

/** Hue-rotate an RGB triple about the grey axis (Rodrigues), for small tint shifts. */
function hueRotate(c: readonly [number, number, number], deg: number): [number, number, number] {
  const a = (deg * Math.PI) / 180;
  const cs = Math.cos(a); const sn = Math.sin(a);
  const k = (1 - cs) / 3; const q = Math.sqrt(1 / 3) * sn;
  return [
    (cs + k) * c[0] + (k - q) * c[1] + (k + q) * c[2],
    (k + q) * c[0] + (cs + k) * c[1] + (k - q) * c[2],
    (k - q) * c[0] + (k + q) * c[1] + (cs + k) * c[2],
  ];
}

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
  const vs = variantSeed(id, 3, island.center.x, island.center.z, r);
  const rng = mulberry32(vs);
  const seed = vs % 50000;
  // per-instance island parameters
  const skirtProfile = (vs % 3) as 0 | 1 | 2;       // 3 distinct skirt silhouettes
  const pathWidth = 0.5 + rng() * 0.3;               // pale path ring 0.5..0.8 m
  const hue = (rng() * 2 - 1) * 6;                   // grass hue +-6 degrees
  const mossWidth = 0.1 + rng() * 0.2;               // moss band 10..30 % of the lawn radius
  const mossStrength = 0.3 + rng() * 0.25;
  const grassBase: [number, number, number] = [0.5, 0.75, 0.4]; // ~ the grass albedo: rotate the final colour, not the multiplier
  const shiftTint = (t: [number, number, number]): [number, number, number] => {
    const rot = hueRotate([grassBase[0] * t[0], grassBase[1] * t[1], grassBase[2] * t[2]], hue);
    return [Math.max(0, rot[0] / grassBase[0]), Math.max(0, rot[1] / grassBase[1]), Math.max(0, rot[2] / grassBase[2])];
  };

  // one mesh: flat top (grass -> moss band -> pale path -> rough stone) and the rocky skirt with striations
  const body = buildIslandBody(scene, {
    id, radius: r, thickness: THICK, grass: gm.grass, stone: gm.stone,
    seed: vs, skirtProfile, pathWidth,
    moss: { width: mossWidth, strength: mossStrength, tint: [0.62, 0.74, 0.55] },
    tint: {
      grass: shiftTint([1.0, 1.04, 0.9]), grassAlt: shiftTint([0.66, 0.6, 0.42]), path: [1, 1, 1],
      rim: [0.78, 0.74, 0.68], skirt: [0.52, 0.5, 0.47], tip: [0.34, 0.33, 0.32],
    },
  });
  body.mesh.parent = root;
  freeze(body.mesh);

  // boulders on the stone overhang: noise-displaced icospheres, one base + instances; count 3..9 and a
  // per-island size bias, some of them clumped in pairs
  const boulder = CreateIcoSphere(n('boulder'), { radius: 0.34, subdivisions: 2, flat: true }, scene);
  displaceByNoise(boulder, 0.1, 3, seed + 1);
  boulder.material = gm.rock;
  const boulderCount = 3 + Math.floor(rng() * 7);
  const boulderSize = 0.65 + rng() * 0.75;
  let lastAng = rng() * Math.PI * 2;
  scatter(boulder, root, boulderCount, (m) => {
    const ang = rng() < 0.3 ? lastAng + (rng() - 0.5) * 0.25 : rng() * Math.PI * 2;
    lastAng = ang;
    const rim = body.rimRadius(ang);
    const dist = r + 0.25 + rng() * Math.max(0.1, rim - r - 0.5);
    m.position.set(Math.cos(ang) * dist, 0.02, Math.sin(ang) * dist);
    const s = boulderSize * (0.6 + rng() * 0.9);
    m.scaling.set(s * (0.8 + rng() * 0.4), s * (0.55 + rng() * 0.45), s * (0.8 + rng() * 0.4));
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

  root.metadata = { variant: { skirtProfile, pathWidth: +pathWidth.toFixed(2), hue: +hue.toFixed(1), mossWidth: +mossWidth.toFixed(2), boulders: boulderCount } };
  return { root, crust, setHazardY, casters: [body.mesh, boulder], receivers: [body.mesh], dispose: disposeRoot(root, [unTheme]) };
}

// ---------------------------------------------------------------- bridges

export type BridgeBuilt = Built & {
  /** 0..1: how far the deck sits under a risen hazard plane (survival). Darkens the deck with an overlay. */
  setSubmerged: (k: number) => void;
};

export function buildBridge(scene: Scene, _mats: Materials, bridge: Bridge): BridgeBuilt {
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
  const vs = variantSeed(bridge.id, 5, a.point.x, a.point.z, b.point.x, b.point.z, w);
  const rng = mulberry32(vs);
  // per-instance bridge parameters
  const pitch = 0.42 + rng() * 0.2;                  // plank pitch 0.42..0.62 m -> plank count
  const gap = 0.06 + rng() * 0.08;                   // gap between planks 0.06..0.14 m
  const postSpacing = 2.4 + rng() * 1.4;             // rail posts every 2.4..3.8 m
  const ropeSag = 0.15 + rng() * 0.2;                // rope sag 0.15..0.35 m
  const toneCount = rng() < 0.5 ? 2 : 3;             // two or three wood tones
  const chipRate = 0.1 + rng() * 0.2;                // worn edge chips on 10..30 % of planks
  const toneMats = [gm.plankA, gm.plankB, gm.plankC];
  for (let i = toneMats.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [toneMats[i], toneMats[j]] = [toneMats[j], toneMats[i]]; }
  toneMats.length = toneCount;

  // deck planks: flat at Y = 0 across the full logical rectangle, real gaps, slightly uneven widths (always >= w).
  // Each plank is its own box (chips are baked into its outline), merged per wood tone: <= 3 draw calls.
  const count = Math.max(2, Math.round(length / pitch));
  const step = length / count;
  const plankDepth = Math.max(0.1, step - gap);
  const toneParts: Mesh[][] = toneMats.map(() => []);
  let chipped = 0;
  for (let i = 0; i < count; i++) {
    const pw = (w + 0.12) * (1 + rng() * 0.04);
    const pd = plankDepth * (0.94 + rng() * 0.06);
    const p = CreateBox(n(`p${i}`), { width: pw, height: 0.14, depth: pd }, scene);
    if (rng() < chipRate) {
      // worn edge: shave one or two corners inward (x/z only, the top stays at Y = 0 and still covers w)
      chipped++;
      const pos = p.getVerticesData(VertexBuffer.PositionKind)!;
      const corners = 1 + (rng() < 0.35 ? 1 : 0);
      for (let c = 0; c < corners; c++) {
        const sx = rng() < 0.5 ? -1 : 1; const sz = rng() < 0.5 ? -1 : 1;
        const cx = 0.025 + rng() * 0.03; const cz = 0.03 + rng() * Math.min(0.06, pd * 0.3);
        for (let k = 0; k < pos.length; k += 3) {
          if (pos[k] * sx > pw / 2 - 1e-4 && pos[k + 2] * sz > pd / 2 - 1e-4) {
            pos[k] -= sx * cx; pos[k + 2] -= sz * cz;
          }
        }
      }
      p.updateVerticesData(VertexBuffer.PositionKind, pos, false, false);
      const nor: number[] = [];
      VertexData.ComputeNormals(pos, p.getIndices()!, nor);
      p.updateVerticesData(VertexBuffer.NormalKind, nor, false, false);
    }
    p.position.set((rng() - 0.5) * 0.04, -0.07, -length / 2 + step * (i + 0.5));
    p.rotation.y = (rng() - 0.5) * 0.02;
    // tones: mostly alternating, with a seeded odd one out so the pattern never repeats exactly
    const tone = rng() < 0.25 ? Math.floor(rng() * toneCount) : i % toneCount;
    toneParts[tone].push(p);
  }
  const planks: Mesh[] = [];
  toneParts.forEach((parts, t) => { if (parts.length) planks.push(merge(n(`plank${t}`), parts, toneMats[t], root)); });
  freeze(...planks);

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
  const bandCount = Math.max(2, Math.floor(length / (1.1 + rng() * 0.7)));
  scatter(band, root, bandCount * 2, (m, i) => {
    const sx = i % 2 === 0 ? -1 : 1;
    const k = Math.floor(i / 2);
    m.position.set(sx * (w / 2 - 0.12), -0.3, -length / 2 + 0.5 + (k / Math.max(1, bandCount - 1)) * (length - 1));
  });

  // posts: at both ends and every ~3 m; ropes sag between them (deck never sags)
  const spans = Math.max(1, Math.round(length / postSpacing));
  const postZ: number[] = [];
  for (let i = 0; i <= spans; i++) postZ.push(-length / 2 + 0.25 + (i / spans) * (length - 0.5));
  const railY = 0.95;
  const postParts: Mesh[] = [];
  const capParts: Mesh[] = [];
  const glassParts: Mesh[] = [];
  const ropeParts: Mesh[] = [];
  const casters: Mesh[] = [...planks, beams];
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.1);
    for (let i = 0; i < postZ.length; i++) {
      const end = i === 0 || i === postZ.length - 1;
      const h = (end ? 1.25 : 1.05) + (rng() - 0.5) * 0.08;
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
      const sag = Math.min(ropeSag * (0.9 + rng() * 0.2), span * 0.2);
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
  const overlayed = [...planks, beams, posts, ropes];
  const dark = new Color3(0.03, 0.08, 0.12);
  let submerged = 0;
  function setSubmerged(k: number) {
    const v = Math.max(0, Math.min(1, k));
    if (Math.abs(v - submerged) < 0.004) return;
    submerged = v;
    for (const m of overlayed) {
      m.renderOverlay = v > 0.01;
      m.overlayColor = dark;
      m.overlayAlpha = v * 0.6;
    }
  }
  root.metadata = { variant: { planks: count, tones: toneCount, chipped, postSpacing: +postSpacing.toFixed(2), ropeSag: +ropeSag.toFixed(2) } };
  return { root, casters, receivers: planks, setSubmerged, dispose: disposeRoot(root) };
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
      // per-instance: height 0.85..1.25, 3..5 canopy clusters with varied radii, lean 0..6 degrees
      const hs = 0.85 + rng() * 0.4;
      const leanRad = (rng() * 6 * Math.PI) / 180;
      const leanDir = rng() * Math.PI * 2;
      const lean = new TransformNode(n('lean'), scene);
      lean.parent = root;
      lean.rotation.set(Math.cos(leanDir) * leanRad, 0, Math.sin(leanDir) * leanRad);
      // trunk: tapered, bent a little, bark noise
      const h = (1.6 + 0.5 * v) * hs;
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
      trunk.parent = lean;
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
        const cy = topY + (0.5 + rng() * 0.7 + (i === 0 ? 0.35 : 0)) * (0.8 + 0.2 * hs);
        const tip = new Vector3(cx, cy, cz);
        branchParts.push(segment(n(`br${i}`), new Vector3(0, topY - 0.3, 0), tip, 0.08, scene, 5));
        const ember = CreateSphere(n(`tip${i}`), { diameter: 0.12, segments: 5 }, scene);
        ember.position.copyFrom(tip);
        tipParts.push(ember);
        const sphere = CreateSphere(n(`c${i}`), { diameter: (0.85 + rng() * 1.0) * (i === 0 ? 1.15 : 1), segments: 10 }, scene);
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
      const branches = merge(n('branches'), branchParts, gm.trunk, lean);
      const tips = merge(n('tips'), tipParts, gm.emberTip, lean);
      const light = merge(n('canopyA'), lightParts, gm.leaves, lean);
      const cards = merge(n('cards'), cardParts, gm.leafCard, lean);
      const dark = darkParts.length ? merge(n('canopyB'), darkParts, gm.leavesDark, lean) : null;
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
      // three silhouettes: squat boulder, standing stone, stacked slabs (all one rock draw call + a chip)
      const shape = Math.floor(rng() * 3);
      let rock: Mesh;
      if (shape === 1) {
        rock = CreateIcoSphere(n('rock'), { radius: 0.62, subdivisions: 2, flat: true }, scene);
        displaceByNoise(rock, 0.16, 1.9, nseed);
        rock.scaling.set(0.75 + 0.15 * v, 1.65 + rng() * 0.35, 0.6);
        rock.rotation.set((rng() - 0.5) * 0.18, v * Math.PI * 2, (rng() - 0.5) * 0.18);
        rock.position.y = 0.75;
        rock.material = gm.rock;
        rock.parent = root;
      } else if (shape === 2) {
        const slabs: Mesh[] = [];
        const layers = 2 + Math.floor(rng() * 2);
        let y = 0;
        for (let k = 0; k < layers; k++) {
          const rad = 0.75 - k * 0.18 + rng() * 0.08;
          const slab = CreateIcoSphere(n(`slab${k}`), { radius: rad, subdivisions: 1, flat: true }, scene);
          displaceByNoise(slab, 0.08, 2.4, nseed + k);
          const th = 0.32 + rng() * 0.1;
          slab.scaling.set(1, th, 0.8 + rng() * 0.2);
          slab.position.set((rng() - 0.5) * 0.25, y + rad * th * 0.8, (rng() - 0.5) * 0.25);
          slab.rotation.set((rng() - 0.5) * 0.15, rng() * Math.PI, (rng() - 0.5) * 0.15);
          y += rad * th * 1.5;
          slabs.push(slab);
        }
        rock = merge(n('rock'), slabs, gm.rock, root);
      } else {
        rock = CreateIcoSphere(n('rock'), { radius: 0.8, subdivisions: 2, flat: true }, scene);
        displaceByNoise(rock, 0.2, 1.6, nseed);
        rock.scaling.set(1, 0.5 + rng() * 0.2, 0.85 + 0.2 * v);
        rock.rotation.set(0.15 * v, v * Math.PI * 2, 0.1);
        rock.position.y = 0.3;
        rock.material = gm.rock;
        rock.parent = root;
      }
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
      // per-instance: post height 1.2..1.8 m, glow tint one of three glass variants
      const ph = 1.2 + rng() * 0.6;
      const glassMat = [gm.lanternGlass, gm.lanternGlassB, gm.lanternGlassC][Math.floor(rng() * 3)];
      const post = CreateCylinder(n('post'), { height: ph, diameterBottom: 0.14, diameterTop: 0.1, tessellation: 8 }, scene);
      post.position.y = ph / 2;
      const arm = CreateBox(n('arm'), { width: 0.08, height: 0.06, depth: 0.5 }, scene);
      arm.position.set(0, ph, 0.2);
      const foot = CreateCylinder(n('foot'), { height: 0.08, diameter: 0.36, tessellation: 10 }, scene);
      foot.position.y = 0.04;
      const frame = merge(n('frame'), [post, arm, foot], gm.lanternPost, root);
      const glass = CreateBox(n('glass'), { width: 0.26, height: 0.34, depth: 0.26 }, scene);
      glass.material = glassMat;
      glass.position.set(0, ph - 0.22, 0.4);
      glass.parent = root;
      const halo = CreateSphere(n('halo'), { diameter: 1.0, segments: 8 }, scene);
      halo.material = gm.halo;
      halo.position.set(0, ph - 0.22, 0.4);
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
    case 'tower': {
      // stacked tapered stone drums, a crenellated top and a band of glowing arrow slits
      const R = DECORATION_RADIUS.tower;
      const drums: Mesh[] = [];
      let y = 0;
      // per-instance: 2..4 drums of varied height
      const drumCount = 2 + Math.floor(rng() * 3);
      const heights: number[] = [];
      for (let i = 0; i < drumCount; i++) heights.push((1.35 - i * 0.08) * (0.85 + rng() * 0.3));
      const stepIn = drumCount === 4 ? 0.24 : 0.3;
      let lastDb = R * 2;
      for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        const db = (R * 2 - i * stepIn) * (i === 0 ? 1 : 0.92);
        lastDb = db;
        const drum = CreateCylinder(n(`drum${i}`), { height: h, diameterBottom: db, diameterTop: db - 0.22, tessellation: 18, subdivisions: 3 }, scene);
        displaceByNoise(drum, 0.025, 3, nseed + i);
        drum.position.y = y + h / 2;
        drums.push(drum);
        // a course ledge between drums
        const ledge = CreateCylinder(n(`ledge${i}`), { height: 0.12, diameter: db + 0.08, tessellation: 18 }, scene);
        ledge.position.y = y + h;
        drums.push(ledge);
        y += h;
      }
      const topD = lastDb - 0.14;
      const merlons = 8;
      for (let i = 0; i < merlons; i++) {
        const a = (i / merlons) * Math.PI * 2;
        const m = CreateBox(n(`merlon${i}`), { width: 0.34, height: 0.4, depth: 0.26 }, scene);
        m.position.set(Math.cos(a) * (topD / 2 - 0.1), y + 0.2, Math.sin(a) * (topD / 2 - 0.1));
        m.rotation.y = -a;
        drums.push(m);
      }
      const tower = merge(n('tower'), drums, gm.towerStone, root);
      const slitY = heights[0] + heights[1] * 0.5;
      const slits = CreateCylinder(n('slits'), { height: 0.5, diameter: R * 2 - stepIn + 0.02, tessellation: 18 }, scene);
      slits.material = gm.towerWindow;
      slits.position.y = slitY;
      slits.parent = root;
      const halo = CreateSphere(n('halo'), { diameter: 2.2, segments: 8 }, scene);
      halo.material = gm.halo;
      halo.position.y = slitY;
      halo.scaling.y = 0.35;
      halo.parent = root;
      casters.push(tower);
      freeze(tower, slits, halo);
      break;
    }
    case 'ruin': {
      // broken columns of different heights, a fallen lintel and moss creeping over the bases
      const parts: Mesh[] = [];
      const mossParts: Mesh[] = [];
      // per-instance: 3 or 4 columns, each either intact (with a capital) or broken at a seeded height
      const slots = [[-0.6, -0.4], [0.65, -0.45], [0.1, 0.6], [-0.55, 0.5]] as const;
      const colCount = 3 + (rng() < 0.4 ? 1 : 0);
      const broken: boolean[] = [];
      for (let i = 0; i < colCount; i++) broken.push(rng() < 0.65);
      if (broken.every((b) => !b)) broken[Math.floor(rng() * colCount)] = true;
      for (let i = 0; i < colCount; i++) {
        const cx = slots[i][0] + (rng() - 0.5) * 0.15; const cz = slots[i][1] + (rng() - 0.5) * 0.15;
        const h = broken[i] ? 0.4 + rng() * 1.5 : 1.95 + rng() * 0.35;
        const base = CreateBox(n(`rb${i}`), { width: 0.7, height: 0.16, depth: 0.7 }, scene);
        base.position.set(cx, 0.08, cz);
        parts.push(base);
        const shaft = CreateCylinder(n(`rs${i}`), { height: h, diameterBottom: 0.5, diameterTop: 0.44, tessellation: 12, subdivisions: 4 }, scene);
        displaceByNoise(shaft, 0.03, 4, nseed + i);
        if (broken[i]) {
          // jagged break: push the top ring vertices up and down
          const pp = shaft.getVerticesData(VertexBuffer.PositionKind)!;
          for (let k = 0; k < pp.length; k += 3) if (pp[k + 1] > h / 2 - 0.01) pp[k + 1] += (rng() - 0.5) * 0.3;
          shaft.updateVerticesData(VertexBuffer.PositionKind, pp, false, false);
        } else {
          const capital = CreateBox(n(`rc${i}`), { width: 0.66, height: 0.16, depth: 0.66 }, scene);
          capital.position.set(cx, 0.16 + h + 0.08, cz);
          capital.rotation.y = rng() * 0.3;
          parts.push(capital);
        }
        shaft.position.set(cx, 0.16 + h / 2, cz);
        shaft.rotation.set((rng() - 0.5) * 0.06, rng() * Math.PI, (rng() - 0.5) * 0.06);
        parts.push(shaft);
        const moss = CreateSphere(n(`moss${i}`), { diameter: 0.9, segments: 6 }, scene);
        moss.position.set(cx + 0.15, 0.1, cz - 0.1);
        moss.scaling.set(1, 0.3, 0.8);
        mossParts.push(moss);
      }
      const lintel = CreateBox(n('lintel'), { width: 1.9, height: 0.34, depth: 0.42 }, scene);
      displaceByNoise(lintel, 0.02, 3, nseed + 9);
      lintel.position.set(0.1, 0.3, 0.1);
      lintel.rotation.set(0.12, 0.5 + v, 0.18);
      parts.push(lintel);
      for (let k = 0; k < 4; k++) {
        const chunk = CreateIcoSphere(n(`chunk${k}`), { radius: 0.14 + rng() * 0.12, subdivisions: 1, flat: true }, scene);
        chunk.position.set((rng() - 0.5) * 1.8, 0.08, (rng() - 0.5) * 1.8);
        chunk.scaling.y = 0.6;
        parts.push(chunk);
      }
      const ruin = merge(n('ruin'), parts, gm.stone, root);
      const mossM = merge(n('mossM'), mossParts, gm.moss, root);
      casters.push(ruin);
      freeze(ruin, mossM);
      break;
    }
    case 'crystal': {
      // a cluster of emissive shards growing out of a rock base, tinted per biome by the crystal material
      const shards: Mesh[] = [];
      // per-instance: 4..8 shards, hue from one of three crystal variants
      const count = 4 + Math.floor(rng() * 5);
      const crystalMat = [gm.crystal, gm.crystalB, gm.crystalC][Math.floor(rng() * 3)];
      for (let i = 0; i < count; i++) {
        const h = 0.7 + rng() * 1.1 * (i === 0 ? 1.3 : 1);
        const d = 0.18 + rng() * 0.16;
        const shard = CreateCylinder(n(`shard${i}`), { height: h, diameterBottom: d, diameterTop: 0.02, tessellation: 6 }, scene);
        const a = rng() * Math.PI * 2;
        const spread = i === 0 ? 0 : 0.12 + rng() * 0.35;
        shard.position.set(Math.cos(a) * spread, h / 2 - 0.1, Math.sin(a) * spread);
        shard.rotation.set(Math.cos(a) * (i === 0 ? 0.05 : 0.25 + rng() * 0.3), rng() * Math.PI, Math.sin(a) * (i === 0 ? 0.05 : 0.25 + rng() * 0.3));
        shards.push(shard);
      }
      const cluster = merge(n('cluster'), shards, crystalMat, root);
      const base = CreateIcoSphere(n('base'), { radius: 0.5, subdivisions: 2, flat: true }, scene);
      displaceByNoise(base, 0.1, 3, nseed);
      base.material = gm.rock;
      base.scaling.set(1.1, 0.45, 1.1);
      base.position.y = 0.05;
      base.parent = root;
      const halo = CreateSphere(n('halo'), { diameter: 1.8, segments: 8 }, scene);
      halo.material = gm.halo;
      halo.position.y = 0.7;
      halo.parent = root;
      casters.push(cluster);
      freeze(cluster, base, halo);
      break;
    }
    case 'mushroom': {
      // one tall cap with spots and two small ones; the cap glows softly at night
      const stems: Mesh[] = [];
      const caps: Mesh[] = [];
      const gills: Mesh[] = [];
      // per-instance: 2..4 caps around the tall one
      const capCount = 2 + Math.floor(rng() * 3);
      const specs: [number, number, number][] = [[0, 0, 0.9 + rng() * 0.2]];
      const a0 = rng() * Math.PI * 2;
      for (let i = 1; i < capCount; i++) {
        const a = a0 + (i / (capCount - 1)) * Math.PI * 1.6 + (rng() - 0.5) * 0.5;
        const d = 0.36 + rng() * 0.16;
        specs.push([Math.cos(a) * d, Math.sin(a) * d, 0.32 + rng() * 0.28]);
      }
      for (let i = 0; i < specs.length; i++) {
        const [sx, sz, k] = specs[i];
        const h = 0.9 * k + 0.1;
        const stem = CreateCylinder(n(`stem${i}`), { height: h, diameterBottom: 0.3 * k + 0.06, diameterTop: 0.22 * k + 0.04, tessellation: 10, subdivisions: 3 }, scene);
        displaceByNoise(stem, 0.01, 4, nseed + i);
        stem.position.set(sx, h / 2, sz);
        stem.rotation.set((rng() - 0.5) * 0.2, 0, (rng() - 0.5) * 0.2);
        stems.push(stem);
        const cap = CreateSphere(n(`cap${i}`), { diameter: 0.9 * k + 0.15, segments: 12, slice: 0.55 }, scene);
        cap.position.set(sx, h - 0.05, sz);
        cap.scaling.y = 0.7;
        caps.push(cap);
        const gill = CreateDisc(n(`gill${i}`), { radius: (0.9 * k + 0.15) / 2, tessellation: 16 }, scene);
        gill.rotation.x = Math.PI / 2;
        gill.position.set(sx, h - 0.06, sz);
        gills.push(gill);
      }
      const stemM = merge(n('stems'), stems, gm.mushroomStem, root);
      const capM = merge(n('caps'), caps, gm.mushroomCap, root);
      const gillM = merge(n('gills'), gills, gm.mushroomStem, root);
      const halo = CreateSphere(n('halo'), { diameter: 1.5, segments: 8 }, scene);
      halo.material = gm.halo;
      halo.position.y = 0.95;
      halo.parent = root;
      halo.visibility = 0;
      casters.push(capM, stemM);
      freeze(stemM, capM, gillM, halo);
      extra.push(gm.onTheme((_v, w) => { halo.visibility = w.night; }));
      break;
    }
    case 'statue': {
      // two-step plinth and a stylised hooded figure, hands folded, head bowed
      const parts: Mesh[] = [];
      const p1 = CreateBox(n('p1'), { width: 1.3, height: 0.26, depth: 1.3 }, scene);
      p1.position.y = 0.13;
      const p2 = CreateBox(n('p2'), { width: 0.95, height: 0.3, depth: 0.95 }, scene);
      p2.position.y = 0.41;
      parts.push(p1, p2);
      const robe = CreateCylinder(n('robe'), { height: 1.5, diameterBottom: 0.8, diameterTop: 0.42, tessellation: 14, subdivisions: 4 }, scene);
      displaceByNoise(robe, 0.02, 5, nseed);
      robe.position.y = 0.56 + 0.75;
      parts.push(robe);
      const shoulders = CreateSphere(n('shoulders'), { diameter: 0.6, segments: 10 }, scene);
      shoulders.position.y = 2.02;
      shoulders.scaling.set(1.1, 0.6, 0.9);
      parts.push(shoulders);
      // per-instance: hooded (head bowed) or crowned (head raised, a ring of points)
      const crowned = rng() < 0.5;
      const head = CreateSphere(n('head'), { diameter: 0.3, segments: 10 }, scene);
      head.position.set(0, crowned ? 2.3 : 2.24, crowned ? 0.02 : 0.06);
      parts.push(head);
      if (crowned) {
        const band = CreateTorus(n('crownBand'), { diameter: 0.29, thickness: 0.05, tessellation: 16 }, scene);
        band.position.set(0, 2.42, 0.02);
        parts.push(band);
        const points = 5 + Math.floor(rng() * 3);
        for (let k = 0; k < points; k++) {
          const a = (k / points) * Math.PI * 2;
          const pt = CreateCylinder(n(`crownPt${k}`), { height: 0.12, diameterBottom: 0.05, diameterTop: 0, tessellation: 4 }, scene);
          pt.position.set(Math.cos(a) * 0.145, 2.49, 0.02 + Math.sin(a) * 0.145);
          parts.push(pt);
        }
      } else {
        const hood = CreateCylinder(n('hood'), { height: 0.5, diameterBottom: 0.5, diameterTop: 0.08, tessellation: 12 }, scene);
        displaceByNoise(hood, 0.015, 5, nseed + 3);
        hood.position.set(0, 2.42, -0.04);
        hood.rotation.x = -0.35;
        parts.push(hood);
      }
      for (const sx of [-1, 1]) {
        const arm = segment(n(`arm${sx}`), new Vector3(sx * 0.3, 1.95, 0.05), new Vector3(sx * 0.08, 1.45, 0.26), 0.13, scene, 8);
        parts.push(arm);
      }
      const hands = CreateSphere(n('hands'), { diameter: 0.22, segments: 8 }, scene);
      hands.position.set(0, 1.42, 0.28);
      parts.push(hands);
      const statue = merge(n('statue'), parts, gm.statueStone, root);
      casters.push(statue);
      freeze(statue);
      break;
    }
  }
  return { root, casters, receivers: [], dispose: disposeRoot(root, extra) };
}

// ---------------------------------------------------------------- relics

export type RelicBuilt = Built & {
  gem: Mesh; baseY: number; phase: number;
  /** -1 dims the relic (not the current checkpoint), 0 is normal, 1 marks it as the next checkpoint (halo + beam). */
  setEmphasis: (e: -1 | 0 | 1) => void;
  animate: (now: number, dtMs: number) => void;
};

export function buildRelic(scene: Scene, _mats: Materials, relic: Relic, pos: { x: number; z: number }): RelicBuilt {
  const gm = geoMaterials(scene);
  const n = (s: string) => `relic:${relic.id}:${s}`;
  const root = new TransformNode(`relic:${relic.id}`, scene);
  root.position.set(pos.x, 0, pos.z);
  const index = Math.floor(hash01(relic.id, 77) * 5);
  const rm = gm.relicMaterials(index);
  const baseY = 1.2;
  // per-instance: gem cut (octahedron, 8 facets, or dodecahedron, 12) and pedestal style (round, square, octagonal)
  const vrng = mulberry32(variantSeed(relic.id, 71, pos.x, pos.z));
  const gemType = vrng() < 0.5 ? 1 : 2;
  const pedestalStyle = Math.floor(vrng() * 3);
  // crystal: a translucent outer shell with a bright emissive core inside, plus a faint halo
  const gem = CreatePolyhedron(n('gem'), { type: gemType, size: gemType === 1 ? 0.55 : 0.42 }, scene);
  if (gemType === 1) gem.scaling.y = 1.12 + vrng() * 0.25;
  gem.material = rm.shell;
  gem.position.y = baseY;
  gem.parent = root;
  const core = CreatePolyhedron(n('core'), { type: gemType, size: gemType === 1 ? 0.3 : 0.24 }, scene);
  core.material = rm.core;
  core.parent = gem;
  core.isPickable = false;
  const halo = CreateSphere(n('halo'), { diameter: 2.0, segments: 12 }, scene);
  halo.material = rm.halo;
  halo.parent = gem;
  halo.isPickable = false;
  // vertical light beam for the checkpoint race: a tall additive cylinder, hidden until emphasised
  const beamMat = gm.beam.clone(n('beamMat'));
  beamMat.emissiveColor = rm.color.clone();
  beamMat.alpha = 0;
  const beam = CreateCylinder(n('beam'), { height: 16, diameterBottom: 0.9, diameterTop: 1.6, tessellation: 16 }, scene);
  beam.material = beamMat;
  beam.position.y = 8;
  beam.parent = root;
  beam.isPickable = false;
  beam.setEnabled(false);
  // stone pedestal with a carved rim and a soft light pool on top
  let pedestal: Mesh;
  if (pedestalStyle === 1) {
    // square, two steps
    const s1 = CreateBox(n('ped1'), { width: 1.15, height: 0.14, depth: 1.15 }, scene);
    s1.position.y = 0.07;
    const s2 = CreateBox(n('ped2'), { width: 0.92, height: 0.12, depth: 0.92 }, scene);
    s2.position.y = 0.2;
    s2.rotation.y = vrng() < 0.5 ? 0 : Math.PI / 4;
    pedestal = merge(n('pedestal'), [s1, s2], gm.stoneDark, root);
  } else if (pedestalStyle === 2) {
    // octagonal drum with a flared foot
    const foot = CreateCylinder(n('pedFoot'), { height: 0.08, diameter: 1.2, tessellation: 8 }, scene);
    foot.position.y = 0.04;
    const drum = CreateCylinder(n('pedDrum'), { height: 0.18, diameterBottom: 1.0, diameterTop: 0.92, tessellation: 8 }, scene);
    drum.position.y = 0.17;
    pedestal = merge(n('pedestal'), [foot, drum], gm.stoneDark, root);
    pedestal.rotation.y = vrng() * Math.PI;
  } else {
    pedestal = CreateCylinder(n('pedestal'), { height: 0.26, diameterBottom: 1.1, diameterTop: 0.9, tessellation: 18 }, scene);
    displaceByNoise(pedestal, 0.012, 5, 311);
    pedestal.material = gm.stoneDark;
    pedestal.position.y = 0.13;
    pedestal.parent = root;
  }
  const ring = CreateTorus(n('ring'), { diameter: pedestalStyle === 1 ? 0.86 : 1.0, thickness: pedestalStyle === 2 ? 0.05 : 0.08, tessellation: pedestalStyle === 2 ? 8 : 24 }, scene);
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
  let emphasis: -1 | 0 | 1 = 0;
  let emph = 0; // smoothed -1..1
  const baseRate = ps.emitRate;
  function setEmphasis(e: -1 | 0 | 1) { emphasis = e; if (e > 0) beam.setEnabled(true); }
  function animate(now: number, dtMs: number) {
    const k = Math.min(1, dtMs / 350);
    emph += (emphasis - emph) * k;
    const up = Math.max(0, emph);
    const down = Math.max(0, -emph);
    // slow breath (about 0.23 Hz) under 10 % amplitude, never a flashing pulse
    const pulse = 0.5 + 0.5 * Math.sin(now / 700);
    const hs = 1 + up * (0.6 + 0.12 * pulse);
    halo.scaling.setAll(hs);
    const vis = 1 - 0.55 * down;
    gem.visibility = vis; core.visibility = vis; pool.visibility = vis;
    halo.visibility = 1 - 0.8 * down;
    ps.emitRate = baseRate * (1 - 0.8 * down) * (1 + 1.5 * up);
    beamMat.alpha = up * (0.08 + 0.012 * pulse);
    if (up < 0.01 && beam.isEnabled()) beam.setEnabled(false);
    else if (up >= 0.01) { beam.rotation.y += dtMs * 0.0004; }
  }
  return {
    root, gem, baseY, phase: hash01(relic.id) * Math.PI * 2, casters: [gem], receivers: [], setEmphasis, animate,
    dispose: disposeRoot(root, [() => { scene.onBeforeRenderObservable.remove(obs); ps.dispose(false); beamMat.dispose(); }]),
  };
}

// ---------------------------------------------------------------- gate

export type HoldArc = { color: string; frac: number };
export type GateBuilt = Built & {
  setUnlocked: (unlocked: boolean) => void;
  animate: (now: number, dtMs: number) => void;
  /** King of the hill: a glowing ring on the ground around the trigger that fills with per-player arcs. null hides it. */
  setHold: (arcs: HoldArc[] | null) => void;
};

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

  // hold ring (king of the hill): a ground disc with a DynamicTexture ring, redrawn only when the arcs change
  const RING_PX = 256;
  let ringTex: DynamicTexture | null = null;
  let ringMesh: Mesh | null = null;
  let ringMat: StandardMaterial | null = null;
  let ringKey = '';
  function drawRing(arcs: HoldArc[]) {
    if (!ringTex) {
      ringTex = new DynamicTexture(n('holdTex'), { width: RING_PX, height: RING_PX }, scene, false);
      ringTex.hasAlpha = true;
      ringMat = new StandardMaterial(n('holdMat'), scene);
      ringMat.diffuseTexture = ringTex;
      ringMat.opacityTexture = ringTex;
      ringMat.emissiveTexture = ringTex;
      ringMat.emissiveColor = new Color3(1, 1, 1);
      ringMat.disableLighting = true;
      ringMat.backFaceCulling = false;
      const rad = GEOMETRY.gateTriggerRadius + 0.45;
      ringMesh = CreateDisc(n('holdRing'), { radius: rad, tessellation: 48 }, scene);
      ringMesh.material = ringMat;
      ringMesh.rotation.x = Math.PI / 2;
      ringMesh.position.y = 0.035;
      ringMesh.parent = root;
      ringMesh.isPickable = false;
    }
    const ctx = ringTex.getContext() as CanvasRenderingContext2D;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, RING_PX, RING_PX);
    const cx = RING_PX / 2; const cy = RING_PX / 2;
    const rOuter = RING_PX * 0.47; const rInner = RING_PX * 0.37;
    const rMid = (rOuter + rInner) / 2; const w = rOuter - rInner;
    ctx.lineCap = 'butt';
    ctx.lineWidth = w;
    ctx.strokeStyle = 'rgba(255, 245, 220, 0.22)';
    ctx.beginPath(); ctx.arc(cx, cy, rMid, 0, Math.PI * 2); ctx.stroke();
    // per-player arcs grow from opposite sides so two players never overdraw each other
    const nArcs = Math.max(1, arcs.length);
    arcs.forEach((a, i) => {
      const start = -Math.PI / 2 + (i / nArcs) * Math.PI * 2;
      const span = Math.max(0, Math.min(1, a.frac)) * (Math.PI * 2) / nArcs;
      if (span <= 0.001) return;
      ctx.strokeStyle = /^#[0-9a-fA-F]{6}$/.test(a.color) ? a.color : '#ffd27f';
      ctx.lineWidth = w * 0.8;
      ctx.beginPath(); ctx.arc(cx, cy, rMid, start, start + span); ctx.stroke();
    });
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 240, 200, 0.5)';
    ctx.beginPath(); ctx.arc(cx, cy, rOuter, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, rInner, 0, Math.PI * 2); ctx.stroke();
    ringTex.update(false);
  }
  function setHold(arcs: HoldArc[] | null) {
    if (!arcs) { ringMesh?.setEnabled(false); ringKey = ''; return; }
    const key = arcs.map((a) => `${a.color}:${Math.round(Math.max(0, Math.min(1, a.frac)) * 96)}`).join('|');
    if (key === ringKey && ringMesh) { ringMesh.setEnabled(true); return; }
    ringKey = key;
    drawRing(arcs);
    ringMesh?.setEnabled(true);
  }

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
    // ambient breath only: about 0.2 Hz and under 10 % amplitude; a locked gate keeps a dim amber ember as the focal accent
    const targetIntensity = unlocked ? 0.9 + 0.07 * Math.sin(now / 800) : 0.3;
    light.intensity += (targetIntensity - light.intensity) * k;
    const targetCone = unlocked ? 0.14 + 0.012 * Math.sin(now / 900) : 0;
    coneAlpha += (targetCone - coneAlpha) * k;
    coneMat.alpha = coneAlpha;
    const targetGlow = unlocked ? 0.88 + 0.07 * Math.sin(now / 850) : 0.32;
    glow += (targetGlow - glow) * k;
    // warm emissive runes (the rune glow mask is the emissive texture) on the shared gate stone
    stone.emissiveColor.copyFrom(warm).scaleInPlace(glow);
    stone.emissiveIntensity = 1.4;
    embers.visibility = Math.max(gm.volcanic(), unlocked ? glow : 0);
    if (!unlocked && coneAlpha < 0.005 && cone.isEnabled()) { cone.setEnabled(false); keyCore.setEnabled(false); }
    if (unlocked) keystone.rotation.y += dtMs * 0.0012;
  }
  return {
    root, casters, receivers: [], setUnlocked, animate, setHold,
    dispose: disposeRoot(root, [() => light.dispose(), () => { for (const f of flames) f.dispose(false); }, () => coneMat.dispose(), () => { stone.emissiveColor.set(0, 0, 0); }, () => { ringTex?.dispose(); ringMat?.dispose(); }]),
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
  /**
   * Walk bob, lean, arm swing, cape sway, falling tumble; speed in m/s, called every frame by index.ts.
   * `view` (optional) carries the sprint / slow / emote flags of the latest tick.
   */
  animate: (nowMs: number, speed: number, facingDeg: number, status: PlayerView['status'], view?: Pick<PlayerView, 'sprinting' | 'slow' | 'emote'> | null) => void;
  dispose: () => void;
};

export function buildPlayer(scene: Scene, _mats: Materials, p: PlayerView): PlayerBuilt {
  const gm = geoMaterials(scene);
  const n = (s: string) => `player:${p.id}:${s}`;
  const root = new TransformNode(`player:${p.id}`, scene);
  const pm = gm.playerMaterials(p.color);
  const parts: Mesh[] = [];
  const casters: Mesh[] = [];
  // rig: a pivot at the feet for lean/tumble; `upper` (pelvis up) bounces with the stride, legs hang from the rig
  const rig = new TransformNode(n('rig'), scene);
  rig.parent = root;
  const hipY = 0.96;
  const shoulderY = 1.58;
  const upper = new TransformNode(n('upper'), scene);
  upper.position.y = hipY;
  upper.parent = rig;

  // torso: belted tunic (slot colour cloth), shoulder pads, leather belt with a metal buckle (static merges)
  const tunic = CreateCapsule(n('tunic'), { height: 0.78, radius: 0.27, tessellation: 14, subdivisions: 2, capSubdivisions: 5 }, scene);
  tunic.position.y = 0.33;
  tunic.scaling.set(1, 1, 0.78);
  const padParts: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const pad = CreateSphere(n(`pad${sx}`), { diameter: 0.3, segments: 8 }, scene);
    pad.position.set(sx * 0.3, shoulderY - hipY - 0.02, 0);
    pad.scaling.set(1, 0.6, 0.85);
    padParts.push(pad);
  }
  const skirt = CreateCylinder(n('skirt'), { height: 0.34, diameterBottom: 0.66, diameterTop: 0.54, tessellation: 14 }, scene);
  skirt.position.y = 0.02;
  const cloth = merge(n('cloth'), [tunic, ...padParts, skirt], pm.body, upper);
  parts.push(cloth); casters.push(cloth);
  const belt = CreateCylinder(n('belt'), { height: 0.09, diameter: 0.6, tessellation: 14 }, scene);
  belt.position.y = 0.2;
  const strap = CreateBox(n('strap'), { width: 0.1, height: 0.5, depth: 0.03 }, scene);
  strap.position.set(0.12, 0.42, -0.24);
  strap.rotation.z = 0.25;
  const leather = merge(n('leather'), [belt, strap], gm.leather, upper);
  parts.push(leather);
  const buckle = CreateBox(n('buckle'), { width: 0.12, height: 0.1, depth: 0.04 }, scene);
  buckle.material = gm.trim;
  buckle.position.set(0, 0.2, 0.3);
  buckle.parent = upper;
  parts.push(buckle);

  // head: neck pivot so it can turn into the direction of travel; hood (slot 0) or crown + jewel (slot 1)
  const neck = new TransformNode(n('neck'), scene);
  neck.position.set(0, shoulderY - hipY + 0.06, 0.02);
  neck.parent = upper;
  const head = CreateSphere(n('head'), { diameter: 0.4, segments: 12 }, scene);
  head.material = gm.skin;
  head.position.y = 0.22;
  head.parent = neck;
  parts.push(head); casters.push(head);
  if (p.slot === 0) {
    const hood = CreateCylinder(n('hood'), { height: 0.56, diameterBottom: 0.56, diameterTop: 0.08, tessellation: 12 }, scene);
    displaceByNoise(hood, 0.02, 5, 17);
    hood.material = gm.hood;
    hood.position.set(0, 0.34, -0.05);
    hood.rotation.x = -0.28;
    hood.parent = neck;
    parts.push(hood);
  } else {
    const crown = CreateTorus(n('crown'), { diameter: 0.4, thickness: 0.06, tessellation: 20 }, scene);
    crown.material = gm.crown;
    crown.position.y = 0.38;
    crown.parent = neck;
    parts.push(crown);
    const jewel = CreatePolyhedron(n('jewel'), { type: 1, size: 0.06 }, scene);
    jewel.material = gm.relicMaterials(0).core;
    jewel.position.set(0, 0.4, 0.2);
    jewel.parent = neck;
    parts.push(jewel);
  }

  // arms: shoulder -> upper arm -> elbow -> lower arm + hand
  type Arm = { shoulder: TransformNode; elbow: TransformNode };
  const arms: Arm[] = [];
  for (const sx of [-1, 1]) {
    const shoulder = new TransformNode(n(`shoulder${sx}`), scene);
    shoulder.position.set(sx * 0.34, shoulderY - hipY - 0.04, 0);
    shoulder.parent = upper;
    const upperArm = CreateCylinder(n(`uarm${sx}`), { height: 0.34, diameterTop: 0.15, diameterBottom: 0.12, tessellation: 8 }, scene);
    upperArm.material = pm.body;
    upperArm.position.y = -0.17;
    upperArm.parent = shoulder;
    const elbow = new TransformNode(n(`elbow${sx}`), scene);
    elbow.position.y = -0.34;
    elbow.parent = shoulder;
    const lowerArm = CreateCylinder(n(`larm${sx}`), { height: 0.32, diameterTop: 0.12, diameterBottom: 0.1, tessellation: 8 }, scene);
    lowerArm.material = gm.leggings;
    lowerArm.position.y = -0.16;
    lowerArm.parent = elbow;
    const hand = CreateSphere(n(`hand${sx}`), { diameter: 0.14, segments: 6 }, scene);
    hand.material = gm.skin;
    hand.position.y = -0.35;
    hand.parent = elbow;
    arms.push({ shoulder, elbow });
    parts.push(upperArm, lowerArm, hand);
  }

  // legs: hip -> upper leg -> knee -> lower leg + boot
  type Leg = { hip: TransformNode; knee: TransformNode };
  const legs: Leg[] = [];
  for (const sx of [-1, 1]) {
    const hip = new TransformNode(n(`hip${sx}`), scene);
    hip.position.set(sx * 0.15, hipY, 0);
    hip.parent = rig;
    const thigh = CreateCylinder(n(`thigh${sx}`), { height: 0.42, diameterTop: 0.2, diameterBottom: 0.16, tessellation: 8 }, scene);
    thigh.material = gm.leggings;
    thigh.position.y = -0.21;
    thigh.parent = hip;
    const knee = new TransformNode(n(`knee${sx}`), scene);
    knee.position.y = -0.42;
    knee.parent = hip;
    const shin = CreateCylinder(n(`shin${sx}`), { height: 0.4, diameterTop: 0.16, diameterBottom: 0.13, tessellation: 8 }, scene);
    shin.material = gm.leggings;
    shin.position.y = -0.2;
    shin.parent = knee;
    const boot = CreateBox(n(`boot${sx}`), { width: 0.2, height: 0.14, depth: 0.32 }, scene);
    boot.material = gm.leather;
    boot.position.set(0, -0.47, 0.05);
    boot.parent = knee;
    legs.push({ hip, knee });
    parts.push(thigh, shin, boot);
    casters.push(thigh);
  }

  // cloak: a short strip of chained segments hanging from the shoulders (-Z is behind: facing is +Z locally)
  const CLOAK_SEGS = 4;
  const cloakSeg = 0.3;
  const cloakPivots: TransformNode[] = [];
  let cloakParent: TransformNode = upper;
  for (let i = 0; i < CLOAK_SEGS; i++) {
    const pivot = new TransformNode(n(`cloak${i}`), scene);
    pivot.position.set(0, i === 0 ? shoulderY - hipY : -cloakSeg, i === 0 ? -0.24 : 0);
    pivot.parent = cloakParent;
    const seg = CreatePlane(n(`cloakSeg${i}`), { width: 0.72 - i * 0.04, height: cloakSeg + 0.02 }, scene);
    seg.material = pm.cape;
    seg.position.y = -cloakSeg / 2;
    seg.parent = pivot;
    parts.push(seg);
    cloakPivots.push(pivot);
    cloakParent = pivot;
  }

  // darker base ring and a soft drop shadow blob
  const R = GEOMETRY.playerRadius * 0.95;
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
  let smoothRatio = 0;
  let settleT = -1;      // ms since the stop-settle started, -1 when idle
  let lastFacing = 0;
  let headYaw = 0;
  let lastStatus: PlayerView['status'] = p.status;
  let statusAt = 0;
  const cloakAngles = new Array<number>(CLOAK_SEGS).fill(0);
  let wave = 0; // smoothed 0..1
  function animate(nowMs: number, speed: number, facingDeg: number, status: PlayerView['status'], view?: Pick<PlayerView, 'sprinting' | 'slow' | 'emote'> | null) {
    const dt = lastNow > 0 ? Math.min(100, Math.max(0, nowMs - lastNow)) : 16;
    lastNow = nowMs;
    if (status !== lastStatus) { lastStatus = status; statusAt = nowMs; }
    const sprinting = !!view?.sprinting;
    const slow = !!view?.slow && !sprinting;
    wave += ((view?.emote === 'wave' && status === 'active' ? 1 : 0) - wave) * Math.min(1, dt / 140);
    // interpolated ground speed drives everything; worlds with a high movement speed run past ratio 1.
    // sprinting pushes the cycle and lean further, slow mode takes short careful steps
    const rawRatio = Math.max(0, Math.min(1.7, (Number.isFinite(speed) ? speed : 0) / GEOMETRY.playerSpeed));
    const ratio = sprinting ? Math.min(1.9, rawRatio * 1.15) : slow ? Math.min(0.5, rawRatio) : rawRatio;
    const prevRatio = smoothRatio;
    smoothRatio += (ratio - smoothRatio) * Math.min(1, dt / 90);
    if (prevRatio > 0.3 && smoothRatio < 0.12 && settleT < 0) settleT = 0;
    if (settleT >= 0) { settleT += dt; if (settleT > 420) settleT = -1; }
    const stride = (Math.min(1, smoothRatio) + 0.4 * Math.max(0, smoothRatio - 1)) * (slow ? 0.55 : 1);
    const moving = Math.min(1, smoothRatio * 4);

    if (Number.isFinite(facingDeg)) {
      root.rotation.y = (facingDeg * Math.PI) / 180;
      // the head leads into turns: it looks toward where the facing is heading, then relaxes
      const turn = shortestDeg(lastFacing, facingDeg);
      lastFacing = facingDeg;
      const targetYaw = Math.max(-0.7, Math.min(0.7, (turn / Math.max(1, dt)) * 25)) * moving;
      headYaw += (targetYaw - headYaw) * Math.min(1, dt / 160);
    }
    phase += dt * 0.0105 * (0.25 + smoothRatio) * (sprinting ? 1.2 : slow ? 1.3 : 1);
    const swing = Math.sin(phase);
    const cos = Math.cos(phase);
    const targetLean = status === 'falling' ? 0 : (0.12 * smoothRatio + 0.1 * Math.max(0, smoothRatio - 1)) * (sprinting ? 1.35 : slow ? 0.5 : 1);
    lean += (targetLean - lean) * Math.min(1, dt / 120);

    // bounce: two beats per cycle, scaled by stride, plus idle breathing and the stop-settle dip
    const breathe = 0.012 * Math.sin(nowMs / 650) * (1 - moving);
    const settle = settleT >= 0 ? -0.05 * Math.sin((settleT / 420) * Math.PI) * Math.exp(-settleT / 300) : 0;
    const bounce = Math.abs(swing) * 0.07 * stride + breathe + settle + (status === 'respawning' ? 0.04 * Math.sin(nowMs / 90) : 0);
    upper.position.y = hipY + bounce;
    upper.scaling.y = 1 + 0.015 * Math.sin(nowMs / 650) * (1 - moving);
    neck.rotation.y = headYaw;
    neck.rotation.x = 0.06 * smoothRatio;

    if (status === 'falling') {
      tumble += dt * 0.004;
      rig.rotation.x = tumble;
      rig.rotation.z = Math.sin(tumble * 0.7) * 0.4;
      // limbs spread
      for (let i = 0; i < 2; i++) {
        const sx = i === 0 ? -1 : 1;
        arms[i].shoulder.rotation.z = sx * 1.3; arms[i].shoulder.rotation.x = -0.6; arms[i].elbow.rotation.x = -0.3;
        legs[i].hip.rotation.x = -0.5 + 0.3 * i; legs[i].hip.rotation.z = sx * 0.35; legs[i].knee.rotation.x = 0.4;
      }
    } else {
      tumble = 0;
      rig.rotation.x = lean;
      rig.rotation.z = Math.sin(phase * 0.5) * 0.03 * smoothRatio;
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? swing : -swing;
        const c = i === 0 ? cos : -cos;
        // legs: hip swing with a knee bend during the forward swing (foot lifts clear of the deck)
        legs[i].hip.rotation.x = -s * 0.62 * stride;
        legs[i].hip.rotation.z = 0;
        legs[i].knee.rotation.x = Math.max(0, c) * 0.95 * stride + 0.04;
        // arms: counter-swing to the same-side leg, elbow bent more as the run gets faster
        arms[i].shoulder.rotation.x = s * 0.6 * stride;
        arms[i].shoulder.rotation.z = (i === 0 ? -1 : 1) * (0.12 + 0.08 * moving);
        arms[i].elbow.rotation.x = -(0.25 + 0.55 * Math.min(1.3, smoothRatio) + Math.max(0, -s) * 0.3 * stride);
      }
      if (wave > 0.01) {
        // wave: the right arm rises over the shoulder and the forearm swings side to side
        const a = arms[1];
        a.shoulder.rotation.x = a.shoulder.rotation.x * (1 - wave) + (-2.6) * wave;
        a.shoulder.rotation.z = a.shoulder.rotation.z * (1 - wave) + 0.35 * wave;
        a.elbow.rotation.x = a.elbow.rotation.x * (1 - wave) + (-0.5) * wave;
        a.elbow.rotation.z = Math.sin(nowMs / 110) * 0.55 * wave;
      } else if (arms[1].elbow.rotation.z !== 0) {
        arms[1].elbow.rotation.z = 0;
      }
    }
    // cloak: segments trail behind with speed and sway with the stride (chained, so angles accumulate)
    const trail = 0.2 + 0.55 * Math.min(1.3, smoothRatio);
    for (let i = 0; i < CLOAK_SEGS; i++) {
      const target = -(i === 0 ? trail : 0.18 * trail) - 0.05 * Math.sin(phase * 0.5 + i * 0.9) * (0.3 + smoothRatio);
      cloakAngles[i] += (target - cloakAngles[i]) * Math.min(1, dt / (120 + i * 60));
      cloakPivots[i].rotation.x = cloakAngles[i];
      cloakPivots[i].rotation.z = Math.sin(phase * 0.5 + i * 0.6) * 0.06 * smoothRatio;
    }
    // respawn: scale in from the ground over the respawn window
    if (status === 'respawning') {
      const f = Math.min(1, (nowMs - statusAt) / GEOMETRY.respawnDurationMs);
      const e = 1 - (1 - f) * (1 - f);
      rig.scaling.set(0.35 + 0.65 * e, 0.2 + 0.8 * e, 0.35 + 0.65 * e);
    } else if (rig.scaling.x !== 1) {
      rig.scaling.setAll(1);
    }
  }
  animate(0, 0, 0, p.status);

  return {
    root, parts, label, casters, setLabel, setVisibility, animate,
    dispose: () => { label.dispose(false, true); tex.dispose(); labelMat.dispose(); root.dispose(false, true); },
  };
}

function shortestDeg(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// ---------------------------------------------------------------- team beacons (markers)

export type MarkerPool = {
  /** Show a beacon at (x, 0, z) in `color` until `untilMs` (local performance.now() clock). */
  spawn: (x: number, z: number, color: string, untilMs: number) => void;
  update: (now: number) => void;
  dispose: () => void;
};

/** A small pool of beacons: a thin vertical light column plus a pulsing ground ring, faded out at `until`. */
export function createMarkerPool(scene: Scene, size = 6): MarkerPool {
  const gm = geoMaterials(scene);
  type Beacon = { root: TransformNode; column: Mesh; ring: Mesh; mat: PBRMaterial; ringMat: PBRMaterial; start: number; until: number; active: boolean };
  const pool: Beacon[] = [];
  for (let i = 0; i < size; i++) {
    const root = new TransformNode(`marker:${i}`, scene);
    const mat = gm.beam.clone(`marker:${i}:mat`);
    mat.alpha = 0;
    const column = CreateCylinder(`marker:${i}:col`, { height: 12, diameterBottom: 0.35, diameterTop: 0.7, tessellation: 12 }, scene);
    column.material = mat;
    column.position.y = 6;
    column.parent = root;
    column.isPickable = false;
    const ringMat = gm.holdRing.clone(`marker:${i}:ring`);
    ringMat.alpha = 0;
    const ring = CreateTorus(`marker:${i}:torus`, { diameter: 1.6, thickness: 0.12, tessellation: 32 }, scene);
    ring.material = ringMat;
    ring.position.y = 0.06;
    ring.parent = root;
    ring.isPickable = false;
    root.setEnabled(false);
    pool.push({ root, column, ring, mat, ringMat, start: 0, until: 0, active: false });
  }
  function spawn(x: number, z: number, color: string, untilMs: number) {
    const now = performance.now();
    let b = pool.find((p) => !p.active) ?? pool.reduce((a, p) => (p.until < a.until ? p : a), pool[0]);
    let col: Color3;
    try { col = Color3.FromHexString(/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#ffd27f'); } catch { col = Color3.FromHexString('#ffd27f'); }
    b.mat.emissiveColor.copyFrom(col);
    b.mat.albedoColor.copyFrom(col);
    b.ringMat.emissiveColor.copyFrom(col);
    b.ringMat.albedoColor.copyFrom(col);
    b.root.position.set(x, 0, z);
    b.start = now;
    b.until = Math.max(now + 400, untilMs);
    b.active = true;
    b.root.setEnabled(true);
  }
  function update(now: number) {
    for (const b of pool) {
      if (!b.active) continue;
      if (now >= b.until) { b.active = false; b.root.setEnabled(false); continue; }
      const life = b.until - b.start;
      const fadeIn = Math.min(1, (now - b.start) / 250);
      const fadeOut = Math.min(1, (b.until - now) / Math.min(900, life * 0.4));
      const k = fadeIn * fadeOut;
      const pulse = 0.5 + 0.5 * Math.sin(now / 600);
      b.mat.alpha = k * (0.12 + 0.012 * pulse);
      b.ringMat.alpha = k * (0.55 + 0.05 * pulse);
      const rs = 1 + 0.08 * pulse;
      b.ring.scaling.set(rs, 1, rs);
      b.column.rotation.y += 0.01;
    }
  }
  function dispose() {
    for (const b of pool) { b.mat.dispose(); b.ringMat.dispose(); b.root.dispose(false, true); }
  }
  return { spawn, update, dispose };
}
