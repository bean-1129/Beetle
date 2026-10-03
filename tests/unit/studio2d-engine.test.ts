// Beetle 2D engine: spec validation and repair, patches, physics, behaviors, determinism, bots, input, saves.
import { it } from "vitest";
import assert from "node:assert/strict";
import { SAMPLES, samplePlatformer, samplePuzzle, sampleTopDown } from "../../apps/web/src/studio2d/samples/index.ts";
import { validateSpec, repairSpec, SpecError } from "../../apps/web/src/studio2d/spec/validate.ts";
import { applyPatch, setParamOps } from "../../apps/web/src/studio2d/spec/patch.ts";
import { BEHAVIORS, CORE_BEHAVIORS, resolveParams } from "../../apps/web/src/studio2d/spec/behaviors.ts";
import { Game, runHeadless } from "../../apps/web/src/studio2d/engine/game.ts";
import { BEHAVIOR_IMPL } from "../../apps/web/src/studio2d/engine/behaviors.ts";
import { BIT, InputMapper } from "../../apps/web/src/studio2d/engine/input.ts";
import { makeGrid, moveBox, ballVsOBB, rot } from "../../apps/web/src/studio2d/engine/physics.ts";
import { playtest, replay } from "../../apps/web/src/studio2d/world/bot.ts";
import { Paint } from "../../apps/web/src/studio2d/world/paint.ts";
import type { GameSpec, Placement } from "../../apps/web/src/studio2d/spec/types.ts";

const flat = (w = 20, h = 8, top = 6) => new Paint(w, h).ground(0, w - 1, top);
function tinyPlatformer(placements: Placement[] = [], mutate?: (spec: GameSpec) => void) {
  const spec = samplePlatformer();
  const lvl = spec.levels[0];
  const p = flat();
  lvl.tiles = p.rows();
  lvl.size = [p.w, p.h];
  lvl.spawn = [2, 5];
  lvl.placements = placements;
  spec.levels = [lvl];
  mutate?.(spec);
  assert.deepEqual(validateSpec(spec).errors, []);
  return spec;
}

it("every sample spec validates and has at least one win rule", () => {
  for (const [name, make] of Object.entries(SAMPLES)) {
    const spec = make();
    assert.deepEqual(validateSpec(spec).errors, [], name);
    assert.ok(spec.rules.some((r) => r.type === "win"), name);
  }
  assert.ok(Object.keys(SAMPLES).length >= 6);
});

it("the behavior library covers the 22 designed behaviors, each implemented with safe ranges", () => {
  assert.equal(CORE_BEHAVIORS.length, 22);
  for (const b of CORE_BEHAVIORS) {
    assert.ok(BEHAVIORS[b], b);
    assert.ok(BEHAVIOR_IMPL[b], `${b} has an engine implementation`);
    for (const [k, d] of Object.entries(BEHAVIORS[b].params))
      if (d.kind === "number") assert.ok(d.min <= d.default && d.default <= d.max, `${b}.${k}`);
  }
  // Out-of-range values clamp, junk falls back to defaults.
  assert.equal(resolveParams("platformer-controller", { jumpHeight: 999 }).jumpHeight, 8);
  assert.equal(resolveParams("platformer-controller", { jumpHeight: "high" }).jumpHeight, 3.4);
  assert.equal(resolveParams("shoot", { aim: "sideways" }).aim, "player");
});

it("validation reports precise errors", () => {
  const spec = samplePlatformer();
  spec.player.behaviors[0]!.params!.jumpHeight = 40;
  spec.levels[0].tiles[3] = spec.levels[0].tiles[3].slice(0, 10);
  spec.entities[0].sprite = "missing";
  spec.rules = spec.rules.filter((r) => r.type !== "win");
  const { ok, errors } = validateSpec(spec);
  assert.equal(ok, false);
  const text = errors.join("\n");
  assert.match(text, /jumpHeight = 40 is outside its safe range/);
  assert.match(text, /tiles\[3\] must have 64 characters/);
  assert.match(text, /sprite "missing" is not an asset/);
  assert.match(text, /at least one win condition/);
});

it("repair turns sloppy model output into a valid spec, or fails clearly", () => {
  const messy = {
    meta: { title: "  Fox Run ", genre: "platformer", palette: ["#112233", "nope"] },
    player: { id: "the fox!", size: [1, 1], behaviors: ["platformer-controller", { type: "teleport" }, { type: "health", params: { hp: 900 } }] },
    entities: [{ id: "coin", size: [0.5, 0.5], behaviors: [{ type: "collectible" }] }, { id: "coin", size: [30, 1], behaviors: [] }],
    levels: [{ size: [20, 6], tiles: ["....", "#####################XX"], spawn: [0, 5], placements: [{ def: "coin", x: 3, y: 2 }, { def: "ghost", x: 1, y: 1 }] }],
    rules: [{ type: "lives", count: 0 }],
  };
  const { spec, fixes } = repairSpec(messy);
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.equal(spec.meta.title, "Fox Run");
  assert.ok(spec.player.behaviors.every((b) => (b.type as string) !== "teleport"));
  assert.equal(spec.player.behaviors.find((b) => b.type === "health")!.params!.hp, 50);
  assert.equal(new Set([spec.player.id, ...spec.entities.map((e) => e.id)]).size, 3);
  assert.equal(spec.levels[0].tiles.length, 6);
  assert.ok(spec.levels[0].tiles.every((r) => r.length === 20 && /^[.#=^~BW]+$/.test(r)));
  assert.equal(spec.levels[0].placements.length, 1);
  assert.ok(fixes.some((f) => /teleport/.test(f)));
  assert.ok(spec.rules.some((r) => r.type === "win"));
  assert.throws(() => repairSpec({ meta: { title: "x" } }), (e) => e instanceof SpecError && /no levels/.test(e.message));
  // Repair is idempotent on valid specs.
  const again = repairSpec(spec);
  assert.deepEqual(again.spec, spec);
});

it("patches apply atomically and can never break the spec", () => {
  const spec = samplePlatformer();
  const ops = setParamOps(spec, "hero", "platformer-controller", "jumpHeight", 5)!;
  const next = applyPatch(spec, ops);
  assert.equal(next.player.behaviors[0]!.params!.jumpHeight, 5);
  assert.equal(spec.player.behaviors[0]!.params!.jumpHeight, 3.4, "original untouched");
  assert.throws(() => applyPatch(spec, setParamOps(spec, "hero", "platformer-controller", "jumpHeight", 50)!), SpecError);
  assert.throws(() => applyPatch(spec, [{ op: "replace", path: "/meta/title", value: "ok" }, { op: "remove", path: "/levels/0/nothing" }]));
  assert.throws(() => applyPatch(spec, [{ op: "add", path: "/__proto__/x", value: 1 }]));
  const byId = applyPatch(spec, [{ op: "replace", path: "/levels/hollow/name", value: "Mossy Hollow" }]);
  assert.equal(byId.levels[1].name, "Mossy Hollow");
});

it("physics: boxes land, one-way floors hold from above only, walls block", () => {
  const g = makeGrid(["......", "..==..", "......", "######"], true);
  const m = { x: 2.1, y: 0, w: 0.8, h: 0.8, vx: 0, vy: 0 };
  const r = moveBox(g, m, 0, 0.5, []);
  assert.equal(r.hitDown, true);
  assert.ok(Math.abs(m.y + m.h - 1) < 1e-9);
  const up = { x: 2.1, y: 2.1, w: 0.8, h: 0.8, vx: 0, vy: 0 };
  moveBox(g, up, 0, -1.5, []);
  assert.ok(up.y < 1, "passes up through a one-way floor");
  const wall = makeGrid(["..#", "..#"], false);
  const b = { x: 0, y: 0, w: 0.8, h: 0.8, vx: 5, vy: 0 };
  moveBox(wall, b, 3, 0, []);
  assert.ok(Math.abs(b.x + b.w - 2) < 1e-9);
  // Circle against a 30 degree plank is pushed out along the plank's normal.
  const [c, s] = rot(30);
  const n = ballVsOBB({ x: 0, y: -0.2, r: 0.4, vx: 0, vy: 0, bounce: 0, friction: 0 }, { cx: 0, cy: 0, hw: 1.5, hh: 0.1, c, s, bounce: 0, friction: 0, uid: 1 });
  assert.ok(n && n.ny < -0.8 && n.nx > 0.4);
});

it("platformer: jump height matches the spec, stomping defeats, pickups score", () => {
  const spec = tinyPlatformer([{ def: "walker", x: 9, y: 5 }, { def: "pickup", x: 5, y: 5 }]);
  const g = new Game(spec);
  runHeadless(g, 30);
  assert.ok(g.player.grounded);
  const y0 = g.player.y;
  let minY = y0;
  g.step(BIT.jump);
  for (let i = 0; i < 60; i++) {
    g.step(BIT.jump);
    minY = Math.min(minY, g.player.y);
  }
  const rise = y0 - minY;
  assert.ok(Math.abs(rise - 3.4) < 0.25, `rose ${rise}`);
  // Walk right into the pickup.
  runHeadless(g, 60, BIT.right);
  assert.equal(g.s.score >= 10, true);
  // Drop onto the walker from above.
  const w = g.s.ents.find((e) => e.def === "walker")!;
  const p = g.player;
  p.x = w.x;
  p.y = w.y - 2;
  p.vy = 2;
  w.vx = 0;
  runHeadless(g, 40);
  assert.equal(w.alive, false);
  assert.ok(g.s.defeated === 1);
});

it("moving platforms carry riders; springs launch; falling platforms fall", () => {
  const spec = tinyPlatformer([{ def: "platform", x: 6, y: 2 }, { def: "spring", x: 14, y: 5 }]);
  const g = new Game(spec);
  const plat = g.s.ents.find((e) => e.def === "platform")!;
  const p = g.player;
  p.x = plat.x + 1;
  p.y = plat.y - p.h - 0.01;
  runHeadless(g, 10);
  assert.equal(p.groundUid, plat.uid);
  const offset = p.x - plat.x;
  runHeadless(g, 60);
  assert.ok(Math.abs(p.x - plat.x - offset) < 0.05, "rider moved with the platform");
  const g2 = new Game(spec);
  const spring = g2.s.ents.find((e) => e.def === "spring")!;
  g2.player.x = spring.x + 0.1;
  g2.player.y = spring.y - 1.5;
  let launched = false;
  for (let i = 0; i < 60; i++) {
    g2.step(0);
    if (g2.player.vy < -15) launched = true;
  }
  assert.ok(launched);
});

it("lives, checkpoints and respawn; falling out of the world costs a life", () => {
  const spec = tinyPlatformer([{ def: "checkpoint", x: 8, y: 5 }], (s) => {
    const l = s.levels[0];
    const p = Paint.from(l.tiles).rect(12, 6, 13, 7, ".");
    l.tiles = p.rows();
  });
  const g = new Game(spec);
  runHeadless(g, 90, BIT.right);
  assert.deepEqual(g.s.checkpoint, [8, 5]);
  runHeadless(g, 240, BIT.right);
  assert.equal(g.s.deaths >= 1, true);
  assert.equal(g.s.lives, 3 - g.s.deaths);
  runHeadless(g, 60);
  if (g.s.status === "playing") assert.ok(Math.abs(g.player.x - 8.1) < 0.6, "respawned at the checkpoint");
});

it("the engine is deterministic: same inputs give the same state, snapshots resume exactly", () => {
  for (const make of [samplePlatformer, sampleTopDown]) {
    const spec = make();
    const inputs = Array.from({ length: 600 }, (_, i) => [BIT.right, BIT.right | BIT.jump, BIT.action | BIT.down, BIT.left, 0][(i * 7) % 5 >> 0]);
    const a = new Game(spec), b = new Game(spec);
    inputs.forEach((i) => a.step(i));
    inputs.forEach((i) => b.step(i));
    assert.equal(a.hash(), b.hash());
    const c = new Game(spec);
    inputs.slice(0, 300).forEach((i) => c.step(i));
    const snap = c.snapshot();
    inputs.slice(300).forEach((i) => c.step(i));
    const d = new Game(spec);
    d.restore(snap);
    inputs.slice(300).forEach((i) => d.step(i));
    assert.equal(c.hash(), d.hash());
    assert.equal(c.hash(), a.hash());
  }
});

it("puzzle: crates on plates open gates; grid moves push crates", () => {
  const spec = samplePuzzle();
  const g = new Game(spec);
  const door = g.s.ents.find((e) => e.def === "door")!;
  assert.equal(g.bh(door, "door")!.s.open, false);
  const r = playtest(spec, 0);
  assert.ok(r.passed, r.reason);
  const g2 = replay(spec, 0, r.inputs);
  assert.equal(g2.s.status, "won");
});

it("the playtest bot finishes every level of every sample and its inputs replay", () => {
  for (const [name, make] of Object.entries(SAMPLES)) {
    const spec = make();
    for (let i = 0; i < spec.levels.length; i++) {
      const r = playtest(spec, i);
      assert.ok(r.passed, `${name} level ${i}: ${r.reason}`);
      if (spec.meta.genre !== "builder" && spec.meta.genre !== "defense") assert.equal(replay(spec, i, r.inputs).s.status, "won", `${name} ${i} replay`);
    }
  }
});

it("input mapper merges keys, gamepad and touch and supports remapping", () => {
  const spec = samplePlatformer();
  const m = new InputMapper(spec.controls);
  m.keyDown("ArrowRight");
  m.keyDown("Space");
  assert.equal(m.read(), BIT.right | BIT.jump);
  m.remap("jump", ["KeyK"]);
  assert.equal(m.read(), BIT.right);
  m.keyUp("ArrowRight");
  assert.equal(m.read(new Set(["pad:left"])), BIT.left);
  m.setTouch(BIT.action);
  assert.equal(m.read(), BIT.action);
});

it("save states survive JSON and resume exactly", async () => {
  const { serializeState, deserializeState } = await import("../../apps/web/src/studio2d/runtime/player.ts");
  const spec = samplePlatformer();
  const a = new Game(spec);
  runHeadless(a, 200, BIT.right);
  const saved = JSON.parse(JSON.stringify(serializeState(a.snapshot())));
  const b = new Game(spec);
  b.restore(deserializeState(saved));
  for (let i = 0; i < 200; i++) {
    a.step(BIT.right | (i % 30 < 10 ? BIT.jump : 0));
    b.step(BIT.right | (i % 30 < 10 ? BIT.jump : 0));
  }
  assert.equal(a.hash(), b.hash());
});

it("lane defense: placing costs currency, producers earn, shooters stop waves, idle play loses", async () => {
  const { sampleDefense } = await import("../../apps/web/src/studio2d/samples/index.ts");
  const { playDefense, replayDefense, defenseLayout } = await import("../../apps/web/src/studio2d/world/defense.ts");
  const spec = sampleDefense();
  assert.deepEqual(validateSpec(spec).errors, []);
  const g = new Game(spec);
  const start = g.s.currency;
  assert.ok(g.placeUnit("producer", 0, 0));
  assert.equal(g.s.currency, start - 50);
  assert.equal(g.canPlace("producer", 0, 1), "recharging");
  assert.equal(g.canPlace("shooter", 0, 0), "taken");
  assert.equal(g.canPlace("shooter", 20, 0), "outside the lanes");
  runHeadless(g, 60 * 10);
  assert.ok(g.s.currency > start - 50 + 25, "producer and income earn currency");
  // Doing nothing lets an invader reach the house.
  const idle = new Game(spec);
  runHeadless(idle, 60 * 200);
  assert.equal(idle.s.status, "lost");
  // The bot wins both levels, and its placements replay to the same win.
  for (let i = 0; i < spec.levels.length; i++) {
    const r = playDefense(spec, i);
    assert.ok(r.won, `level ${i}: ${r.reason}`);
    assert.equal(replayDefense(spec, i, r.commands).s.status, "won");
  }
  const lay = defenseLayout(3, 0.1);
  assert.equal(lay.lanes!.rows, 3);
  assert.equal(defenseLayout(3, 0.8).lanes!.rows, 5);
});
