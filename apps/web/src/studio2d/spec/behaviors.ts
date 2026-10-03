// The fixed behavior library: every behavior has typed parameters with safe ranges, so a
// patch like "make the jump higher" can never produce a value that breaks a level.
import type { BehaviorName } from "./types.ts";

export type NumParam = { kind: "number"; min: number; max: number; default: number; unit?: string };
export type BoolParam = { kind: "bool"; default: boolean };
export type EnumParam = { kind: "enum"; values: string[]; default: string };
export type TextParam = { kind: "text"; default: string; maxLength: number };
export type ParamDef = NumParam | BoolParam | EnumParam | TextParam;

const n = (min: number, max: number, def: number, unit?: string): NumParam => ({ kind: "number", min, max, default: def, unit });
const b = (def: boolean): BoolParam => ({ kind: "bool", default: def });
const e = (values: string[], def: string): EnumParam => ({ kind: "enum", values, default: def });
const t = (def: string, maxLength = 200): TextParam => ({ kind: "text", default: def, maxLength });

// Speeds are tiles per second, heights in tiles, times in seconds.
export const BEHAVIORS: Record<BehaviorName, { summary: string; params: Record<string, ParamDef> }> = {
  "platformer-controller": {
    summary: "Run and jump with coyote time and jump buffering",
    params: {
      speed: n(2, 14, 7, "tiles/s"),
      jumpHeight: n(1, 8, 3.4, "tiles"),
      airControl: n(0.2, 1, 0.85),
      doubleJump: b(false),
      coyote: n(0, 0.2, 0.09, "s"),
      acceleration: n(10, 120, 60, "tiles/s²"),
    },
  },
  "top-down-controller": {
    summary: "Move in eight directions",
    params: { speed: n(2, 12, 5.5, "tiles/s"), diagonal: b(true), acceleration: n(10, 120, 50) },
  },
  patrol: {
    summary: "Walk back and forth, turning at walls and ledges",
    params: { speed: n(0.5, 8, 2, "tiles/s"), range: n(0, 30, 0, "tiles"), turnAtLedges: b(true), axis: e(["x", "y"], "x") },
  },
  chase: { summary: "Move toward the player when near", params: { speed: n(0.5, 10, 2.6), sight: n(1, 30, 7, "tiles") } },
  flee: { summary: "Move away from the player when near", params: { speed: n(0.5, 10, 3), sight: n(1, 30, 5, "tiles") } },
  shoot: {
    summary: "Fire projectiles on a cadence",
    params: {
      every: n(0.15, 6, 1.6, "s"),
      speed: n(2, 30, 9, "tiles/s"),
      aim: e(["player", "facing", "nearest", "up", "down", "left", "right", "mouse"], "player"),
      range: n(1, 40, 10, "tiles"),
      damage: n(1, 10, 1),
      trigger: e(["auto", "action"], "auto"),
      lane: b(false),
    },
  },
  "jump-on-kill": { summary: "Defeated when the player lands on top", params: { bounce: n(0, 1.5, 0.7) } },
  collectible: {
    summary: "Picked up on touch for points or effects",
    params: { points: n(0, 1000, 10), effect: e(["none", "heal", "life", "double-jump", "speed", "key"], "none"), required: b(true) },
  },
  "damage-on-touch": { summary: "Hurts on contact", params: { damage: n(1, 10, 1), knockback: n(0, 20, 6) } },
  "moving-platform": {
    summary: "Moves along a path and carries riders",
    params: { dx: n(-20, 20, 4, "tiles"), dy: n(-20, 20, 0, "tiles"), period: n(1, 20, 4, "s") },
  },
  "falling-platform": { summary: "Falls shortly after being stood on", params: { delay: n(0.1, 3, 0.5, "s"), respawn: n(0, 10, 3, "s") } },
  door: { summary: "Blocks the way until opened by a switch or key", params: { link: t("", 40), needsKey: b(false), open: b(false) } },
  switch: { summary: "Toggles linked doors when pressed", params: { link: t("", 40), toggle: b(false), pressure: b(true) } },
  checkpoint: { summary: "Sets the respawn point", params: {} },
  spawner: {
    summary: "Creates entities over time",
    params: { spawn: t("", 40), every: n(0.3, 20, 3, "s"), max: n(1, 50, 6), waves: n(0, 20, 0), perWave: n(1, 30, 4), delay: n(0, 120, 0, "s"), spacing: n(0, 10, 0, "s") },
  },
  health: { summary: "Takes damage and can be defeated", params: { hp: n(1, 50, 3), invulnerable: n(0, 3, 0.8, "s") } },
  timer: { summary: "Counts time for this entity (lifetime)", params: { seconds: n(0.1, 600, 5), action: e(["remove", "toggle"], "remove") } },
  dialogue: { summary: "Shows lines when the player is near", params: { text: t("Hello!", 280), radius: n(0.5, 8, 2) } },
  "camera-follow": { summary: "The camera follows this entity", params: { lerp: n(0.02, 1, 0.14), lookAhead: n(0, 8, 2, "tiles") } },
  "wind-zone": { summary: "Pushes bodies inside it", params: { fx: n(-60, 60, 0), fy: n(-60, 60, -30) } },
  bouncy: { summary: "Launches bodies that land on it", params: { power: n(2, 14, 7, "tiles") } },
  breakable: { summary: "Breaks when hit from below or by projectiles", params: { hits: n(1, 10, 1) } },
  goal: { summary: "Finishing point of the level", params: {} },
  pushable: { summary: "Can be pushed by the player one tile at a time or smoothly", params: { grid: b(true) } },
  projectile: { summary: "Moves straight and hurts what it hits", params: { speed: n(2, 30, 9), damage: n(1, 10, 1), life: n(0.2, 6, 2), friendly: b(false) } },
  producer: { summary: "Adds currency on a timer (a sunflower, a mine, a farm)", params: { every: n(1, 30, 7, "s"), amount: n(5, 200, 25) } },
  march: { summary: "Walks steadily one way, stopping while it attacks", params: { speed: n(0.1, 6, 0.45, "tiles/s"), dir: e(["left", "right", "up", "down"], "left") } },
  attacker: { summary: "Chews through whatever blocks its way", params: { damage: n(1, 20, 1), every: n(0.2, 5, 1, "s"), target: e(["units", "player", "any"], "units") } },
  "auto-run": { summary: "Always runs forward, speeding up over time", params: { speed: n(3, 16, 7), ramp: n(0, 1, 0.08, "tiles/s²"), max: n(4, 20, 12) } },
};

export const BEHAVIOR_NAMES = Object.keys(BEHAVIORS) as BehaviorName[];
// The 22 behaviors named in the design, which the engine must support.
export const CORE_BEHAVIORS: BehaviorName[] = [
  "platformer-controller", "top-down-controller", "patrol", "chase", "flee", "shoot", "jump-on-kill",
  "collectible", "damage-on-touch", "moving-platform", "falling-platform", "door", "switch", "checkpoint",
  "spawner", "health", "timer", "dialogue", "camera-follow", "wind-zone", "bouncy", "breakable",
];

export function clampParam(def: ParamDef, value: unknown): number | string | boolean {
  switch (def.kind) {
    case "number": {
      const v = typeof value === "string" ? parseFloat(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(v)) return def.default;
      return Math.min(def.max, Math.max(def.min, v));
    }
    case "bool":
      return typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : def.default;
    case "enum":
      return typeof value === "string" && def.values.includes(value) ? value : def.default;
    case "text":
      return typeof value === "string" ? value.slice(0, def.maxLength) : typeof value === "number" ? String(value) : def.default;
  }
}

// Full parameter set for a behavior: defaults, then the given values clamped into range.
export function resolveParams(name: BehaviorName, given?: Record<string, unknown>): Record<string, any> {
  const lib = BEHAVIORS[name];
  const out: Record<string, any> = {};
  for (const [k, d] of Object.entries(lib.params)) out[k] = clampParam(d, given?.[k]);
  return out;
}
