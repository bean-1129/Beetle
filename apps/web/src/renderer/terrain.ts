// Procedural terrain helpers for the world geometry: a seeded PRNG, small noise functions, and the custom
// floating-island body mesh. Everything here is deterministic per object id so rebuilds are stable.
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';
import type { Material } from '@babylonjs/core/Materials/material';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial';

// ---------------------------------------------------------------- PRNG / noise

/** FNV-1a over a string, mixed with a numeric seed. */
export function hashString(s: string, seed = 0): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, good enough for cosmetic scatter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(id: string, salt = 0): () => number {
  return mulberry32(hashString(id, salt));
}

function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number) { return t * t * (3 - 2 * t); }

/** Seeded 3-D value noise in [0, 1], continuous in space (the same position always gives the same value). */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const x0 = Math.floor(x); const y0 = Math.floor(y); const z0 = Math.floor(z);
  const fx = smooth(x - x0); const fy = smooth(y - y0); const fz = smooth(z - z0);
  let acc = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        acc += w * hash3(x0 + dx, y0 + dy, z0 + dz, seed);
      }
    }
  }
  return acc;
}

/** Two octaves of noise3, still in [0, 1]. */
export function fbm3(x: number, y: number, z: number, seed = 0): number {
  return 0.66 * noise3(x, y, z, seed) + 0.34 * noise3(x * 2.1 + 7.3, y * 2.1 + 1.9, z * 2.1 + 4.7, seed + 17);
}

/**
 * A periodic (in angle) noise profile in [0, 1]: a few seeded harmonics so the rim reads as one coherent
 * outline rather than random jitter. Returned function is cheap to evaluate per vertex.
 */
export function makeAngularProfile(rng: () => number, harmonics = 5): (angle: number) => number {
  const waves: { k: number; phase: number; amp: number }[] = [];
  let total = 0;
  for (let i = 0; i < harmonics; i++) {
    const k = 2 + i + Math.floor(rng() * 2);
    const amp = 1 / (1 + i * 0.7);
    waves.push({ k, phase: rng() * Math.PI * 2, amp });
    total += amp;
  }
  return (angle: number) => {
    let v = 0;
    for (const w of waves) v += w.amp * Math.sin(angle * w.k + w.phase);
    return Math.max(0, Math.min(1, 0.5 + 0.5 * (v / total) * 1.35));
  };
}

// ---------------------------------------------------------------- vertex displacement helpers

/** Displace a mesh's vertices along their normals by seeded 3-D noise (position based, so split vertices stay sealed). */
export function displaceByNoise(mesh: Mesh, amount: number, frequency: number, seed: number, flat = false) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const nor = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!pos || !nor) return;
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]; const y = pos[i + 1]; const z = pos[i + 2];
    const n = (fbm3(x * frequency + 11.1, y * frequency + 5.5, z * frequency + 3.3, seed) - 0.5) * 2 * amount;
    out[i] = x + nor[i] * n;
    out[i + 1] = y + nor[i + 1] * n;
    out[i + 2] = z + nor[i + 2] * n;
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, out, false, false);
  const normals = new Float32Array(pos.length);
  const indices = mesh.getIndices();
  if (indices) {
    VertexData.ComputeNormals(out, indices, normals);
    mesh.updateVerticesData(VertexBuffer.NormalKind, normals, false, false);
  }
  if (flat) mesh.convertToFlatShadedMesh();
  mesh.refreshBoundingInfo();
}

// ---------------------------------------------------------------- island body

export type IslandBodyOptions = {
  id: string;
  radius: number;
  thickness: number;
  grass: Material;
  stone: Material;
  /** RGB multipliers for the three top zones and the skirt (vertex colours, multiplied into the albedo). */
  tint: { grass: [number, number, number]; grassAlt: [number, number, number]; path: [number, number, number]; rim: [number, number, number]; skirt: [number, number, number]; tip: [number, number, number] };
  /** Per-instance variation seed (hash of the id and the world); 0 or absent keeps the id-only look. */
  seed?: number;
  /** Skirt silhouette: 0 tapered bulge, 1 terraced ledges, 2 deep spire. Defaults to a seeded pick. */
  skirtProfile?: 0 | 1 | 2;
  /** Width of the pale path ring inside the logical radius (0.5 to 0.8 m; default 0.6). */
  pathWidth?: number;
  /** Moss band on the outer lawn: width as a fraction of the lawn radius (0.1 to 0.3) and darkening strength. */
  moss?: { width: number; strength: number; tint: [number, number, number] };
};

export type IslandBody = {
  mesh: Mesh;
  /** Outer rim radius at a given angle (radians, atan2(z, x)); >= radius + 0.5 and <= radius + 2.0. */
  rimRadius: (angle: number) => number;
  /** Largest rim radius, for placing the crust ring and the under-shadow. */
  maxRim: number;
  segments: number;
};

/**
 * One mesh per island: a flat top disc at Y = 0 (grass inside radius - 0.6, pale path to the logical radius, rough
 * stone from there out to the irregular rim) and a tapered rocky skirt that ends in jagged stalactite tips.
 * Sub-mesh 0 is grass, sub-mesh 1 is stone (MultiMaterial), so an island body is two draw calls.
 */
export function buildIslandBody(scene: Scene, o: IslandBodyOptions): IslandBody {
  const r = o.radius;
  const vseed = (o.seed ?? 0) >>> 0;
  const rng = mulberry32(hashString(o.id, 101 ^ vseed));
  const seed = hashString(o.id, 7 ^ vseed) % 100000;
  const skirtProfile = o.skirtProfile ?? (Math.floor(rng() * 3) as 0 | 1 | 2);
  const profile = makeAngularProfile(rng, 5);
  const segments = Math.max(48, Math.min(96, Math.round(r * 7)));
  const rimRadius = (angle: number) => r + 0.5 + 1.5 * profile(angle);
  let maxRim = r + 0.5;
  for (let i = 0; i < segments; i++) maxRim = Math.max(maxRim, rimRadius((i / segments) * Math.PI * 2));

  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pathInner = Math.max(1, r - Math.max(0.5, Math.min(0.8, o.pathWidth ?? 0.6)));
  const mossW = Math.max(0.1, Math.min(0.3, o.moss?.width ?? 0.18));
  const uvScale = 0.35; // repeats of the detail textures per metre

  const pushVertex = (x: number, y: number, z: number, c: [number, number, number], u?: number, v?: number) => {
    positions.push(x, y, z);
    colors.push(c[0], c[1], c[2], 1);
    uvs.push(u ?? x * uvScale, v ?? z * uvScale);
    return positions.length / 3 - 1;
  };
  const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  // ---- top: shared (smooth) vertices, rings of equal segment count, all at Y = 0 over the logical disc ----
  const ring = (radiusAt: (ang: number, i: number) => number, yAt: (ang: number, i: number) => number, colorAt: (ang: number, i: number) => [number, number, number]) => {
    const start = positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const ang = (i / segments) * Math.PI * 2;
      const rad = radiusAt(ang, i);
      pushVertex(Math.cos(ang) * rad, yAt(ang, i), Math.sin(ang) * rad, colorAt(ang, i));
    }
    return start;
  };
  const quadStrip = (a: number, b: number) => {
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      indices.push(a + i, b + i, b + j);
      indices.push(a + i, b + j, a + j);
    }
  };
  const grassNoise = (x: number, z: number) => fbm3(x * 0.25 + 3, 0.5, z * 0.25 + 9, seed);

  const centre = pushVertex(0, 0, 0, o.tint.grass);
  // lawn rings: two inner rings, one at the inner edge of the moss band, one at the path edge (moss tinted)
  const ringFracs = [0.32, 0.62, 1 - mossW, 1];
  const ringCount = ringFracs.length;
  const grassRings: number[] = [];
  for (let k = 0; k < ringCount; k++) {
    const rad = pathInner * ringFracs[k];
    const outer = k === ringCount - 1;
    grassRings.push(ring(
      () => rad, () => 0,
      (ang) => {
        const g = mix(o.tint.grass, o.tint.grassAlt, grassNoise(Math.cos(ang) * rad, Math.sin(ang) * rad));
        if (!outer || !o.moss) return g;
        const m = o.moss.strength * (0.75 + 0.25 * profile(ang * 5 + 3));
        return mix(g, [g[0] * o.moss.tint[0], g[1] * o.moss.tint[1], g[2] * o.moss.tint[2]], m);
      },
    ));
  }
  // grass fan + strips (sub-mesh 0)
  const grassIndexStart = indices.length;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(centre, grassRings[0] + i, grassRings[0] + j);
  }
  for (let k = 1; k < ringCount; k++) quadStrip(grassRings[k - 1], grassRings[k]);
  const grassIndexCount = indices.length - grassIndexStart;

  // stone (sub-mesh 1): path ring (pathInner -> r), rim ring (r -> rimRadius), then the skirt
  const stoneIndexStart = indices.length;
  const pathInnerRing = ring(() => pathInner, () => 0, () => o.tint.path);
  const pathOuterRing = ring(() => r, () => 0, (ang) => mix(o.tint.path, o.tint.rim, 0.25 + 0.2 * profile(ang * 3)));
  // the overhang outside the logical radius stays flat at Y = 0 until the very edge, which sags a touch
  const rimRing = ring(
    (ang) => rimRadius(ang),
    (ang) => -0.06 - 0.08 * profile(ang * 2 + 1),
    (ang) => mix(o.tint.rim, o.tint.path, 0.3 * profile(ang * 4 + 2)),
  );
  quadStrip(pathInnerRing, pathOuterRing);
  quadStrip(pathOuterRing, rimRing);

  // ---- skirt: flat shaded (unique vertices per triangle) tapered multi-ring with noisy radii and a jagged bottom ----
  const depth = o.thickness * (skirtProfile === 2 ? 2.7 : skirtProfile === 1 ? 2.0 : 2.2);
  type P = { x: number; y: number; z: number; c: [number, number, number]; u: number; v: number };
  const skirtRing = (k: number, levels: number): P[] => {
    const t = k / levels; // 0 at the rim, 1 at the bottom
    const pts: P[] = [];
    for (let i = 0; i < segments; i++) {
      const ang = (i / segments) * Math.PI * 2;
      const rimR = rimRadius(ang);
      let rad: number;
      let y: number;
      if (k === 0) {
        rad = rimR; y = -0.06 - 0.08 * profile(ang * 2 + 1);
      } else {
        // profile 0: slight bulge just under the rim, then draw in toward ~0.35 r at the bottom
        // profile 1: terraced ledges (three shelves, each a short overhang then a steep drop)
        // profile 2: quick pinch into a deep, narrow spire
        let taper: number;
        if (skirtProfile === 1) {
          const steps = 3;
          const f = t * steps;
          const st = Math.floor(Math.min(steps - 1e-6, f));
          const local = f - st;
          taper = 1.02 - 0.22 * st - 0.22 * smooth(Math.min(1, local * 1.6));
        } else if (skirtProfile === 2) {
          taper = 1 - 0.82 * Math.pow(t, 0.62);
        } else {
          taper = t < 0.2 ? 1 + 0.06 * (t / 0.2) : 1.06 - 0.71 * ((t - 0.2) / 0.8);
        }
        const n = fbm3(Math.cos(ang) * 2.2 + 50, t * 5, Math.sin(ang) * 2.2 + 50, seed + 3);
        rad = Math.max(0.8, rimR * taper + (n - 0.5) * (0.9 + 1.6 * t) + (rng() - 0.5) * 0.3 * (1 + t));
        y = -t * depth * (0.8 + 0.4 * n) + (rng() - 0.5) * 0.25 * t;
        if (k === levels) {
          // jagged bottom: every few vertices drop into a stalactite tip
          const every = skirtProfile === 1 ? 4 : skirtProfile === 2 ? 2 : 3;
          const tip = (i % every === 0 ? 1 : 0.15) * (0.6 + 1.4 * rng()) * (skirtProfile === 2 ? 1.3 : 1);
          y -= tip;
        }
      }
      // cliff striation: alternate rings darken a touch, plus a little per-vertex grain
      const band = k % 2 === 0 ? 1 : 0.78;
      const grain = 0.92 + 0.16 * rng();
      const base = k === levels ? o.tint.tip : mix(o.tint.rim, o.tint.skirt, Math.min(1, t * 1.4));
      const c: [number, number, number] = [base[0] * band * grain, base[1] * band * grain, base[2] * band * grain];
      pts.push({ x: Math.cos(ang) * rad, y, z: Math.sin(ang) * rad, c, u: (i / segments) * 12, v: t * 3 });
    }
    return pts;
  };
  const levels = skirtProfile === 1 ? 7 : 6;
  const rings: P[][] = [];
  for (let k = 0; k <= levels; k++) rings.push(skirtRing(k, levels));
  const tri = (a: P, b: P, c: P) => {
    const ia = pushVertex(a.x, a.y, a.z, a.c, a.u, a.v);
    const ib = pushVertex(b.x, b.y, b.z, b.c, b.u, b.v);
    const ic = pushVertex(c.x, c.y, c.z, c.c, c.u, c.v);
    indices.push(ia, ib, ic);
  };
  for (let k = 0; k < levels; k++) {
    const up = rings[k]; const dn = rings[k + 1];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      // outward facing (checked against VertexData.ComputeNormals' winding)
      tri(up[i], dn[i], dn[j]);
      tri(up[i], dn[j], up[j]);
    }
  }
  // bottom: a few deep tips fanning to a central spike
  const bottom = rings[levels];
  const spikeY = -depth - 0.9 - 0.6 * rng();
  const spike: P = { x: (rng() - 0.5) * r * 0.3, y: spikeY, z: (rng() - 0.5) * r * 0.3, c: o.tint.tip, u: 0.5, v: 3.5 };
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    tri(bottom[i], spike, bottom[j]);
  }
  const stoneIndexCount = indices.length - stoneIndexStart;

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  // the flat top must read as flat: force straight-up normals on every vertex at Y = 0 (the shared top rings)
  const topVertexCount = 1 + segments * (ringCount + 3);
  for (let i = 0; i < topVertexCount; i++) {
    normals[i * 3] = 0; normals[i * 3 + 1] = 1; normals[i * 3 + 2] = 0;
  }
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.colors = colors;
  vd.uvs = uvs;
  const mesh = new Mesh(`island:${o.id}:body`, scene);
  vd.applyToMesh(mesh, false);
  mesh.subMeshes = [];
  const vertexCount = positions.length / 3;
  new SubMesh(0, 0, vertexCount, grassIndexStart, grassIndexCount, mesh);
  new SubMesh(1, 0, vertexCount, stoneIndexStart, stoneIndexCount, mesh);
  const multi = new MultiMaterial(`island:${o.id}:multi`, scene);
  multi.subMaterials.push(o.grass, o.stone);
  mesh.material = multi;
  mesh.useVertexColors = true;
  return { mesh, rimRadius, maxRim, segments };
}
