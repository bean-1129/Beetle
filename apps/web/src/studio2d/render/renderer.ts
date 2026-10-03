// Canvas renderer. The world draws into a small pixel-art canvas (30×17 tiles), which is then
// scaled up crisply onto the display canvas; HUD, dialogue and menus draw at full
// resolution on top so text stays sharp. Particles and weather are visual only and never
// touch the simulation.
import type { GameSpec } from "../spec/types.ts";
import type { BuiltAssets } from "../assets/pipeline.ts";
import type { Pixels } from "../assets/pixels.ts";
import { packSheet } from "../assets/sheet.ts";
import { FRAME_COUNT, FRAME_TIME, type Anim } from "../assets/rig.ts";
import { blobIndexAt, BLOB_INDEX } from "../assets/tiles.ts";
import type { Ent, Game, GameEvent } from "../engine/game.ts";
import { T as TT, tileAt } from "../engine/physics.ts";

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; g: number };

function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
function toCanvas(p: Pixels): Canvas {
  const c = makeCanvas(p.w, p.h);
  const ctx = c.getContext("2d") as Ctx;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  return c;
}

export type MenuView = { title: string; subtitle?: string; items: string[]; selected: number; footer?: string };
export type Overlay = {
  menu?: MenuView;
  banner?: string;
  toast?: string;
  builder?: { selected: number; angle: number; hover?: [number, number] };
  defense?: { selected: number; hover?: [number, number] | null; cursor: [number, number]; keyboard: boolean };
  paused?: boolean;
};

export class Renderer {
  canvas: HTMLCanvasElement;
  spec!: GameSpec;
  assets!: BuiltAssets;
  tile = 16;
  vw = 30;
  vh = 17;
  low!: Canvas;
  lctx!: Ctx;
  sheet!: Canvas;
  rects: Record<string, [number, number, number, number]> = {};
  tileImgs: Record<string, { solid: Canvas[]; wall: Canvas[]; oneway: Canvas; spike: Canvas; water: Canvas; breakable: Canvas; floor: Canvas }> = {};
  bgs: Record<string, Canvas> = {};
  particles: Particle[] = [];
  weather: Particle[] = [];
  time = 0;
  shake = 0;
  private fx = Math.random;
  palette: string[] = [];
  view = { scale: 1, ox: 0, oy: 0 };
  // Where each menu item was drawn (canvas pixels), so clicks and hovers can pick items.
  menuHits: { x: number; y: number; w: number; h: number }[] = [];
  shopHits: { x: number; y: number; w: number; h: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  load(spec: GameSpec, assets: BuiltAssets) {
    this.spec = spec;
    this.assets = assets;
    this.tile = assets.tile;
    this.palette = spec.meta.palette;
    this.low = makeCanvas(this.vw * this.tile, this.vh * this.tile);
    this.lctx = this.low.getContext("2d") as Ctx;
    this.lctx.imageSmoothingEnabled = false;
    const items: { key: string; img: Pixels }[] = [];
    for (const [id, set] of Object.entries(assets.sprites))
      for (const [anim, frames] of Object.entries(set.frames)) frames?.forEach((f, i) => items.push({ key: `${id}:${anim}:${i}`, img: f }));
    const sheet = packSheet(items, 2048);
    this.sheet = toCanvas(sheet.image);
    this.rects = sheet.rects;
    this.tileImgs = {};
    for (const [id, ts] of Object.entries(assets.tilesets))
      this.tileImgs[id] = {
        solid: ts.solid.map(toCanvas),
        wall: ts.wall.map(toCanvas),
        oneway: toCanvas(ts.oneway),
        spike: toCanvas(ts.spike),
        water: toCanvas(ts.water),
        breakable: toCanvas(ts.breakable),
        floor: toCanvas(ts.floor),
      };
    this.bgs = {};
    for (const [id, bg] of Object.entries(assets.backgrounds)) this.bgs[id] = toCanvas(bg);
    this.particles = [];
    this.weather = [];
  }

  // Swap one asset (for example, generated art replacing its placeholder) without a reload.
  replaceAssets(assets: BuiltAssets) {
    this.load(this.spec, assets);
  }

  resize() {
    const dpr = globalThis.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const lw = this.vw * this.tile, lh = this.vh * this.tile;
    const s = Math.min(w / lw, h / lh);
    // Quarter steps keep pixels nearly square while still filling the view.
    const scale = s >= 2 ? Math.floor(s * 4) / 4 : s;
    this.view = { scale, ox: Math.round((w - lw * scale) / 2), oy: Math.round((h - lh * scale) / 2) };
  }

  // Which menu item is under a screen point, or -1.
  menuItemAt(cx: number, cy: number): number {
    const dpr = globalThis.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const x = (cx - r.left) * dpr, y = (cy - r.top) * dpr;
    return this.menuHits.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  }

  // Screen pixel → world tile coordinates (builder placement).
  screenToTile(game: Game, cx: number, cy: number): [number, number] {
    const dpr = globalThis.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const x = ((cx - r.left) * dpr - this.view.ox) / this.view.scale / this.tile + game.s.cam.x;
    const y = ((cy - r.top) * dpr - this.view.oy) / this.view.scale / this.tile + game.s.cam.y;
    return [x, y];
  }

  events(evts: GameEvent[]) {
    const T = this.tile;
    for (const e of evts) {
      const x = e.x * T, y = e.y * T;
      switch (e.t) {
        case "coin":
        case "powerup":
        case "checkpoint":
          this.burst(x, y, 10, ["#fff4a0", "#ffd35c", "#ffffff"], 60, 0);
          break;
        case "jump":
          this.burst(x, y + T * 0.4, 5, ["#d8d8d8", "#ffffff"], 30, 40);
          break;
        case "hit":
          this.burst(x, y, 8, ["#ff6b6b", "#ffffff"], 70, 60);
          this.shake = Math.max(this.shake, 3);
          break;
        case "defeat":
        case "stomp":
          this.burst(x, y, 14, ["#ffffff", "#d8d8d8", this.palette[3] || "#aaa"], 80, 80);
          break;
        case "break":
        case "crumble":
          this.burst(x, y, 12, ["#8a6a4a", "#5e3423", "#c49a6c"], 90, 300);
          break;
        case "bounce":
          this.burst(x, y, 6, ["#ffffff"], 50, 0);
          break;
        case "win":
        case "goal":
          this.burst(x, y, 40, ["#ffd35c", "#ff6b8a", "#5cf2d6", "#9fb4ff", "#ffffff"], 160, 120);
          break;
        case "die":
          this.burst(x, y, 20, ["#ffffff", "#ff6b6b"], 120, 100);
          this.shake = 6;
          break;
        case "shoot":
          this.burst(x, y, 3, ["#fff4a0"], 30, 0);
          break;
      }
    }
  }

  private burst(x: number, y: number, n: number, colors: string[], speed: number, g: number) {
    for (let i = 0; i < n; i++) {
      const a = this.fx() * Math.PI * 2, s = speed * (0.3 + this.fx() * 0.7);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.3, life: 0, max: 0.3 + this.fx() * 0.5, color: colors[i % colors.length], size: this.fx() < 0.3 ? 2 : 1, g });
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  private stepParticles(dt: number, game: Game) {
    for (const p of this.particles) {
      p.life += dt;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    const level = game.level;
    const kind = level.weather ?? "none";
    if (kind === "none") {
      this.weather = [];
      return;
    }
    const amount = level.weatherAmount ?? 0.5;
    const W = this.vw * this.tile, H = this.vh * this.tile;
    const want = Math.round(amount * (kind === "rain" ? 160 : 70));
    while (this.weather.length < want) {
      const base = { x: this.fx() * W, y: this.fx() * H - H, life: 0, max: 99, size: 1, g: 0 };
      if (kind === "rain") this.weather.push({ ...base, vx: -30, vy: 260 + this.fx() * 80, color: "rgba(180,210,255,0.55)" });
      else if (kind === "snow") this.weather.push({ ...base, vx: -8 + this.fx() * 16, vy: 18 + this.fx() * 20, color: "rgba(255,255,255,0.9)", size: this.fx() < 0.4 ? 2 : 1 });
      else if (kind === "leaves") this.weather.push({ ...base, vx: -20 - this.fx() * 20, vy: 20 + this.fx() * 15, color: this.fx() < 0.5 ? "#e08a3c" : "#b0413e", size: 2 });
      else if (kind === "embers") this.weather.push({ ...base, y: H + this.fx() * H, vx: -5 + this.fx() * 10, vy: -25 - this.fx() * 25, color: this.fx() < 0.5 ? "#ffcf5c" : "#f2781c" });
      else this.weather.push({ ...base, y: H + this.fx() * H, vx: 0, vy: -20 - this.fx() * 20, color: "rgba(220,245,255,0.6)", size: 2 });
    }
    for (const p of this.weather) {
      p.x += p.vx * dt + (kind === "snow" || kind === "leaves" ? Math.sin(this.time * 2 + p.y * 0.05) * 0.3 : 0);
      p.y += p.vy * dt;
      if (p.y > H + 4) p.y -= H + 8;
      if (p.y < -H - 8) p.y += H * 2;
      if (p.x < -4) p.x += W + 8;
      if (p.x > W + 4) p.x -= W + 8;
    }
    if (this.weather.length > want) this.weather.length = want;
  }

  draw(game: Game, dt: number, overlay: Overlay = {}) {
    this.time += dt;
    this.resize();
    this.stepParticles(dt, game);
    const ctx = this.lctx;
    const T = this.tile;
    const W = this.vw * T, H = this.vh * T;
    const cam = game.s.cam;
    const shakeX = this.shake > 0 ? (this.fx() - 0.5) * this.shake : 0;
    const shakeY = this.shake > 0 ? (this.fx() - 0.5) * this.shake : 0;
    this.shake = Math.max(0, this.shake - dt * 20);
    const camX = Math.round(cam.x * T + shakeX), camY = Math.round(cam.y * T + shakeY);
    ctx.fillStyle = this.palette[0] || "#101418";
    ctx.fillRect(0, 0, W, H);
    // Parallax layers.
    const side = game.s.grid.sideView;
    for (const layer of game.level.background) {
      const img = this.bgs[layer.asset];
      if (!img) continue;
      if (!side && layer.speed > 0.1) continue; // top-down: sky only, the floor covers the rest
      const iw = img.width;
      const off = -((camX * layer.speed) % iw);
      const y = layer.y ?? Math.round(-camY * layer.speed * 0.3);
      for (let x = off - iw; x < W; x += iw) ctx.drawImage(img as CanvasImageSource, Math.round(x), y);
    }
    this.drawTiles(game, camX, camY);
    if (game.level.lanes) this.drawLanes(game, camX, camY, overlay);
    // Entities, back to front: platforms and props first, then pickups, enemies, player.
    const order = (e: Ent) => (e.uid === game.s.playerUid ? 5 : e.kind === "enemy" ? 4 : e.kind === "pickup" ? 3 : e.kind === "npc" ? 2 : 1);
    const ents = game.s.ents.filter((e) => e.alive && !e.hidden && !(game.level.lanes && game.bh(e, "spawner"))).sort((a, b) => order(a) - order(b));
    for (const e of ents) this.drawEnt(game, e, camX, camY);
    // Builder ghost part.
    if (overlay.builder?.hover && game.s.status === "build") {
      const parts = game.level.parts || [];
      const sel = parts[overlay.builder.selected];
      const def = sel && game.defs.get(sel.def);
      if (def) {
        const [hx, hy] = overlay.builder.hover;
        ctx.save();
        ctx.globalAlpha = 0.55;
        const w = def.size[0] * T, h = def.size[1] * T;
        const cx = (Math.floor(hx) + 0.5) * T - camX, cy = (Math.floor(hy) + 1) * T - h / 2 - camY;
        ctx.translate(cx, cy);
        ctx.rotate(((sel.def === "plank" ? overlay.builder.angle : 0) * Math.PI) / 180);
        this.blitSprite(def.sprite, "idle", 0, -w / 2, -h / 2, w, h, false);
        ctx.restore();
      }
    }
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x - camX), Math.round(p.y - camY), p.size, p.size);
    }
    ctx.globalAlpha = 1;
    for (const p of this.weather) {
      ctx.fillStyle = p.color;
      if (p.vy > 200) ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 4);
      else ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    if (game.level.tint) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = game.level.tint;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    // Scale up to the display canvas.
    const out = this.canvas.getContext("2d")!;
    out.imageSmoothingEnabled = false;
    out.fillStyle = "#07090c";
    out.fillRect(0, 0, this.canvas.width, this.canvas.height);
    out.drawImage(this.low as CanvasImageSource, this.view.ox, this.view.oy, W * this.view.scale, H * this.view.scale);
    this.drawHud(out, game, overlay);
  }

  private drawTiles(game: Game, camX: number, camY: number) {
    const ctx = this.lctx;
    const T = this.tile;
    const g = game.s.grid;
    const imgs = this.tileImgs[game.level.tileset] || Object.values(this.tileImgs)[0];
    if (!imgs) return;
    const x0 = Math.floor(camX / T) - 1, y0 = Math.floor(camY / T) - 1;
    const x1 = x0 + this.vw + 2, y1 = y0 + this.vh + 2;
    const solid = (x: number, y: number) => {
      if (x < 0 || x >= g.w) return true;
      if (y < 0) return !g.sideView;
      if (y >= g.h) return true;
      const t = tileAt(g, x, y);
      return t === TT.SOLID || t === TT.WALL || (!g.sideView && t === TT.BREAK);
    };
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || y < 0 || x >= g.w) continue;
        // Below a short side-view level, solid columns continue down to the screen edge.
        if (y >= g.h) {
          if (!g.sideView || tileAt(g, x, g.h - 1) !== TT.SOLID) continue;
          ctx.drawImage(imgs.solid[BLOB_INDEX.get(255)!] as CanvasImageSource, x * T - camX, y * T - camY);
          continue;
        }
        const t = tileAt(g, x, y);
        const dx = x * T - camX, dy = y * T - camY;
        if (!g.sideView && t !== TT.SOLID && t !== TT.WALL) ctx.drawImage(imgs.floor as CanvasImageSource, dx, dy);
        let img: Canvas | null = null;
        if (t === TT.SOLID || t === TT.WALL) img = (g.sideView ? imgs.solid : imgs.wall)[blobIndexAt(solid, x, y)] ?? imgs.solid[BLOB_INDEX.get(255)!];
        else if (t === TT.ONEWAY) img = imgs.oneway;
        else if (t === TT.SPIKE) img = imgs.spike;
        else if (t === TT.WATER) img = imgs.water;
        else if (t === TT.BREAK) img = imgs.breakable;
        if (img) {
          if (t === TT.WATER) {
            ctx.globalAlpha = 0.85;
            ctx.drawImage(img as CanvasImageSource, dx + Math.round(Math.sin(this.time * 2 + x) * 1), dy);
            ctx.globalAlpha = 1;
          } else ctx.drawImage(img as CanvasImageSource, dx, dy);
        }
      }
  }

  private blitSprite(asset: string, anim: string, frame: number, x: number, y: number, w: number, h: number, flip: boolean) {
    const set = this.assets.sprites[asset];
    const a = set?.frames[anim as Anim] ? anim : "idle";
    const n = set?.frames[a as Anim]?.length ?? 0;
    const r = this.rects[`${asset}:${a}:${n ? frame % n : 0}`];
    const ctx = this.lctx;
    if (!r) {
      ctx.fillStyle = this.palette[4] || "#ccc";
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      return;
    }
    if (flip) {
      ctx.save();
      ctx.translate(Math.round(x + w), Math.round(y));
      ctx.scale(-1, 1);
      ctx.drawImage(this.sheet as CanvasImageSource, r[0], r[1], r[2], r[3], 0, 0, w, h);
      ctx.restore();
    } else ctx.drawImage(this.sheet as CanvasImageSource, r[0], r[1], r[2], r[3], Math.round(x), Math.round(y), w, h);
  }

  private drawEnt(game: Game, e: Ent, camX: number, camY: number) {
    const ctx = this.lctx;
    const T = this.tile;
    if (e.inv > 0 && e.uid === game.s.playerUid && Math.floor(this.time * 20) % 2 === 0) return;
    if (e.sprite === "__shot") {
      ctx.fillStyle = e.friendly ? "#fff4a0" : "#ff6b8a";
      const cx = (e.x + e.w / 2) * T - camX, cy = (e.y + e.h / 2) * T - camY;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1.5, e.w * T * 0.5), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const set = this.assets.sprites[e.sprite];
    const door = game.bh(e, "door");
    const sw = game.bh(e, "switch");
    const wind = game.bh(e, "wind-zone");
    const anim = (set?.frames[e.anim as Anim] ? e.anim : "idle") as Anim;
    const ft = FRAME_TIME[anim] ?? 0.15;
    const count = set?.frames[anim]?.length ?? 1;
    const frame = set?.archetype === "item" ? Math.floor(this.time / 0.15) % count : Math.floor(e.animT / ft) % (FRAME_COUNT[anim] ? count : 1);
    const fw = set ? set.w : e.w * T, fh = set ? set.h : e.h * T;
    const character = set && set.archetype !== "item";
    let x = character ? (e.x + e.w / 2) * T - fw / 2 : e.x * T;
    let y = character ? (e.y + e.h) * T - fh + 1 : e.y * T;
    const w = character ? fw : e.w * T, h = character ? fh : e.h * T;
    x -= camX;
    y -= camY;
    if (door?.s.open) ctx.globalAlpha = 0.22;
    if (sw?.s.pressed || (sw && game.s.toggles[sw.p.link])) y += 2;
    if (wind) {
      ctx.globalAlpha = 0.35 + 0.15 * Math.sin(this.time * 6);
      this.blitSprite(e.sprite, "idle", 0, x, y - ((this.time * 30) % (T / 2)), w, h, false);
      ctx.globalAlpha = 1;
      return;
    }
    if (game.bh(e, "falling-platform")?.s.armed && !game.bh(e, "falling-platform")?.s.falling) x += Math.sin(this.time * 60) * 0.8;
    if (e.angle || (e.shape === "circle" && game.genre === "builder")) {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      const roll = e.shape === "circle" ? (e.x / (e.w / 2)) : (e.angle * Math.PI) / 180;
      ctx.rotate(roll);
      this.blitSprite(e.sprite, anim, frame, -w / 2, -h / 2, w, h, false);
      ctx.restore();
    } else this.blitSprite(e.sprite, anim, frame, x, y, w, h, e.facing < 0);
    ctx.globalAlpha = 1;
    // Lit checkpoints glow.
    if (game.bh(e, "checkpoint")?.s.active) {
      ctx.globalAlpha = 0.25 + 0.1 * Math.sin(this.time * 4);
      ctx.fillStyle = "#ffcf5c";
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h * 0.25, T * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // Health bars: bosses always, lane units and invaders once hurt.
    if ((e.tags.includes("boss") && e.maxHp > 1) || (game.level.lanes && (e.kind === "unit" || e.kind === "enemy") && e.hp < e.maxHp)) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(Math.round(x), Math.round(y) - 5, Math.round(w), 3);
      ctx.fillStyle = "#ff5c6b";
      ctx.fillRect(Math.round(x), Math.round(y) - 5, Math.round((w * Math.max(0, e.hp)) / e.maxHp), 3);
    }
  }

  // Lane defense: a mown-lawn checkerboard, the hovered cell and a preview of the unit.
  private drawLanes(game: Game, camX: number, camY: number, overlay: Overlay) {
    const ctx = this.lctx;
    const T = this.tile;
    const g = game.level.lanes!;
    for (let r = 0; r < g.rows; r++)
      for (let c = 0; c < g.cols; c++) {
        ctx.fillStyle = (r + c) % 2 ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.07)";
        ctx.fillRect((g.x0 + c * g.cell) * T - camX, (g.y0 + r * g.cell) * T - camY, g.cell * T, g.cell * T);
      }
    // The home edge the invaders must not cross.
    ctx.fillStyle = "rgba(90,50,30,0.55)";
    ctx.fillRect(g.x0 * T - camX - 3, g.y0 * T - camY, 3, g.rows * g.cell * T);
    const d = overlay.defense;
    if (!d || game.s.status !== "playing") return;
    const cell = d.keyboard ? d.cursor : d.hover;
    if (!cell) return;
    const [c, r] = cell;
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return;
    const item = game.level.shop?.[d.selected];
    const ok = item ? !game.canPlace(item.def, c, r) : false;
    const x = (g.x0 + c * g.cell) * T - camX, y = (g.y0 + r * g.cell) * T - camY;
    ctx.strokeStyle = ok ? "rgba(255,255,255,0.9)" : "rgba(255,110,110,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, g.cell * T - 1, g.cell * T - 1);
    const def = item && game.defs.get(item.def);
    if (def && !game.unitAt(c, r)) {
      ctx.globalAlpha = ok ? 0.55 : 0.25;
      const w = def.size[0] * T, h = def.size[1] * T;
      this.blitSprite(def.sprite, "idle", 0, x + (g.cell * T - w) / 2, y + (g.cell * T - h) / 2, w, h, false);
      ctx.globalAlpha = 1;
    }
  }

  // Which shop slot is under a screen point, or -1.
  shopItemAt(cx: number, cy: number): number {
    const dpr = globalThis.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const x = (cx - r.left) * dpr, y = (cy - r.top) * dpr;
    return this.shopHits.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  }
  // Screen point → lane cell, or null.
  cellAt(game: Game, cx: number, cy: number): [number, number] | null {
    const g = game.level.lanes;
    if (!g) return null;
    const [x, y] = this.screenToTile(game, cx, cy);
    const c = Math.floor((x - g.x0) / g.cell), r = Math.floor((y - g.y0) / g.cell);
    return c >= 0 && r >= 0 && c < g.cols && r < g.rows ? [c, r] : null;
  }

  private drawShop(ctx: CanvasRenderingContext2D, game: Game, overlay: Overlay, fs: number) {
    const shop = game.level.shop ?? [];
    const k = this.view.scale;
    const T = this.tile * k;
    const slotW = T * 3.1, slotH = T * 1.8, gap = T * 0.25;
    const x0 = T * 5.5, y0 = T * 0.1;
    this.shopHits = [];
    shop.forEach((item, i) => {
      const x = x0 + i * (slotW + gap), y = y0;
      this.shopHits.push({ x: this.view.ox + x, y: this.view.oy + y, w: slotW, h: slotH });
      const cd = game.s.cooldowns[item.def] ?? 0;
      const afford = game.s.currency >= item.cost;
      const selected = overlay.defense?.selected === i;
      ctx.fillStyle = selected ? "rgba(255,244,160,0.28)" : "rgba(12,14,24,0.55)";
      roundRect(ctx, x, y, slotW, slotH, fs * 0.4);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = "#fff4a0";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const def = game.defs.get(item.def);
      const r = def && this.rects[`${def.sprite}:idle:0`];
      ctx.globalAlpha = afford && cd <= 0 ? 1 : 0.4;
      if (r) {
        const s = Math.min((slotH * 0.86) / r[3], (slotW * 0.45) / r[2]);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.sheet as CanvasImageSource, r[0], r[1], r[2], r[3], x + fs * 0.3, y + (slotH - r[3] * s) / 2, r[2] * s, r[3] * s);
      }
      ctx.fillStyle = afford ? "#fff4a0" : "#ff9b93";
      ctx.font = `800 ${Math.round(fs * 1.05)}px ui-rounded, system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(String(item.cost), x + slotW - fs * 0.4, y + fs * 0.25);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = `600 ${Math.round(fs * 0.7)}px ui-rounded, system-ui, sans-serif`;
      ctx.fillText(`${i + 1}`, x + slotW - fs * 0.4, y + slotH - fs * 0.95);
      ctx.globalAlpha = 1;
      if (cd > 0) {
        const total = item.cooldown || 1;
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(x, y + slotH * (1 - cd / total), slotW, slotH * (cd / total));
      }
    });
  }

  // ---------- HUD and menus (full resolution) ----------

  private drawHud(ctx: CanvasRenderingContext2D, game: Game, overlay: Overlay) {
    const s = game.s;
    const k = this.view.scale;
    const pad = Math.round(8 * k * 0.5 + 6);
    const fs = Math.max(12, Math.round(7 * k));
    ctx.save();
    ctx.translate(this.view.ox, this.view.oy);
    const W = this.vw * this.tile * k;
    const H = this.vh * this.tile * k;
    ctx.font = `700 ${fs}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    const text = (t: string, x: number, y: number, align: CanvasTextAlign = "left", color = "#ffffff") => {
      ctx.textAlign = align;
      ctx.lineWidth = Math.max(2, fs / 5);
      ctx.strokeStyle = "rgba(10,12,20,0.75)";
      ctx.strokeText(t, x, y);
      ctx.fillStyle = color;
      ctx.fillText(t, x, y);
    };
    const hearts = (n: number, max: number, x: number, y: number, align: "left" | "right") => {
      const size = fs * 0.9;
      for (let i = 0; i < max; i++) {
        const hx = align === "left" ? x + i * (size + 3) : x - (max - i) * (size + 3);
        ctx.fillStyle = i < n ? "#ff5c6b" : "rgba(255,255,255,0.25)";
        heart(ctx, hx, y, size);
      }
    };
    const slots: Record<string, { x: number; y: number; align: CanvasTextAlign; line: number }> = {
      "top-left": { x: pad, y: pad, align: "left", line: 0 },
      "top-right": { x: W - pad, y: pad, align: "right", line: 0 },
      "top-center": { x: W / 2, y: pad, align: "center", line: 0 },
    };
    const p = game.player;
    for (const item of this.spec.ui.hud) {
      const slot = slots[item.anchor ?? "top-left"];
      const y = slot.y + slot.line * (fs + 6);
      slot.line++;
      switch (item.kind) {
        case "score":
          text(`★ ${s.score}`, slot.x, y, slot.align);
          break;
        case "lives":
          if (slot.align === "right") hearts(s.lives, Math.max(s.lives, 1), slot.x, y, "right");
          else hearts(s.lives, Math.max(s.lives, 1), slot.x, y, "left");
          break;
        case "health":
          hearts(Math.max(0, p.hp), p.maxHp, slot.align === "right" ? slot.x : slot.x, y, slot.align === "right" ? "right" : "left");
          break;
        case "timer": {
          const t = Math.max(0, s.timer);
          text(`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`, slot.x, y, slot.align);
          break;
        }
        case "collected":
          if (s.required) text(`${s.collected} / ${s.required}`, slot.x, y, slot.align, "#fff4a0");
          else slot.line--;
          break;
        case "level":
          text(game.level.name, slot.x, y, slot.align);
          break;
        case "distance":
          text(`${Math.floor(s.distance)} m`, slot.x, y, slot.align);
          break;
        case "currency": {
          const r = 0.42 * fs;
          ctx.fillStyle = "#ffd35c";
          ctx.beginPath();
          ctx.arc(slot.x + r, y + fs * 0.55, r, 0, Math.PI * 2);
          ctx.fill();
          text(String(Math.floor(s.currency)), slot.x + r * 2 + 6, y, "left", "#fff4a0");
          break;
        }
        case "wave": {
          const w = game.waveInfo();
          text(w.waves ? `Wave ${Math.max(1, w.wave)} / ${w.waves}` : "", slot.x, y, slot.align);
          break;
        }
        case "parts": {
          const parts = game.partsLeft();
          text(parts.map((q) => `${q.def} ×${q.left}`).join("   "), slot.x, y, slot.align);
          break;
        }
      }
    }
    if (game.level.shop) this.drawShop(ctx, game, overlay, fs);
    else this.shopHits = [];
    if (s.keys > 0) text(`🔑 ×${s.keys}`, pad, H - pad - fs, "left", "#ffd35c");
    // Dialogue box.
    if (s.dialogue) {
      const bw = Math.min(W - pad * 2, fs * 34);
      const bx = (W - bw) / 2, by = H - fs * 4 - pad;
      ctx.fillStyle = "rgba(12,14,24,0.85)";
      roundRect(ctx, bx, by, bw, fs * 3.4, fs * 0.6);
      ctx.fill();
      ctx.font = `600 ${Math.round(fs * 0.95)}px ui-rounded, system-ui, sans-serif`;
      wrapText(ctx, s.dialogue, bx + fs, by + fs * 0.6, bw - fs * 2, fs * 1.25);
    }
    // Builder bar.
    if (game.genre === "builder" && s.status === "build") {
      const parts = game.partsLeft();
      const sel = overlay.builder?.selected ?? 0;
      ctx.font = `700 ${Math.round(fs * 0.9)}px ui-rounded, system-ui, sans-serif`;
      const label = parts.map((q, i) => `${i === sel ? "▸" : " "}${i + 1} ${q.def} ×${q.left}`).join("    ");
      text(label, W / 2, H - pad - fs * 2.6, "center", "#fff4a0");
      text("Click to place · right-click to remove · R rotate · Space to drop the marble", W / 2, H - pad - fs * 1.2, "center", "rgba(255,255,255,0.8)");
      if (s.message) text(s.message, W / 2, pad + fs * 2, "center", "#ffcf5c");
    }
    if (overlay.toast) text(overlay.toast, W / 2, H * 0.3, "center", "#fff4a0");
    if (overlay.banner) {
      ctx.fillStyle = "rgba(10,12,20,0.55)";
      ctx.fillRect(0, H * 0.38, W, fs * 3);
      ctx.font = `800 ${Math.round(fs * 1.6)}px ui-rounded, system-ui, sans-serif`;
      text(overlay.banner, W / 2, H * 0.38 + fs * 0.6, "center");
    }
    if (overlay.menu) this.drawMenu(ctx, overlay.menu, W, H, fs);
    else this.menuHits = [];
    ctx.restore();
  }

  private drawMenu(ctx: CanvasRenderingContext2D, m: MenuView, W: number, H: number, fs: number) {
    ctx.fillStyle = "rgba(8,10,18,0.72)";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 ${Math.round(fs * 2.6)}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
    ctx.fillText(m.title, W / 2, H * 0.2);
    if (m.subtitle) {
      ctx.font = `600 ${Math.round(fs * 1.05)}px ui-rounded, system-ui, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      wrapText(ctx, m.subtitle, W / 2, H * 0.2 + fs * 3.4, Math.min(W * 0.8, fs * 40), fs * 1.4, "center");
    }
    ctx.font = `700 ${Math.round(fs * 1.3)}px ui-rounded, system-ui, sans-serif`;
    this.menuHits = [];
    m.items.forEach((it, i) => {
      const y = H * 0.52 + i * fs * 2.1;
      this.menuHits.push({ x: this.view.ox + W / 2 - fs * 9, y: this.view.oy + y - fs * 0.4, w: fs * 18, h: fs * 1.9 });
      if (i === m.selected) {
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        roundRect(ctx, W / 2 - fs * 9, y - fs * 0.4, fs * 18, fs * 1.9, fs * 0.5);
        ctx.fill();
      }
      ctx.fillStyle = i === m.selected ? "#fff4a0" : "#ffffff";
      ctx.textAlign = "center";
      ctx.fillText(it, W / 2, y);
    });
    if (m.footer) {
      ctx.font = `500 ${Math.round(fs * 0.85)}px ui-rounded, system-ui, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(m.footer, W / 2, H - fs * 2.2);
    }
  }
}

function heart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(x + s / 2, y + s * 0.95);
  ctx.bezierCurveTo(x - s * 0.1, y + s * 0.5, x, y, x + s * 0.27, y + s * 0.05);
  ctx.bezierCurveTo(x + s * 0.4, y, x + s / 2, y + s * 0.12, x + s / 2, y + s * 0.25);
  ctx.bezierCurveTo(x + s / 2, y + s * 0.12, x + s * 0.6, y, x + s * 0.73, y + s * 0.05);
  ctx.bezierCurveTo(x + s, y, x + s * 1.1, y + s * 0.5, x + s / 2, y + s * 0.95);
  ctx.fill();
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, align: CanvasTextAlign = "left") {
  ctx.textAlign = align;
  ctx.fillStyle = ctx.fillStyle || "#fff";
  const words = text.split(/\s+/);
  let line = "";
  let yy = y;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      ctx.fillStyle = "#ffffff";
      ctx.fillText(line, x, yy);
      line = w;
      yy += lh;
    } else line = t;
  }
  if (line) {
    ctx.fillStyle = "#ffffff";
    ctx.fillText(line, x, yy);
  }
}
