// Plays a Studio2D Script game in a canvas: procedural sprites from each object's "look",
// Web Audio sound, keyboard, gamepad, mouse and touch, and the same title, pause, win and
// lose screens as built-in games.
import type { GameSpec, SfxPreset } from "../spec/types.ts";
import { SFX_PRESETS } from "../spec/types.ts";
import { ScriptGame, SCRIPT_W, SCRIPT_H, smokeTest, type Keys, type ScriptModule, type Obj } from "./script.ts";
import { makeCharacter, makeItem, archetypeOf, type SpriteSet, type Style } from "../assets/sprites.ts";
import { Mixer } from "../audio/mixer.ts";
import { InputMapper, padNames, BIT } from "../engine/input.ts";
import type { PlayerEvent } from "./player.ts";

const T = 16;
type Mode = "title" | "play" | "pause" | "won" | "lost" | "broken";

export class ScriptPlayer {
  spec: GameSpec;
  mod: ScriptModule;
  game: ScriptGame;
  canvas: HTMLCanvasElement;
  mixer: Mixer;
  input: InputMapper;
  mode: Mode = "title";
  menuIndex = 0;
  error = "";
  private low: HTMLCanvasElement;
  private sprites = new Map<string, { set: SpriteSet; frames: HTMLCanvasElement[] }>();
  private raf = 0;
  private last = 0;
  private acc = 0;
  private prevInput = 0;
  private hits: { x: number; y: number; w: number; h: number }[] = [];
  private view = { scale: 1, ox: 0, oy: 0 };
  private mouse = { x: 0, y: 0, down: false, clicked: false };
  private cleanup: (() => void)[] = [];
  private onEvent?: (e: PlayerEvent) => void;
  private seed = 1;

  constructor(canvas: HTMLCanvasElement, spec: GameSpec, mod: ScriptModule, opts: { onEvent?: (e: PlayerEvent) => void; skipTitle?: boolean } = {}) {
    this.canvas = canvas;
    this.spec = spec;
    this.mod = mod;
    this.onEvent = opts.onEvent;
    this.mixer = new Mixer(spec);
    this.input = new InputMapper(spec.controls);
    this.low = document.createElement("canvas");
    this.low.width = SCRIPT_W * T;
    this.low.height = SCRIPT_H * T;
    // Check the game before anyone plays it.
    const broken = (mod as { broken?: string }).broken;
    const check: { ok: boolean; error?: string; stack?: string } = broken ? { ok: false, error: `syntax error: ${broken}` } : smokeTest(mod, 600);
    if (!check.ok) check.error = withLine(check.error ?? "", check.stack);
    this.onEvent?.({ type: "script-check", ok: check.ok, error: check.error });
    this.game = this.fresh();
    if (!check.ok) {
      this.mode = "broken";
      this.error = check.error ?? "The game could not start.";
    } else if (opts.skipTitle) this.mode = "play";
    this.bind();
  }

  private fresh(): ScriptGame {
    try {
      return new ScriptGame(this.mod, this.seed++);
    } catch (e) {
      this.mode = "broken";
      this.error = (e as Error).message;
      return new ScriptGame({}, 1);
    }
  }

  start() {
    this.last = performance.now();
    const frame = (now: number) => {
      this.tick(Math.min(0.1, (now - this.last) / 1000));
      this.last = now;
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
  stop() {
    cancelAnimationFrame(this.raf);
  }
  destroy() {
    this.stop();
    this.mixer.destroy();
    for (const c of this.cleanup) c();
  }
  restart() {
    this.game = this.fresh();
    if (this.mode !== "broken") this.mode = "play";
  }

  private menu(): { title: string; subtitle?: string; items: string[] } | null {
    switch (this.mode) {
      case "title":
        return { title: this.spec.meta.title, subtitle: [this.spec.meta.pitch, this.spec.script?.howToPlay].filter(Boolean).join(" "), items: ["Play"] };
      case "pause":
        return { title: "Paused", items: ["Resume", "Restart"] };
      case "won":
        return { title: this.game.endText || "You win!", subtitle: `Score ${this.game.score}`, items: ["Play again"] };
      case "lost":
        return { title: this.game.endText || "Game over", subtitle: `Score ${this.game.score}`, items: ["Retry", "Quit to title"] };
      case "broken":
        return { title: "This game has a bug", subtitle: this.error, items: [] };
    }
    return null;
  }
  private choose(i: number) {
    const m = this.menu();
    const item = (m?.items[i] ?? "").toLowerCase();
    this.mixer.resume();
    if (this.mode === "pause" && item === "resume") this.mode = "play";
    else if (/quit/.test(item)) {
      this.game = this.fresh();
      this.mode = "title";
    } else if (item) {
      this.restart();
      this.mixer.stopMusic();
    }
    this.menuIndex = 0;
  }

  private keys(mask: number): Keys {
    return { left: !!(mask & BIT.left), right: !!(mask & BIT.right), up: !!(mask & BIT.up), down: !!(mask & BIT.down), jump: !!(mask & BIT.jump), action: !!(mask & BIT.action) };
  }

  tick(dt: number) {
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) ?? null : null;
    const inp = this.input.read(padNames(pads as any));
    const pressed = inp & ~this.prevInput;
    this.prevInput = inp;
    const m = this.menu();
    if (m) {
      if (pressed & BIT.up) this.menuIndex = (this.menuIndex + m.items.length - 1) % Math.max(1, m.items.length);
      if (pressed & BIT.down) this.menuIndex = (this.menuIndex + 1) % Math.max(1, m.items.length);
      if (pressed & (BIT.jump | BIT.action) && m.items.length) this.choose(this.menuIndex);
      else if (pressed & BIT.pause && this.mode === "pause") this.mode = "play";
    } else if (this.mode === "play") {
      if (pressed & BIT.pause) {
        this.mode = "pause";
      } else {
        this.acc += dt;
        let n = 0;
        while (this.acc >= 1 / 60 && n < 5) {
          try {
            this.game.step(this.keys(inp), this.mouse);
          } catch (e) {
            this.mode = "broken";
            this.error = withLine((e as Error).message, (e as Error).stack);
            this.onEvent?.({ type: "script-check", ok: false, error: this.error });
            break;
          }
          this.mouse.clicked = false;
          for (const ev of this.game.events) {
            if (ev.t === "sound") this.mixer.play((SFX_PRESETS.includes(ev.name as SfxPreset) ? ev.name : "coin") as SfxPreset);
            else if (ev.t === "music") this.mixer.playMusic(`music-${ev.mood}`);
          }
          this.acc -= 1 / 60;
          n++;
        }
        if (this.acc > 5 / 60) this.acc = 0;
        if (this.game.status === "won" || this.game.status === "lost") {
          this.mode = this.game.status;
          this.menuIndex = 0;
          this.onEvent?.({ type: this.game.status, level: 0, score: this.game.score, time: this.game.time } as PlayerEvent);
        }
      }
    }
    this.draw();
  }

  // ---------- drawing ----------

  private sprite(o: Obj): { set: SpriteSet; frames: HTMLCanvasElement[] } | null {
    if (!o.look) return null;
    const key = `${o.look}|${o.w.toFixed(2)}|${o.h.toFixed(2)}`;
    let s = this.sprites.get(key);
    if (!s) {
      const style = this.spec.meta.artStyle as Style;
      const seed = [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 100000;
      const character = archetypeOf(o.look, "none") !== "none";
      const set = character ? makeCharacter(o.look, [o.w, o.h], T, style, this.spec.meta.palette, seed) : makeItem(o.look, [o.w, o.h], T, style, this.spec.meta.palette, seed);
      const src = character ? [...(set.frames.walk ?? []), ...(set.frames.idle ?? [])] : set.frames.idle ?? [];
      const frames = src.map((p) => {
        const c = document.createElement("canvas");
        c.width = p.w;
        c.height = p.h;
        c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
        return c;
      });
      s = { set, frames };
      this.sprites.set(key, s);
      if (this.sprites.size > 300) this.sprites.delete(this.sprites.keys().next().value!);
    }
    return s;
  }

  private draw() {
    const dpr = globalThis.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const lw = SCRIPT_W * T, lh = SCRIPT_H * T;
    const s0 = Math.min(W / lw, H / lh);
    const scale = s0 >= 2 ? Math.floor(s0 * 4) / 4 : s0;
    this.view = { scale, ox: Math.round((W - lw * scale) / 2), oy: Math.round((H - lh * scale) / 2) };
    const ctx = this.low.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = /^#[0-9a-f]{3,8}$/i.test(this.game.bg) ? this.game.bg : "#1d2b3a";
    ctx.fillRect(0, 0, lw, lh);
    const time = this.game.time;
    for (const o of this.game.objs) {
      if (!o.alive || o.shape === "text") continue;
      const x = o.x * T, y = o.y * T, w = o.w * T, h = o.h * T;
      ctx.save();
      ctx.globalAlpha = typeof o.alpha === "number" ? Math.max(0, Math.min(1, o.alpha)) : 1;
      if (o.angle) {
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate((o.angle * Math.PI) / 180);
        ctx.translate(-(x + w / 2), -(y + h / 2));
      }
      const sp = o.shape === "sprite" ? this.sprite(o) : null;
      if (sp && sp.frames.length) {
        const moving = Math.abs(o.vx) + Math.abs(o.vy) > 0.2;
        const walk = sp.set.frames.walk?.length ?? 0;
        const idx = moving && walk ? Math.floor(time / 0.1) % walk : walk + (Math.floor(time / 0.2) % Math.max(1, sp.frames.length - walk));
        const img = sp.frames[Math.min(sp.frames.length - 1, idx)];
        const flip = o.flip ?? o.vx < -0.1;
        // Characters are drawn a little larger than their box, standing on its bottom.
        const fw = sp.set.archetype === "item" ? w : img.width, fh = sp.set.archetype === "item" ? h : img.height;
        const dx = x + w / 2 - fw / 2, dy = sp.set.archetype === "item" ? y : y + h - fh;
        if (flip) {
          ctx.translate(dx + fw, dy);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0, fw, fh);
        } else ctx.drawImage(img, Math.round(dx), Math.round(dy), fw, fh);
      } else {
        ctx.fillStyle = typeof o.color === "string" ? o.color : this.spec.meta.palette[4] ?? "#cccccc";
        if (o.shape === "circle") {
          ctx.beginPath();
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      }
      ctx.restore();
    }
    const out = this.canvas.getContext("2d")!;
    out.imageSmoothingEnabled = false;
    out.fillStyle = "#07090c";
    out.fillRect(0, 0, W, H);
    out.drawImage(this.low, this.view.ox, this.view.oy, lw * scale, lh * scale);
    this.hud(out, lw * scale, lh * scale);
  }

  private hud(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const k = this.view.scale;
    const fs = Math.max(12, Math.round(7 * k));
    const cell = T * k;
    ctx.save();
    ctx.translate(this.view.ox, this.view.oy);
    const text = (t: string, x: number, y: number, align: CanvasTextAlign = "left", color = "#fff", size = fs, weight = 700) => {
      ctx.font = `${weight} ${Math.round(size)}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = "top";
      ctx.lineWidth = Math.max(2, size / 5);
      ctx.strokeStyle = "rgba(10,12,20,0.75)";
      ctx.strokeText(t, x, y);
      ctx.fillStyle = color;
      ctx.fillText(t, x, y);
    };
    const g = this.game;
    for (const o of g.objs) if (o.alive && o.shape === "text" && o.text !== undefined) text(String(o.text), o.x * cell, o.y * cell, "left", typeof o.color === "string" ? o.color : "#fff", (o.size ?? 1) * cell);
    for (const t of g.texts) text(t.text, t.x * cell, t.y * cell, "left", t.color, t.size * cell);
    if (this.mode !== "title") {
      text(`★ ${g.score}`, fs * 0.8, fs * 0.6);
      if (g.lives > 0) text("♥".repeat(Math.min(10, g.lives)), W - fs * 0.8, fs * 0.6, "right", "#ff5c6b");
    }
    if (g.messageT > 0 && g.message) text(g.message, W / 2, H * 0.3, "center", "#fff4a0", fs * 1.3, 800);
    const m = this.menu();
    this.hits = [];
    if (m) {
      ctx.fillStyle = "rgba(8,10,18,0.72)";
      ctx.fillRect(0, 0, W, H);
      text(m.title, W / 2, H * 0.2, "center", "#fff", fs * 2.4, 800);
      if (m.subtitle) {
        ctx.font = `600 ${Math.round(fs)}px ui-rounded, system-ui, sans-serif`;
        const words = m.subtitle.split(/\s+/);
        let line = "", y = H * 0.2 + fs * 3.4;
        for (const w of words) {
          if (ctx.measureText(line + " " + w).width > W * 0.8 && line) {
            text(line, W / 2, y, "center", "rgba(255,255,255,0.85)", fs, 600);
            line = w;
            y += fs * 1.4;
          } else line = line ? `${line} ${w}` : w;
        }
        if (line) text(line, W / 2, y, "center", "rgba(255,255,255,0.85)", fs, 600);
      }
      m.items.forEach((it, i) => {
        const y = H * 0.55 + i * fs * 2.1;
        this.hits.push({ x: this.view.ox + W / 2 - fs * 9, y: this.view.oy + y - fs * 0.4, w: fs * 18, h: fs * 1.9 });
        if (i === this.menuIndex) {
          ctx.fillStyle = "rgba(255,255,255,0.14)";
          ctx.fillRect(W / 2 - fs * 9, y - fs * 0.4, fs * 18, fs * 1.9);
        }
        text(it, W / 2, y, "center", i === this.menuIndex ? "#fff4a0" : "#fff", fs * 1.3);
      });
    }
    ctx.restore();
  }

  // ---------- input ----------

  private bind() {
    const c = this.canvas;
    const on = (t: EventTarget, type: string, fn: (e: any) => void) => {
      t.addEventListener(type, fn);
      this.cleanup.push(() => t.removeEventListener(type, fn));
    };
    const target: EventTarget = c.tabIndex >= 0 ? c : window;
    on(target, "keydown", (e: KeyboardEvent) => {
      this.mixer.resume();
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
      this.input.keyDown(e.code);
    });
    on(target, "keyup", (e: KeyboardEvent) => this.input.keyUp(e.code));
    on(window, "blur", () => this.input.clear());
    const toCells = (e: PointerEvent) => {
      const r = c.getBoundingClientRect(), dpr = globalThis.devicePixelRatio || 1;
      const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
      return { px, py, x: (px - this.view.ox) / this.view.scale / T, y: (py - this.view.oy) / this.view.scale / T };
    };
    const hitAt = (px: number, py: number) => this.hits.findIndex((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    on(c, "pointermove", (e: PointerEvent) => {
      const p = toCells(e);
      this.mouse.x = p.x;
      this.mouse.y = p.y;
      if (this.menu()) {
        const i = hitAt(p.px, p.py);
        if (i >= 0) this.menuIndex = i;
        c.style.cursor = i >= 0 ? "pointer" : "";
      } else c.style.cursor = "";
    });
    on(c, "pointerdown", (e: PointerEvent) => {
      this.mixer.resume();
      c.focus?.();
      const p = toCells(e);
      if (this.menu()) {
        const i = hitAt(p.px, p.py);
        if (i >= 0) this.choose(i);
        return;
      }
      this.mouse.down = true;
      this.mouse.clicked = true;
      this.mouse.x = p.x;
      this.mouse.y = p.y;
    });
    on(c, "pointerup", () => (this.mouse.down = false));
    on(c, "contextmenu", (e: Event) => e.preventDefault());
  }
}

// Point at the line in the game's own code when the browser tells us where an error was.
function withLine(message: string, stack?: string): string {
  const base = (globalThis as { __studio2dScriptLine?: number }).__studio2dScriptLine;
  if (!stack || !base || /\(line \d+\)/.test(message)) return message;
  const m = /index\.html:(\d+):\d+|\.html:(\d+):\d+/.exec(stack);
  const line = m ? Number(m[1] ?? m[2]) - base : 0;
  return line > 0 ? `${message} (line ${line})` : message;
}
