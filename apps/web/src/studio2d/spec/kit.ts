// Standard entity definitions per genre. Hand-written samples, the world builder and the
// generator all start from this kit, so every generated game uses parts the engine knows.
import type { AssetRef, EntityDef, GameSpec, Genre, LevelDef, MusicCue, SfxRef } from "./types.ts";
import { defaultControls, defaultHud, defaultMenus, defaultRules, PALETTES } from "./defaults.ts";
import { hashString } from "./validate.ts";

export type Theme = {
  title: string;
  pitch: string;
  genre: Genre;
  palette?: string[];
  hero?: string; // e.g. "fox"
  enemy?: string; // e.g. "slime"
  flyer?: string; // e.g. "bat"
  pickup?: string; // e.g. "seed"
  setting?: string; // e.g. "forest", used for tiles and backgrounds
  weather?: string; // "rain", "snow", "none"
  artStyle?: "pixel" | "flat" | "painted";
  doubleJump?: boolean;
  producer?: string; // lane defense unit looks
  shooter?: string;
  blocker?: string;
  jumpHeight?: number;
  speed?: number;
  boss?: boolean;
};

const sprite = (recipe: string, seed: number, extra: Partial<AssetRef> = {}): AssetRef => ({ kind: "sprite", source: "procedural", seed, recipe, ...extra });

export function kitFor(theme: Theme): { player: EntityDef; entities: EntityDef[]; assets: Record<string, AssetRef> } {
  const g = theme.genre;
  const seed = hashString(theme.title) % 100000;
  const hero = theme.hero || (g === "builder" ? "ball" : "fox");
  const enemy = theme.enemy || "slime";
  const flyer = theme.flyer || "bat";
  const pickup = theme.pickup || "coin";
  const setting = theme.setting || "forest";
  const assets: Record<string, AssetRef> = {
    hero: sprite(hero, seed + 1, { rig: g !== "builder", frames: 1 }),
    enemy: sprite(enemy, seed + 2, { rig: true }),
    flyer: sprite(flyer, seed + 3, { rig: true }),
    pickup: sprite(pickup, seed + 4),
    heart: sprite("heart", seed + 5),
    key: sprite("key", seed + 6),
    goal: sprite(g === "builder" ? "basket" : g === "puzzle" || g === "top-down" ? "portal" : "flag", seed + 7),
    checkpoint: sprite("lantern", seed + 8),
    platform: sprite(`${setting} platform`, seed + 9),
    crumble: sprite(`${setting} crumbling platform`, seed + 10),
    spring: sprite("spring", seed + 11),
    door: sprite("door", seed + 12),
    switch: sprite("switch", seed + 13),
    crate: sprite("crate", seed + 14),
    spike: sprite("spikes", seed + 15),
    turret: sprite("turret", seed + 16),
    npc: sprite(`${setting} elder`, seed + 17, { rig: true }),
    boss: sprite(`giant ${enemy}`, seed + 18, { rig: true }),
    tiles: { kind: "tileset", source: "procedural", seed: seed + 20, recipe: `${setting} ground` },
    "bg-far": { kind: "background", source: "procedural", seed: seed + 21, recipe: `${setting} sky` },
    "bg-mid": { kind: "background", source: "procedural", seed: seed + 22, recipe: `${setting} hills` },
    "bg-near": { kind: "background", source: "procedural", seed: seed + 23, recipe: `${setting} trees` },
    plank: sprite("plank", seed + 24),
    fan: sprite("fan", seed + 25),
    block: sprite(`${setting} block`, seed + 26),
    wind: sprite("wind", seed + 27),
    gem: sprite("gem", seed + 28),
    producer: sprite(theme.producer || `${pickup} flower`, seed + 29),
    shooter: sprite(theme.shooter || `${hero} shooter`, seed + 30),
    blocker: sprite(theme.blocker || "nut wall", seed + 31),
    runner: sprite(`fast ${enemy}`, seed + 32, { rig: true }),
    brute: sprite(`big ${enemy}`, seed + 33, { rig: true }),
  };
  const side = g === "platformer" || g === "runner";
  const player: EntityDef = {
    id: "hero",
    kind: "player",
    name: hero,
    sprite: "hero",
    size: g === "builder" ? [0.8, 0.8] : side ? [0.8, 0.9] : g === "puzzle" ? [0.8, 0.8] : [0.8, 0.8],
    body: g === "builder"
      ? { type: "dynamic", shape: "circle", bounce: 0.25, friction: 0.3 }
      : { type: "dynamic", shape: "box" },
    behaviors: [],
    stats: { health: g === "arena" || g === "top-down" ? 5 : 3 },
  };
  if (g === "platformer")
    player.behaviors.push(
      { type: "platformer-controller", params: { speed: theme.speed ?? 7, jumpHeight: theme.jumpHeight ?? 3.4, doubleJump: !!theme.doubleJump } },
      { type: "health", params: { hp: 3, invulnerable: 1 } },
      { type: "camera-follow" },
    );
  if (g === "runner")
    player.behaviors.push(
      { type: "platformer-controller", params: { speed: theme.speed ?? 8, jumpHeight: theme.jumpHeight ?? 3.2, doubleJump: !!theme.doubleJump } },
      { type: "auto-run", params: { speed: theme.speed ?? 8, ramp: 0.06, max: 12 } },
      { type: "health", params: { hp: 1, invulnerable: 0.5 } },
      { type: "camera-follow", params: { lookAhead: 6 } },
    );
  if (g === "top-down" || g === "arena")
    player.behaviors.push(
      { type: "top-down-controller", params: { speed: theme.speed ?? 5.5 } },
      { type: "health", params: { hp: 5, invulnerable: 1 } },
      { type: "shoot", params: { trigger: "action", aim: "nearest", every: g === "arena" ? 0.25 : 0.45, speed: 12, range: 9 } },
      { type: "camera-follow", params: { lookAhead: 0 } },
    );
  if (g === "defense") {
    // No avatar: the player places units on the lane grid.
    player.size = [0.5, 0.5];
    player.body = { type: "static", shape: "box", sensor: true };
  }
  if (g === "puzzle") player.behaviors.push({ type: "top-down-controller", params: { speed: 7, diagonal: false } }, { type: "camera-follow", params: { lookAhead: 0 } });
  if (g === "builder") player.behaviors.push({ type: "camera-follow", params: { lookAhead: 0, lerp: 0.2 } });

  const entities: EntityDef[] = [];
  const add = (e: EntityDef) => entities.push(e);
  add({ id: "goal", kind: "goal", name: "goal", sprite: "goal", size: g === "builder" ? [1.4, 1] : [1, g === "platformer" || g === "runner" ? 2 : 1], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "goal" }] });
  add({ id: "pickup", kind: "pickup", name: pickup, sprite: "pickup", size: [0.6, 0.6], body: { type: "static", shape: "circle", sensor: true }, behaviors: [{ type: "collectible", params: { points: 10, required: g !== "runner" } }] });
  add({ id: "gem", kind: "pickup", name: "gem", sprite: "gem", size: [0.6, 0.6], body: { type: "static", shape: "circle", sensor: true }, behaviors: [{ type: "collectible", params: { points: 50, required: false } }], tags: ["secret"] });
  add({ id: "heart", kind: "pickup", name: "heart", sprite: "heart", size: [0.6, 0.6], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "collectible", params: { points: 0, effect: "heal", required: false } }] });
  if (g === "platformer" || g === "runner") {
    add({ id: "walker", kind: "enemy", name: enemy, sprite: "enemy", size: [0.9, 0.8], body: { type: "dynamic", shape: "box" }, behaviors: [{ type: "patrol", params: { speed: 1.8, turnAtLedges: true } }, { type: "jump-on-kill" }, { type: "damage-on-touch" }] });
    add({ id: "flyer", kind: "enemy", name: flyer, sprite: "flyer", size: [0.8, 0.6], body: { type: "kinematic", shape: "box", gravity: false }, behaviors: [{ type: "moving-platform", params: { dx: 0, dy: 2, period: 2.4 } }, { type: "jump-on-kill" }, { type: "damage-on-touch" }] });
    add({ id: "platform", kind: "platform", name: "moving platform", sprite: "platform", size: [3, 0.5], body: { type: "kinematic", shape: "box", solid: true }, behaviors: [{ type: "moving-platform", params: { dx: 4, dy: 0, period: 4 } }] });
    add({ id: "crumble", kind: "platform", name: "crumbling platform", sprite: "crumble", size: [2, 0.5], body: { type: "kinematic", shape: "box", solid: true }, behaviors: [{ type: "falling-platform", params: { delay: 0.5, respawn: 3 } }] });
    add({ id: "spring", kind: "prop", name: "spring", sprite: "spring", size: [1, 0.5], body: { type: "static", shape: "box", solid: true }, behaviors: [{ type: "bouncy", params: { power: 6 } }] });
    add({ id: "checkpoint", kind: "prop", name: "lantern", sprite: "checkpoint", size: [0.6, 1.2], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "checkpoint" }] });
    add({ id: "spikes", kind: "hazard", name: "spikes", sprite: "spike", size: [1, 0.5], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "damage-on-touch", params: { damage: 1, knockback: 8 } }] });
    add({ id: "block", kind: "prop", name: "breakable block", sprite: "block", size: [1, 1], body: { type: "static", shape: "box", solid: true }, behaviors: [{ type: "breakable", params: { hits: 1 } }] });
    add({ id: "npc", kind: "npc", name: "elder", sprite: "npc", size: [0.9, 1.2], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "dialogue", params: { text: "The seeds glow brighter past the old bridge.", radius: 2 } }] });
    add({ id: "wind", kind: "prop", name: "updraft", sprite: "wind", size: [2, 5], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "wind-zone", params: { fx: 0, fy: -60 } }] });
    add({ id: "turret", kind: "enemy", name: "turret", sprite: "turret", size: [0.9, 0.9], body: { type: "static", shape: "box", solid: true }, behaviors: [{ type: "shoot", params: { every: 2.2, speed: 6, aim: "player", range: 9 } }, { type: "health", params: { hp: 2 } }] });
    add({ id: "boss", kind: "enemy", name: `giant ${enemy}`, sprite: "boss", size: [2.4, 2], body: { type: "dynamic", shape: "box" }, behaviors: [{ type: "patrol", params: { speed: 2.4, turnAtLedges: true } }, { type: "health", params: { hp: 3, invulnerable: 0.8 } }, { type: "damage-on-touch" }, { type: "shoot", params: { every: 2.5, speed: 5, aim: "player", range: 12 } }], tags: ["boss"] });
  }
  if (g === "top-down" || g === "arena") {
    add({ id: "walker", kind: "enemy", name: enemy, sprite: "enemy", size: [0.8, 0.8], body: { type: "dynamic", shape: "box", gravity: false }, behaviors: [{ type: "patrol", params: { speed: 1.6 } }, { type: "chase", params: { speed: 2.2, sight: 6 } }, { type: "damage-on-touch", params: { knockback: 5 } }, { type: "health", params: { hp: 2 } }] });
    add({ id: "flyer", kind: "enemy", name: flyer, sprite: "flyer", size: [0.7, 0.7], body: { type: "dynamic", shape: "box", gravity: false }, behaviors: [{ type: "chase", params: { speed: 3, sight: 9 } }, { type: "damage-on-touch", params: { knockback: 4 } }, { type: "health", params: { hp: 1 } }] });
    add({ id: "turret", kind: "enemy", name: "turret", sprite: "turret", size: [0.9, 0.9], body: { type: "static", shape: "box", solid: true }, behaviors: [{ type: "shoot", params: { every: 1.8, speed: 5, aim: "player", range: 8 } }, { type: "health", params: { hp: 3 } }] });
    add({ id: "spawner", kind: "prop", name: "nest", sprite: "block", size: [1, 1], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "spawner", params: { spawn: "walker", every: 2, waves: 3, perWave: 3 } }] });
    add({ id: "key", kind: "pickup", name: "key", sprite: "key", size: [0.6, 0.6], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "collectible", params: { points: 0, effect: "key", required: false } }] });
    add({ id: "door", kind: "prop", name: "door", sprite: "door", size: [1, 1], body: { type: "static", shape: "box", solid: true }, behaviors: [{ type: "door", params: { needsKey: true } }] });
    add({ id: "npc", kind: "npc", name: "elder", sprite: "npc", size: [0.8, 0.9], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "dialogue", params: { text: "The portal wakes when the key turns.", radius: 1.8 } }] });
    add({ id: "fleer", kind: "npc", name: "sprite", sprite: "gem", size: [0.6, 0.6], body: { type: "dynamic", shape: "box", gravity: false }, behaviors: [{ type: "flee", params: { speed: 2.5, sight: 4 } }, { type: "collectible", params: { points: 100, required: false } }] });
    add({ id: "boss", kind: "enemy", name: `giant ${enemy}`, sprite: "boss", size: [1.8, 1.8], body: { type: "dynamic", shape: "box", gravity: false }, behaviors: [{ type: "chase", params: { speed: 1.8, sight: 12 } }, { type: "health", params: { hp: 12, invulnerable: 0.3 } }, { type: "damage-on-touch" }, { type: "shoot", params: { every: 1.6, speed: 5, aim: "player", range: 12 } }], tags: ["boss"] });
    add({ id: "spikes", kind: "hazard", name: "spikes", sprite: "spike", size: [1, 1], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "damage-on-touch", params: { knockback: 6 } }, { type: "timer", params: { seconds: 1.5, action: "toggle" } }] });
  }
  if (g === "defense") {
    const unit = (id: string, name: string, size: [number, number], hp: number, extra: EntityDef["behaviors"]) =>
      add({ id, kind: "unit", name, sprite: id, size, body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "health", params: { hp, invulnerable: 0 } }, ...extra] });
    unit("producer", theme.producer || `${pickup} flower`, [1.6, 1.8], 4, [{ type: "producer", params: { every: 8, amount: 25 } }]);
    unit("shooter", theme.shooter || `${hero} shooter`, [1.6, 1.8], 4, [{ type: "shoot", params: { aim: "right", lane: true, every: 1.4, speed: 9, range: 30, damage: 1 } }]);
    unit("blocker", theme.blocker || "nut wall", [1.6, 1.9], 24, []);
    const foe = (id: string, name: string, sprite: string, size: [number, number], hp: number, speed: number, tags?: string[]) =>
      add({ id, kind: "enemy", name, sprite, size, body: { type: "dynamic", shape: "box", gravity: false }, behaviors: [{ type: "attacker", params: { damage: 1, every: 1 } }, { type: "march", params: { speed, dir: "left" } }, { type: "health", params: { hp, invulnerable: 0 } }], tags });
    foe("walker", enemy, "enemy", [1.3, 2.2], 6, 0.45);
    foe("runner", `fast ${enemy}`, "runner", [1.2, 2.1], 4, 0.9);
    foe("brute", `big ${enemy}`, "brute", [1.6, 2.5], 16, 0.3);
    foe("boss", `giant ${enemy}`, "boss", [2.2, 2.8], 40, 0.25, ["boss"]);
    add({ id: "spawner", kind: "prop", name: "gate", sprite: "block", size: [1, 1], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "spawner", params: { spawn: "walker", every: 6, waves: 3, perWave: 2, delay: 18, spacing: 4 } }] });
  }
  if (g === "puzzle") {
    add({ id: "crate", kind: "prop", name: "crate", sprite: "crate", size: [1, 1], body: { type: "static", shape: "box", solid: true }, behaviors: [{ type: "pushable", params: { grid: true } }] });
    add({ id: "switch", kind: "prop", name: "pressure plate", sprite: "switch", size: [1, 1], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "switch", params: { link: "a", pressure: true } }] });
    add({ id: "door", kind: "prop", name: "gate", sprite: "door", size: [1, 1], body: { type: "static", shape: "box", solid: true }, behaviors: [{ type: "door", params: { link: "a" } }] });
    add({ id: "key", kind: "pickup", name: "key", sprite: "key", size: [0.6, 0.6], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "collectible", params: { points: 0, effect: "key", required: false } }] });
    add({ id: "lockdoor", kind: "prop", name: "locked door", sprite: "door", size: [1, 1], body: { type: "static", shape: "box", solid: true }, behaviors: [{ type: "door", params: { needsKey: true } }] });
  }
  if (g === "builder") {
    add({ id: "plank", kind: "part", name: "plank", sprite: "plank", size: [3, 0.35], body: { type: "static", shape: "box", solid: true, friction: 0.3 }, behaviors: [] });
    add({ id: "spring", kind: "part", name: "spring", sprite: "spring", size: [1, 0.5], body: { type: "static", shape: "box", solid: true }, behaviors: [{ type: "bouncy", params: { power: 5 } }] });
    add({ id: "fan", kind: "part", name: "fan", sprite: "fan", size: [1, 4], body: { type: "static", shape: "box", sensor: true }, behaviors: [{ type: "wind-zone", params: { fx: 0, fy: -60 } }] });
    add({ id: "block", kind: "part", name: "block", sprite: "block", size: [1, 1], body: { type: "static", shape: "box", solid: true }, behaviors: [] });
  }
  return { player, entities, assets };
}

export function sfxFor(seed: number): Record<string, SfxRef> {
  const out: Record<string, SfxRef> = {};
  (["jump", "coin", "hit", "explosion", "powerup", "shoot", "door", "step", "win", "lose", "bounce", "break"] as const).forEach((p, i) => (out[p] = { preset: p, seed: seed + i }));
  return out;
}

export function musicFor(seed: number, moods: MusicCue["mood"][] = ["calm", "adventure", "tense", "boss", "victory"]): MusicCue[] {
  return moods.map((mood, i) => ({ id: `music-${mood}`, mood, seed: seed + i * 7 }));
}

export function assemble(theme: Theme, levels: LevelDef[], extra?: { rules?: GameSpec["rules"] }): GameSpec {
  const kit = kitFor(theme);
  const seed = hashString(theme.title) % 100000;
  const palette = theme.palette && theme.palette.length >= 3 ? theme.palette : PALETTES[theme.setting || "forest"] || PALETTES.forest;
  return {
    version: 1,
    meta: { title: theme.title, genre: theme.genre, pitch: theme.pitch, artStyle: theme.artStyle || "pixel", palette },
    player: kit.player,
    entities: kit.entities,
    rules: extra?.rules ?? defaultRules(theme.genre),
    controls: defaultControls(theme.genre),
    levels,
    audio: { music: musicFor(seed), sfx: sfxFor(seed) },
    ui: { hud: defaultHud(theme.genre), menus: defaultMenus(theme.title) },
    assets: kit.assets,
  };
}

export const BACKGROUND = [
  { asset: "bg-far", speed: 0.05 },
  { asset: "bg-mid", speed: 0.25 },
  { asset: "bg-near", speed: 0.5 },
];
