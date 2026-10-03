// The Studio2D engine core: plays one level of a Game Spec with a fixed 60 Hz step.
// All state lives in one plain object (Game.s), so snapshots, replays, playtest bots and
// lockstep multiplayer are a structuredClone away. Nothing here touches the DOM.
import type { BehaviorName, EntityDef, GameSpec, Genre, LevelDef, Placement } from "../spec/types.ts";
import { resolveParams } from "../spec/behaviors.ts";
import { DEFAULT_GRAVITY } from "../spec/defaults.ts";
import { mulberry, type Rng } from "./rng.ts";
import { BIT } from "./input.ts";
import {
  T, EPS, makeGrid, moveBox, tileAt, setTile, touchesTile, boxesOverlap, isSolidTile,
  ballVsOBB, resolveBall, rot, type Box, type Grid, type OBB,
} from "./physics.ts";
import { BEHAVIOR_IMPL } from "./behaviors.ts";

export const HZ = 60;
export const DT = 1 / HZ;
export const TERMINAL = 28; // tiles per second

export type BState = { type: BehaviorName; p: Record<string, any>; s: Record<string, any> };
export type Ent = {
  uid: number;
  def: string;
  kind: string;
  sprite: string;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  ox: number; // origin (placement) for patrol and platforms
  oy: number;
  bodyType: "static" | "dynamic" | "kinematic";
  shape: "box" | "circle" | "capsule";
  gravity: boolean;
  solid: boolean;
  sensor: boolean;
  bounce: number;
  friction: number;
  bh: BState[];
  alive: boolean;
  hidden: boolean;
  grounded: boolean;
  groundUid: number;
  hitWall: number; // -1 left, 1 right, 0 none
  facing: number; // 1 right, -1 left
  aimX: number;
  aimY: number;
  hp: number;
  maxHp: number;
  inv: number; // invulnerable seconds left
  hurtT: number;
  anim: string;
  animT: number;
  angle: number; // degrees, builder parts
  tags: string[];
  pid?: string;
  owner?: number; // spawner or shooter uid
  friendly?: boolean;
  part?: boolean; // placed by the player in builder mode
  cell?: [number, number]; // lane defense: the grid cell a unit stands in
  dx: number; // last frame displacement (kinematic carry)
  dy: number;
  stats: Record<string, number>;
};

export type GameEvent = { t: string; x: number; y: number; uid?: number; text?: string };
export type Status = "build" | "playing" | "won" | "lost";

export type State = {
  tick: number;
  time: number;
  status: Status;
  grid: Grid;
  ents: Ent[];
  nextUid: number;
  playerUid: number;
  score: number;
  lives: number;
  livesRule: boolean;
  collected: number;
  required: number;
  defeated: number;
  keys: number;
  keysFound: number;
  doorsOpened: number;
  reachedGoal: boolean;
  checkpoint: [number, number];
  respawnT: number;
  timer: number; // countdown seconds (if a countdown rule exists), else elapsed
  countdown: boolean;
  distance: number;
  bestX: number;
  prevInput: number;
  cam: { x: number; y: number };
  camTarget: number;
  dialogue: string;
  doorLinks: Record<string, boolean>;
  toggles: Record<string, boolean>;
  rng: number;
  chunk: number; // endless: next chunk index
  streamedTo: number; // endless: columns generated so far
  deaths: number;
  buildTime: number;
  runT: number; // builder: seconds since Go
  message: string;
  currency: number;
  cooldowns: Record<string, number>; // lane defense: seconds until each shop item is ready
};

export type Streamer = (spec: GameSpec, level: LevelDef, chunkIndex: number, fromColumn: number) => { columns: string[]; placements: Placement[] };
export type GameOptions = { level?: number; seed?: number; streamer?: Streamer; view?: [number, number] };

const SIDE_VIEW: Record<Genre, boolean> = { platformer: true, runner: true, builder: true, "top-down": false, arena: false, puzzle: false, defense: false };
const TOUCH_BEHAVIORS = new Set(["collectible", "damage-on-touch", "jump-on-kill", "goal", "checkpoint", "door", "dialogue", "switch"]);

export class Game {
  spec: GameSpec;
  level: LevelDef;
  levelIndex: number;
  genre: Genre;
  gravity: number;
  defs = new Map<string, EntityDef>();
  s: State;
  rng: Rng;
  events: GameEvent[] = [];
  view: [number, number];
  streamer?: Streamer;
  input = 0;
  pressed = 0;

  constructor(spec: GameSpec, opts: GameOptions = {}) {
    this.spec = spec;
    this.levelIndex = Math.max(0, Math.min(spec.levels.length - 1, opts.level ?? 0));
    this.level = spec.levels[this.levelIndex];
    this.genre = spec.meta.genre;
    this.gravity = this.level.gravity ?? DEFAULT_GRAVITY[this.genre];
    this.view = opts.view ?? [30, 17];
    this.streamer = opts.streamer;
    this.defs.set(spec.player.id, spec.player);
    for (const e of spec.entities) this.defs.set(e.id, e);
    const seed = opts.seed ?? this.level.seed ?? 1;
    this.rng = mulberry(seed);
    const lives = spec.rules.find((r) => r.type === "lives") as { count: number } | undefined;
    const timer = spec.rules.find((r) => r.type === "timer") as { seconds: number; countDown?: boolean } | undefined;
    const countdown = !!timer && timer.countDown !== false && timer.seconds > 0;
    this.s = {
      tick: 0,
      time: 0,
      status: this.genre === "builder" ? "build" : "playing",
      grid: makeGrid(this.level.tiles, SIDE_VIEW[this.genre]),
      ents: [],
      nextUid: 1,
      playerUid: 0,
      score: 0,
      lives: lives?.count ?? 1,
      livesRule: !!lives,
      collected: 0,
      required: 0,
      defeated: 0,
      keys: 0,
      keysFound: 0,
      doorsOpened: 0,
      reachedGoal: false,
      checkpoint: [this.level.spawn[0], this.level.spawn[1]],
      respawnT: 0,
      timer: countdown ? timer!.seconds : 0,
      countdown,
      distance: 0,
      bestX: this.level.spawn[0],
      prevInput: 0,
      cam: { x: 0, y: 0 },
      camTarget: 0,
      dialogue: "",
      doorLinks: {},
      toggles: {},
      rng: 0,
      chunk: 0,
      streamedTo: this.level.size[0],
      deaths: 0,
      buildTime: 0,
      runT: 0,
      message: "",
      currency: this.level.economy?.start ?? 0,
      cooldowns: {},
    };
    const player = this.spawn(spec.player.id, this.level.spawn[0], this.level.spawn[1]);
    this.s.playerUid = player.uid;
    this.s.camTarget = player.uid;
    // Lane defense has no avatar: the player is the hand that places units.
    if (this.genre === "defense") player.hidden = true;
    for (const p of this.level.placements) this.spawn(p.def, p.x, p.y, p.params, p.id);
    this.s.required = this.s.ents.filter((e) => this.bh(e, "collectible")?.p.required && e.kind !== "player").length;
    if (this.level.endless && this.streamer) this.streamMore();
    this.updateDoors();
    this.snapCamera();
  }

  // ---------- entities ----------

  spawn(defId: string, tx: number, ty: number, overrides?: Record<string, any>, pid?: string): Ent {
    const def = this.defs.get(defId);
    if (!def) throw new Error(`unknown entity ${defId}`);
    const [w, h] = def.size;
    const isPlayer = def.id === this.spec.player.id;
    const body = def.body ?? {
      type: isPlayer || def.kind === "enemy" ? "dynamic" : "static",
      shape: "box",
    };
    const bh: BState[] = def.behaviors.map((b) => ({
      type: b.type,
      p: resolveParams(b.type, { ...(b.params || {}), ...(overrides || {}) }),
      s: {},
    }));
    // Placement coordinates name a tile: stand the entity on that tile's floor, centred.
    const x = tx + 0.5 - w / 2;
    const y = ty + 1 - h;
    const healthB = bh.find((b) => b.type === "health");
    const hp = healthB ? healthB.p.hp : def.stats?.health ?? (isPlayer ? 3 : 1);
    const e: Ent = {
      uid: this.s.nextUid++,
      def: def.id,
      kind: def.kind ?? (isPlayer ? "player" : "prop"),
      sprite: def.sprite,
      x, y, w, h,
      vx: 0, vy: 0,
      ox: x, oy: y,
      bodyType: body.type,
      shape: body.shape,
      gravity: body.gravity ?? (body.type === "dynamic" && this.gravity > 0),
      solid: !!body.solid,
      sensor: !!body.sensor,
      bounce: body.bounce ?? 0,
      friction: body.friction ?? 0.4,
      bh,
      alive: true,
      hidden: false,
      grounded: false,
      groundUid: -1,
      hitWall: 0,
      facing: 1,
      aimX: 1,
      aimY: 0,
      hp,
      maxHp: hp,
      inv: 0,
      hurtT: 0,
      anim: "idle",
      animT: 0,
      angle: typeof overrides?.angle === "number" ? overrides.angle : 0,
      tags: def.tags ?? [],
      dx: 0,
      dy: 0,
      stats: def.stats ?? {},
    };
    if (pid) e.pid = pid;
    if (overrides?.facing === -1) e.facing = -1;
    this.s.ents.push(e);
    for (const b of e.bh) BEHAVIOR_IMPL[b.type]?.init?.(this, e, b);
    return e;
  }

  get player(): Ent {
    return this.s.ents.find((e) => e.uid === this.s.playerUid)!;
  }
  byUid(uid: number) {
    return this.s.ents.find((e) => e.uid === uid);
  }
  bh(e: Ent, type: BehaviorName): BState | undefined {
    return e.bh.find((b) => b.type === type);
  }
  emit(t: string, e?: { x: number; y: number; w?: number; h?: number; uid?: number }, text?: string) {
    const ev: GameEvent = { t, x: e ? e.x + (e.w ?? 0) / 2 : 0, y: e ? e.y + (e.h ?? 0) / 2 : 0 };
    if (e?.uid) ev.uid = e.uid;
    if (text) ev.text = text;
    this.events.push(ev);
  }
  remove(e: Ent) {
    e.alive = false;
  }

  // Harm an entity. Returns true when the hit landed.
  hurt(target: Ent, amount: number, from?: Ent, knockback = 6): boolean {
    if (!target.alive || target.inv > 0 || this.s.status !== "playing") return false;
    if (target.uid === this.s.playerUid && this.s.respawnT > 0) return false;
    target.hp -= amount;
    target.hurtT = 0.3;
    const healthB = this.bh(target, "health");
    target.inv = target.uid === this.s.playerUid ? healthB?.p.invulnerable ?? 1 : healthB?.p.invulnerable ?? 0.15;
    if (from && knockback > 0) {
      const dir = target.x + target.w / 2 < from.x + from.w / 2 ? -1 : 1;
      target.vx = dir * knockback;
      if (this.gravity > 0) target.vy = -knockback * 0.8;
      else {
        const dy = target.y + target.h / 2 - (from.y + from.h / 2);
        target.vy = dy < 0 ? -knockback * 0.6 : knockback * 0.6;
      }
    }
    this.emit("hit", target);
    if (target.hp <= 0) {
      if (target.uid === this.s.playerUid) this.killPlayer();
      else this.defeat(target);
    }
    return true;
  }

  defeat(e: Ent) {
    if (!e.alive) return;
    e.alive = false;
    if (e.kind === "unit") {
      this.emit("unit-lost", e);
      return;
    }
    this.s.defeated++;
    this.addScore("defeat", e);
    this.emit("defeat", e);
  }

  addScore(event: "collect" | "defeat" | "finish" | "distance", e?: Ent, amount?: number) {
    for (const r of this.spec.rules)
      if (r.type === "score" && r.event === event && (!r.tag || e?.tags.includes(r.tag))) this.s.score += amount ?? r.points;
  }

  killPlayer() {
    const p = this.player;
    if (this.s.respawnT > 0 || this.s.status !== "playing") return;
    this.s.deaths++;
    this.emit("die", p);
    if (this.genre === "builder") return this.resetBuild("The ball got lost. Try another layout.");
    if (this.s.livesRule) {
      this.s.lives--;
      if (this.s.lives <= 0) return this.lose();
    } else return this.lose();
    this.s.respawnT = 0.8;
    p.hidden = true;
    p.vx = p.vy = 0;
  }

  respawnPlayer() {
    const p = this.player;
    const [cx, cy] = this.s.checkpoint;
    p.x = cx + 0.5 - p.w / 2;
    p.y = cy + 1 - p.h;
    p.vx = p.vy = 0;
    p.hp = p.maxHp;
    p.inv = 1.2;
    p.hidden = false;
    this.emit("respawn", p);
  }

  win() {
    if (this.s.status !== "playing") return;
    this.s.status = "won";
    this.addScore("finish");
    this.emit("win", this.player);
  }
  lose() {
    if (this.s.status !== "playing") return;
    this.s.status = "lost";
    this.emit("lose", this.player);
  }

  // ---------- lane defense ----------

  cellCenter(col: number, row: number): [number, number] {
    const g = this.level.lanes!;
    return [g.x0 + col * g.cell + g.cell / 2, g.y0 + row * g.cell + g.cell / 2];
  }
  // Which lane (row) a world y falls in, or -1.
  laneOf(y: number): number {
    const g = this.level.lanes;
    if (!g) return -1;
    const r = Math.floor((y - g.y0) / g.cell);
    return r >= 0 && r < g.rows ? r : -1;
  }
  unitAt(col: number, row: number): Ent | undefined {
    return this.s.ents.find((e) => e.alive && e.cell && e.cell[0] === col && e.cell[1] === row);
  }
  // Why a unit cannot be placed right now, or "" when it can.
  canPlace(defId: string, col: number, row: number): string {
    const g = this.level.lanes;
    const item = this.level.shop?.find((i) => i.def === defId);
    if (!g || !item) return "not for sale";
    if (this.s.status !== "playing") return "not playing";
    if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return "outside the lanes";
    if (this.unitAt(col, row)) return "taken";
    if (this.s.currency < item.cost) return "not enough";
    if ((this.s.cooldowns[defId] ?? 0) > 0) return "recharging";
    return "";
  }
  placeUnit(defId: string, col: number, row: number): Ent | null {
    if (this.canPlace(defId, col, row)) return null;
    const item = this.level.shop!.find((i) => i.def === defId)!;
    const [cx, cy] = this.cellCenter(col, row);
    const def = this.defs.get(defId)!;
    const e = this.spawn(defId, cx - 0.5, cy + def.size[1] / 2 - 1);
    e.kind = "unit";
    e.cell = [col, row];
    this.s.currency -= item.cost;
    this.s.cooldowns[defId] = item.cooldown ?? 0;
    this.emit("place", e);
    return e;
  }
  // Take a unit back for half its price.
  removeUnit(col: number, row: number) {
    const u = this.unitAt(col, row);
    if (!u || this.s.status !== "playing") return;
    u.alive = false;
    const item = this.level.shop?.find((i) => i.def === u.def);
    this.s.currency += Math.floor((item?.cost ?? 0) / 2);
  }
  waveInfo(): { wave: number; waves: number } {
    let wave = 0, waves = 0;
    for (const e of this.s.ents) {
      const sp = this.bh(e, "spawner");
      if (!sp || !sp.p.waves) continue;
      waves = Math.max(waves, sp.p.waves);
      wave = Math.max(wave, sp.s.wave ?? 0);
    }
    return { wave, waves };
  }

  // ---------- builder mode ----------

  partsUsed(defId: string) {
    return this.s.ents.filter((e) => e.alive && e.part && e.def === defId).length;
  }
  partsLeft(): { def: string; left: number }[] {
    return (this.level.parts || []).map((p) => ({ def: p.def, left: p.count - this.partsUsed(p.def) }));
  }
  placePart(defId: string, tx: number, ty: number, angle = 0): Ent | null {
    if (this.s.status !== "build") return null;
    const budget = this.level.parts?.find((p) => p.def === defId);
    if (!budget || this.partsUsed(defId) >= budget.count) return null;
    const x = Math.floor(tx), y = Math.floor(ty);
    if (x < 0 || y < 0 || x >= this.s.grid.w || y >= this.s.grid.h) return null;
    if (isSolidTile(this.s.grid, tileAt(this.s.grid, x, y))) return null;
    const e = this.spawn(defId, x, y, { angle });
    e.part = true;
    return e;
  }
  removePart(uid: number) {
    const e = this.byUid(uid);
    if (e?.part && this.s.status === "build") e.alive = false;
  }
  go() {
    if (this.s.status !== "build") return;
    this.s.status = "playing";
    this.s.runT = 0;
    this.s.message = "";
    const p = this.player;
    p.vx = p.vy = 0;
    this.emit("go", p);
  }
  resetBuild(message = "") {
    const p = this.player;
    p.x = p.ox;
    p.y = p.oy;
    p.vx = p.vy = 0;
    this.s.status = "build";
    this.s.message = message;
  }

  // ---------- snapshots ----------

  snapshot(): State {
    this.s.rng = this.rng.state;
    return structuredClone(this.s);
  }
  restore(snap: State) {
    this.s = structuredClone(snap);
    this.rng.state = snap.rng;
    this.events = [];
  }
  // A cheap fingerprint of the whole state, for determinism checks.
  hash(): string {
    let h = 2166136261;
    const mix = (n: number) => {
      const v = Math.round(n * 1e6);
      h ^= v & 0xffff;
      h = Math.imul(h, 16777619);
      h ^= (v >>> 16) & 0xffff;
      h = Math.imul(h, 16777619);
    };
    mix(this.s.tick);
    mix(this.s.score);
    for (const e of this.s.ents) {
      mix(e.uid);
      mix(e.x);
      mix(e.y);
      mix(e.vx);
      mix(e.vy);
      mix(e.alive ? 1 : 0);
      mix(e.hp);
    }
    return (h >>> 0).toString(16);
  }

  // ---------- the step ----------

  step(input = 0) {
    this.events = [];
    const s = this.s;
    this.input = input;
    this.pressed = input & ~s.prevInput;
    s.prevInput = input;
    s.tick++;
    if (s.status === "build") {
      s.buildTime += DT;
      if (this.pressed & (BIT.action | BIT.jump)) this.go();
      this.updateCamera();
      return;
    }
    if (s.status !== "playing") return;
    s.time += DT;
    if (this.genre === "builder") s.runT += DT;
    if (s.countdown) {
      s.timer = Math.max(0, s.timer - DT);
      if (s.timer <= 0) {
        const survive = this.spec.rules.some((r) => r.type === "win" && r.when === "survive");
        if (survive) this.win();
        else this.lose();
        return;
      }
    } else s.timer = s.time;
    s.dialogue = "";
    if (this.level.economy) s.currency += this.level.economy.perSecond * DT;
    for (const k in s.cooldowns) if (s.cooldowns[k] > 0) s.cooldowns[k] = Math.max(0, s.cooldowns[k] - DT);
    if (s.respawnT > 0) {
      s.respawnT -= DT;
      if (s.respawnT <= 0) this.respawnPlayer();
    }
    const ents = s.ents;
    // Timers.
    for (const e of ents) {
      if (e.inv > 0) e.inv = Math.max(0, e.inv - DT);
      if (e.hurtT > 0) e.hurtT = Math.max(0, e.hurtT - DT);
    }
    // 1. Kinematic motion first, so riders can be carried this frame.
    for (const e of ents) {
      if (!e.alive || e.bodyType !== "kinematic") continue;
      const px = e.x, py = e.y;
      for (const b of e.bh) BEHAVIOR_IMPL[b.type]?.kinematic?.(this, e, b);
      e.dx = e.x - px;
      e.dy = e.y - py;
    }
    for (const e of ents) {
      if (!e.alive || e.groundUid < 0) continue;
      const g = this.byUid(e.groundUid);
      if (g && g.alive && (g.dx || g.dy)) {
        const solids = this.solidsFor(e).filter((b) => b.uid !== g.uid);
        moveBox(s.grid, e, g.dx, 0, solids);
        e.y += g.dy;
      }
    }
    // 2. Behaviors.
    const count = ents.length;
    for (let i = 0; i < count; i++) {
      const e = ents[i];
      if (!e.alive) continue;
      if (e.uid === s.playerUid && (s.respawnT > 0 || e.hidden)) continue;
      for (const b of e.bh) BEHAVIOR_IMPL[b.type]?.update?.(this, e, b);
    }
    // 3. Physics.
    for (const e of ents) {
      if (!e.alive || e.bodyType !== "dynamic") continue;
      if (e.uid === s.playerUid && (s.respawnT > 0 || e.hidden)) continue;
      if (e.shape === "circle" && this.genre === "builder") this.stepBall(e);
      else this.stepBox(e);
    }
    // 4. Interactions.
    this.interactions();
    this.updateDoors();
    // 5. World checks.
    const p = this.player;
    if (p.alive && !p.hidden && s.respawnT <= 0) {
      if (s.grid.sideView && p.y > s.grid.h + 1) this.killPlayer();
      else if (touchesTile(s.grid, p, T.SPIKE, 0.2)) {
        if (this.genre === "builder") this.killPlayer();
        else this.hurt(p, 1, undefined, 0) && p.hp > 0 && this.bounceOffSpikes(p);
      }
      if (this.genre === "builder" && s.runT > 20) this.resetBuild("Too slow. Try a steeper path.");
      if (p.x > s.bestX + 1) {
        const gained = Math.floor(p.x - s.bestX);
        s.bestX += gained;
        s.distance += gained;
        this.addScore("distance", p, undefined);
      }
    }
    // Lane defense: an enemy that walks past the last column reaches the base.
    if (this.level.lanes && this.spec.rules.some((r) => r.type === "lose" && r.when === "base-reached"))
      for (const e of s.ents)
        if (e.alive && e.kind === "enemy" && e.x + e.w / 2 < this.level.lanes.x0 - 0.2) {
          this.emit("base", e);
          this.lose();
          return;
        }
    if (this.level.endless && this.streamer && p.x + this.view[0] * 2 > s.streamedTo) this.streamMore();
    // Clean up dead entities now and then so long sessions stay small.
    if (s.tick % 120 === 0) s.ents = s.ents.filter((e) => e.alive || e.uid === s.playerUid || this.keepDead(e));
    for (const e of ents) this.animate(e);
    this.evaluateRules();
    this.updateCamera();
  }

  private keepDead(e: Ent) {
    // Falling platforms respawn; keep them.
    return !!this.bh(e, "falling-platform");
  }

  private bounceOffSpikes(p: Ent) {
    if (this.gravity > 0) p.vy = -Math.sqrt(2 * this.gravity * 1.5);
    return true;
  }

  solidsFor(e: Ent): Box[] {
    const out: Box[] = [];
    for (const o of this.s.ents) {
      if (!o.alive || o.uid === e.uid || o.hidden) continue;
      if (!this.isSolidEnt(o)) continue;
      if (o.part && o.angle % 180 !== 0) continue; // rotated parts only collide with balls
      const oneWay = !!(this.bh(o, "moving-platform") || this.bh(o, "falling-platform"));
      // Projectiles and pickups never stand on things.
      if (this.bh(e, "projectile")) {
        if (oneWay) continue;
      }
      out.push({ x: o.x, y: o.y, w: o.w, h: o.h, oneWay, uid: o.uid });
    }
    return out;
  }

  isSolidEnt(o: Ent): boolean {
    const door = this.bh(o, "door");
    if (door) return !door.s.open;
    const fall = this.bh(o, "falling-platform");
    if (fall && fall.s.falling) return false;
    return o.solid;
  }

  private stepBox(e: Ent) {
    const s = this.s;
    if (e.gravity) e.vy = Math.min(TERMINAL, e.vy + this.gravity * DT);
    const inWater = touchesTile(s.grid, e, T.WATER, 0.2) && s.grid.sideView;
    const k = inWater ? 0.55 : 1;
    const dropThrough = e.uid === s.playerUid && (this.input & BIT.down) !== 0 && (this.pressed & BIT.jump) !== 0;
    const solids = this.solidsFor(e);
    // Push crates in side view by walking into them.
    if (e.uid === s.playerUid && e.vx !== 0 && s.grid.sideView) this.pushCrates(e, e.vx * DT * k);
    const r = moveBox(s.grid, e, e.vx * DT * k, e.vy * DT * k, solids, dropThrough);
    e.grounded = r.hitDown;
    e.groundUid = r.hitDown ? r.groundUid : -1;
    e.hitWall = r.hitLeft ? -1 : r.hitRight ? 1 : 0;
    if (this.bh(e, "projectile") && (r.hitLeft || r.hitRight || r.hitUp || r.hitDown)) {
      if (e.friendly) {
        const cx = Math.floor(e.x + e.w / 2 + (r.hitRight ? 0.5 : r.hitLeft ? -0.5 : 0));
        const cy = Math.floor(e.y + e.h / 2 + (r.hitDown ? 0.5 : r.hitUp ? -0.5 : 0));
        if (tileAt(s.grid, cx, cy) === T.BREAK) {
          setTile(s.grid, cx, cy, T.EMPTY);
          this.emit("break", { x: cx, y: cy, w: 1, h: 1 });
        }
      }
      e.alive = false;
      return;
    }
    // Head-butting breakable tiles and blocks from below.
    if (r.hitUp && e.uid === s.playerUid && s.grid.sideView) {
      for (const [c, rr] of r.ceilTiles)
        if (tileAt(s.grid, c, rr) === T.BREAK) {
          setTile(s.grid, c, rr, T.EMPTY);
          this.emit("break", { x: c, y: rr, w: 1, h: 1 });
          this.s.score += 5;
        }
      for (const o of s.ents) {
        const br = o.alive && this.bh(o, "breakable");
        if (br && Math.abs(o.y + o.h - e.y) < 0.05 && e.x < o.x + o.w && e.x + e.w > o.x) this.hitBreakable(o);
      }
    }
    // Landing on a spring.
    if (e.groundUid >= 0) {
      const g = this.byUid(e.groundUid);
      const b = g && this.bh(g, "bouncy");
      if (b) {
        e.vy = -Math.sqrt(2 * Math.max(1, this.gravity) * b.p.power);
        e.grounded = false;
        e.groundUid = -1;
        this.emit("bounce", g);
      }
    }
  }

  hitBreakable(o: Ent) {
    const br = this.bh(o, "breakable")!;
    br.s.hits = (br.s.hits ?? br.p.hits) - 1;
    this.emit("hit", o);
    if (br.s.hits <= 0) {
      o.alive = false;
      this.emit("break", o);
      this.s.score += 5;
    }
  }

  private pushCrates(p: Ent, dx: number) {
    for (const o of this.s.ents) {
      if (!o.alive || !this.bh(o, "pushable") || o.bodyType !== "dynamic") continue;
      const vert = p.y < o.y + o.h - EPS && p.y + p.h > o.y + EPS;
      if (!vert) continue;
      const touching = dx > 0 ? Math.abs(p.x + p.w - o.x) < 0.02 : Math.abs(o.x + o.w - p.x) < 0.02;
      if (!touching) continue;
      const solids = this.solidsFor(o).filter((b) => b.uid !== p.uid);
      moveBox(this.s.grid, o, dx * 0.6, 0, solids);
    }
  }

  private stepBall(e: Ent) {
    const s = this.s;
    if (s.status !== "playing") return;
    const SUB = 4;
    const dt = DT / SUB;
    const r = e.w / 2;
    const ball = { x: e.x + r, y: e.y + r, r, vx: e.vx, vy: e.vy, bounce: e.bounce, friction: e.friction };
    const parts: OBB[] = [];
    for (const o of s.ents) {
      if (!o.alive || o.uid === e.uid || o.hidden) continue;
      if (!(this.isSolidEnt(o) || this.bh(o, "bouncy"))) continue;
      const [c, sn] = rot(o.angle);
      const b = this.bh(o, "bouncy");
      parts.push({ cx: o.x + o.w / 2, cy: o.y + o.h / 2, hw: o.w / 2, hh: o.h / 2, c, s: sn, bounce: b ? 0 : o.bounce, friction: o.friction, uid: o.uid, boost: b ? Math.sqrt(2 * Math.max(1, this.gravity) * b.p.power) : 0 });
    }
    let grounded = false;
    for (let k = 0; k < SUB; k++) {
      ball.vy = Math.min(TERMINAL, ball.vy + this.gravity * dt);
      for (const o of s.ents) {
        const wz = o.alive && this.bh(o, "wind-zone");
        if (wz && ball.x > o.x && ball.x < o.x + o.w && ball.y > o.y && ball.y < o.y + o.h) {
          ball.vx += wz.p.fx * dt;
          ball.vy += wz.p.fy * dt;
        }
      }
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      // Tiles near the ball are boxes.
      const x0 = Math.floor(ball.x - r) - 1, x1 = Math.floor(ball.x + r) + 1;
      const y0 = Math.floor(ball.y - r) - 1, y1 = Math.floor(ball.y + r) + 1;
      for (let ty = y0; ty <= y1; ty++)
        for (let tx = x0; tx <= x1; tx++) {
          const t = tileAt(s.grid, tx, ty);
          if (!(isSolidTile(s.grid, t) || t === T.ONEWAY) || ty >= s.grid.h || ty < 0) continue;
          const n = ballVsOBB(ball, { cx: tx + 0.5, cy: ty + 0.5, hw: 0.5, hh: 0.5, c: 1, s: 0, bounce: 0.2, friction: 0.5, uid: -1 });
          if (n && !(t === T.ONEWAY && n.ny > -0.5)) {
            resolveBall(ball, n, 0.2, 0.5);
            if (n.ny < -0.5) grounded = true;
          }
        }
      for (const o of parts) {
        const n = ballVsOBB(ball, o);
        if (!n) continue;
        resolveBall(ball, n, o.bounce, o.friction);
        if (o.boost) {
          ball.vx += n.nx * o.boost;
          ball.vy += n.ny * o.boost;
          this.emit("bounce", this.byUid(o.uid));
        }
        if (n.ny < -0.5) grounded = true;
      }
    }
    e.x = ball.x - r;
    e.y = ball.y - r;
    e.vx = ball.vx;
    e.vy = ball.vy;
    e.grounded = grounded;
    // A ball resting still for a while has stopped short of the goal.
    if (grounded && Math.abs(e.vx) < 0.05 && Math.abs(e.vy) < 0.3) {
      e.animT += DT;
      if (e.animT > 2 && s.runT > 2) this.resetBuild("The ball stopped. Adjust the parts and try again.");
    } else if (e.animT > 0 && !grounded) e.animT = 0;
  }

  private interactions() {
    const s = this.s;
    const p = this.player;
    const playerActive = p.alive && !p.hidden && s.respawnT <= 0;
    for (const e of s.ents) {
      if (!e.alive || e.uid === p.uid) continue;
      // Projectiles hit whatever they meet.
      if (this.bh(e, "projectile")) {
        this.projectileHits(e);
        continue;
      }
      if (!playerActive) continue;
      let touching = false;
      for (const b of e.bh) {
        if (!TOUCH_BEHAVIORS.has(b.type) && !BEHAVIOR_IMPL[b.type]?.touch) continue;
        if (!touching) touching = boxesOverlap(p, e) || this.standingOn(p, e);
        if (!touching) break;
        BEHAVIOR_IMPL[b.type]?.touch?.(this, e, b, p);
        if (!e.alive) break;
      }
    }
    // Pressure switches read every body resting on them.
    for (const e of s.ents) {
      const sw = e.alive && this.bh(e, "switch");
      if (!sw || !sw.p.pressure) continue;
      const pressed = s.ents.some((o) => o.alive && o.uid !== e.uid && !o.hidden && (o.uid === p.uid || this.bh(o, "pushable")) && boxesOverlap(o, { x: e.x + 0.2, y: e.y - 0.05, w: e.w - 0.4, h: e.h + 0.1 }));
      if (pressed !== !!sw.s.pressed) this.emit(pressed ? "switch-on" : "switch-off", e);
      sw.s.pressed = pressed;
    }
  }

  standingOn(p: Ent, e: Ent) {
    return p.groundUid === e.uid;
  }

  private projectileHits(e: Ent) {
    const pr = this.bh(e, "projectile")!;
    for (const o of this.s.ents) {
      if (!o.alive || o.uid === e.uid || o.uid === e.owner || o.hidden || this.bh(o, "projectile")) continue;
      if (!boxesOverlap(e, o)) continue;
      const isPlayer = o.uid === this.s.playerUid;
      if (e.friendly && !isPlayer && o.kind === "enemy") {
        if (this.bh(o, "breakable")) this.hitBreakable(o);
        else this.hurt(o, pr.p.damage, e, 2);
        e.alive = false;
        return;
      }
      if (!e.friendly && isPlayer) {
        this.hurt(o, pr.p.damage, e, 4);
        e.alive = false;
        return;
      }
      if (e.friendly && this.bh(o, "breakable")) {
        this.hitBreakable(o);
        e.alive = false;
        return;
      }
      if (this.isSolidEnt(o) && !this.bh(o, "moving-platform")) {
        e.alive = false;
        return;
      }
    }
  }

  updateDoors() {
    const s = this.s;
    const links: Record<string, { all: boolean; any: boolean; n: number }> = {};
    for (const e of s.ents) {
      const sw = e.alive && this.bh(e, "switch");
      if (!sw || !sw.p.link) continue;
      const on = sw.p.pressure ? !!sw.s.pressed : !!s.toggles[sw.p.link];
      const l = (links[sw.p.link] ??= { all: true, any: false, n: 0 });
      l.all &&= on;
      l.any ||= on;
      l.n++;
    }
    for (const e of s.ents) {
      const d = e.alive && this.bh(e, "door");
      if (!d) continue;
      const l = d.p.link ? links[d.p.link] : undefined;
      if (l) {
        const open = l.all;
        if (open !== !!d.s.open) this.emit(open ? "door" : "door-close", e);
        d.s.open = open;
        if (open) this.clearDoorway(e);
      } else if (d.s.open === undefined) d.s.open = !!d.p.open;
      s.doorLinks[d.p.link || `door-${e.uid}`] = !!d.s.open;
    }
  }

  // Doors closing on a body push it out rather than trapping it.
  private clearDoorway(_door: Ent) {}

  private animate(e: Ent) {
    if (!e.alive) return;
    const prev = e.anim;
    let a = "idle";
    if (e.hurtT > 0) a = "hurt";
    else if (this.gravity > 0 && e.bodyType === "dynamic" && !e.grounded && e.shape !== "circle") a = e.vy < 0 ? "jump" : "fall";
    else if (Math.abs(e.vx) > 0.3 || (this.gravity === 0 && Math.abs(e.vy) > 0.3)) a = Math.abs(e.vx) > 6 ? "run" : "walk";
    if (e.bh.some((b) => b.type === "shoot" && b.s.flash > 0)) a = "attack";
    if (a !== prev) {
      e.anim = a;
      e.animT = e.shape === "circle" ? e.animT : 0;
    } else if (e.shape !== "circle") e.animT += DT;
  }

  private evaluateRules() {
    const s = this.s;
    if (s.status !== "playing") return;
    const enemiesLeft = s.ents.some((e) => e.alive && e.kind === "enemy");
    const spawnersDone = s.ents.every((e) => !this.bh(e, "spawner") || this.bh(e, "spawner")!.s.done || !e.alive);
    const hasGoal = s.ents.some((e) => this.bh(e, "goal"));
    const hasEnemies = s.defeated > 0 || enemiesLeft || s.ents.some((e) => this.bh(e, "spawner"));
    for (const r of this.spec.rules) {
      if (r.type !== "win") continue;
      let met = false;
      switch (r.when) {
        case "reach-goal":
          met = hasGoal && s.reachedGoal;
          break;
        case "collect-all":
          met = s.required > 0 && s.collected >= s.required;
          break;
        case "defeat-all":
          met = hasEnemies && !enemiesLeft && spawnersDone;
          break;
        case "survive":
          met = !s.countdown && s.time >= (r.value ?? 60);
          break;
        case "score-at-least":
          met = s.score >= (r.value ?? 100);
          break;
      }
      if (met) return this.win();
    }
  }

  // ---------- camera ----------

  snapCamera() {
    const t = this.byUid(this.s.camTarget) ?? this.player;
    this.s.cam.x = this.clampCamX(t.x + t.w / 2 - this.view[0] / 2);
    this.s.cam.y = this.clampCamY(t.y + t.h / 2 - this.view[1] / 2);
  }
  private clampCamX(x: number) {
    return Math.max(0, Math.min(Math.max(0, this.s.grid.w - this.view[0]), x));
  }
  private clampCamY(y: number) {
    return Math.max(0, Math.min(Math.max(0, this.s.grid.h - this.view[1]), y));
  }
  private updateCamera() {
    const t = this.byUid(this.s.camTarget) ?? this.player;
    const cf = this.bh(t, "camera-follow");
    const lerp = cf?.p.lerp ?? 0.14;
    const look = (cf?.p.lookAhead ?? 2) * (this.gravity > 0 ? t.facing : 0);
    const tx = this.clampCamX(t.x + t.w / 2 - this.view[0] / 2 + look);
    const ty = this.clampCamY(t.y + t.h / 2 - this.view[1] / 2);
    this.s.cam.x += (tx - this.s.cam.x) * lerp;
    this.s.cam.y += (ty - this.s.cam.y) * lerp;
  }

  // ---------- endless levels ----------

  private streamMore() {
    if (!this.streamer) return;
    const s = this.s;
    const { columns, placements } = this.streamer(this.spec, this.level, s.chunk, s.streamedTo);
    if (!columns.length) return;
    const add = columns[0].length;
    const g = s.grid;
    const w = g.w + add;
    const cells = new Uint8Array(w * g.h);
    const codes: Record<string, number> = { ".": 0, "#": 1, "=": 2, "^": 3, "~": 4, B: 5, W: 6 };
    for (let y = 0; y < g.h; y++) {
      cells.set(g.cells.subarray(y * g.w, y * g.w + g.w), y * w);
      for (let x = 0; x < add; x++) cells[y * w + g.w + x] = codes[columns[y]?.[x] ?? "."] ?? 0;
    }
    s.grid = { w, h: g.h, cells, sideView: g.sideView };
    for (const p of placements) this.spawn(p.def, p.x, p.y, p.params, p.id);
    s.streamedTo = w;
    s.chunk++;
  }
}

// Run a game headless for a number of ticks with a fixed input or an input function.
export function runHeadless(game: Game, ticks: number, input: number | ((g: Game, i: number) => number) = 0) {
  for (let i = 0; i < ticks && (game.s.status === "playing" || game.s.status === "build"); i++)
    game.step(typeof input === "function" ? input(game, i) : input);
  return game;
}
