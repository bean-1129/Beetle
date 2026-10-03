// The Studio2D player: runs a Game Spec in a canvas with a fixed 60 Hz simulation, menus,
// keyboard, gamepad and touch input, sound, save states and replays. The same code runs
// inside Beetle 2D and in exported single-file games.
import type { GameSpec } from "../spec/types.ts";
import { Game, DT, type Streamer, type State } from "../engine/game.ts";
import { BIT, InputMapper, padNames } from "../engine/input.ts";
import { buildAssets, processGenerated, type BuiltAssets } from "../assets/pipeline.ts";
import type { Pixels } from "../assets/pixels.ts";
import { Renderer, type MenuView, type Overlay } from "../render/renderer.ts";
import { Mixer } from "../audio/mixer.ts";

export type PlayerEvent =
  | { type: "level-start"; level: number }
  | { type: "won"; level: number; score: number; time: number }
  | { type: "lost"; level: number; score: number }
  | { type: "finished"; score: number }
  | { type: "stats"; fps: number; stepMs: number; entities: number }
  | { type: "script-check"; ok: boolean; error?: string };

export type PlayerOptions = {
  streamer?: Streamer;
  onEvent?: (e: PlayerEvent) => void;
  startLevel?: number;
  skipTitle?: boolean;
  storageKey?: string;
  tile?: number;
};

type Mode = "title" | "controls" | "card" | "play" | "pause" | "won" | "lost" | "finished";

export class Studio2DPlayer {
  spec: GameSpec;
  game: Game;
  renderer: Renderer;
  mixer: Mixer;
  input: InputMapper;
  assets: BuiltAssets;
  mode: Mode = "title";
  menuIndex = 0;
  levelIndex = 0;
  totalScore = 0;
  replay: number[] = [];
  opts: PlayerOptions;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private cardT = 0;
  private toast = "";
  private toastT = 0;
  private quick: State | null = null;
  private builder = { selected: 0, angle: 0, hover: undefined as [number, number] | undefined };
  // Lane defense: the chosen shop item, the cell under the mouse, and a keyboard cursor.
  private defense = { selected: 0, hover: null as [number, number] | null, cursor: [0, 0] as [number, number], keyboard: false };
  private stats = { frames: 0, t: 0, stepMs: 0, fps: 60 };
  private cleanup: (() => void)[] = [];
  private prevMenuInput = 0;
  private running = false;

  constructor(canvas: HTMLCanvasElement, spec: GameSpec, opts: PlayerOptions = {}) {
    this.spec = spec;
    this.opts = opts;
    this.levelIndex = Math.min(spec.levels.length - 1, opts.startLevel ?? 0);
    this.renderer = new Renderer(canvas);
    this.assets = buildAssets(spec, opts.tile ?? 16);
    this.renderer.load(spec, this.assets);
    this.mixer = new Mixer(spec);
    this.input = new InputMapper(spec.controls);
    this.game = new Game(spec, { level: this.levelIndex, streamer: opts.streamer });
    if (opts.skipTitle) this.startLevel(this.levelIndex);
    this.bind(canvas);
    void this.loadGenerated();
  }

  // ---------- lifecycle ----------

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      this.tick(Math.min(0.1, (now - this.last) / 1000));
      this.last = now;
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
  destroy() {
    this.stop();
    this.mixer.destroy();
    for (const c of this.cleanup) c();
    this.cleanup = [];
  }

  // Live iteration: swap in a patched spec. The current level restarts only when its layout
  // changed; otherwise the player keeps their place.
  setSpec(spec: GameSpec, keepPosition = true) {
    const prev = this.spec;
    this.spec = spec;
    const assetsChanged = JSON.stringify(prev.assets) !== JSON.stringify(spec.assets) || prev.meta.palette.join() !== spec.meta.palette.join() || prev.meta.artStyle !== spec.meta.artStyle || JSON.stringify(prev.player.size) !== JSON.stringify(spec.player.size);
    if (assetsChanged) {
      this.assets = buildAssets(spec, this.opts.tile ?? 16);
      this.renderer.load(spec, this.assets);
      void this.loadGenerated();
    } else this.renderer.spec = spec;
    this.renderer.palette = spec.meta.palette;
    this.mixer.setSpec(spec);
    this.input = new InputMapper(spec.controls);
    this.levelIndex = Math.min(this.levelIndex, spec.levels.length - 1);
    const old = this.game;
    this.game = new Game(spec, { level: this.levelIndex, streamer: this.opts.streamer });
    const sameLayout = JSON.stringify(prev.levels[old.levelIndex]?.tiles) === JSON.stringify(spec.levels[this.levelIndex]?.tiles);
    if (keepPosition && sameLayout && (this.mode === "play" || this.mode === "pause")) {
      const p = this.game.player, q = old.player;
      p.x = q.x;
      p.y = q.y;
      this.game.s.score = old.s.score;
      this.game.s.lives = old.s.lives;
      this.game.snapCamera();
    }
    this.flash("Updated");
  }

  private async loadGenerated() {
    const gen = Object.entries(this.spec.assets).filter(([, a]) => a.data && (a.source === "generated" || a.source === "user"));
    if (!gen.length || typeof Image === "undefined") return;
    let changed = false;
    for (const [id, ref] of gen) {
      try {
        const px = await decodeDataUrl(ref.data!);
        const r = processGenerated(px, this.spec, id, this.assets.tile);
        if (r.set) {
          this.assets.sprites[id] = r.set;
          changed = true;
        }
      } catch {}
    }
    if (changed) this.renderer.replaceAssets(this.assets);
  }

  // ---------- flow ----------

  startLevel(i: number) {
    this.levelIndex = i;
    this.game = new Game(this.spec, { level: i, streamer: this.opts.streamer });
    this.replay = [];
    this.mode = "card";
    this.cardT = 1.4;
    this.builder = { selected: 0, angle: 0, hover: undefined };
    this.defense = { selected: 0, hover: null, cursor: [0, 0], keyboard: false };
    this.mixer.playMusic(this.game.level.music);
    this.opts.onEvent?.({ type: "level-start", level: i });
  }
  restartLevel() {
    this.startLevel(this.levelIndex);
    this.cardT = 0.4;
  }
  private flash(t: string) {
    this.toast = t;
    this.toastT = 1.2;
  }

  private menuFor(): MenuView | undefined {
    const find = (id: string) => this.spec.ui.menus.find((m) => m.id === id);
    switch (this.mode) {
      case "title": {
        const m = find("title");
        return { title: m?.title || this.spec.meta.title, subtitle: this.spec.meta.pitch, items: m?.items.length ? m.items : ["Play", "Controls"], selected: this.menuIndex, footer: "Arrows to choose · Space or Enter to start" };
      }
      case "controls":
        return { title: "Controls", subtitle: controlsText(this.spec), items: ["Back"], selected: 0 };
      case "pause": {
        const m = find("pause");
        return { title: m?.title || "Paused", items: m?.items.length ? m.items : ["Resume", "Restart level", "Quit to title"], selected: this.menuIndex, footer: "F5 quick save · F9 quick load" };
      }
      case "won": {
        const m = find("win");
        const last = this.levelIndex >= this.spec.levels.length - 1;
        return { title: m?.title || "Level complete", subtitle: `Score ${this.game.s.score} · ${formatTime(this.game.s.time)}`, items: last ? ["Finish", "Replay"] : m?.items.length ? m.items : ["Next level", "Replay"], selected: this.menuIndex };
      }
      case "lost": {
        const m = find("lose");
        return { title: m?.title || "Try again", subtitle: `Score ${this.game.s.score}`, items: m?.items.length ? m.items : ["Retry", "Quit to title"], selected: this.menuIndex };
      }
      case "finished":
        return { title: "The end", subtitle: `You finished ${this.spec.meta.title}! Total score ${this.totalScore}.`, items: ["Play again"], selected: 0 };
    }
    return undefined;
  }

  private choose(item: string) {
    const it = item.toLowerCase();
    this.mixer.resume();
    if (this.mode === "title") {
      if (/control|help|how/.test(it)) this.mode = "controls";
      else {
        this.totalScore = 0;
        this.startLevel(this.bestLevel());
      }
    } else if (this.mode === "controls") this.mode = "title";
    else if (this.mode === "pause") {
      if (/restart/.test(it)) this.restartLevel();
      else if (/quit|title/.test(it)) this.toTitle();
      else this.mode = "play";
    } else if (this.mode === "won") {
      if (/replay/.test(it)) this.restartLevel();
      else if (this.levelIndex >= this.spec.levels.length - 1) {
        this.mode = "finished";
        this.opts.onEvent?.({ type: "finished", score: this.totalScore });
      } else this.startLevel(this.levelIndex + 1);
    } else if (this.mode === "lost") {
      if (/quit|title/.test(it)) this.toTitle();
      else this.restartLevel();
    } else if (this.mode === "finished") this.toTitle();
    this.menuIndex = 0;
  }
  private toTitle() {
    this.mode = "title";
    this.menuIndex = 0;
    this.game = new Game(this.spec, { level: 0, streamer: this.opts.streamer });
    this.mixer.playMusic(this.spec.audio.music.find((m) => m.mood === "calm")?.id ?? this.spec.audio.music[0]?.id);
  }

  private bestLevel() {
    return 0;
  }

  // ---------- per frame ----------

  tick(dt: number) {
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) ?? null : null;
    const inp = this.input.read(padNames(pads as any));
    const pressed = inp & ~this.prevMenuInput;
    this.prevMenuInput = inp;
    if (this.toastT > 0) this.toastT -= dt;
    const menu = this.menuFor();
    if (menu) {
      if (pressed & BIT.up) this.menuIndex = (this.menuIndex + menu.items.length - 1) % menu.items.length;
      if (pressed & BIT.down) this.menuIndex = (this.menuIndex + 1) % menu.items.length;
      if (pressed & (BIT.jump | BIT.action)) this.choose(menu.items[this.menuIndex] ?? "");
      if (pressed & BIT.pause && this.mode === "pause") this.mode = "play";
    } else if (this.mode === "card") {
      this.cardT -= dt;
      if (this.cardT <= 0) this.mode = "play";
    } else if (this.mode === "play") {
      if (pressed & BIT.pause) {
        this.mode = "pause";
        this.menuIndex = 0;
      } else {
        this.acc += dt;
        let steps = 0;
        const t0 = performance.now();
        while (this.acc >= DT && steps < 5) {
          const input = inp & ~BIT.pause;
          this.game.step(input);
          this.replay.push(input);
          this.renderer.events(this.game.events);
          for (const e of this.game.events) this.mixer.playEvent(e.t);
          this.acc -= DT;
          steps++;
          if (this.game.s.status === "won" || this.game.s.status === "lost") break;
        }
        if (steps) this.stats.stepMs = (performance.now() - t0) / steps;
        if (this.acc > DT * 5) this.acc = 0;
        const st = this.game.s.status;
        if (st === "won") {
          this.totalScore += this.game.s.score;
          this.mode = "won";
          this.menuIndex = 0;
          this.saveProgress();
          this.opts.onEvent?.({ type: "won", level: this.levelIndex, score: this.game.s.score, time: this.game.s.time });
        } else if (st === "lost") {
          this.mode = "lost";
          this.menuIndex = 0;
          this.opts.onEvent?.({ type: "lost", level: this.levelIndex, score: this.game.s.score });
        }
      }
    }
    const overlay: Overlay = { menu: this.menuFor(), toast: this.toastT > 0 ? this.toast : undefined };
    if (this.mode === "card") overlay.banner = `${this.game.level.name}${this.game.level.story ? "" : ""}`;
    if (this.game.genre === "builder") overlay.builder = this.builder;
    if (this.game.level.lanes) overlay.defense = this.defense;
    this.renderer.draw(this.game, dt, overlay);
    this.stats.frames++;
    this.stats.t += dt;
    if (this.stats.t >= 1) {
      this.stats.fps = this.stats.frames / this.stats.t;
      this.opts.onEvent?.({ type: "stats", fps: Math.round(this.stats.fps), stepMs: +this.stats.stepMs.toFixed(3), entities: this.game.s.ents.length });
      this.stats.frames = 0;
      this.stats.t = 0;
    }
  }

  // ---------- save states ----------

  quickSave() {
    this.quick = this.game.snapshot();
    try {
      localStorage.setItem(`${this.key()}:quick`, JSON.stringify({ level: this.levelIndex, state: serializeState(this.quick) }));
    } catch {}
    this.flash("Saved");
  }
  quickLoad() {
    let snap = this.quick;
    if (!snap)
      try {
        const raw = localStorage.getItem(`${this.key()}:quick`);
        if (raw) {
          const { level, state } = JSON.parse(raw);
          if (level !== this.levelIndex) this.startLevel(level);
          snap = deserializeState(state);
        }
      } catch {}
    if (!snap) return this.flash("No save yet");
    this.game.restore(snap);
    this.mode = "play";
    this.flash("Loaded");
  }
  private key() {
    return this.opts.storageKey ?? `studio2d:${this.spec.meta.title}`;
  }
  private saveProgress() {
    try {
      const raw = localStorage.getItem(this.key());
      const p = raw ? JSON.parse(raw) : { unlocked: 0, best: {} };
      p.unlocked = Math.max(p.unlocked, this.levelIndex + 1);
      p.best[this.levelIndex] = Math.max(p.best[this.levelIndex] ?? 0, this.game.s.score);
      localStorage.setItem(this.key(), JSON.stringify(p));
    } catch {}
  }

  // ---------- input ----------

  private bind(canvas: HTMLCanvasElement) {
    const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn, opts);
      this.cleanup.push(() => t.removeEventListener(type, fn, opts));
    };
    const target: EventTarget = canvas.tabIndex >= 0 ? canvas : window;
    on(target, "keydown", (e: KeyboardEvent) => {
      this.mixer.resume();
      if (e.code === "F5") {
        e.preventDefault();
        return this.quickSave();
      }
      if (e.code === "F9") {
        e.preventDefault();
        return this.quickLoad();
      }
      if (this.game.genre === "builder" && this.mode === "play" && this.game.s.status === "build") {
        if (/^Digit[1-9]$/.test(e.code)) this.builder.selected = Math.min((this.game.level.parts?.length ?? 1) - 1, Number(e.code.slice(5)) - 1);
        if (e.code === "KeyR") this.builder.angle = this.builder.angle >= 45 ? -45 : this.builder.angle + 15;
      }
      if (this.game.level.lanes && this.mode === "play" && this.defenseKey(e.code)) {
        e.preventDefault();
        return;
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
      this.input.keyDown(e.code);
    });
    on(target, "keyup", (e: KeyboardEvent) => this.input.keyUp(e.code));
    on(window, "blur", () => this.input.clear());
    on(canvas, "pointermove", (e: PointerEvent) => {
      if (this.menuFor()) {
        const i = this.renderer.menuItemAt(e.clientX, e.clientY);
        if (i >= 0) this.menuIndex = i;
        canvas.style.cursor = i >= 0 ? "pointer" : "";
        return;
      }
      if (this.game.level.lanes) {
        this.defense.hover = this.renderer.cellAt(this.game, e.clientX, e.clientY);
        if (this.defense.hover) this.defense.keyboard = false;
        canvas.style.cursor = this.renderer.shopItemAt(e.clientX, e.clientY) >= 0 || this.defense.hover ? "pointer" : "";
        return;
      }
      canvas.style.cursor = "";
      if (this.game.genre === "builder") this.builder.hover = this.renderer.screenToTile(this.game, e.clientX, e.clientY);
    });
    on(canvas, "contextmenu", (e: Event) => e.preventDefault());
    on(canvas, "pointerdown", (e: PointerEvent) => {
      this.mixer.resume();
      canvas.focus?.();
      // Menus (title, pause, win, lose) are clickable.
      const menu = this.menuFor();
      if (menu) {
        const i = this.renderer.menuItemAt(e.clientX, e.clientY);
        if (i >= 0 && e.button === 0) {
          this.menuIndex = i;
          this.choose(menu.items[i] ?? "");
          this.input.clear();
        }
        return;
      }
      if (this.game.genre === "builder" && this.mode === "play" && this.game.s.status === "build") {
        const [x, y] = this.renderer.screenToTile(this.game, e.clientX, e.clientY);
        if (e.button === 2) {
          const hit = this.game.s.ents.find((q) => q.alive && q.part && x >= q.x - 0.3 && x <= q.x + q.w + 0.3 && y >= q.y - 0.5 && y <= q.y + q.h + 0.5);
          if (hit) this.game.removePart(hit.uid);
        } else {
          const part = this.game.level.parts?.[this.builder.selected];
          if (part && !this.game.placePart(part.def, x, y, part.def === "plank" ? this.builder.angle : 0)) this.flash(`No ${part.def}s left`);
        }
        return;
      }
      if (this.game.level.lanes && this.mode === "play") {
        const slot = this.renderer.shopItemAt(e.clientX, e.clientY);
        if (slot >= 0) {
          this.defense.selected = slot;
          return;
        }
        const cell = this.renderer.cellAt(this.game, e.clientX, e.clientY);
        if (cell) {
          this.defense.keyboard = false;
          if (e.button === 2) this.game.removeUnit(cell[0], cell[1]);
          else this.placeDefender(cell);
        }
        return;
      }
      if (e.pointerType === "touch") this.touch(e, canvas, true);
    });
    on(canvas, "pointerup", (e: PointerEvent) => {
      if (e.pointerType === "touch") this.touch(e, canvas, false);
    });
  }

  // Keyboard for lane defense: number keys pick, arrows move the cursor, Space/Enter places,
  // Backspace removes. Returns true when the key was used.
  private defenseKey(code: string): boolean {
    const g = this.game.level.lanes!;
    const d = this.defense;
    const shop = this.game.level.shop ?? [];
    if (/^Digit[1-9]$/.test(code)) {
      d.selected = Math.min(shop.length - 1, Number(code.slice(5)) - 1);
      return true;
    }
    const move: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], KeyA: [-1, 0], KeyD: [1, 0], KeyW: [0, -1], KeyS: [0, 1] };
    if (move[code]) {
      if (d.keyboard) d.cursor = [Math.max(0, Math.min(g.cols - 1, d.cursor[0] + move[code][0])), Math.max(0, Math.min(g.rows - 1, d.cursor[1] + move[code][1]))];
      d.keyboard = true;
      return true;
    }
    if (code === "Space" || code === "Enter" || code === "KeyX") {
      d.keyboard = true;
      this.placeDefender(d.cursor);
      return true;
    }
    if (code === "Backspace" || code === "Delete") {
      this.game.removeUnit(d.cursor[0], d.cursor[1]);
      return true;
    }
    return false;
  }

  private placeDefender(cell: [number, number]) {
    const item = this.game.level.shop?.[this.defense.selected];
    if (!item) return;
    const why = this.game.canPlace(item.def, cell[0], cell[1]);
    if (!why) {
      this.game.placeUnit(item.def, cell[0], cell[1]);
      this.mixer.play("powerup");
    } else if (why === "not enough") this.flash(`Need ${item.cost - Math.floor(this.game.s.currency)} more`);
    else if (why === "recharging") this.flash("Still recharging");
    else if (why === "taken") this.flash("Something is already there. Right-click to remove it.");
  }

  // Touch: left third moves left, right third moves right, the middle jumps/acts.
  private touch(e: PointerEvent, canvas: HTMLCanvasElement, down: boolean) {
    if (!down) return this.input.setTouch(0);
    const r = canvas.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    let bits = 0;
    if (fx < 0.33) bits = BIT.left;
    else if (fx > 0.67) bits = BIT.right;
    else bits = fy < 0.5 ? BIT.up | BIT.jump : BIT.action | BIT.jump;
    this.input.setTouch(bits);
  }
}

function formatTime(t: number) {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

function controlsText(spec: GameSpec) {
  const name = (k: string) => k.replace(/^Key/, "").replace(/^Arrow/, "").replace(/^pad:/, "pad ");
  const g = spec.meta.genre;
  const parts = [
    `Move: ${[...spec.controls.left, ...spec.controls.right].filter((k) => !k.startsWith("pad")).map(name).join(" ")}`,
    g === "platformer" || g === "runner" ? `Jump: ${spec.controls.jump.filter((k) => !k.startsWith("pad")).map(name).join(" ")}` : `Act: ${spec.controls.action.filter((k) => !k.startsWith("pad")).map(name).join(" ")}`,
    `Pause: ${spec.controls.pause.filter((k) => !k.startsWith("pad")).map(name).join(" ")}`,
    "Gamepads and touch work too.",
  ];
  return parts.join(" · ");
}

// Typed arrays do not survive JSON; store the grid cells as a plain list.
export function serializeState(s: State) {
  return { ...s, grid: { ...s.grid, cells: Array.from(s.grid.cells) } };
}
export function deserializeState(s: any): State {
  return { ...s, grid: { ...s.grid, cells: new Uint8Array(s.grid.cells) } };
}

export async function decodeDataUrl(url: string): Promise<Pixels> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { w: c.width, h: c.height, data: d.data };
}

// Mount a player in a canvas and start it. Used by exported games.
export function mount(canvas: HTMLCanvasElement, spec: GameSpec, opts: PlayerOptions = {}) {
  const p = new Studio2DPlayer(canvas, spec, opts);
  p.start();
  (globalThis as any).__studio2d = p;
  return p;
}
