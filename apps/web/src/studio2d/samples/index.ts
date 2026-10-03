// Hand-written sample games, one per genre. They are the engine's regression suite and the
// starting points people see before they describe their own game.
import type { GameSpec, LevelDef, Placement } from "../spec/types.ts";
import { assemble, BACKGROUND } from "../spec/kit.ts";
import { Paint } from "../world/paint.ts";
import { defenseLayout } from "../world/defense.ts";

const P = (def: string, x: number, y: number, params?: Placement["params"]): Placement => (params ? { def, x, y, params } : { def, x, y });

function level(id: string, name: string, paint: Paint, spawn: [number, number], placements: Placement[], extra: Partial<LevelDef> = {}): LevelDef {
  return {
    id,
    name,
    size: [paint.w, paint.h],
    tileSize: 16,
    tileset: "tiles",
    tiles: paint.rows(),
    spawn,
    placements,
    background: BACKGROUND,
    ...extra,
  };
}

export function samplePlatformer(): GameSpec {
  const p = new Paint(64, 15);
  p.ground(0, 14, 12).ground(18, 30, 12).ground(24, 26, 10).rect(20, 8, 22, 8, "=");
  p.ground(37, 50, 12).rect(42, 11, 43, 11, "^").rect(45, 8, 46, 8, "B");
  p.ground(54, 63, 12);
  const l1 = level("glade", "Rainy Glade", p, [2, 11], [
    P("pickup", 8, 10), P("pickup", 21, 7), P("pickup", 33, 8), P("pickup", 46, 10), P("pickup", 57, 10),
    P("walker", 12, 11), P("walker", 47, 11),
    P("platform", 31, 11), P("checkpoint", 38, 11), P("flyer", 40, 7),
    P("npc", 5, 11), P("goal", 61, 11), P("gem", 25, 6),
  ], { music: "music-adventure", beat: "intro", weather: "rain", weatherAmount: 0.6, story: "Collect the glowing seeds before the rain washes them away." });
  const q = new Paint(48, 15);
  q.ground(0, 8, 12).ground(13, 16, 12).ground(21, 24, 10).ground(29, 47, 12).rect(33, 11, 34, 11, "^");
  const l2 = level("hollow", "Hollow Stumps", q, [2, 11], [
    P("pickup", 14, 10), P("pickup", 22, 8), P("pickup", 30, 8),
    P("crumble", 18, 10), P("spring", 27, 11), P("walker", 38, 11), P("walker", 42, 11),
    P("boss", 44, 11), P("goal", 46, 11),
  ], { music: "music-boss", beat: "finale", weather: "leaves", weatherAmount: 0.4 });
  return assemble({ title: "Seedlight", pitch: "A fox collects glowing seeds in a rainy forest.", genre: "platformer", hero: "fox", enemy: "slime", pickup: "seed", setting: "forest", weather: "rain" }, [l1, l2]);
}

export function sampleTopDown(): GameSpec {
  const p = new Paint(40, 24).border("W");
  p.rect(12, 1, 12, 14, "W").rect(12, 18, 12, 22, "W");
  p.rect(26, 8, 38, 8, "W").rect(26, 9, 26, 22, "W").set(26, 15, ".");
  p.rect(4, 17, 8, 19, "~");
  p.rect(16, 4, 18, 5, "~");
  const l1 = level("courtyard", "Moss Courtyard", p, [3, 3], [
    P("pickup", 6, 6), P("pickup", 9, 12), P("pickup", 20, 3), P("pickup", 22, 16), P("pickup", 33, 4),
    P("walker", 18, 12), P("walker", 30, 4), P("flyer", 20, 20),
    P("key", 34, 3), P("door", 26, 15), P("goal", 33, 18), P("heart", 16, 20), P("npc", 6, 3),
  ], { music: "music-adventure", tint: "#1f3d2b" });
  return assemble({ title: "Moss Keep", pitch: "A small knight finds the key to the old portal.", genre: "top-down", hero: "knight", enemy: "beetle", flyer: "wisp", pickup: "gem", setting: "forest" }, [l1]);
}

export function sampleRunner(): GameSpec {
  const p = new Paint(220, 12);
  p.ground(0, 219, 9);
  const gaps = [30, 48, 70, 95, 120, 150, 175];
  for (const g of gaps) p.rect(g, 9, g + 2, 11, ".");
  for (const s of [40, 60, 85, 110, 140, 165, 195]) p.set(s, 8, "^");
  p.rect(100, 6, 104, 6, "=");
  const pickups = [15, 22, 36, 55, 78, 102, 130, 160, 185, 205].map((x) => P("pickup", x, 7));
  const l1 = level("dash", "Canopy Dash", p, [3, 8], [...pickups, P("goal", 214, 8)], { music: "music-adventure" });
  return assemble({ title: "Canopy Dash", pitch: "A squirrel races along the treetops.", genre: "runner", hero: "squirrel", pickup: "acorn", setting: "forest" }, [l1]);
}

export function sampleArena(): GameSpec {
  const p = new Paint(30, 18).border("W");
  p.rect(7, 6, 8, 7, "W").rect(21, 6, 22, 7, "W").rect(7, 11, 8, 12, "W").rect(21, 11, 22, 12, "W");
  const l1 = level("pit", "Star Pit", p, [15, 9], [
    P("spawner", 3, 3, { waves: 3, perWave: 3, every: 1.5 }), P("spawner", 26, 14, { waves: 2, perWave: 3, every: 2, spawn: "flyer" }),
    P("heart", 15, 3),
  ], { music: "music-tense", weather: "embers", weatherAmount: 0.3 });
  return assemble({ title: "Star Pit", pitch: "Hold the arena against waves of space slimes.", genre: "arena", hero: "robot", enemy: "slime", flyer: "drone", setting: "space" }, [l1]);
}

export function samplePuzzle(): GameSpec {
  const a = Paint.from([
    "WWWWWWWWWWWW",
    "W..........W",
    "W..........W",
    "W..........W",
    "W..........W",
    "WWWWW.WWWWWW",
    "W..........W",
    "WWWWWWWWWWWW",
  ]);
  const l1 = level("plate", "The Pressure Plate", a, [2, 4], [P("crate", 3, 2), P("switch", 8, 2), P("door", 5, 5), P("goal", 9, 6)], { music: "music-calm" });
  const b = Paint.from([
    "WWWWWWWWWWWW",
    "W....W.....W",
    "W....W.....W",
    "W..........W",
    "W....W.....W",
    "WWWWWWWW.WWW",
    "W..........W",
    "WWWWWWWWWWWW",
  ]);
  const l2 = level("twin", "Twin Plates", b, [1, 1], [
    P("crate", 3, 2), P("crate", 7, 3), P("switch", 2, 4, { link: "a" }), P("switch", 9, 2, { link: "a" }), P("door", 8, 5, { link: "a" }), P("goal", 2, 6),
  ], { music: "music-calm" });
  return assemble({ title: "Plates and Crates", pitch: "Push crates onto plates to open the way.", genre: "puzzle", hero: "cat", setting: "desert" }, [l1, l2]);
}

export function sampleBuilder(): GameSpec {
  const p = new Paint(30, 17);
  p.rect(0, 16, 29, 16, "#").rect(0, 15, 29, 15, "^");
  p.ground(13, 17, 12).set(17, 11, "#");
  const l1 = level("drop", "First Drop", p, [5, 1], [P("goal", 15, 11)], {
    music: "music-calm",
    weather: "snow",
    weatherAmount: 0.5,
    parts: [{ def: "plank", count: 2 }, { def: "spring", count: 1 }],
  });
  return assemble({ title: "Marble Works", pitch: "Guide the marble into the basket with planks and springs.", genre: "builder", hero: "ball", setting: "snow" }, [l1]);
}

export function sampleDefense(): GameSpec {
  const l1 = { id: "lawn", name: "Front Lawn", tileSize: 16, tileset: "tiles", background: [BACKGROUND[0]], music: "music-adventure", ...defenseLayout(7, 0.3) };
  const l2 = { id: "night-lawn", name: "Night Lawn", tileSize: 16, tileset: "tiles", background: [BACKGROUND[0]], music: "music-boss", tint: "#2a2f4a", ...defenseLayout(11, 0.6, { boss: true }) };
  return assemble({ title: "Lawn Guard", pitch: "Plant sun flowers and pea shooters to stop the zombies before they reach the house.", genre: "defense", hero: "pea", enemy: "zombie", pickup: "sun", setting: "garden" }, [l1, l2]);
}

export const SAMPLES: Record<string, () => GameSpec> = {
  platformer: samplePlatformer,
  "top-down": sampleTopDown,
  runner: sampleRunner,
  arena: sampleArena,
  puzzle: samplePuzzle,
  builder: sampleBuilder,
  defense: sampleDefense,
};
