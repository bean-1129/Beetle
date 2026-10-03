// The Game Spec: the one document every part of Studio2D reads and writes.
// The model never writes the game; it writes this spec, and the engine plays it.

export type Genre = "platformer" | "top-down" | "builder" | "puzzle" | "runner" | "arena" | "defense";
export type ArtStyle = "pixel" | "flat" | "painted";
export const GENRES: Genre[] = ["platformer", "top-down", "builder", "puzzle", "runner", "arena", "defense"];
export const ART_STYLES: ArtStyle[] = ["pixel", "flat", "painted"];

export type BehaviorName =
  | "platformer-controller"
  | "top-down-controller"
  | "patrol"
  | "chase"
  | "flee"
  | "shoot"
  | "jump-on-kill"
  | "collectible"
  | "damage-on-touch"
  | "moving-platform"
  | "falling-platform"
  | "door"
  | "switch"
  | "checkpoint"
  | "spawner"
  | "health"
  | "timer"
  | "dialogue"
  | "camera-follow"
  | "wind-zone"
  | "bouncy"
  | "breakable"
  // Supporting behaviors the genres need beyond the core list.
  | "goal"
  | "pushable"
  | "projectile"
  | "auto-run"
  // Lane defense.
  | "producer"
  | "march"
  | "attacker";

export type Behavior = { type: BehaviorName; params?: Record<string, number | string | boolean> };

export type Body = {
  type: "static" | "dynamic" | "kinematic";
  shape: "box" | "circle" | "capsule";
  friction?: number;
  bounce?: number;
  // Sensors report overlaps but never push other bodies.
  sensor?: boolean;
  // Solid bodies block the player like ground (platforms, crates, doors).
  solid?: boolean;
  gravity?: boolean;
};

export type EntityKind = "player" | "enemy" | "pickup" | "platform" | "hazard" | "npc" | "prop" | "goal" | "part" | "unit";

export type EntityDef = {
  id: string;
  kind?: EntityKind;
  name?: string;
  sprite: string; // asset id
  size: [number, number];
  body?: Body;
  behaviors: Behavior[];
  stats?: Record<string, number>; // speed, jumpHeight, health, damage
  tags?: string[];
};

export type RuleWhen =
  | "reach-goal"
  | "collect-all"
  | "defeat-all"
  | "survive"
  | "score-at-least"
  | "no-lives"
  | "time-up"
  | "health-zero"
  | "base-reached";

export type Rule =
  | { type: "win"; when: RuleWhen; value?: number; tag?: string }
  | { type: "lose"; when: RuleWhen; value?: number }
  | { type: "lives"; count: number }
  | { type: "timer"; seconds: number; countDown?: boolean }
  | { type: "score"; event: "collect" | "defeat" | "finish" | "distance"; points: number; tag?: string };

export type Action = "left" | "right" | "up" | "down" | "jump" | "action" | "pause";
export const ACTIONS: Action[] = ["left", "right", "up", "down", "jump", "action", "pause"];
export type ControlMap = Record<Action, string[]>;

export type Placement = {
  def: string; // EntityDef id
  x: number; // tile coordinates (may be fractional)
  y: number;
  params?: Record<string, number | string | boolean>; // per-instance overrides (patrol range, door link...)
  id?: string;
};

export type Weather = "none" | "rain" | "snow" | "leaves" | "embers" | "bubbles";
export const WEATHERS: Weather[] = ["none", "rain", "snow", "leaves", "embers", "bubbles"];
export type ParallaxLayer = { asset: string; speed: number; y?: number };

export type LevelDef = {
  id: string;
  name: string;
  beat?: "intro" | "teach" | "test" | "twist" | "finale" | "endless";
  size: [number, number]; // tiles
  tileSize: number; // pixels
  tileset: string; // asset id
  // One string per row. '.' empty, '#' solid, '=' one-way platform, '^' spikes,
  // '~' water (slows, top-down blocks), 'B' breakable block, 'W' wall (top-down solid).
  tiles: string[];
  spawn: [number, number];
  placements: Placement[];
  background: ParallaxLayer[];
  music?: string; // music cue id
  tint?: string; // lighting tint over the level
  weather?: Weather;
  weatherAmount?: number; // 0..1
  gravity?: number; // pixels per second squared, default by genre
  difficulty?: number; // 0..1
  story?: string; // one line shown on the level card
  parts?: { def: string; count: number }[]; // builder genre: the parts budget
  solution?: { def: string; x: number; y: number; angle: number }[]; // builder: one known answer
  // Lane defense: a placement grid, what can be bought, and the income.
  lanes?: { x0: number; y0: number; cell: number; cols: number; rows: number };
  shop?: { def: string; cost: number; cooldown?: number }[];
  economy?: { start: number; perSecond: number };
  seed?: number;
  // Endless levels stream chunks at runtime.
  endless?: boolean;
};

export type Mood = "adventure" | "calm" | "tense" | "boss" | "victory";
export const MOODS: Mood[] = ["adventure", "calm", "tense", "boss", "victory"];
export type MusicCue = { id: string; mood: Mood; tempo?: number; seed: number };
export type SfxPreset = "jump" | "coin" | "hit" | "explosion" | "powerup" | "shoot" | "door" | "step" | "win" | "lose" | "bounce" | "break";
export const SFX_PRESETS: SfxPreset[] = ["jump", "coin", "hit", "explosion", "powerup", "shoot", "door", "step", "win", "lose", "bounce", "break"];
export type SfxRef = { preset: SfxPreset; seed: number; params?: Record<string, number> };

export type HudItem = { kind: "score" | "lives" | "health" | "timer" | "collected" | "level" | "distance" | "parts" | "currency" | "wave"; anchor?: "top-left" | "top-right" | "top-center" };
export type MenuDef = { id: "title" | "pause" | "win" | "lose" | "level"; title: string; items: string[] };

export type AssetKind = "sprite" | "tileset" | "background" | "ui" | "sfx" | "music";
export type AssetSource = "procedural" | "generated" | "placeholder" | "user";
export type AssetRef = {
  kind: AssetKind;
  source: AssetSource;
  seed: number;
  // Procedural recipe: what to draw (fox, slime, coin, grass tiles...). Always present so a
  // generated asset can fall back to its procedural twin.
  recipe: string;
  prompt?: string;
  data?: string; // data URL for generated or user art
  frames?: number;
  rig?: boolean; // cutout animated from parts
  colors?: string[];
};

export type GameSpec = {
  version: 1;
  meta: { title: string; genre: Genre; pitch: string; artStyle: ArtStyle; palette: string[] };
  player: EntityDef;
  entities: EntityDef[];
  rules: Rule[];
  controls: ControlMap;
  levels: LevelDef[];
  audio: { music: MusicCue[]; sfx: Record<string, SfxRef> };
  ui: { hud: HudItem[]; menus: MenuDef[] };
  assets: Record<string, AssetRef>;
  // A game written in Studio2D Script (for ideas no built-in genre covers). When present it
  // is what plays; the rest of the spec supplies the title, palette, sound and controls.
  script?: { code: string; howToPlay?: string; model?: string };
};

export const TILE = {
  EMPTY: ".",
  SOLID: "#",
  ONEWAY: "=",
  SPIKE: "^",
  WATER: "~",
  BREAK: "B",
  WALL: "W",
} as const;
export const TILE_CHARS = new Set(Object.values(TILE));
