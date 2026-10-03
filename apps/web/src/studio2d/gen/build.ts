// Steps 3–7 of generation: design doc → Game Spec → levels → assets → playtest. The spec is
// assembled from the behavior kit and tuned from the design, then validated and repaired.
import type { GameSpec, Rule } from "../spec/types.ts";
import { assemble, type Theme } from "../spec/kit.ts";
import { PALETTES, defaultRules } from "../spec/defaults.ts";
import { repairSpec } from "../spec/validate.ts";
import { buildWorld, outline, placeholderLevel, type LevelReport } from "../world/levels.ts";
import type { DesignDoc } from "./design.ts";

export function themeOf(d: DesignDoc): Theme {
  return {
    title: d.title,
    pitch: d.pitch,
    genre: d.genre,
    palette: PALETTES[d.art.palette] ?? PALETTES.forest,
    hero: d.art.hero,
    enemy: d.art.enemy,
    flyer: d.art.flyer,
    pickup: d.art.pickup,
    setting: d.art.setting,
    weather: d.art.weather,
    artStyle: d.art.style,
    doubleJump: d.tuning.doubleJump,
    jumpHeight: d.tuning.jumpHeight,
    speed: d.tuning.playerSpeed,
    boss: d.boss,
  };
}

export function rulesFor(d: DesignDoc): Rule[] {
  let rules = defaultRules(d.genre);
  if (rules.some((r) => r.type === "lives")) rules = rules.map((r) => (r.type === "lives" ? { ...r, count: d.genre === "runner" ? Math.min(3, d.tuning.lives) : d.tuning.lives } : r));
  if (d.tuning.timeLimit > 0 && d.genre !== "builder" && d.genre !== "arena") {
    rules = rules.filter((r) => r.type !== "timer");
    rules.push({ type: "timer", seconds: d.tuning.timeLimit, countDown: true }, { type: "lose", when: "time-up" });
  }
  return rules;
}

// Enemy speed from the design, applied to every enemy movement behavior.
function tuneEnemies(spec: GameSpec, speed: number) {
  for (const e of spec.entities) {
    if (e.kind !== "enemy") continue;
    for (const b of e.behaviors)
      if (b.type === "patrol" || b.type === "chase") b.params = { ...(b.params || {}), speed: Math.round(speed * (b.type === "chase" ? 1.2 : 1) * (e.tags?.includes("boss") ? 1.2 : 1) * 10) / 10 };
  }
}

export type BuildResult = { spec: GameSpec; reports: LevelReport[]; fixes: string[]; ms: number };

export function specFromDesign(d: DesignDoc, opts: { seed?: number; skipBot?: boolean; onProgress?: (m: string) => void } = {}): BuildResult {
  const t0 = performance.now();
  const theme = themeOf(d);
  const plans = outline(d.levels.length, d.difficulty, d.levels.map((l) => l.name)).map((p, i) => ({ ...p, story: d.levels[i]?.story, boss: p.boss && d.boss }));
  // The tuned spec (rules, enemy speeds) is what the levels are validated against.
  const base = assemble(theme, [placeholderLevel()], { rules: rulesFor(d) });
  tuneEnemies(base, d.tuning.enemySpeed);
  // Give the NPC the story's first line.
  const npc = base.entities.find((e) => e.id === "npc");
  const say = npc?.behaviors.find((b) => b.type === "dialogue");
  if (say && d.levels[0]?.story) say.params = { ...(say.params || {}), text: d.levels[0].story.slice(0, 200) };
  opts.onProgress?.("Building levels");
  const { levels, reports } = buildWorld(theme, { base, levels: plans, seed: opts.seed ?? 1, skipBot: opts.skipBot, onProgress: opts.onProgress });
  levels.forEach((l, i) => {
    l.name = d.levels[i]?.name ?? l.name;
    if (d.levels[i]?.story) l.story = d.levels[i].story;
  });
  const spec: GameSpec = { ...base, levels };
  const { spec: fixed, fixes } = repairSpec(spec);
  return { spec: fixed, reports, fixes, ms: Math.round(performance.now() - t0) };
}
