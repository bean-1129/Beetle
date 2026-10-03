// Step 2 of generation: the design doc. A short, editable plan (pitch, genre, core loop,
// mechanics, levels, art direction) that the person approves before anything is built.
// The local model writes it through a strict JSON schema; code reads the idea directly as
// a fallback, and repairs whatever the model returns.
import type { Genre, ArtStyle, Weather } from "../spec/types.ts";
import { GENRES, ART_STYLES, WEATHERS } from "../spec/types.ts";
import { PALETTES } from "../spec/defaults.ts";
import { findTemplate } from "../samples/scripts.ts";
import { wantsScript } from "./script.ts";

export type LevelIdea = { name: string; story: string };
export type Tuning = { playerSpeed: number; jumpHeight: number; doubleJump: boolean; enemySpeed: number; lives: number; timeLimit: number };
export type DesignDoc = {
  // How the game gets made: a built-in genre, a ready template, or a script the model writes.
  route?: "genre" | "template" | "script";
  template?: string;
  title: string;
  pitch: string;
  genre: Genre;
  coreLoop: string;
  mechanics: string[];
  levels: LevelIdea[];
  art: { style: ArtStyle; palette: string; setting: string; hero: string; enemy: string; flyer: string; pickup: string; weather: Weather };
  difficulty: number; // 0..1
  boss: boolean;
  tuning: Tuning;
};

export const PALETTE_NAMES = Object.keys(PALETTES);

// JSON schema for Ollama's structured output (like designSchema in electron/viz.cjs).
export const DESIGN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    pitch: { type: "string" },
    genre: { type: "string", enum: GENRES },
    coreLoop: { type: "string" },
    mechanics: { type: "array", items: { type: "string" }, maxItems: 6 },
    levels: { type: "array", minItems: 3, maxItems: 5, items: { type: "object", properties: { name: { type: "string" }, story: { type: "string" } }, required: ["name", "story"] } },
    art: {
      type: "object",
      properties: {
        style: { type: "string", enum: ART_STYLES },
        palette: { type: "string", enum: PALETTE_NAMES },
        setting: { type: "string" },
        hero: { type: "string" },
        enemy: { type: "string" },
        flyer: { type: "string" },
        pickup: { type: "string" },
        weather: { type: "string", enum: WEATHERS },
      },
      required: ["style", "palette", "setting", "hero", "enemy", "pickup", "weather"],
    },
    difficulty: { type: "number" },
    boss: { type: "boolean" },
    fits: { type: "boolean" },
    tuning: {
      type: "object",
      properties: {
        playerSpeed: { type: "number" },
        jumpHeight: { type: "number" },
        doubleJump: { type: "boolean" },
        enemySpeed: { type: "number" },
        lives: { type: "integer" },
        timeLimit: { type: "integer" },
      },
    },
  },
  required: ["title", "pitch", "genre", "coreLoop", "mechanics", "levels", "art", "difficulty", "boss"],
};

export const DESIGN_SYSTEM = `You design small 2D games for Beetle 2D. Reply only with JSON matching the schema.
Genres: platformer (side view, run and jump), runner (auto-running side view), top-down (explore rooms, find a key, reach the portal), arena (top-down shooter, survive waves), puzzle (push crates onto plates to open gates), builder (place planks and springs so a marble reaches the basket), defense (lane defense like plants versus zombies: place defenders on a grid of lanes with currency that builds up, stop waves before they reach your home).
For defense: hero is the shooter defender (pea, cactus, archer), enemy is the invader (zombie), pickup is the currency (sun, gold).
Set fits to false when none of these genres can play the idea properly (for example chess, a card game, a rhythm game); it will then be written as a custom script instead.
Keep names short and warm. The pitch is one sentence. 3 to 5 levels, each with a one-line story beat that builds toward a finale.
Pick the palette that best fits the setting. hero/enemy/flyer/pickup are single creature or object words (fox, slime, bat, seed).
Tuning ranges: playerSpeed 4-10 tiles/s, jumpHeight 2.5-5 tiles, enemySpeed 1-4, lives 1-5, timeLimit 0 (none) to 300 seconds. difficulty 0 (gentle) to 1 (hard).`;

const GENRE_WORDS: [Genre, RegExp][] = [
  ["defense", /\b(tower[- ]defen[cs]e|lane[- ]defen[cs]e|plants?\s+(vs\.?|versus|v)\s+zombies?|pvz|defend (the|your|my) (house|base|castle|garden|home|village|lawn)|protect (the|your|my) (house|base|castle|garden|home|village|lawn)|place (plants|towers|defenders)|lanes?)\b/],
  ["builder", /\b(build|builder|contraption|marble|machine|physics|rube|goldberg|ramp|bridge builder|plank)s?\b/],
  ["puzzle", /\b(puzzle|sokoban|push(ing)? (the )?(crate|box|block)s?|crates?|pressure plate|logic|brain)\b/],
  ["runner", /\b(runner|endless|auto[- ]?run|keeps? running|dash|flappy|temple run|infinite run)\b/],
  ["arena", /\b(arena|shooter|shoot|shooting|waves?|survive|survival|bullet|blast|twin[- ]stick|horde)\b/],
  ["top-down", /\b(top[- ]down|zelda|dungeon|explore|exploration|maze|rooms?|adventure map|rpg|overworld|labyrinth|quest)\b/],
  ["platformer", /\b(platform(er|s)?|jump(ing|s)?|side[- ]?scroll(ing|er)?|mario|metroid|climb)\b/],
];
const CREATURES = /\b(fox|cat|dog|wolf|squirrel|rabbit|bunny|bear|deer|mouse|raccoon|panda|frog|toad|lion|tiger|pig|horse|hedgehog|otter|dragon|dino|dinosaur|lizard|kitten|puppy|hamster|turtle|penguin|monkey|owl|bird|bee|bat|knight|robot|kid|child|girl|boy|wizard|ninja|pirate|astronaut|princess|prince|witch|explorer|alien|chef|scientist|slime|ghost|beetle|spider|crab|fish|snail|marble|ball|drone|goblin|skeleton|zombie|mushroom|firefly|butterfly|jellyfish|octopus)\b/g;
const SETTINGS: [string, RegExp][] = [
  ["forest", /\b(forest|woods?|jungle|grove|garden|meadow|park|tree|lawn|yard|plant)s?\b/],
  ["desert", /\b(desert|sand|dunes?|egypt|canyon|beach)\b/],
  ["snow", /\b(snow\w*|ice|icy|frozen|arctic|winter|mountains?|glaciers?|penguins?)\b/],
  ["space", /\b(space|moon|mars|planet|galaxy|star ?ship|asteroid|alien|rocket)s?\b/],
  ["ocean", /\b(ocean|sea|underwater|reef|coral|lagoon|island)s?\b/],
  ["lava", /\b(lava|volcano|fire|inferno|magma)\b/],
  ["candy", /\b(candy|sweet|cake|sugar|chocolate|dessert)s?\b/],
  ["night", /\b(night|haunted|spooky|dark|moonlit|ghost)s?\b/],
  ["cave", /\b(cave|cavern|mine|underground|dungeon|castle|temple|ruins?)s?\b/],
  ["city", /\b(city|street|rooftop|urban|neon|town)s?\b/],
];
const PALETTE_FOR: Record<string, string> = { forest: "forest", desert: "desert", snow: "snow", space: "space", ocean: "ocean", lava: "lava", candy: "candy", night: "night", cave: "night", city: "night" };

const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function detectGenre(idea: string): Genre {
  const t = idea.toLowerCase();
  for (const [g, re] of GENRE_WORDS) if (re.test(t)) return g;
  return "platformer";
}

// Read the idea directly: no model needed. Also the base the model's answer is merged onto.
export function designFromIdea(idea: string): DesignDoc {
  const t = idea.toLowerCase().trim();
  const genre = detectGenre(t);
  const template = findTemplate(t);
  const route: DesignDoc["route"] = GENRE_WORDS.some(([, re]) => re.test(t)) && !template ? "genre" : template ? "template" : wantsScript(t) ? "script" : "genre";
  const creatures = [...t.matchAll(CREATURES)].map((m) => m[1]);
  const heroDefault = genre === "builder" ? "marble" : genre === "arena" ? "robot" : genre === "top-down" ? "knight" : genre === "defense" ? "pea" : "fox";
  // In lane defense the invaders are the enemy even when they are named first.
  const invaders = /\b(zombie|goblin|skeleton|alien|robot|slime|ghost|orc|monster|bug|ant)s?\b/.exec(t)?.[1];
  const hero = genre === "builder" ? "marble" : genre === "defense" ? (/\b(cactus|mushroom|flower|tree|cannon|knight|archer|wizard|robot)s?\b/.exec(t)?.[1] ?? heroDefault) : creatures[0] ?? heroDefault;
  const enemyWord = /\b(slime|ghost|beetle|spider|crab|goblin|skeleton|zombie|drone|bat|alien)s?\b/.exec(t)?.[1];
  const enemy = (genre === "defense" ? invaders : undefined) ?? enemyWord ?? creatures.find((c) => c !== hero && !/bat|bird|bee|owl|firefly|butterfly/.test(c)) ?? (genre === "arena" ? "slime" : "slime");
  const flyer = creatures.find((c) => /bat|bird|bee|owl|firefly|butterfly|drone|ghost/.test(c) && c !== hero && c !== enemy) ?? (/(space|star)/.test(t) ? "drone" : "bat");
  const pickupMatch = /collect(?:s|ing)?\s+(?:the\s+|all\s+(?:the\s+)?)?(?:\w+\s+)?(\w+?)s?\b/.exec(t) ?? /\b(coins?|gems?|seeds?|stars?|acorns?|crystals?|berries|berry|keys?|orbs?|shells?|apples?|leaves|leaf)\b/.exec(t);
  let pickup = (pickupMatch?.[1] ?? (genre === "defense" ? (/plant|garden|lawn|flower|zombie/.test(t) ? "sun" : "gold") : "coin")).replace(/ies$/, "y").replace(/s$/, "");
  // Keys are their own item (they open doors), never the collectible.
  if (/^(key|thing|item|stuff|all|every)$/.test(pickup)) pickup = genre === "top-down" ? "gem" : "coin";
  const glowing = /\b(glow(ing)?|shiny|shining|sparkl\w*|magic)\b/.exec(t)?.[0];
  const setting = SETTINGS.find(([, re]) => re.test(t))?.[0] ?? (genre === "arena" ? "space" : genre === "puzzle" ? "desert" : "forest");
  const weather: Weather = /\brain(y|ing)?\b|storm/.test(t) ? "rain" : /\bsnow(y|ing)?\b|blizzard/.test(t) ? "snow" : /autumn|fall leaves|leaves/.test(t) ? "leaves" : /lava|volcano|ember/.test(t) ? "embers" : /underwater|ocean|reef/.test(t) ? "bubbles" : "none";
  const n = /\b(\d|three|four|five)\s+levels?\b/.exec(t);
  const count = n ? Math.max(3, Math.min(5, Number(n[1]) || { three: 3, four: 4, five: 5 }[n[1] as "three"] || 3)) : 3;
  const hard = /\b(hard|difficult|challenging|brutal|tough)\b/.test(t), easy = /\b(easy|gentle|relaxing|cozy|kids?|toddler|calm)\b/.test(t);
  const difficulty = hard ? 0.8 : easy ? 0.2 : 0.45;
  const mechanics: string[] = [];
  if (/moving platforms?/.test(t)) mechanics.push("moving platforms");
  if (/double[- ]jump/.test(t)) mechanics.push("double jump");
  if (/boss/.test(t)) mechanics.push("boss fight");
  if (/spring|bounce|trampoline/.test(t)) mechanics.push("springs");
  if (/key|lock|door/.test(t)) mechanics.push("keys and doors");
  if (/shoot|blast|laser/.test(t)) mechanics.push("shooting");
  if (!mechanics.length) mechanics.push(...defaultMechanics(genre));
  const pickupLabel = `${glowing ? glowing.replace(/ing$/, "ing") + " " : ""}${pickup}`;
  const title = genre === "defense" ? `${cap(enemy)}s at the Gate` : titleFor(hero, pickup, setting, glowing);
  const places = SETTING_PLACES[setting] ?? SETTING_PLACES.forest;
  const levels: LevelIdea[] = Array.from({ length: count }, (_, i) => ({
    name: places[i % places.length],
    story: i === 0 ? `The ${hero} sets out to find the ${pickupLabel}s.` : i === count - 1 ? (/boss/.test(t) ? `A giant ${enemy} guards the last ${pickup}.` : `The final stretch home.`) : `Deeper into the ${setting}, the way grows harder.`,
  }));
  return {
    route,
    ...(template ? { template: template.id } : {}),
    title: template && !/\b(called|named|title)\b/.test(t) ? template.title : title,
    pitch: idea.trim().replace(/^./, (c) => c.toUpperCase()).replace(/\.?$/, "."),
    genre,
    coreLoop: CORE_LOOP[genre].replace("{pickup}", pickupLabel + "s").replace("{hero}", hero),
    mechanics,
    levels,
    art: { style: /\bpainted|watercolou?r\b/.test(t) ? "painted" : /\bflat|vector|minimal\b/.test(t) ? "flat" : "pixel", palette: PALETTE_FOR[setting] ?? "forest", setting, hero, enemy, flyer, pickup: pickupLabel, weather },
    difficulty,
    boss: /boss/.test(t) || count >= 4,
    tuning: { playerSpeed: 7, jumpHeight: /high jump|jump high|higher jump/.test(t) ? 4.2 : 3.4, doubleJump: /double[- ]jump/.test(t), enemySpeed: easy ? 1.4 : hard ? 2.6 : 1.9, lives: easy ? 5 : hard ? 2 : 3, timeLimit: /timer|time limit|against the clock|race the clock/.test(t) ? 120 : 0 },
  };
}

const CORE_LOOP: Record<Genre, string> = {
  platformer: "Run, jump and stomp through each level, collecting {pickup} on the way to the goal.",
  runner: "The {hero} runs on its own; jump at the right moment to clear gaps and hazards and grab {pickup}.",
  "top-down": "Explore rooms, find the key, dodge or defeat enemies and reach the portal.",
  arena: "Survive each wave: keep moving and blast every enemy until the arena is clear.",
  puzzle: "Push crates onto pressure plates to open the gate, then reach the exit.",
  builder: "Place a few planks and springs, drop the marble, and guide it into the basket.",
  defense: "Earn {pickup}s, plant defenders in the lanes, and stop every wave before it reaches your home.",
};
function defaultMechanics(g: Genre): string[] {
  return {
    platformer: ["jumping", "stomping enemies", "moving platforms"],
    runner: ["auto-run", "timed jumps", "speed ramps up"],
    "top-down": ["exploration", "keys and doors", "shooting"],
    arena: ["waves", "aim assist shooting", "health pickups"],
    puzzle: ["pushing crates", "pressure plates", "gates"],
    builder: ["planks", "springs", "marble physics"],
    defense: ["lanes", "place defenders", "waves", "income"],
  }[g];
}
const SETTING_PLACES: Record<string, string[]> = {
  forest: ["Mossy Path", "Hollow Stumps", "Rain Canopy", "Old Bridge", "Heartwood"],
  desert: ["Sun Steps", "Dune Sea", "Mirage Ruins", "Scorpion Pass", "Oasis Gate"],
  snow: ["First Frost", "Icicle Cave", "Pine Ridge", "Blizzard Peak", "Aurora Hall"],
  space: ["Docking Bay", "Asteroid Belt", "Moon Base", "Nebula Drift", "Core Reactor"],
  ocean: ["Tide Pools", "Kelp Forest", "Coral Maze", "Sunken Ship", "Deep Trench"],
  lava: ["Ash Fields", "Ember Steps", "Magma Falls", "Obsidian Keep", "Heart of Fire"],
  candy: ["Sugar Lane", "Gumdrop Hills", "Caramel Falls", "Cocoa Caves", "Cake Castle"],
  night: ["Moonlit Lane", "Whisper Woods", "Lantern Hill", "Crooked Tower", "Midnight Gate"],
  cave: ["Cave Mouth", "Crystal Hollow", "Echo Tunnels", "Deep Mine", "Hidden Temple"],
  city: ["Rooftops", "Neon Alley", "Clock Tower", "Subway", "Skyline"],
};
function titleFor(hero: string, pickup: string, setting: string, glow?: string) {
  if (glow && pickup !== "coin") return cap(`${pickup}${/light|glow/.test(glow) ? "light" : "shine"}`);
  const map: Record<string, string> = { forest: "Woods", desert: "Dunes", snow: "Frost", space: "Stars", ocean: "Tides", lava: "Embers", candy: "Sweets", night: "Moon", cave: "Depths", city: "City" };
  return `${cap(hero)} and the ${map[setting] ?? "Wilds"}`;
}

// Merge a model's answer onto the idea-based design, clamping everything to safe values.
export function repairDesign(raw: unknown, base: DesignDoc): DesignDoc {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const str = (v: unknown, d: string, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : d);
  const word = (v: unknown, d: string) => {
    const s = typeof v === "string" ? v.toLowerCase().replace(/[^a-z \-]/g, "").trim().split(/\s+/).slice(-2).join(" ") : "";
    return s || d;
  };
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const art = r.art && typeof r.art === "object" ? r.art : {};
  const tn = r.tuning && typeof r.tuning === "object" ? r.tuning : {};
  const levels: LevelIdea[] = Array.isArray(r.levels)
    ? r.levels.filter((l: any) => l && typeof l.name === "string").slice(0, 5).map((l: any) => ({ name: l.name.slice(0, 40), story: str(l.story, "", 160) }))
    : [];
  while (levels.length < 3) levels.push(base.levels[levels.length] ?? { name: `Level ${levels.length + 1}`, story: "" });
  return {
    route: base.route === "genre" && r.fits === false ? "script" : base.route,
    ...(base.template ? { template: base.template } : {}),
    title: str(r.title, base.title, 60),
    pitch: str(r.pitch, base.pitch, 300),
    genre: GENRES.includes(r.genre) ? r.genre : base.genre,
    coreLoop: str(r.coreLoop, base.coreLoop, 300),
    mechanics: Array.isArray(r.mechanics) ? r.mechanics.filter((m: any) => typeof m === "string").slice(0, 6).map((m: string) => m.slice(0, 60)) : base.mechanics,
    levels,
    art: {
      style: ART_STYLES.includes(art.style) ? art.style : base.art.style,
      palette: PALETTE_NAMES.includes(art.palette) ? art.palette : base.art.palette,
      setting: word(art.setting, base.art.setting),
      hero: word(art.hero, base.art.hero),
      enemy: word(art.enemy, base.art.enemy),
      flyer: word(art.flyer, base.art.flyer),
      pickup: word(art.pickup, base.art.pickup),
      weather: WEATHERS.includes(art.weather) ? art.weather : base.art.weather,
    },
    difficulty: num(r.difficulty, 0, 1, base.difficulty),
    boss: typeof r.boss === "boolean" ? r.boss : base.boss,
    tuning: {
      playerSpeed: num(tn.playerSpeed, 4, 10, base.tuning.playerSpeed),
      jumpHeight: num(tn.jumpHeight, 2.5, 5, base.tuning.jumpHeight),
      doubleJump: typeof tn.doubleJump === "boolean" ? tn.doubleJump : base.tuning.doubleJump,
      enemySpeed: num(tn.enemySpeed, 1, 4, base.tuning.enemySpeed),
      lives: Math.round(num(tn.lives, 1, 5, base.tuning.lives)),
      timeLimit: Math.round(num(tn.timeLimit, 0, 300, base.tuning.timeLimit)),
    },
  };
}

export function designPrompt(idea: string) {
  return `Game idea: ${idea}`;
}
