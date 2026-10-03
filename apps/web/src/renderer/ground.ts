// Ground terrain ('ground' worlds): one continuous landmass instead of floating islands. Zones are plateaus flat
// at Y = 0 over the whole logical disc, crossings are flat roads at Y = 0 over the whole logical rectangle, and the
// land between them sits 0 to -2.5 m lower with gentle hills. Everything is procedural and seeded by the world
// seed, so a rebuild with the same zones gives the same land. Only the heightfield and the vegetation depend on
// the zone layout; roads are built per crossing id (index.ts diffs them like bridges).
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateIcoSphere } from '@babylonjs/core/Meshes/Builders/icoSphereBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { WORLD_LIMITS } from '@beetle/contracts';
import type { Bridge, Decoration, WorldSpec } from '@beetle/contracts';
import type { Materials } from './materials.ts';
import { buildDecoration, type Built, type BridgeBuilt } from './builders.ts';
import { displaceByNoise, hashString, mulberry32 } from './terrain.ts';
import { geoMaterials } from './geometry-materials.ts';

const H = WORLD_LIMITS.bounds.halfExtent; // 60: the walkable bounds are 120 x 120 m
const SEGMENTS = 96;
const ZONE_FLAT = 0.8;    // flat band outside every zone radius
const ROAD_FLAT = 0.6;    // flat band outside every crossing half width
const BLEND = 1.8;        // falloff from the flat band to the natural land
const MAX_DEPTH = 2.5;

type Biome = WorldSpec['biome'];
type RGB = [number, number, number];
type BiomeLook = { grass: RGB; grassAlt: RGB; earth: RGB; rock: RGB; ember?: RGB; edging: boolean; road: 'path' | 'stone' };
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
const LOOKS: Record<Biome, BiomeLook> = {
  garden: { grass: hex('#6fae4f'), grassAlt: hex('#8fbf5a'), earth: hex('#7a5f3e'), rock: hex('#8a8a80'), edging: false, road: 'path' },
  desert: { grass: hex('#e0c48a'), grassAlt: hex('#d6a85e'), earth: hex('#b8793e'), rock: hex('#9c6a3c'), edging: true, road: 'stone' },
  frost: { grass: hex('#eef3f6'), grassAlt: hex('#d8e2ea'), earth: hex('#9aa6b0'), rock: hex('#6c7682'), edging: true, road: 'stone' },
  night: { grass: hex('#2c4a34'), grassAlt: hex('#3a5a3a'), earth: hex('#2e2a26'), rock: hex('#454a52'), edging: false, road: 'path' },
  volcanic: { grass: hex('#5a5550'), grassAlt: hex('#6e6660'), earth: hex('#3a3430'), rock: hex('#26221f'), ember: hex('#ff6a1e'), edging: true, road: 'stone' },
};
export function groundLook(biome: string | undefined): BiomeLook { return LOOKS[(biome as Biome) in LOOKS ? (biome as Biome) : 'garden']; }

// ---------------------------------------------------------------- noise (2-D value noise, seeded)

function hash2(ix: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iz * 668265263 + seed * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x); const iz = Math.floor(z);
  const fx = x - ix; const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx); const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed); const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed); const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
function fbm2(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0; let amp = 0.5; let f = 1; let norm = 0;
  for (let o = 0; o < octaves; o++) { sum += noise2(x * f, z * f, seed + o * 131) * amp; norm += amp; amp *= 0.5; f *= 2.03; }
  return sum / norm;
}
const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- walkable shapes

type Zone = { x: number; z: number; r: number };
type Road = { ax: number; az: number; dx: number; dz: number; len: number; hw: number };
function shapesOf(spec: WorldSpec): { zones: Zone[]; roads: Road[] } {
  const zones = spec.islands.map((i) => ({ x: i.center.x, z: i.center.z, r: i.radius }));
  const roads = spec.bridges.map((b) => {
    const [a, c] = b.endpoints;
    const dx = c.point.x - a.point.x; const dz = c.point.z - a.point.z;
    const len = Math.max(1e-3, Math.hypot(dx, dz));
    return { ax: a.point.x, az: a.point.z, dx: dx / len, dz: dz / len, len, hw: b.width / 2 };
  });
  return { zones, roads };
}
/** Signed distance outside the walkable area (<= 0 inside a zone disc or a crossing rectangle), minus the flat bands. */
function walkDistance(x: number, z: number, zones: Zone[], roads: Road[]): number {
  let d = Infinity;
  for (const zn of zones) d = Math.min(d, Math.hypot(x - zn.x, z - zn.z) - zn.r - ZONE_FLAT);
  for (const r of roads) {
    const px = x - r.ax; const pz = z - r.az;
    const t = px * r.dx + pz * r.dz;
    const along = t < 0 ? -t : t > r.len ? t - r.len : 0;
    const perp = Math.abs(px * r.dz - pz * r.dx) - r.hw - ROAD_FLAT;
    d = Math.min(d, along > 0 ? Math.hypot(along, Math.max(0, perp)) + Math.min(0, perp) : perp);
  }
  return d;
}

export type GroundField = { height: (x: number, z: number) => number; walk: (x: number, z: number) => number };
export function groundField(spec: WorldSpec): GroundField {
  const { zones, roads } = shapesOf(spec);
  const seed = (spec.seed >>> 0) % 100000;
  function natural(x: number, z: number): number {
    const base = fbm2(x * 0.028, z * 0.028, seed, 4);
    const hills = fbm2(x * 0.075 + 17.3, z * 0.075 - 4.1, seed + 77, 3);
    let h = -0.35 - 2.15 * Math.pow(base, 1.15) + (hills - 0.5) * 0.9;
    h = Math.max(-MAX_DEPTH, Math.min(-0.15, h));
    // beyond the bounds the land rises into a ring of hills that closes the horizon
    const edge = Math.max(Math.abs(x), Math.abs(z));
    if (edge > H - 6) h += smoothstep(H - 6, H + 60, edge) * (5 + 9 * fbm2(x * 0.02, z * 0.02, seed + 9, 3));
    return h;
  }
  const walk = (x: number, z: number) => walkDistance(x, z, zones, roads);
  function height(x: number, z: number): number {
    const d = walk(x, z);
    if (d <= 0) return 0;
    return natural(x, z) * smoothstep(0, BLEND, d);
  }
  return { height, walk };
}

// ---------------------------------------------------------------- heightfield + edging + vegetation

export type GroundBuilt = Built;

function gridCoords(): number[] {
  const out: number[] = [-H - 110, -H - 70, -H - 40, -H - 20, -H - 8];
  for (let i = 0; i <= SEGMENTS; i++) out.push(-H + (2 * H * i) / SEGMENTS);
  out.push(H + 8, H + 20, H + 40, H + 70, H + 110);
  return out;
}

let groundMat: PBRMaterial | null = null;
let groundMatScene: Scene | null = null;
function groundMaterial(scene: Scene, look: BiomeLook): PBRMaterial {
  if (!groundMat || groundMatScene !== scene || groundMat.getScene() !== scene) {
    const gm = geoMaterials(scene);
    const m = new PBRMaterial('ground:land', scene);
    m.albedoColor = Color3.White();
    m.metallic = 0;
    m.roughness = 0.96;
    m.environmentIntensity = 0.7;
    const bump = gm.tex.soilNormal.clone() as Texture;
    bump.uScale = 60; bump.vScale = 60;
    m.bumpTexture = bump;
    m.bumpTexture.level = 0.35;
    const cracks = gm.tex.cracks.clone() as Texture;
    cracks.uScale = 14; cracks.vScale = 14;
    m.emissiveTexture = cracks;
    groundMat = m; groundMatScene = scene;
  }
  const e = look.ember;
  groundMat.emissiveColor = e ? new Color3(e[0] * 0.9, e[1] * 0.9, e[2] * 0.9) : Color3.Black();
  groundMat.emissiveIntensity = e ? 1.2 : 0;
  return groundMat;
}

const VEG_KINDS: { type: Decoration['type']; weight: number }[] = [
  { type: 'tree', weight: 0.45 }, { type: 'bush', weight: 0.35 }, { type: 'rock', weight: 0.2 },
];

/** Instance one built decoration template at many placements (instances of each template mesh, one draw call per source). */
function instanceTemplate(scene: Scene, template: Built, parent: TransformNode, placements: { x: number; y: number; z: number; yaw: number; s: number }[], tag: string): Mesh[] {
  const root = template.root;
  root.computeWorldMatrix(true);
  const rootInv = root.getWorldMatrix().clone().invert();
  const parts: { src: Mesh; rel: Matrix }[] = [];
  for (const c of root.getChildMeshes(false)) {
    c.computeWorldMatrix(true);
    const rel = c.getWorldMatrix().multiply(rootInv);
    if (c instanceof InstancedMesh) parts.push({ src: c.sourceMesh, rel });
    else if (c instanceof Mesh && c.getTotalVertices() > 0) parts.push({ src: c, rel });
  }
  const srcs = new Set<Mesh>();
  const sc = new Vector3(); const q = new Quaternion(); const tr = new Vector3();
  placements.forEach((p, i) => {
    const node = new TransformNode(`${tag}:${i}`, scene);
    node.parent = parent;
    node.position.set(p.x, p.y, p.z);
    node.rotation.y = p.yaw;
    node.scaling.setAll(p.s);
    for (const part of parts) {
      const inst = part.src.createInstance(`${part.src.name}:g${i}`);
      part.rel.decompose(sc, q, tr);
      inst.parent = node;
      inst.position.copyFrom(tr);
      inst.rotationQuaternion = q.clone();
      inst.scaling.copyFrom(sc);
      inst.isPickable = false;
      inst.computeWorldMatrix(true);
      inst.freezeWorldMatrix();
      srcs.add(part.src);
    }
  });
  // the template itself stays at the origin, hidden under the land
  root.position.y = -40;
  root.setEnabled(true);
  return [...srcs];
}

export function buildGround(scene: Scene, mats: Materials, spec: WorldSpec): GroundBuilt {
  const look = groundLook(spec.biome);
  const field = groundField(spec);
  const seed = (spec.seed >>> 0) % 100000;
  const root = new TransformNode('ground', scene);
  const extra: (() => void)[] = [];

  // ---- heightfield: one mesh, uniform 96 x 96 inside the bounds plus a coarse outer ring of hills ----
  const xs = gridCoords();
  const N = xs.length;
  const positions = new Float32Array(N * N * 3);
  const colors = new Float32Array(N * N * 4);
  const uvs = new Float32Array(N * N * 2);
  const heights = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = xs[i]; const z = xs[j];
      const k = j * N + i;
      const y = field.height(x, z);
      heights[k] = y;
      positions[k * 3] = x; positions[k * 3 + 1] = y; positions[k * 3 + 2] = z;
      uvs[k * 2] = (x + H) / (2 * H); uvs[k * 2 + 1] = (z + H) / (2 * H);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i; const b = a + 1; const c = a + N; const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const normals = new Float32Array(N * N * 3);
  VertexData.ComputeNormals(positions, indices, normals);
  // colours by slope, depth and biome noise; a subtle per-vertex normal perturbation breaks up the shading
  for (let k = 0; k < N * N; k++) {
    const x = positions[k * 3]; const z = positions[k * 3 + 2]; const y = heights[k];
    let nx = normals[k * 3]; let ny = normals[k * 3 + 1]; let nz = normals[k * 3 + 2];
    nx += (noise2(x * 0.9, z * 0.9, seed + 5) - 0.5) * 0.12;
    nz += (noise2(x * 0.9 + 3.1, z * 0.9, seed + 6) - 0.5) * 0.12;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    normals[k * 3] = nx; normals[k * 3 + 1] = ny; normals[k * 3 + 2] = nz;
    const slope = 1 - ny;
    const patch = fbm2(x * 0.08, z * 0.08, seed + 31, 3);
    const fine = noise2(x * 0.6, z * 0.6, seed + 41);
    const g = look.grass; const ga = look.grassAlt; const e = look.earth; const r = look.rock;
    const ta = smoothstep(0.35, 0.7, patch);
    let cr = g[0] + (ga[0] - g[0]) * ta; let cg = g[1] + (ga[1] - g[1]) * ta; let cb = g[2] + (ga[2] - g[2]) * ta;
    // earth in the low ground and on moderate slopes, rock on steep plateau flanks
    const earth = Math.max(smoothstep(0.08, 0.3, slope), smoothstep(-1.4, -2.4, y) * 0.6) * (0.75 + 0.25 * fine);
    cr += (e[0] - cr) * earth; cg += (e[1] - cg) * earth; cb += (e[2] - cb) * earth;
    const rock = smoothstep(0.32, 0.55, slope);
    cr += (r[0] - cr) * rock; cg += (r[1] - cg) * rock; cb += (r[2] - cb) * rock;
    const v = 0.88 + 0.24 * fine;
    colors[k * 4] = cr * v; colors[k * 4 + 1] = cg * v; colors[k * 4 + 2] = cb * v; colors[k * 4 + 3] = 1;
  }
  const vd = new VertexData();
  vd.positions = positions; vd.indices = indices; vd.normals = normals; vd.colors = colors; vd.uvs = uvs;
  const land = new Mesh('ground:land', scene);
  vd.applyToMesh(land, false);
  land.material = groundMaterial(scene, look);
  land.parent = root;
  land.receiveShadows = true;
  land.isPickable = false;
  land.freezeWorldMatrix();

  const gm = geoMaterials(scene);
  const casters: Mesh[] = [];
  const rng = mulberry32(hashString(`ground:${spec.worldId}`, seed));

  // ---- zone rims: low stone edging (some biomes), skipped where a crossing meets the zone ----
  if (look.edging) {
    const stone = CreateIcoSphere('ground:edge', { radius: 0.22, subdivisions: 1, flat: true }, scene);
    displaceByNoise(stone, 0.05, 3, seed + 3);
    stone.material = gm.stoneDark;
    stone.parent = root;
    stone.isPickable = false;
    const spots: { x: number; z: number; a: number }[] = [];
    for (const zn of spec.islands) {
      const rr = zn.radius + 0.35;
      const count = Math.min(90, Math.ceil((2 * Math.PI * rr) / 0.55));
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rng() * 0.04;
        const x = zn.center.x + Math.cos(a) * rr; const z = zn.center.z + Math.sin(a) * rr;
        // keep the crossings open: any point inside a crossing rectangle (plus margin) gets no stone
        if (crossingHit(spec, x, z, 0.5)) continue;
        if (insideOtherZone(spec, zn.id, x, z)) continue;
        spots.push({ x, z, a });
      }
    }
    spots.slice(0, 600).forEach((p, i) => {
      const m = i === 0 ? stone : stone.createInstance(`ground:edge:${i}`);
      m.parent = root;
      m.position.set(p.x, 0.02, p.z);
      m.rotation.y = p.a + rng();
      const s = 0.8 + rng() * 0.6;
      m.scaling.set(s, 0.55 + rng() * 0.3, s * (0.8 + rng() * 0.3));
      m.isPickable = false;
      m.freezeWorldMatrix();
    });
    if (spots.length === 0) stone.setEnabled(false);
  }

  // ---- vegetation: 60..120 instances of tree, bush and rock templates, never on a plateau or a road ----
  const target = 60 + Math.floor(rng() * 61);
  const byType = new Map<Decoration['type'], { x: number; y: number; z: number; yaw: number; s: number }[]>();
  let placed = 0;
  for (let tries = 0; tries < target * 30 && placed < target; tries++) {
    const x = (rng() * 2 - 1) * (H + 18);
    const z = (rng() * 2 - 1) * (H + 18);
    if (field.walk(x, z) < 1.6) continue;
    // clump: prefer the denser parts of a seeded density field
    if (fbm2(x * 0.05, z * 0.05, seed + 99, 2) < 0.38 + rng() * 0.2) continue;
    let u = rng(); let type: Decoration['type'] = 'tree';
    for (const k of VEG_KINDS) { if (u < k.weight) { type = k.type; break; } u -= k.weight; }
    const y = field.height(x, z) - 0.08;
    const list = byType.get(type) ?? [];
    list.push({ x, y, z, yaw: rng() * Math.PI * 2, s: type === 'tree' ? 0.9 + rng() * 0.7 : 0.8 + rng() * 0.6 });
    byType.set(type, list);
    placed++;
  }
  for (const [type, list] of byType) {
    // two template variants per kind keep silhouettes varied without per-instance meshes
    const halves = [list.filter((_, i) => i % 2 === 0), list.filter((_, i) => i % 2 === 1)];
    halves.forEach((pl, vi) => {
      if (pl.length === 0) return;
      const deco: Decoration = { id: `veg-${type}-${vi}`, type, supportingSurfaceId: spec.islands[0]?.id ?? 'ground', localPosition: { x: 0, z: 0 }, rotationDeg: 0, scale: 1 };
      const tpl = buildDecoration(scene, mats, deco, { x: 0, z: 0 }, spec.seed + vi);
      tpl.root.parent = root;
      const srcs = instanceTemplate(scene, tpl, root, pl, `ground:veg:${type}:${vi}`);
      for (const c of tpl.casters) if (srcs.includes(c)) casters.push(c);
      extra.push(() => tpl.dispose());
    });
  }

  root.metadata = { ground: { vegetation: placed, segments: SEGMENTS } };
  return {
    root, casters, receivers: [land],
    dispose: () => { for (const fn of extra) { try { fn(); } catch { /* ignore */ } } root.dispose(false, false); },
  };
}

function crossingHit(spec: WorldSpec, x: number, z: number, margin: number): boolean {
  for (const b of spec.bridges) {
    const [a, c] = b.endpoints;
    const dx = c.point.x - a.point.x; const dz = c.point.z - a.point.z;
    const len = Math.max(1e-3, Math.hypot(dx, dz));
    const px = x - a.point.x; const pz = z - a.point.z;
    const t = (px * dx + pz * dz) / len;
    const perp = Math.abs(px * dz - pz * dx) / len;
    if (t > -margin && t < len + margin && perp < b.width / 2 + margin) return true;
  }
  return false;
}
function insideOtherZone(spec: WorldSpec, id: string, x: number, z: number): boolean {
  return spec.islands.some((i) => i.id !== id && Math.hypot(x - i.center.x, z - i.center.z) < i.radius + 0.2);
}

// ---------------------------------------------------------------- roads (one per crossing id)

let roadMats: { path: PBRMaterial; stone: PBRMaterial } | null = null;
function roadMaterial(scene: Scene, kind: 'path' | 'stone', look: BiomeLook): PBRMaterial {
  if (!roadMats || roadMats.path.getScene() !== scene) {
    const gm = geoMaterials(scene);
    const path = new PBRMaterial('ground:path', scene);
    path.metallic = 0; path.roughness = 0.97;
    const pb = gm.tex.soilNormal.clone() as Texture; pb.uScale = 2; pb.vScale = 8; path.bumpTexture = pb;
    const stone = new PBRMaterial('ground:road', scene);
    stone.metallic = 0; stone.roughness = 0.88;
    const sa = gm.tex.stoneAlbedo.clone() as Texture; sa.uScale = 1.5; sa.vScale = 6; stone.albedoTexture = sa;
    const sb = gm.tex.stoneNormal.clone() as Texture; sb.uScale = 1.5; sb.vScale = 6; stone.bumpTexture = sb;
    roadMats = { path, stone };
  }
  const m = roadMats[kind];
  const base = kind === 'path' ? look.earth : look.rock;
  const lift = kind === 'path' ? 1.25 : 1.6;
  m.albedoColor = new Color3(Math.min(1, base[0] * lift), Math.min(1, base[1] * lift), Math.min(1, base[2] * lift));
  return m;
}

/** A crossing as a worn path or stone road: flat, 0.05 m proud of Y = 0, small stones along both edges. */
export function buildRoad(scene: Scene, _mats: Materials, bridge: Bridge, biome: string | undefined): BridgeBuilt {
  const look = groundLook(biome);
  const gm = geoMaterials(scene);
  const [a, b] = bridge.endpoints;
  const dx = b.point.x - a.point.x; const dz = b.point.z - a.point.z;
  const length = Math.max(0.5, Math.hypot(dx, dz));
  const w = bridge.width;
  const root = new TransformNode(`bridge:${bridge.id}`, scene);
  root.position.set((a.point.x + b.point.x) / 2, 0, (a.point.z + b.point.z) / 2);
  root.rotation.y = Math.atan2(dx, dz);
  const deck = CreateBox(`bridge:${bridge.id}:road`, { width: w, depth: length + 0.6, height: 0.3 }, scene);
  deck.position.y = 0.05 - 0.15;
  deck.material = roadMaterial(scene, look.road, look);
  deck.parent = root;
  deck.receiveShadows = true;
  deck.isPickable = false;
  const rng = mulberry32(hashString(bridge.id, 7));
  const stone = CreateIcoSphere(`bridge:${bridge.id}:edge`, { radius: 0.13, subdivisions: 1, flat: true }, scene);
  stone.material = look.road === 'stone' ? gm.stoneDark : gm.pebble;
  stone.parent = root;
  const per = Math.max(2, Math.floor(length / 0.45));
  let k = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < per; i++) {
      const m = k === 0 ? stone : stone.createInstance(`bridge:${bridge.id}:edge:${k}`);
      m.parent = root;
      m.position.set(side * (w / 2 + 0.05) + (rng() - 0.5) * 0.06, 0.04, -length / 2 + (i + 0.5) * (length / per));
      const s = 0.8 + rng() * 0.6;
      m.scaling.set(s, 0.6 + rng() * 0.3, s);
      m.rotation.y = rng() * Math.PI;
      m.isPickable = false;
      k++;
    }
  }
  root.getChildMeshes(false).forEach((m: AbstractMesh) => { m.computeWorldMatrix(true); m.freezeWorldMatrix(); });
  return { root, casters: [], receivers: [deck], setSubmerged: () => { /* nothing to submerge on land */ }, dispose: () => root.dispose(false, false) };
}
