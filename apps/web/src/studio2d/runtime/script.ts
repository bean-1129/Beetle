// Studio2D Script: for ideas no built-in genre covers, the local model writes a small game
// against this API (create + update). The code only ever runs inside the sandboxed game
// page (no network, no same-origin access), and it is checked twice before anyone plays it:
// a static check that refuses network, storage and page APIs, and a headless smoke test
// that plays it with random input and reports any error so the model can repair it.
import { mulberry, type Rng } from "../engine/rng.ts";

export type Obj = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  look?: string; // a recipe for procedural art: "zombie", "red car", "coin"
  color?: string;
  shape?: "rect" | "circle" | "sprite" | "text";
  tag?: string;
  text?: string;
  size?: number; // text size in cells
  gravity?: number;
  wrap?: boolean; // wrap around the screen edges
  bounded?: boolean; // stay inside the screen
  flip?: boolean;
  angle?: number; // degrees
  alpha?: number;
  alive: boolean;
  [k: string]: unknown;
};

export type Keys = { left: boolean; right: boolean; up: boolean; down: boolean; jump: boolean; action: boolean };
export type ScriptModule = { create?: (g: ScriptApi) => void; update?: (g: ScriptApi, dt: number) => void };
export type ScriptApi = ReturnType<ScriptGame["api"]>;
export type ScriptEvent = { t: "sound"; name: string } | { t: "music"; mood: string } | { t: "say"; text: string };

export const SCRIPT_W = 30;
export const SCRIPT_H = 17;
const DT = 1 / 60;

export class ScriptGame {
  objs: Obj[] = [];
  nextId = 1;
  time = 0;
  score = 0;
  lives = 0;
  level = 1;
  status: "playing" | "won" | "lost" = "playing";
  endText = "";
  message = "";
  messageT = 0;
  bg = "#1d2b3a";
  keys: Keys = { left: false, right: false, up: false, down: false, jump: false, action: false };
  prev: Keys = { ...this.keys };
  mouse = { x: 0, y: 0, down: false, clicked: false };
  events: ScriptEvent[] = [];
  texts: { x: number; y: number; text: string; size: number; color: string }[] = [];
  rng: Rng;
  private timers = new Map<string, number>();
  private mod: ScriptModule;
  private g: ReturnType<ScriptGame["api"]>;

  constructor(mod: ScriptModule, seed = 1) {
    this.mod = mod;
    this.rng = mulberry(seed);
    this.g = this.api();
    this.mod.create?.(this.g);
  }

  api() {
    const self = this;
    const overlap = (a: Obj, b: Obj) => a.alive && b.alive && a !== b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const pressed = {} as Keys;
    for (const k of Object.keys(this.keys) as (keyof Keys)[]) Object.defineProperty(pressed, k, { get: () => self.keys[k] && !self.prev[k], enumerable: true });
    // Friendly aliases people (and models) reach for: g.key.space, g.pressed.a, g.key.enter...
    const ALIAS: Record<string, keyof Keys> = { space: "jump", a: "left", d: "right", w: "up", s: "down", z: "jump", x: "action", enter: "action", fire: "action", shoot: "action", arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down" };
    const keyView = new Proxy(this.keys, { get: (t, p) => (typeof p === "string" && !(p in t) && ALIAS[p.toLowerCase()] ? t[ALIAS[p.toLowerCase()]] : (t as any)[p]) });
    const pressedView = new Proxy(pressed, { get: (t, p) => (typeof p === "string" && !(p in t) && ALIAS[p.toLowerCase()] ? t[ALIAS[p.toLowerCase()]] : (t as any)[p]) });
    return {
      W: SCRIPT_W,
      H: SCRIPT_H,
      get time() {
        return self.time;
      },
      get score() {
        return self.score;
      },
      set score(v: number) {
        self.score = Number(v) || 0;
      },
      get lives() {
        return self.lives;
      },
      set lives(v: number) {
        self.lives = Number(v) || 0;
      },
      get level() {
        return self.level;
      },
      set level(v: number) {
        self.level = Number(v) || 1;
      },
      key: keyView,
      pressed: pressedView,
      mouse: this.mouse,
      add(props: Partial<Obj> = {}): Obj {
        const o: Obj = { w: 1, h: 1, vx: 0, vy: 0, x: 0, y: 0, ...props, id: self.nextId++, alive: true };
        if (!o.shape) o.shape = o.text !== undefined ? "text" : o.look ? "sprite" : "rect";
        self.objs.push(o);
        if (self.objs.length > 3000) throw new Error("Too many objects (over 3000). Remove objects you no longer need.");
        return o;
      },
      remove(o: Obj | null | undefined) {
        if (o) o.alive = false;
      },
      all(tag?: string): Obj[] {
        return self.objs.filter((o) => o.alive && (tag === undefined || o.tag === tag));
      },
      first(tag: string): Obj | null {
        return self.objs.find((o) => o.alive && o.tag === tag) ?? null;
      },
      hit(a: Obj | null | undefined, b: Obj | null | undefined): boolean {
        return !!a && !!b && overlap(a, b);
      },
      hitAny(o: Obj | null | undefined, tag: string): Obj | null {
        if (!o) return null;
        return self.objs.find((b) => b.tag === tag && overlap(o, b)) ?? null;
      },
      hits(o: Obj | null | undefined, tag: string): Obj[] {
        if (!o) return [];
        return self.objs.filter((b) => b.tag === tag && overlap(o, b));
      },
      at(x: number, y: number, tag?: string): Obj | null {
        return self.objs.find((o) => o.alive && (tag === undefined || o.tag === tag) && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) ?? null;
      },
      rand: (a = 0, b = 1) => a + self.rng.next() * (b - a),
      randInt: (a: number, b: number) => self.rng.int(Math.ceil(a), Math.floor(b)),
      chance: (p: number) => self.rng.next() < p,
      pick: <T>(arr: T[]): T => arr[Math.floor(self.rng.next() * arr.length)],
      clamp: (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)),
      dist: (a: Obj, b: Obj) => Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2)),
      every(seconds: number, name = "default"): boolean {
        const t = self.timers.get(name) ?? 0;
        if (self.time >= t) {
          self.timers.set(name, self.time + Math.max(DT, seconds));
          return t > 0 || seconds <= DT; // first call only starts the clock
        }
        return false;
      },
      say(text: string, seconds = 2) {
        self.message = String(text).slice(0, 120);
        self.messageT = seconds;
      },
      text(x: number, y: number, text: string, size = 1, color = "#ffffff") {
        if (self.texts.length < 200) self.texts.push({ x, y, text: String(text).slice(0, 80), size, color });
      },
      win(text = "You win!") {
        if (self.status === "playing") {
          self.status = "won";
          self.endText = String(text).slice(0, 80);
          self.events.push({ t: "sound", name: "win" });
        }
      },
      lose(text = "Game over") {
        if (self.status === "playing") {
          self.status = "lost";
          self.endText = String(text).slice(0, 80);
          self.events.push({ t: "sound", name: "lose" });
        }
      },
      sound(name: string) {
        self.events.push({ t: "sound", name: String(name) });
      },
      music(mood: string) {
        self.events.push({ t: "music", mood: String(mood) });
      },
      background(color: string) {
        self.bg = String(color);
      },
    };
  }

  step(keys: Keys, mouse?: { x: number; y: number; down: boolean; clicked: boolean }) {
    if (this.status !== "playing") return;
    this.events = [];
    this.texts = [];
    Object.assign(this.prev, this.keys);
    Object.assign(this.keys, keys);
    if (mouse) Object.assign(this.mouse, mouse);
    this.time += DT;
    if (this.messageT > 0) this.messageT -= DT;
    this.mod.update?.(this.g, DT);
    for (const o of this.objs) {
      if (!o.alive) continue;
      if (o.gravity) o.vy += o.gravity * DT;
      o.x += (Number(o.vx) || 0) * DT;
      o.y += (Number(o.vy) || 0) * DT;
      if (o.wrap) {
        if (o.x + o.w < 0) o.x += SCRIPT_W + o.w;
        if (o.x > SCRIPT_W) o.x -= SCRIPT_W + o.w;
        if (o.y + o.h < 0) o.y += SCRIPT_H + o.h;
        if (o.y > SCRIPT_H) o.y -= SCRIPT_H + o.h;
      } else if (o.bounded) {
        o.x = Math.min(SCRIPT_W - o.w, Math.max(0, o.x));
        o.y = Math.min(SCRIPT_H - o.h, Math.max(0, o.y));
      } else if (o.x > SCRIPT_W + 12 || o.x + o.w < -12 || o.y > SCRIPT_H + 12 || o.y + o.h < -12) o.alive = false;
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) throw new Error(`Object ${o.tag ?? o.id} has an invalid position (x or y is not a number).`);
    }
    if (this.time % 2 < DT) this.objs = this.objs.filter((o) => o.alive);
    this.mouse.clicked = false;
  }
}

// ---------- safety and checks ----------

const FORBIDDEN: [RegExp, string][] = [
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection/, "network access"],
  [/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/, "storage"],
  [/\b(document|window|globalThis|self|parent|top|opener|frames|location|navigator)\s*[.[]/, "the page itself"],
  [/\b(eval|Function)\s*\(|\bimport\s*\(|\bimportScripts\b|\brequire\s*\(/, "running other code"],
  [/\b(Worker|SharedWorker|postMessage|setInterval|setTimeout|requestAnimationFrame)\b/, "timers or messages (use update and g.every instead)"],
  [/<\/?script/i, "script tags"],
];

export function checkScript(code: unknown): string[] {
  if (typeof code !== "string" || !code.trim()) return ["the script is empty"];
  const errs: string[] = [];
  if (code.length > 40000) errs.push("the script is too long (keep it under 40,000 characters)");
  const bare = code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  for (const [re, what] of FORBIDDEN) if (re.test(bare)) errs.push(`the script may not use ${what}`);
  if (!/function\s+update\s*\(|(?:const|let|var)\s+update\s*=/.test(bare)) errs.push("the script must define function update(g, dt)");
  return errs;
}

// Small models make the same few slips; fix them before anything runs.
export function autoFix(code: string): { code: string; fixes: string[] } {
  const fixes: string[] = [];
  let c = code.replace(/\r\n/g, "\n");
  // "g.every(1, 'x') { ... }" means "if (g.every(1, 'x')) { ... }".
  c = c.replace(/^(\s*)(g\.every\([^()\n]*\))\s*\{/gm, (_m, sp, call) => {
    fixes.push("wrapped g.every(...) in an if");
    return `${sp}if (${call}) {`;
  });
  // Code fences around the code.
  if (/^\s*```/.test(c)) {
    c = c.replace(/^\s*```[a-z]*\n?/, "").replace(/```\s*$/, "");
    fixes.push("removed code fences");
  }
  return { code: c, fixes };
}

// Wrap the code so it can be embedded as an inline script in the game page.
export function scriptWrapper(code: string): string {
  return `globalThis.__studio2dScript = (function () {\n${code}\n;return { create: typeof create === "function" ? create : undefined, update: typeof update === "function" ? update : undefined };\n})();`;
}

// Play a scripted game headless with random input. Returns the first error, or ok with
// what happened, so broken or empty games are caught before anyone sees them.
export function smokeTest(mod: ScriptModule, frames = 900, seed = 7): { ok: boolean; error?: string; stack?: string; objects: number; moved: boolean; ended?: string } {
  let game: ScriptGame;
  try {
    game = new ScriptGame(mod, seed);
  } catch (e) {
    return { ok: false, error: `create() failed: ${(e as Error).message}`, stack: (e as Error).stack, objects: 0, moved: false };
  }
  const rng = mulberry(seed);
  const start = new Map(game.objs.map((o) => [o.id, [o.x, o.y]]));
  let moved = false;
  const keys: Keys = { left: false, right: false, up: false, down: false, jump: false, action: false };
  let endedAt = "";
  try {
    for (let f = 0; f < frames; f++) {
      if (f % 12 === 0) for (const k of Object.keys(keys) as (keyof Keys)[]) keys[k] = rng.next() < 0.3;
      const click = f % 30 === 0;
      game.step(keys, { x: rng.next() * SCRIPT_W, y: rng.next() * SCRIPT_H, down: click, clicked: click });
      if (!moved) for (const o of game.objs) {
        const s = start.get(o.id);
        if (!s || Math.abs(s[0] - o.x) + Math.abs(s[1] - o.y) > 0.5) moved = true;
      }
      if (game.status !== "playing") {
        endedAt = `${game.status} after ${(game.time).toFixed(1)}s`;
        // Restart and keep testing: a game that ends is fine, a game that crashes is not.
        game = new ScriptGame(mod, seed + f);
      }
    }
  } catch (e) {
    return { ok: false, error: `update() failed after ${game.time.toFixed(1)}s: ${(e as Error).message}`, stack: (e as Error).stack, objects: game.objs.length, moved };
  }
  const objects = game.objs.filter((o) => o.alive).length;
  if (!objects) return { ok: false, error: "nothing is on screen: create() should add the player and the world with g.add()", objects, moved };
  if (!moved) return { ok: false, error: "nothing ever moves: set vx/vy or change x/y in update() in response to g.key", objects, moved };
  return { ok: true, objects, moved, ended: endedAt || undefined };
}

// Node and tests only: turn code into a module (pages embed it as an inline script instead).
export function compileScript(code: string): ScriptModule {
  return new Function(`${scriptWrapper(code)}\nreturn globalThis.__studio2dScript;`)() as ScriptModule;
}
