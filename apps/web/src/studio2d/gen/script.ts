// Scripted games: when an idea fits none of the built-in genres (Tetris, Pong, a racing
// game, a rhythm game...), the local model writes the game in Studio2D Script. The code is
// statically checked, then smoke-tested inside the sandboxed game page; errors go back to
// the model for a repair.
import type { GameSpec, Genre } from "../spec/types.ts";
import { assemble } from "../spec/kit.ts";
import { PALETTES } from "../spec/defaults.ts";
import { repairSpec } from "../spec/validate.ts";
import { placeholderLevel } from "../world/levels.ts";
import { checkScript } from "../runtime/script.ts";
import { FLAPPY } from "../samples/scripts.ts";
import type { DesignDoc } from "./design.ts";

// Well-known game types that no built-in genre plays properly.
export const SCRIPT_IDEAS = /\b(tetris|falling blocks|pong|snake|breakout|arkanoid|brick breaker|flappy|space invaders|galaga|asteroids|pac-?man|maze chase|frogger|crossy|match[- ]?3|bejeweled|candy crush|2048|minesweeper|sudoku|chess|checkers|tic[- ]tac[- ]toe|connect four|memory (game|cards)|card game|solitaire|racing|race car|kart|driving|fishing|rhythm|piano tiles|guitar hero|golf|mini golf|pinball|bowling|basketball|soccer|football|tennis|ping pong|air hockey|whack[- ]a[- ]mole|typing|quiz|trivia|clicker|idle game|cookie clicker|dodge|dodging|catch (the|falling)|stack(ing)? (blocks|tower)|bubble shooter|fruit ninja|slice|shooting gallery|duck hunt|lunar lander|missile command|tank|worms|sim(ulation)?|farm(ing)? sim|cooking|restaurant|stealth|boxing|fighting game)\b/;

export function wantsScript(idea: string): boolean {
  return SCRIPT_IDEAS.test(idea.toLowerCase());
}

export const SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    pitch: { type: "string" },
    howToPlay: { type: "string" },
    code: { type: "string" },
  },
  required: ["title", "pitch", "howToPlay", "code"],
};

export const SCRIPT_API = `Studio2D Script API. Write plain JavaScript with two functions:
  function create(g) { ... }      // once, set up the game
  function update(g, dt) { ... }  // 60 times a second, dt = 1/60
The screen is g.W = 30 by g.H = 17 cells; x grows right, y grows down. Positions and sizes are in cells.
Objects:  const o = g.add({ x, y, w, h, look: "zombie", tag: "enemy", vx, vy })
  look = a short description drawn as pixel art ("red car", "zombie", "coin", "apple", "heart", "tree", "spaceship", "ghost").
  Or no look and color: "#ff6b8a" with shape: "rect" or "circle" for simple blocks. text: "Hi" makes a text object (size in cells).
  Fields you may set any time: x, y, w, h, vx, vy (cells per second, applied automatically), gravity (cells/s², pulls down),
  wrap: true (wraps around edges), bounded: true (stays on screen), angle (degrees), flip, alpha, look, color, text, tag.
  Objects that leave the screen by more than 12 cells are removed automatically.
g.remove(o) · g.all("tag") → array · g.first("tag") · g.hit(a, b) → true if touching · g.hitAny(o, "tag") → object or null · g.hits(o, "tag") → array · g.at(x, y, "tag")
Input: g.key.left/right/up/down/jump/action (held) · g.pressed.left/right/up/down/jump/action (just pressed this frame) · g.mouse.x, g.mouse.y, g.mouse.down, g.mouse.clicked
Arrows or WASD are left/right/up/down, Space is jump, X or Enter is action.
Random: g.rand(a, b) · g.randInt(a, b) · g.chance(0.3) · g.pick(array). Helpers: g.clamp(v, a, b) · g.dist(a, b) · g.every(seconds, "name") → true once per interval.
Game: g.score, g.lives, g.level (numbers you set) · g.say("text") shows a message · g.text(x, y, "text", size) draws text this frame
g.win("text") and g.lose("text") end the game (the player gets Retry) · g.sound("jump"|"coin"|"hit"|"explosion"|"powerup"|"shoot"|"bounce"|"break"|"door") · g.music("adventure"|"calm"|"tense"|"boss") · g.background("#hex")
Keep your own state on g (for example g.player = g.add(...), g.state = {...}).
Not allowed: fetch, document, window, localStorage, setTimeout, setInterval, eval, import. Use update() and g.every() for timing.`;

export const SCRIPT_SYSTEM = `You write small, complete, fun 2D games in Studio2D Script. Reply only with JSON: {"title","pitch","howToPlay","code"}.
${SCRIPT_API}
Rules: playable right away with the keyboard (and the mouse if it suits); create() adds the player and the world; update() reacts to input; keep score; end with g.win or g.lose. Under 120 lines. Use looks for characters and items.
Example:
${FLAPPY}`;

export function scriptPrompt(idea: string, d?: DesignDoc) {
  return `Make this game: ${idea}${d ? `\nTitle idea: ${d.title}. Setting: ${d.art.setting}. Hero: ${d.art.hero}.` : ""}`;
}
export function repairPrompt(idea: string, code: string, error: string) {
  return `Game idea: ${idea}\nThis code has a problem: ${error.slice(0, 400)}\nFix it and return the whole corrected game.\n\nCode:\n${code.slice(0, 12000)}`;
}

// The genre whose defaults (controls, palette, sounds) suit a scripted idea best.
export function closestGenre(idea: string): Genre {
  const t = idea.toLowerCase();
  if (/shoot|invaders|galaga|asteroids|missile|tank|duck/.test(t)) return "arena";
  if (/puzzle|tetris|match|2048|sudoku|minesweeper|chess|checkers|tic|connect|memory|card|solitaire/.test(t)) return "puzzle";
  if (/race|racing|kart|driving|flappy|dodge|runner/.test(t)) return "runner";
  if (/pac|maze|frogger|crossy|stealth/.test(t)) return "top-down";
  return "platformer";
}

export function scriptedSpec(p: { title: string; pitch: string; howToPlay?: string; code: string; idea: string; palette?: string; model?: string }): GameSpec {
  const genre = closestGenre(p.idea);
  const spec = assemble({ title: p.title.slice(0, 60) || "My game", pitch: p.pitch.slice(0, 300), genre, palette: PALETTES[p.palette ?? ""] ?? undefined }, [{ ...placeholderLevel(), id: "game", name: p.title.slice(0, 40) || "Game" }]);
  spec.script = { code: p.code, howToPlay: p.howToPlay?.slice(0, 300), ...(p.model ? { model: p.model } : {}) };
  return repairSpec(spec).spec;
}

export function scriptProblems(code: unknown): string[] {
  return checkScript(code);
}
