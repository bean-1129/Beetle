// Hand-written Studio2D Script games. They prove the API, anchor the tests, and are shown to
// the local model as examples of the style it should write.

export const SNAKE = `// Snake: eat apples, grow, never bite yourself.
function create(g) {
  g.background("#1f3d2b");
  g.state = { dir: [1, 0], next: [1, 0], body: [], step: 0, grow: 2 };
  for (let i = 0; i < 3; i++) g.state.body.push(g.add({ x: 10 - i, y: 8, look: "snake body", color: "#7ac74f", tag: "snake" }));
  placeApple(g);
  g.lives = 1;
  g.music("adventure");
}
function placeApple(g) {
  g.remove(g.first("apple"));
  let x, y;
  do { x = g.randInt(1, g.W - 2); y = g.randInt(2, g.H - 2); } while (g.at(x + 0.5, y + 0.5, "snake"));
  g.add({ x, y, look: "apple", tag: "apple" });
}
function update(g, dt) {
  const s = g.state;
  if (g.key.left && s.dir[0] === 0) s.next = [-1, 0];
  if (g.key.right && s.dir[0] === 0) s.next = [1, 0];
  if (g.key.up && s.dir[1] === 0) s.next = [0, -1];
  if (g.key.down && s.dir[1] === 0) s.next = [0, 1];
  s.step += dt;
  if (s.step < Math.max(0.06, 0.14 - g.score * 0.002)) return;
  s.step = 0;
  s.dir = s.next;
  const head = s.body[0];
  const x = head.x + s.dir[0], y = head.y + s.dir[1];
  if (x < 0 || y < 1 || x >= g.W || y >= g.H || g.at(x + 0.5, y + 0.5, "snake")) return g.lose("The snake bit itself");
  s.body.unshift(g.add({ x, y, look: "snake head", color: "#a6e36b", tag: "snake" }));
  head.look = "snake body";
  if (g.hitAny(s.body[0], "apple")) {
    g.score += 1;
    s.grow += 1;
    g.sound("coin");
    placeApple(g);
  }
  if (s.grow > 0) s.grow -= 1;
  else g.remove(s.body.pop());
  if (g.score >= 25) g.win("The snake is full!");
}`;

export const BREAKOUT = `// Breakout: bounce the ball off the paddle and clear every brick.
function create(g) {
  g.background("#141432");
  g.paddle = g.add({ x: 13, y: 15.5, w: 4, h: 0.6, color: "#9fb4ff", tag: "paddle", bounded: true });
  g.ball = g.add({ x: 14.7, y: 14.6, w: 0.6, h: 0.6, shape: "circle", color: "#ffffff", tag: "ball" });
  g.ball.vx = 7; g.ball.vy = -9;
  const colors = ["#ff6b8a", "#ffcf5c", "#5cf2d6", "#a88bff"];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 13; c++) g.add({ x: 1.6 + c * 2.1, y: 2 + r * 1.1, w: 2, h: 0.9, color: colors[r], tag: "brick" });
  g.lives = 3;
  g.music("tense");
}
function update(g, dt) {
  const p = g.paddle, b = g.ball;
  p.vx = (g.key.right ? 16 : 0) - (g.key.left ? 16 : 0);
  if (g.mouse.down) p.x = g.clamp(g.mouse.x - p.w / 2, 0, g.W - p.w);
  if (b.x <= 0 && b.vx < 0) b.vx = -b.vx;
  if (b.x + b.w >= g.W && b.vx > 0) b.vx = -b.vx;
  if (b.y <= 1 && b.vy < 0) b.vy = -b.vy;
  if (g.hit(b, p) && b.vy > 0) {
    b.vy = -Math.abs(b.vy);
    b.vx = ((b.x + b.w / 2) - (p.x + p.w / 2)) * 5;
    g.sound("bounce");
  }
  const brick = g.hitAny(b, "brick");
  if (brick) {
    g.remove(brick);
    b.vy = -b.vy;
    g.score += 10;
    g.sound("break");
    if (g.all("brick").length === 0) g.win("Every brick is gone!");
  }
  if (b.y > g.H) {
    g.lives -= 1;
    g.sound("hit");
    if (g.lives <= 0) return g.lose("Out of balls");
    b.x = p.x + p.w / 2; b.y = 14; b.vx = 6; b.vy = -9;
    g.say("Ball " + (4 - g.lives));
  }
}`;

export const FLAPPY = `// Flappy: tap to flap through the gaps between pipes.
function create(g) {
  g.background("#8fd0ff");
  g.bird = g.add({ x: 6, y: 7, w: 1.2, h: 1, look: "yellow bird", tag: "bird", gravity: 38 });
  g.music("adventure");
}
function update(g, dt) {
  const b = g.bird;
  if (g.pressed.jump || g.pressed.up || g.pressed.action || g.mouse.clicked) {
    b.vy = -12;
    g.sound("jump");
  }
  if (g.every(1.6, "pipes")) {
    const gap = g.rand(4, g.H - 7);
    g.add({ x: g.W, y: 0, w: 2, h: gap, color: "#4fa64a", tag: "pipe", vx: -6 });
    g.add({ x: g.W, y: gap + 5, w: 2, h: g.H - gap - 5, color: "#4fa64a", tag: "pipe", vx: -6 });
    g.add({ x: g.W + 1, y: gap, w: 0.1, h: 5, tag: "gate", vx: -6, color: "#00000000" });
  }
  const gate = g.hitAny(b, "gate");
  if (gate) { g.remove(gate); g.score += 1; g.sound("coin"); }
  if (g.hitAny(b, "pipe") || b.y > g.H || b.y < -2) return g.lose("Bonk!");
  if (g.score >= 20) g.win("20 pipes!");
}`;

export const SCRIPT_SAMPLES: Record<string, { title: string; pitch: string; howToPlay: string; code: string }> = {
  snake: { title: "Garden Snake", pitch: "Eat apples, grow longer, and never bite your own tail.", howToPlay: "Arrow keys steer.", code: SNAKE },
  breakout: { title: "Brick Breaker", pitch: "Bounce the ball and clear every brick.", howToPlay: "Arrows or the mouse move the paddle.", code: BREAKOUT },
  flappy: { title: "Flap Flap", pitch: "Tap to flap through the gaps.", howToPlay: "Space, up or click to flap.", code: FLAPPY },
};

// ---------- classic templates ({{hero}}, {{enemy}}, {{pickup}} are filled from the idea) ----------

export const TETRIS = `// Falling blocks: complete rows to clear them.
const COLS = 10, ROWS = 16, OX = 10, OY = 0.5;
const SHAPES = [
  [[0,0],[1,0],[2,0],[3,0]], [[0,0],[1,0],[0,1],[1,1]], [[0,0],[1,0],[2,0],[1,1]],
  [[0,0],[1,0],[2,0],[0,1]], [[0,0],[1,0],[2,0],[2,1]], [[1,0],[2,0],[0,1],[1,1]], [[0,0],[1,0],[1,1],[2,1]],
];
const COLORS = ["#5cf2d6", "#ffd35c", "#a88bff", "#ffa54a", "#5b8fd6", "#6cc04a", "#ff6b8a"];
function create(g) {
  g.background("#141432");
  g.grid = [];
  for (let y = 0; y < ROWS; y++) g.grid.push(new Array(COLS).fill(null));
  g.add({ x: OX - 0.2, y: OY, w: 0.2, h: ROWS, color: "#5c6fd6" });
  g.add({ x: OX + COLS, y: OY, w: 0.2, h: ROWS, color: "#5c6fd6" });
  g.add({ x: OX - 0.2, y: OY + ROWS, w: COLS + 0.4, h: 0.2, color: "#5c6fd6" });
  g.fall = 0; g.lines = 0;
  spawn(g);
  g.music("tense");
}
function cells(p) { return p.shape.map(([x, y]) => [p.x + x, p.y + y]); }
function free(g, p) { return cells(p).every(([x, y]) => x >= 0 && x < COLS && y < ROWS && (y < 0 || !g.grid[y][x])); }
function spawn(g) {
  const i = g.randInt(0, SHAPES.length - 1);
  g.piece = { shape: SHAPES[i].map((c) => c.slice()), x: 3, y: 0, color: COLORS[i], blocks: [] };
  if (!free(g, g.piece)) return g.lose("The blocks reached the top");
  draw(g);
}
function draw(g) {
  for (const b of g.piece.blocks) g.remove(b);
  g.piece.blocks = cells(g.piece).map(([x, y]) => g.add({ x: OX + x, y: OY + y, w: 0.95, h: 0.95, color: g.piece.color, tag: "falling" }));
}
function move(g, dx, dy) {
  const p = g.piece;
  p.x += dx; p.y += dy;
  if (free(g, p)) { draw(g); return true; }
  p.x -= dx; p.y -= dy;
  return false;
}
function rotate(g) {
  const p = g.piece, old = p.shape;
  p.shape = old.map(([x, y]) => [1 - y + 1, x]);
  for (const kick of [0, -1, 1, -2, 2]) { p.x += kick; if (free(g, p)) return draw(g); p.x -= kick; }
  p.shape = old;
}
function lock(g) {
  for (const b of g.piece.blocks) b.tag = "settled";
  for (const [x, y] of cells(g.piece)) if (y >= 0) g.grid[y][x] = g.piece.blocks.find((b) => b.x === OX + x && b.y === OY + y) || true;
  let cleared = 0;
  for (let y = ROWS - 1; y >= 0; y--) {
    if (g.grid[y].every(Boolean)) {
      for (const b of g.grid[y]) if (b && b !== true) g.remove(b);
      g.grid.splice(y, 1);
      g.grid.unshift(new Array(COLS).fill(null));
      for (let yy = 0; yy <= y; yy++) for (const b of g.grid[yy]) if (b && b !== true) b.y = OY + yy;
      cleared++; y++;
    }
  }
  if (cleared) { g.lines += cleared; g.score += [0, 100, 300, 500, 800][cleared]; g.sound("powerup"); g.say(cleared > 1 ? cleared + " lines!" : "Line!"); }
  else g.sound("step");
  g.level = 1 + Math.floor(g.lines / 8);
  if (g.lines >= 40) return g.win("40 lines cleared!");
  spawn(g);
}
function update(g, dt) {
  g.text(1, 3, "Lines " + g.lines, 1); g.text(1, 4.5, "Level " + g.level, 1);
  if (g.pressed.left) move(g, -1, 0);
  if (g.pressed.right) move(g, 1, 0);
  if (g.pressed.up || g.pressed.action) rotate(g);
  if (g.pressed.jump) { while (move(g, 0, 1)) g.score += 2; return lock(g); }
  g.fall += dt * (g.key.down ? 12 : 1 + g.level * 0.5);
  if (g.fall >= 1) { g.fall = 0; if (!move(g, 0, 1)) lock(g); }
}`;

export const PONG = `// Pong: first to 7 wins.
function create(g) {
  g.background("#10131c");
  for (let y = 0; y < g.H; y += 1.2) g.add({ x: 14.9, y: y, w: 0.2, h: 0.6, color: "#2e3550" });
  g.me = g.add({ x: 1, y: 6.5, w: 0.6, h: 3.5, color: "#9fb4ff", bounded: true, tag: "paddle" });
  g.cpu = g.add({ x: g.W - 1.6, y: 6.5, w: 0.6, h: 3.5, color: "#ff6b8a", bounded: true, tag: "paddle" });
  g.ball = g.add({ x: 14.7, y: 8.2, w: 0.6, h: 0.6, shape: "circle", color: "#ffffff" });
  g.them = 0;
  serve(g, 1);
  g.music("adventure");
}
function serve(g, dir) { const b = g.ball; b.x = 14.7; b.y = 8.2; b.vx = 9 * dir; b.vy = g.rand(-5, 5); }
function update(g, dt) {
  const b = g.ball;
  g.text(11.5, 0.6, String(g.score), 2); g.text(17, 0.6, String(g.them), 2);
  g.me.vy = (g.key.down ? 14 : 0) - (g.key.up ? 14 : 0);
  if (g.mouse.down) g.me.y = g.clamp(g.mouse.y - g.me.h / 2, 0, g.H - g.me.h);
  const target = b.y - g.cpu.h / 2 + 0.3;
  g.cpu.vy = g.clamp((target - g.cpu.y) * 6, -9, 9);
  if ((b.y <= 0 && b.vy < 0) || (b.y + b.h >= g.H && b.vy > 0)) { b.vy = -b.vy; g.sound("bounce"); }
  for (const p of [g.me, g.cpu]) if (g.hit(b, p) && Math.sign(b.vx) === (p === g.me ? -1 : 1)) {
    b.vx = -b.vx * 1.06;
    b.vy = ((b.y + b.h / 2) - (p.y + p.h / 2)) * 4;
    g.sound("hit");
  }
  if (b.x < -1) { g.them++; g.say("Point to them"); serve(g, 1); }
  if (b.x > g.W + 1) { g.score++; g.sound("coin"); serve(g, -1); }
  if (g.score >= 7) g.win("You win " + g.score + " - " + g.them);
  if (g.them >= 7) g.lose("They win " + g.them + " - " + g.score);
}`;

export const INVADERS = `// Invaders: stop the {{enemy}} fleet before it lands.
function create(g) {
  g.background("#05050f");
  for (let i = 0; i < 40; i++) g.add({ x: g.rand(0, g.W), y: g.rand(0, g.H), w: 0.1, h: 0.1, color: "#ffffff", alpha: 0.6 });
  g.ship = g.add({ x: 14, y: 15, w: 1.6, h: 1.2, look: "{{hero}} spaceship", tag: "ship", bounded: true });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) g.add({ x: 3 + c * 2.6, y: 1.5 + r * 1.8, w: 1.4, h: 1.2, look: "{{enemy}}", tag: "alien" });
  g.dir = 1; g.speed = 1.2; g.lives = 3;
  g.music("tense");
}
function update(g, dt) {
  const s = g.ship;
  s.vx = (g.key.right ? 12 : 0) - (g.key.left ? 12 : 0);
  if ((g.pressed.jump || g.pressed.action || g.pressed.up) && g.all("shot").length < 3) {
    g.add({ x: s.x + s.w / 2 - 0.1, y: s.y - 0.6, w: 0.2, h: 0.6, color: "#fff4a0", tag: "shot", vy: -20 });
    g.sound("shoot");
  }
  const aliens = g.all("alien");
  if (!aliens.length) return g.win("The fleet is gone!");
  let edge = false;
  for (const a of aliens) { a.x += g.dir * g.speed * dt; if (a.x < 0.5 || a.x + a.w > g.W - 0.5) edge = true; }
  if (edge) { g.dir = -g.dir; for (const a of aliens) a.y += 0.6; g.speed += 0.15; }
  for (const shot of g.all("shot")) {
    const a = g.hitAny(shot, "alien");
    if (a) { g.remove(a); g.remove(shot); g.score += 10; g.sound("explosion"); }
  }
  if (g.every(1.1 - Math.min(0.7, g.score / 600), "bombs")) {
    const a = g.pick(aliens);
    g.add({ x: a.x + a.w / 2, y: a.y + a.h, w: 0.3, h: 0.5, color: "#ff6b8a", tag: "bomb", vy: 8 });
  }
  const bomb = g.hitAny(s, "bomb");
  if (bomb) { g.remove(bomb); g.lives--; g.sound("hit"); if (g.lives <= 0) return g.lose("Your ship is down"); }
  for (const a of aliens) if (a.y + a.h > s.y) return g.lose("They landed");
}`;

export const ASTEROIDS = `// Asteroids: turn, thrust and shoot the rocks apart.
function create(g) {
  g.background("#07070f");
  g.ship = g.add({ x: 14.5, y: 8, w: 1.2, h: 1.2, look: "{{hero}} spaceship", tag: "ship", wrap: true, angle: 0 });
  g.lives = 3;
  wave(g, 4);
  g.music("tense");
}
function wave(g, n) {
  for (let i = 0; i < n; i++) {
    const size = 3;
    g.add({ x: g.pick([0, g.W - 3]), y: g.rand(0, g.H - 3), w: size, h: size, look: "grey asteroid rock", tag: "rock", wrap: true, vx: g.rand(-3, 3), vy: g.rand(-3, 3) });
  }
}
function update(g, dt) {
  const s = g.ship;
  if (g.key.left) s.angle -= 220 * dt;
  if (g.key.right) s.angle += 220 * dt;
  const a = (s.angle - 90) * Math.PI / 180;
  if (g.key.up) { s.vx += Math.cos(a) * 14 * dt; s.vy += Math.sin(a) * 14 * dt; }
  s.vx *= 0.99; s.vy *= 0.99;
  if (g.pressed.jump || g.pressed.action) {
    g.add({ x: s.x + 0.5, y: s.y + 0.5, w: 0.25, h: 0.25, shape: "circle", color: "#fff4a0", tag: "shot", vx: Math.cos(a) * 22 + s.vx, vy: Math.sin(a) * 22 + s.vy, life: 0.9 });
    g.sound("shoot");
  }
  for (const shot of g.all("shot")) {
    shot.life -= dt;
    if (shot.life <= 0) { g.remove(shot); continue; }
    const r = g.hitAny(shot, "rock");
    if (r) {
      g.remove(shot); g.remove(r); g.score += Math.round(30 / r.w); g.sound("explosion");
      if (r.w > 1.2) for (let i = 0; i < 2; i++) g.add({ x: r.x, y: r.y, w: r.w / 2, h: r.h / 2, look: "grey asteroid rock", tag: "rock", wrap: true, vx: g.rand(-5, 5), vy: g.rand(-5, 5) });
    }
  }
  if (!g.all("rock").length) { g.level++; g.say("Wave " + g.level); if (g.level > 4) return g.win("Space is clear!"); wave(g, 3 + g.level); }
  if (g.hitAny(s, "rock") && !g.safe) {
    g.lives--; g.sound("hit"); g.safe = 2; s.x = 14.5; s.y = 8; s.vx = 0; s.vy = 0;
    if (g.lives <= 0) return g.lose("Your ship broke apart");
  }
  if (g.safe) { g.safe = Math.max(0, g.safe - dt); s.alpha = g.safe ? 0.5 : 1; }
}`;

export const WHACK = `// Whack-a-mole: click the {{enemy}}s (or move the hammer and press Space) before they hide.
function create(g) {
  g.background("#58a653");
  g.holes = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) g.holes.push(g.add({ x: 4 + c * 6, y: 3.5 + r * 4.3, w: 3, h: 1, color: "#3d2a1a", tag: "hole" }));
  g.cursor = 0;
  g.mark = g.add({ x: 0, y: 0, w: 3.4, h: 0.3, color: "#fff4a0" });
  g.time0 = 45;
  g.music("adventure");
}
function whack(g, mole) {
  if (!mole) return;
  g.remove(mole); g.score += 10; g.sound("hit"); g.say("+10", 0.4);
}
function update(g, dt) {
  const left = Math.max(0, g.time0 - g.time);
  g.text(12, 0.3, "Time " + Math.ceil(left), 1.2);
  if (left <= 0) return g.score >= 150 ? g.win("Great whacking! " + g.score) : g.lose("Time is up: " + g.score + " (need 150)");
  if (g.every(Math.max(0.35, 0.9 - g.time / 80), "pop")) {
    const h = g.pick(g.holes);
    if (!g.hitAny(h, "mole")) g.add({ x: h.x + 0.4, y: h.y - 2, w: 2.2, h: 2.2, look: "{{enemy}}", tag: "mole", life: 1.3 });
  }
  for (const m of g.all("mole")) { m.life -= dt; if (m.life <= 0) g.remove(m); }
  if (g.pressed.left) g.cursor = (g.cursor + 11) % 12;
  if (g.pressed.right) g.cursor = (g.cursor + 1) % 12;
  if (g.pressed.up) g.cursor = (g.cursor + 8) % 12;
  if (g.pressed.down) g.cursor = (g.cursor + 4) % 12;
  const h = g.holes[g.cursor];
  g.mark.x = h.x - 0.2; g.mark.y = h.y + 1.2;
  if (g.pressed.jump || g.pressed.action) whack(g, g.all("mole").find((m) => Math.abs(m.x - h.x) < 1));
  if (g.mouse.clicked) whack(g, g.at(g.mouse.x, g.mouse.y, "mole"));
}`;

export const MEMORY = `// Memory: flip two cards at a time and find every pair.
const ICONS = ["apple", "star", "heart", "key", "gem", "flower", "coin", "{{pickup}}"];
function create(g) {
  g.background("#2d1b3d");
  const deck = ICONS.concat(ICONS);
  for (let i = deck.length - 1; i > 0; i--) { const j = g.randInt(0, i); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
  g.cards = deck.map((look, i) => {
    const x = 5 + (i % 8) * 2.6, y = 3 + Math.floor(i / 8) * 5;
    return { look, back: g.add({ x, y, w: 2.2, h: 3, color: "#a54aa5", tag: "card" }), face: null, done: false };
  });
  g.open = []; g.cursor = 0; g.wait = 0; g.moves = 0;
  g.mark = g.add({ x: 0, y: 0, w: 2.2, h: 0.25, color: "#fff4a0" });
  g.music("calm");
}
function flip(g, c) {
  if (!c || c.done || c.face || g.open.length >= 2) return;
  c.face = g.add({ x: c.back.x + 0.3, y: c.back.y + 0.6, w: 1.6, h: 1.6, look: c.look });
  c.back.color = "#f2e8ff";
  g.open.push(c); g.sound("step");
  if (g.open.length === 2) { g.moves++; g.wait = 0.8; }
}
function update(g, dt) {
  g.text(1, 0.4, "Moves " + g.moves, 1);
  if (g.wait > 0) {
    g.wait -= dt;
    if (g.wait <= 0) {
      const [a, b] = g.open;
      if (a.look === b.look) { a.done = b.done = true; g.score += 20; g.sound("coin"); }
      else for (const c of [a, b]) { g.remove(c.face); c.face = null; c.back.color = "#a54aa5"; }
      g.open = [];
      if (g.cards.every((c) => c.done)) g.win("All pairs in " + g.moves + " moves!");
    }
  }
  const n = g.cards.length;
  if (g.pressed.left) g.cursor = (g.cursor + n - 1) % n;
  if (g.pressed.right) g.cursor = (g.cursor + 1) % n;
  if (g.pressed.up) g.cursor = (g.cursor + n - 8) % n;
  if (g.pressed.down) g.cursor = (g.cursor + 8) % n;
  const cur = g.cards[g.cursor].back;
  g.mark.x = cur.x; g.mark.y = cur.y + 3.2;
  if (g.pressed.jump || g.pressed.action) flip(g, g.cards[g.cursor]);
  if (g.mouse.clicked) flip(g, g.cards.find((c) => g.mouse.x >= c.back.x && g.mouse.x < c.back.x + c.back.w && g.mouse.y >= c.back.y && g.mouse.y < c.back.y + c.back.h));
}`;

export const RACER = `// Racer: weave through traffic on the highway.
function create(g) {
  g.background("#3a3f4a");
  for (let i = 0; i < 4; i++) g.add({ x: 7.5 + i * 4, y: 0, w: 0.2, h: g.H, color: "#5a6070" });
  g.add({ x: 6.8, y: 0, w: 0.4, h: g.H, color: "#f2f2f2" });
  g.add({ x: 23.3, y: 0, w: 0.4, h: g.H, color: "#f2f2f2" });
  g.car = g.add({ x: 14.4, y: 13, w: 1.6, h: 2.6, look: "{{hero}} red race car", tag: "me" });
  g.speed = 10; g.dist = 0;
  g.music("adventure");
}
function update(g, dt) {
  const c = g.car;
  c.vx = (g.key.right ? 11 : 0) - (g.key.left ? 11 : 0);
  c.x = g.clamp(c.x, 7.3, 22.9 - c.w);
  g.speed = Math.min(26, g.speed + dt * 0.6 + (g.key.up ? dt * 2 : 0) - (g.key.down ? dt * 3 : 0));
  g.dist += g.speed * dt;
  g.score = Math.floor(g.dist);
  if (g.every(1.2, "stripes")) for (let i = 0; i < 3; i++) g.add({ x: 11 + i * 4, y: -2, w: 0.25, h: 1.5, color: "#f2e8b6", tag: "stripe" });
  for (const s of g.all("stripe")) s.vy = g.speed;
  if (g.every(Math.max(0.35, 1.1 - g.speed / 40), "traffic")) {
    const lane = g.randInt(0, 3);
    g.add({ x: 7.8 + lane * 4, y: -3, w: 1.6, h: 2.6, look: g.pick(["blue car", "yellow taxi car", "green truck", "white van"]), tag: "car", flip: true, own: g.rand(0.3, 0.6) });
  }
  for (const o of g.all("car")) o.vy = g.speed * o.own;
  if (g.hitAny(c, "car")) { g.sound("explosion"); return g.lose("Crash! " + g.score + " m"); }
  if (g.score >= 2000) g.win("2 km without a scratch!");
}`;

export const CATCHER = `// Catch: move the basket to catch falling {{pickup}}s and avoid the rocks.
function create(g) {
  g.background("#8fd0ff");
  g.add({ x: 0, y: 15.5, w: g.W, h: 1.5, color: "#6cc04a" });
  g.basket = g.add({ x: 13.5, y: 13.8, w: 3, h: 1.7, look: "basket", tag: "basket", bounded: true });
  g.lives = 3;
  g.music("calm");
}
function update(g, dt) {
  const b = g.basket;
  b.vx = (g.key.right ? 15 : 0) - (g.key.left ? 15 : 0);
  if (g.mouse.down) b.x = g.clamp(g.mouse.x - b.w / 2, 0, g.W - b.w);
  if (g.every(Math.max(0.3, 0.9 - g.score / 400), "drop")) {
    const bad = g.chance(0.25);
    g.add({ x: g.rand(1, g.W - 2), y: -1, w: 1, h: 1, look: bad ? "grey rock" : "{{pickup}}", tag: bad ? "rock" : "good", vy: 6 + g.score / 40 });
  }
  const got = g.hitAny(b, "good");
  if (got) { g.remove(got); g.score += 10; g.sound("coin"); }
  const rock = g.hitAny(b, "rock");
  if (rock) { g.remove(rock); g.lives--; g.sound("hit"); if (g.lives <= 0) return g.lose("Too many rocks"); }
  for (const o of g.all("good")) if (o.y > 15) { g.remove(o); g.lives--; g.sound("hit"); if (g.lives <= 0) return g.lose("Missed too many"); }
  if (g.score >= 300) g.win("Basket full!");
}`;

export const GAME2048 = `// 2048: slide the tiles and merge equal numbers.
function create(g) {
  g.background("#faf3e6");
  g.cells = [];
  for (let i = 0; i < 16; i++) g.cells.push(0);
  g.tiles = [];
  for (let i = 0; i < 16; i++) g.add({ x: 9 + (i % 4) * 3.1, y: 2 + Math.floor(i / 4) * 3.1, w: 2.9, h: 2.9, color: "#cdc1b4" });
  add2(g); add2(g); draw(g);
  g.music("calm");
}
function add2(g) {
  const empty = [];
  g.cells.forEach((v, i) => { if (!v) empty.push(i); });
  if (empty.length) g.cells[g.pick(empty)] = g.chance(0.9) ? 2 : 4;
}
function draw(g) {
  for (const t of g.tiles) g.remove(t);
  g.tiles = [];
  const colors = { 2: "#eee4da", 4: "#ede0c8", 8: "#f2b179", 16: "#f59563", 32: "#f67c5f", 64: "#f65e3b", 128: "#edcf72", 256: "#edcc61", 512: "#edc850", 1024: "#edc53f", 2048: "#edc22e" };
  g.cells.forEach((v, i) => {
    if (!v) return;
    const x = 9 + (i % 4) * 3.1, y = 2 + Math.floor(i / 4) * 3.1;
    g.tiles.push(g.add({ x, y, w: 2.9, h: 2.9, color: colors[v] || "#3c3a32" }));
    g.tiles.push(g.add({ x: x + 0.5, y: y + 0.8, text: String(v), size: v < 100 ? 1.3 : 0.9, color: v < 8 ? "#776e65" : "#ffffff" }));
  });
}
function slide(g, dx, dy) {
  let moved = false;
  const get = (x, y) => g.cells[y * 4 + x], set = (x, y, v) => { g.cells[y * 4 + x] = v; };
  for (let k = 0; k < 4; k++) {
    const line = [];
    for (let s = 0; s < 4; s++) {
      const x = dx ? (dx > 0 ? 3 - s : s) : k, y = dy ? (dy > 0 ? 3 - s : s) : k;
      line.push([x, y]);
    }
    const vals = line.map(([x, y]) => get(x, y)).filter(Boolean);
    const out = [];
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] === vals[i + 1]) { out.push(vals[i] * 2); g.score += vals[i] * 2; i++; }
      else out.push(vals[i]);
    }
    line.forEach(([x, y], i) => { const v = out[i] || 0; if (get(x, y) !== v) moved = true; set(x, y, v); });
  }
  if (moved) { add2(g); draw(g); g.sound("step"); }
  if (g.cells.some((v) => v >= 2048)) return g.win("2048!");
  const full = g.cells.every(Boolean);
  let canMerge = false;
  for (let i = 0; i < 16; i++) { if (i % 4 < 3 && g.cells[i] === g.cells[i + 1]) canMerge = true; if (i < 12 && g.cells[i] === g.cells[i + 4]) canMerge = true; }
  if (full && !canMerge) g.lose("No moves left: " + g.score);
}
function update(g, dt) {
  if (g.pressed.left) slide(g, -1, 0);
  else if (g.pressed.right) slide(g, 1, 0);
  else if (g.pressed.up) slide(g, 0, -1);
  else if (g.pressed.down) slide(g, 0, 1);
}`;

export type ScriptTemplate = { id: string; match: RegExp; title: string; pitch: string; howToPlay: string; code: string };
export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  { id: "tetris", match: /\b(tetris|falling blocks|tetromino)/, title: "Block Drop", pitch: "Complete rows of falling blocks to clear them.", howToPlay: "Left and right move, up or X rotates, down drops faster, Space drops at once.", code: TETRIS },
  { id: "pong", match: /\b(pong|ping pong|table tennis|air hockey)/, title: "Paddle Duel", pitch: "First to seven points wins.", howToPlay: "Up and down (or the mouse) move your paddle.", code: PONG },
  { id: "invaders", match: /\b(space invaders|invaders|galaga|alien fleet)/, title: "Fleet Defense", pitch: "Stop the fleet before it lands.", howToPlay: "Left and right move, Space fires.", code: INVADERS },
  { id: "asteroids", match: /\b(asteroids?|space rocks)/, title: "Rock Field", pitch: "Shoot the asteroids apart before they hit you.", howToPlay: "Left and right turn, up thrusts, Space fires.", code: ASTEROIDS },
  { id: "whack", match: /\b(whack[- ]?a[- ]?mole|whack)/, title: "Whack Attack", pitch: "Bop them before they hide.", howToPlay: "Click them, or move with the arrows and press Space.", code: WHACK },
  { id: "memory", match: /\b(memory (game|cards|match)|matching pairs|concentration|pairs)/, title: "Pair Up", pitch: "Flip two cards at a time and find every pair.", howToPlay: "Click cards, or move with the arrows and press Space.", code: MEMORY },
  { id: "racer", match: /\b(racing|race car|racer|kart|driving|highway|traffic)/, title: "Highway Dash", pitch: "Weave through traffic and go the distance.", howToPlay: "Left and right steer, up speeds up, down slows down.", code: RACER },
  { id: "catcher", match: /\b(catch(ing)? (the |falling )?\w+|falling (fruit|apples|stars|eggs))/, title: "Catch It", pitch: "Catch what falls, dodge the rocks.", howToPlay: "Left and right (or the mouse) move the basket.", code: CATCHER },
  { id: "2048", match: /\b2048\b|sliding (number )?tiles/, title: "2048", pitch: "Slide and merge the tiles to reach 2048.", howToPlay: "Arrow keys slide every tile.", code: GAME2048 },
  { id: "snake", match: /\bsnake\b/, title: "Garden Snake", pitch: SCRIPT_SAMPLES.snake.pitch, howToPlay: SCRIPT_SAMPLES.snake.howToPlay, code: SNAKE },
  { id: "breakout", match: /\b(breakout|brick breaker|arkanoid|bricks)/, title: "Brick Breaker", pitch: SCRIPT_SAMPLES.breakout.pitch, howToPlay: SCRIPT_SAMPLES.breakout.howToPlay, code: BREAKOUT },
  { id: "flappy", match: /\b(flappy|flap)/, title: "Flap Flap", pitch: SCRIPT_SAMPLES.flappy.pitch, howToPlay: SCRIPT_SAMPLES.flappy.howToPlay, code: FLAPPY },
];

export function findTemplate(idea: string): ScriptTemplate | null {
  const t = idea.toLowerCase();
  return SCRIPT_TEMPLATES.find((x) => x.match.test(t)) ?? null;
}

export function fillTemplate(code: string, words: { hero?: string; enemy?: string; pickup?: string }): string {
  const clean = (s: string | undefined, d: string) => (s ?? d).toLowerCase().replace(/[^a-z \-]/g, "").trim().slice(0, 30) || d;
  const hero = clean(words.hero, "");
  return (hero ? code.replace(/\{\{hero\}\}/g, hero) : code.replace(/\{\{hero\}\} ?/g, "")).replace(/\{\{enemy\}\}/g, clean(words.enemy, "alien")).replace(/\{\{pickup\}\}/g, clean(words.pickup, "apple"));
}
