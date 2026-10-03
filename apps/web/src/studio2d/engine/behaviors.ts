// Behavior implementations. Each is a few small hooks the engine calls in a fixed order:
// init (on spawn), kinematic (moves itself before physics), update (sets intent), touch
// (the player overlaps it). Parameters arrive already clamped to their safe ranges.
import type { BState, Ent, Game } from "./game.ts";
import { DT } from "./game.ts";
import { BIT } from "./input.ts";
import { pingPong } from "./rng.ts";
import { groundBelow, tileAt, isSolidTile, boxesOverlap, T } from "./physics.ts";

type Impl = {
  init?: (g: Game, e: Ent, b: BState) => void;
  kinematic?: (g: Game, e: Ent, b: BState) => void;
  update?: (g: Game, e: Ent, b: BState) => void;
  touch?: (g: Game, e: Ent, b: BState, player: Ent) => void;
};

const approach = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
const isPlayer = (g: Game, e: Ent) => e.uid === g.s.playerUid;
const center = (e: Ent) => [e.x + e.w / 2, e.y + e.h / 2];
const held = (g: Game, bit: number) => (g.input & bit) !== 0;
const tapped = (g: Game, bit: number) => (g.pressed & bit) !== 0;

export function jumpVelocity(gravity: number, height: number) {
  return Math.sqrt(2 * gravity * height);
}

// Grid movement for puzzle rooms: one tile per move, pushing blocks ahead.
function gridBlocked(g: Game, x: number, y: number, ignore: number): Ent | "wall" | null {
  if (isSolidTile(g.s.grid, tileAt(g.s.grid, x, y))) return "wall";
  for (const o of g.s.ents) {
    if (!o.alive || o.uid === ignore || o.hidden) continue;
    if (Math.floor(o.x + o.w / 2) !== x || Math.floor(o.y + o.h / 2) !== y) continue;
    if (g.bh(o, "pushable")) return o;
    if (g.isSolidEnt(o)) return "wall";
  }
  return null;
}

export const BEHAVIOR_IMPL: Partial<Record<string, Impl>> = {
  "platformer-controller": {
    update(g, e, b) {
      if (!isPlayer(g, e)) return;
      const p = b.p, s = b.s;
      const auto = g.bh(e, "auto-run");
      const dir = auto ? 0 : (held(g, BIT.right) ? 1 : 0) - (held(g, BIT.left) ? 1 : 0);
      if (!auto) {
        const accel = p.acceleration * (e.grounded ? 1 : p.airControl) * DT;
        const target = dir * p.speed;
        // Knockback decays like friction; input pulls toward the target speed.
        e.vx = approach(e.vx, target, dir === 0 ? accel * 1.4 : accel);
        if (dir) e.facing = dir;
      }
      if (e.grounded) {
        s.coyote = p.coyote;
        s.jumps = 0;
      } else s.coyote = Math.max(0, (s.coyote ?? 0) - DT);
      if (tapped(g, BIT.jump) || (tapped(g, BIT.up) && !g.bh(e, "shoot"))) s.buffer = 0.1;
      else s.buffer = Math.max(0, (s.buffer ?? 0) - DT);
      const v = jumpVelocity(g.gravity, p.jumpHeight);
      if (s.buffer > 0 && !held(g, BIT.down)) {
        if (s.coyote > 0) {
          e.vy = -v;
          s.coyote = 0;
          s.buffer = 0;
          s.jumps = 1;
          e.grounded = false;
          e.groundUid = -1;
          g.emit("jump", e);
        } else if ((p.doubleJump || s.extraJump) && (s.jumps ?? 0) < 2) {
          e.vy = -v * 0.9;
          s.jumps = 2;
          s.buffer = 0;
          g.emit("jump", e);
        }
      }
      // Short hops: releasing jump early cuts the rise.
      if (e.vy < 0 && !held(g, BIT.jump) && !held(g, BIT.up) && s.jumps === 1) e.vy = Math.max(e.vy, -v * 0.45);
    },
  },

  "top-down-controller": {
    update(g, e, b) {
      if (!isPlayer(g, e)) return;
      const p = b.p, s = b.s;
      const ix = (held(g, BIT.right) ? 1 : 0) - (held(g, BIT.left) ? 1 : 0);
      const iy = (held(g, BIT.down) ? 1 : 0) - (held(g, BIT.up) ? 1 : 0);
      if (g.bh(e, "pushable") === undefined && g.spec.meta.genre === "puzzle") {
        // Grid mode: finish the current step before taking the next.
        if (s.moving) {
          s.t += (p.speed * DT);
          const t = Math.min(1, s.t);
          e.x = s.fx + (s.tx - s.fx) * t;
          e.y = s.fy + (s.ty - s.fy) * t;
          if (s.box) {
            const box = g.byUid(s.box);
            if (box) {
              box.x = s.bfx + (s.tx - s.fx) * t;
              box.y = s.bfy + (s.ty - s.fy) * t;
            }
          }
          if (t >= 1) {
            s.moving = false;
            s.box = 0;
          }
          e.vx = e.vy = 0;
          return;
        }
        const dx = ix !== 0 ? ix : 0;
        const dy = ix !== 0 ? 0 : iy;
        if (!dx && !dy) return;
        e.facing = dx || e.facing;
        e.aimX = dx;
        e.aimY = dy;
        const cx = Math.floor(e.x + e.w / 2), cy = Math.floor(e.y + e.h / 2);
        const hit = gridBlocked(g, cx + dx, cy + dy, e.uid);
        if (hit === "wall") return;
        if (hit) {
          const beyond = gridBlocked(g, cx + 2 * dx, cy + 2 * dy, hit.uid);
          if (beyond) return;
          s.box = hit.uid;
          s.bfx = hit.x;
          s.bfy = hit.y;
          g.emit("push", hit);
        }
        s.moving = true;
        s.t = 0;
        s.fx = e.x;
        s.fy = e.y;
        s.tx = e.x + dx;
        s.ty = e.y + dy;
        g.emit("step", e);
        return;
      }
      let dx = ix, dy = iy;
      if (dx && dy) {
        if (!p.diagonal) dy = 0;
        else {
          dx *= 0.7071;
          dy *= 0.7071;
        }
      }
      if (ix || iy) {
        e.aimX = ix;
        e.aimY = iy;
        if (ix) e.facing = ix;
      }
      const a = p.acceleration * DT;
      e.vx = approach(e.vx, dx * p.speed, a);
      e.vy = approach(e.vy, dy * p.speed, a);
    },
  },

  patrol: {
    init(_g, e, b) {
      b.s.dir = e.facing || 1;
    },
    update(g, e, b) {
      if (isPlayer(g, e)) return;
      const p = b.p, s = b.s;
      const axis = p.axis === "y" ? "y" : "x";
      if (axis === "x") {
        if (e.hitWall) s.dir = -e.hitWall;
        if (p.range > 0) {
          if (e.x > e.ox + p.range) s.dir = -1;
          if (e.x < e.ox - p.range) s.dir = 1;
        }
        if (p.turnAtLedges && g.gravity > 0 && e.grounded) {
          const footX = s.dir > 0 ? e.x + e.w + 0.05 : e.x - 0.05;
          if (!groundBelow(g.s.grid, footX, e.y + e.h)) s.dir = -s.dir;
        }
        if (g.gravity === 0) {
          const nx = s.dir > 0 ? e.x + e.w + 0.05 : e.x - 0.05;
          if (isSolidTile(g.s.grid, tileAt(g.s.grid, Math.floor(nx), Math.floor(e.y + e.h / 2)))) s.dir = -s.dir;
        }
        if (!g.bh(e, "chase") || !b.s.chasing) e.vx = s.dir * p.speed;
        e.facing = s.dir;
      } else {
        if (p.range > 0) {
          if (e.y > e.oy + p.range) s.dir = -1;
          if (e.y < e.oy - p.range) s.dir = 1;
        }
        const ny = s.dir > 0 ? e.y + e.h + 0.05 : e.y - 0.05;
        if (isSolidTile(g.s.grid, tileAt(g.s.grid, Math.floor(e.x + e.w / 2), Math.floor(ny)))) s.dir = -s.dir;
        e.vy = s.dir * p.speed;
      }
    },
  },

  chase: {
    update(g, e, b) {
      const pl = g.player;
      if (!pl.alive || pl.hidden) return;
      const [ex, ey] = center(e), [px, py] = center(pl);
      const dx = px - ex, dy = py - ey;
      const d2 = dx * dx + dy * dy;
      const patrol = g.bh(e, "patrol");
      if (d2 > b.p.sight * b.p.sight) {
        if (patrol) patrol.s.chasing = false;
        else if (g.gravity === 0) e.vx = e.vy = 0;
        else e.vx = 0;
        return;
      }
      if (patrol) patrol.s.chasing = true;
      const d = Math.sqrt(d2) || 1;
      if (g.gravity > 0) {
        e.vx = Math.abs(dx) > 0.2 ? Math.sign(dx) * b.p.speed : 0;
        if (patrol) patrol.s.dir = Math.sign(dx) || patrol.s.dir;
      } else {
        e.vx = (dx / d) * b.p.speed;
        e.vy = (dy / d) * b.p.speed;
      }
      if (dx) e.facing = Math.sign(dx);
    },
  },

  flee: {
    update(g, e, b) {
      const pl = g.player;
      const [ex, ey] = center(e), [px, py] = center(pl);
      const dx = ex - px, dy = ey - py;
      const d2 = dx * dx + dy * dy;
      if (d2 > b.p.sight * b.p.sight || !pl.alive) {
        if (g.gravity === 0) e.vx = e.vy = 0;
        return;
      }
      const d = Math.sqrt(d2) || 1;
      e.vx = (dx / d) * b.p.speed;
      if (g.gravity === 0) e.vy = (dy / d) * b.p.speed;
      if (dx) e.facing = Math.sign(dx);
    },
  },

  shoot: {
    update(g, e, b) {
      const p = b.p, s = b.s;
      s.cd = Math.max(0, (s.cd ?? p.every * 0.5) - DT);
      s.flash = Math.max(0, (s.flash ?? 0) - DT);
      const player = isPlayer(g, e);
      if (s.cd > 0) return;
      // Lane shooters fire only when an enemy is ahead of them in their own lane.
      if (p.lane) {
        const lane = g.laneOf(e.y + e.h / 2);
        const dir = p.aim === "left" ? -1 : 1;
        const [ex] = center(e);
        const target = g.s.ents.some((o) => {
          if (!o.alive || o.kind !== "enemy" || o.hidden) return false;
          const [ox, oy] = center(o);
          const ahead = (ox - ex) * dir;
          // Point-blank counts: an invader chewing on the shooter still gets shot.
          return g.laneOf(oy) === lane && ahead > -(e.w / 2 + o.w / 2) && ahead < p.range;
        });
        if (!target) return;
        s.cd = p.every;
        s.flash = 0.12;
        fireProjectile(g, e, dir, 0, p.speed, p.damage, true, p.range / p.speed);
        return;
      }
      if (player || p.trigger === "action") {
        if (!player || !held(g, BIT.action)) return;
      } else {
        const pl = g.player;
        if (!pl.alive || pl.hidden) return;
        const [ex, ey] = center(e), [px, py] = center(pl);
        if ((px - ex) ** 2 + (py - ey) ** 2 > p.range * p.range) return;
      }
      let ax = 0, ay = 0;
      switch (p.aim) {
        case "player": {
          const [ex, ey] = center(e), [px, py] = center(g.player);
          const d = Math.sqrt((px - ex) ** 2 + (py - ey) ** 2) || 1;
          ax = (px - ex) / d;
          ay = (py - ey) / d;
          break;
        }
        case "nearest": {
          // Aim assist: the closest enemy in range, else straight ahead.
          const [ex, ey] = center(e);
          let best: Ent | null = null, bd = p.range * p.range;
          for (const o of g.s.ents) {
            if (!o.alive || o.kind !== "enemy" || o.hidden) continue;
            const [ox, oy] = center(o);
            const d2 = (ox - ex) ** 2 + (oy - ey) ** 2;
            if (d2 < bd) {
              bd = d2;
              best = o;
            }
          }
          if (best) {
            const [ox, oy] = center(best);
            const d = Math.sqrt(bd) || 1;
            ax = (ox - ex) / d;
            ay = (oy - ey) / d;
          } else if (g.gravity === 0 && (e.aimX || e.aimY)) {
            const d = Math.sqrt(e.aimX * e.aimX + e.aimY * e.aimY);
            ax = e.aimX / d;
            ay = e.aimY / d;
          } else ax = e.facing || 1;
          break;
        }
        case "facing":
        case "mouse":
          if (g.gravity === 0 && (e.aimX || e.aimY)) {
            const d = Math.sqrt(e.aimX * e.aimX + e.aimY * e.aimY);
            ax = e.aimX / d;
            ay = e.aimY / d;
          } else ax = e.facing || 1;
          break;
        case "up": ay = -1; break;
        case "down": ay = 1; break;
        case "left": ax = -1; break;
        case "right": ax = 1; break;
      }
      s.cd = p.every;
      s.flash = 0.12;
      fireProjectile(g, e, ax, ay, p.speed, p.damage, player || e.kind === "unit", p.range / p.speed);
    },
  },

  "jump-on-kill": {
    touch(g, e, b, pl) {
      const falling = pl.vy > 0.5 || pl.groundUid === e.uid;
      const above = pl.y + pl.h <= e.y + Math.min(0.45, e.h * 0.5);
      if (falling && above) {
        g.defeat(e);
        pl.vy = -jumpVelocity(Math.max(1, g.gravity), 2.2 * (b.p.bounce ?? 0.7) + 0.4);
        pl.inv = Math.max(pl.inv, 0.1);
        g.emit("stomp", e);
        b.s.stomped = g.s.tick;
      }
    },
  },

  collectible: {
    touch(g, e, b, pl) {
      if (!e.alive) return;
      e.alive = false;
      g.s.collected += b.p.required ? 1 : 0;
      g.s.score += b.p.points;
      switch (b.p.effect) {
        case "heal":
          pl.hp = Math.min(pl.maxHp, pl.hp + 1);
          break;
        case "life":
          g.s.lives++;
          break;
        case "double-jump": {
          const c = g.bh(pl, "platformer-controller");
          if (c) c.s.extraJump = true;
          break;
        }
        case "speed": {
          const c = g.bh(pl, "platformer-controller") ?? g.bh(pl, "top-down-controller");
          if (c) c.p.speed = Math.min(14, c.p.speed * 1.25);
          break;
        }
        case "key":
          g.s.keys++;
          g.s.keysFound++;
          break;
      }
      g.emit(b.p.effect === "none" ? "coin" : "powerup", e);
    },
  },

  "damage-on-touch": {
    touch(g, e, b, pl) {
      const stomp = g.bh(e, "jump-on-kill");
      if (stomp && (stomp.s.stomped === g.s.tick || !e.alive)) return;
      if (stomp && pl.vy > 0.5 && pl.y + pl.h <= e.y + Math.min(0.45, e.h * 0.5)) return;
      g.hurt(pl, b.p.damage, e, b.p.knockback);
    },
  },

  "moving-platform": {
    init(g, e, b) {
      e.bodyType = "kinematic";
      e.solid = !!g.defs.get(e.def)?.body?.solid;
      b.s.phase = 0;
    },
    kinematic(g, e, b) {
      const t = (g.s.time / b.p.period) % 1;
      const k = pingPong(t);
      e.x = e.ox + b.p.dx * k;
      e.y = e.oy + b.p.dy * k;
    },
  },

  "falling-platform": {
    init(_g, e) {
      e.bodyType = "kinematic";
      e.solid = true;
    },
    kinematic(g, e, b) {
      const s = b.s;
      if (s.gone) {
        s.t += DT;
        if (s.t >= b.p.respawn && b.p.respawn > 0) {
          s.gone = false;
          s.falling = false;
          s.t = 0;
          s.vy = 0;
          e.x = e.ox;
          e.y = e.oy;
          e.alive = true;
          e.hidden = false;
        }
        return;
      }
      if (s.falling) {
        s.vy = Math.min(20, (s.vy ?? 0) + Math.max(20, g.gravity) * DT);
        e.y += s.vy * DT;
        if (e.y > g.s.grid.h + 2) {
          s.gone = true;
          s.t = 0;
          e.hidden = true;
        }
        return;
      }
      const stood = g.player.groundUid === e.uid;
      if (stood || s.armed) {
        s.armed = true;
        s.t = (s.t ?? 0) + DT;
        if (s.t >= b.p.delay) {
          s.falling = true;
          s.t = 0;
          g.emit("crumble", e);
        }
      }
    },
  },

  door: {
    init(_g, e, b) {
      e.solid = true;
      b.s.open = !!b.p.open;
    },
    update(g, e, b) {
      // Key doors open when the player walks up to them holding a key.
      if (b.s.open || !b.p.needsKey || g.s.keys <= 0) return;
      const pl = g.player;
      const near = boxesOverlap({ x: e.x - 0.15, y: e.y - 0.15, w: e.w + 0.3, h: e.h + 0.3 }, pl);
      if (near) {
        g.s.keys--;
        g.s.doorsOpened++;
        b.s.open = true;
        b.p.link = "";
        g.emit("door", e);
      }
    },
  },

  switch: {
    touch(g, e, b) {
      if (b.p.pressure) return;
      const inside = true;
      if (inside && !b.s.inside) {
        g.s.toggles[b.p.link] = b.p.toggle ? !g.s.toggles[b.p.link] : true;
        g.emit("switch-on", e);
      }
      b.s.inside = g.s.tick;
    },
    update(g, _e, b) {
      if (b.s.inside && b.s.inside < g.s.tick - 1) b.s.inside = 0;
    },
  },

  checkpoint: {
    touch(g, e, b) {
      if (b.s.active) return;
      b.s.active = true;
      g.s.checkpoint = [Math.floor(e.x + e.w / 2), Math.floor(e.y + e.h - 0.01)];
      g.emit("checkpoint", e);
    },
  },

  spawner: {
    init(_g, e, b) {
      b.s.t = -b.p.delay;
      b.s.total = 0;
      b.s.queue = 0; // enemies of the current wave still to walk in
      b.s.wave = 0;
      b.s.kids = [];
      e.solid = false;
    },
    update(g, e, b) {
      const p = b.p, s = b.s;
      if (s.done || !p.spawn || !g.defs.has(p.spawn)) {
        s.done = true;
        return;
      }
      s.kids = s.kids.filter((uid: number) => g.byUid(uid)?.alive);
      s.t += DT;
      const place = (i: number) => {
        const off = ((i % 3) - 1) * 0.8;
        const kid = g.spawn(p.spawn, Math.floor(e.x + e.w / 2 + off), Math.floor(e.y + e.h - 0.01));
        kid.owner = e.uid;
        s.kids.push(kid.uid);
        s.total++;
        g.emit("spawn", kid);
      };
      if (p.waves > 0) {
        // With spacing, a wave's enemies arrive one after another instead of all at once.
        if (s.queue > 0) {
          s.gap = (s.gap ?? 0) + DT;
          if (s.gap >= p.spacing) {
            s.gap = 0;
            s.queue--;
            place(s.total);
          }
          return;
        }
        if (s.kids.length === 0 && s.t >= p.every) {
          if (s.wave >= p.waves) {
            s.done = true;
            return;
          }
          s.wave++;
          if (p.spacing > 0) {
            s.queue = p.perWave;
            s.gap = p.spacing;
          } else for (let i = 0; i < p.perWave; i++) place(i);
          s.t = 0;
        }
      } else {
        if (s.t >= p.every && s.kids.length < p.max && s.total < p.max * 3) {
          place(s.total);
          s.t = 0;
        }
        if (s.total >= p.max * 3) s.done = true;
      }
    },
  },

  health: {},

  timer: {
    update(g, e, b) {
      b.s.t = (b.s.t ?? 0) + DT;
      if (b.s.t < b.p.seconds) return;
      b.s.t = 0;
      if (b.p.action === "remove") e.alive = false;
      else {
        e.hidden = !e.hidden;
        e.solid = !e.hidden;
      }
      void g;
    },
  },

  dialogue: {
    update(g, e, b) {
      const pl = g.player;
      const [ex, ey] = center(e), [px, py] = center(pl);
      if ((px - ex) ** 2 + (py - ey) ** 2 <= b.p.radius * b.p.radius) {
        g.s.dialogue = b.p.text;
        if (!b.s.shown) {
          b.s.shown = true;
          g.emit("talk", e, b.p.text);
        }
      }
    },
  },

  "camera-follow": {
    init(g, e) {
      g.s.camTarget = e.uid;
    },
  },

  "wind-zone": {
    init(_g, e) {
      e.solid = false;
    },
    update(g, e, b) {
      for (const o of g.s.ents) {
        if (!o.alive || o.bodyType !== "dynamic" || o.uid === e.uid || o.shape === "circle") continue;
        if (!boxesOverlap(o, e)) continue;
        o.vx += b.p.fx * DT;
        o.vy += b.p.fy * DT;
      }
    },
  },

  bouncy: {
    init(_g, e) {
      e.solid = true;
    },
  },

  breakable: {
    init(_g, e, b) {
      e.solid = true;
      b.s.hits = b.p.hits;
    },
  },

  goal: {
    touch(g, e) {
      if (g.s.reachedGoal) return;
      g.s.reachedGoal = true;
      g.emit("goal", e);
    },
  },

  pushable: {
    init(g, e) {
      e.solid = true;
      if (g.spec.meta.genre === "puzzle") e.bodyType = "static";
    },
  },

  projectile: {
    init(_g, e, b) {
      b.s.life = b.p.life;
      e.gravity = false;
      e.solid = false;
    },
    update(g, e, b) {
      b.s.life -= DT;
      if (b.s.life <= 0) {
        e.alive = false;
        return;
      }
      const t = tileAt(g.s.grid, Math.floor(e.x + e.w / 2), Math.floor(e.y + e.h / 2));
      if (isSolidTile(g.s.grid, t)) {
        if (t === T.BREAK && e.friendly) {
          g.s.grid.cells[Math.floor(e.y + e.h / 2) * g.s.grid.w + Math.floor(e.x + e.w / 2)] = T.EMPTY;
          g.emit("break", e);
        }
        e.alive = false;
      }
    },
  },

  producer: {
    update(g, e, b) {
      b.s.t = (b.s.t ?? b.p.every * 0.4) + DT;
      if (b.s.t < b.p.every) return;
      b.s.t = 0;
      g.s.currency += b.p.amount;
      g.emit("coin", e);
    },
  },

  // Attackers run before marchers (kits list them first): a biting enemy stands still.
  attacker: {
    update(g, e, b) {
      const want = b.p.target;
      let victim: Ent | undefined;
      for (const o of g.s.ents) {
        if (!o.alive || o.uid === e.uid || o.hidden) continue;
        const ok = want === "any" ? o.kind === "unit" || isPlayer(g, o) : want === "player" ? isPlayer(g, o) : o.kind === "unit";
        if (ok && boxesOverlap(e, o)) {
          victim = o;
          break;
        }
      }
      b.s.biting = !!victim;
      b.s.t = victim ? (b.s.t ?? 0) + DT : b.p.every * 0.5;
      if (victim && b.s.t >= b.p.every) {
        b.s.t = 0;
        g.hurt(victim, b.p.damage, undefined, 0);
        g.emit("bite", victim);
      }
    },
  },

  march: {
    update(g, e, b) {
      const biting = g.bh(e, "attacker")?.s.biting;
      const d = b.p.dir;
      const sp = biting ? 0 : b.p.speed;
      e.vx = d === "left" ? -sp : d === "right" ? sp : 0;
      e.vy = d === "up" ? -sp : d === "down" ? sp : 0;
      if (d === "left" || d === "right") e.facing = d === "left" ? -1 : 1;
    },
  },

  "auto-run": {
    init(_g, _e, b) {
      b.s.speed = b.p.speed;
    },
    update(g, e, b) {
      if (!isPlayer(g, e)) return;
      b.s.speed = Math.min(b.p.max, b.s.speed + b.p.ramp * DT);
      e.vx = b.s.speed;
      e.facing = 1;
    },
  },
};

// Projectiles are ordinary entities with the projectile behavior, created from a built-in def.
export function fireProjectile(g: Game, from: Ent, ax: number, ay: number, speed: number, damage: number, friendly: boolean, life: number) {
  const id = "__shot";
  if (!g.defs.has(id))
    g.defs.set(id, {
      id,
      kind: "prop",
      sprite: "__shot",
      size: [0.35, 0.35],
      body: { type: "dynamic", shape: "circle", gravity: false, sensor: true },
      behaviors: [{ type: "projectile" }],
    });
  const [cx, cy] = [from.x + from.w / 2, from.y + from.h / 2];
  const shot = g.spawn(id, cx - 0.5, cy - 0.5, { speed, damage, life: Math.min(6, Math.max(0.2, life)), friendly });
  shot.x = cx - shot.w / 2 + ax * (from.w / 2);
  shot.y = cy - shot.h / 2 + ay * (from.h / 2);
  shot.vx = ax * speed;
  shot.vy = ay * speed;
  shot.owner = from.uid;
  shot.friendly = friendly;
  shot.shape = "box";
  g.emit("shoot", from);
  return shot;
}
