// Beetle 2D generation: idea to design, design to bot-verified game, world building, word patches, desktop bridge.
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { designFromIdea, repairDesign, detectGenre, DESIGN_SCHEMA } from "../../apps/web/src/studio2d/gen/design.ts";
import { specFromDesign } from "../../apps/web/src/studio2d/gen/build.ts";
import { planPatch, safeApply, specOutline, PATCH_SCHEMA } from "../../apps/web/src/studio2d/gen/nlpatch.ts";
import { validateSpec } from "../../apps/web/src/studio2d/spec/validate.ts";
import { samplePlatformer, sampleTopDown } from "../../apps/web/src/studio2d/samples/index.ts";
import { buildWorld, outline, reachableSide, reachableTop, difficultyCost, budgetFor, makeStreamer, endlessLevel } from "../../apps/web/src/studio2d/world/levels.ts";
import { assemble, type Theme } from "../../apps/web/src/studio2d/spec/kit.ts";
import type { GameSpec } from "../../apps/web/src/studio2d/spec/types.ts";
import { Game } from "../../apps/web/src/studio2d/engine/game.ts";
import { generatePuzzleRoom, puzzleModel, solvePuzzle } from "../../apps/web/src/studio2d/world/puzzle.ts";
import { wfcInterior } from "../../apps/web/src/studio2d/world/topdown.ts";
import { mulberry } from "../../apps/web/src/studio2d/engine/rng.ts";
import { jumpReach, limits } from "../../apps/web/src/studio2d/world/platformer.ts";
import { makeDesign, changeInWords } from "../../apps/web/src/studio2d/gen/ai.ts";

it("ideas are read into a design without any model", () => {
  const d = designFromIdea("a fox who collects glowing seeds in a rainy forest, with moving platforms and a boss at the end");
  assert.equal(d.genre, "platformer");
  assert.equal(d.art.hero, "fox");
  assert.match(d.art.pickup, /seed/);
  assert.equal(d.art.setting, "forest");
  assert.equal(d.art.weather, "rain");
  assert.equal(d.boss, true);
  assert.ok(d.mechanics.includes("moving platforms"));
  assert.ok(d.levels.length >= 3 && d.levels.length <= 5);
  const cases = {
    "an endless runner with a penguin": "runner",
    "top-down dungeon crawler": "top-down",
    "arena shooter where you survive waves": "arena",
    "sokoban style crate pushing puzzle": "puzzle",
    "build a marble contraption": "builder",
    "a jumping game about a frog": "platformer",
  };
  for (const [idea, genre] of Object.entries(cases)) assert.equal(detectGenre(idea), genre, idea);
  const kid = designFromIdea("an easy cozy game for kids with 5 levels");
  assert.equal(kid.levels.length, 5);
  assert.ok(kid.difficulty < 0.3 && kid.tuning.lives >= 4);
});

it("the model's design is repaired onto the idea: bad values never get through", () => {
  const base = designFromIdea("a fox platformer in the forest");
  const d = repairDesign({ title: "  ", genre: "mmo", levels: [{ name: "One" }], art: { palette: "neon", hero: "Brave Fox!!", weather: "hail" }, difficulty: 7, tuning: { jumpHeight: 40, lives: -3 } }, base);
  assert.equal(d.title, base.title);
  assert.equal(d.genre, base.genre);
  assert.equal(d.levels.length, 3);
  assert.equal(d.art.palette, base.art.palette);
  assert.equal(d.art.hero, "brave fox");
  assert.equal(d.art.weather, base.art.weather);
  assert.equal(d.difficulty, 1);
  assert.equal(d.tuning.jumpHeight, 5);
  assert.equal(d.tuning.lives, 1);
  assert.equal(repairDesign(null, base).title, base.title);
  assert.ok(DESIGN_SCHEMA.required.includes("genre") && PATCH_SCHEMA.required.includes("ops"));
});

it("every genre goes from idea to a valid, bot-verified game", () => {
  for (const idea of [
    "a fox who collects glowing seeds in a rainy forest with a boss",
    "an endless runner with a penguin on icy cliffs",
    "a top-down dungeon where a knight finds a key",
    "a space arena shooter with a robot and waves of slimes",
    "a puzzle about a cat pushing crates in the desert",
    "build a contraption so the marble lands in the basket",
  ]) {
    const d = designFromIdea(idea);
    const r = specFromDesign(d, { seed: 5 });
    assert.deepEqual(validateSpec(r.spec).errors, [], idea);
    assert.equal(r.spec.meta.genre, d.genre);
    assert.equal(r.spec.levels.length, d.levels.length);
    assert.ok(r.reports.every((x) => x.passed), `${idea}: ${r.reports.map((x) => x.reason).join("; ")}`);
    assert.ok(r.reports.every((x) => x.attempts <= 2), `${idea}: repaired within two tries`);
    assert.ok(r.ms < 30000, `${idea} took ${r.ms}ms`);
  }
}, 60000); // its own budget is 30s per idea; keep the runner from cutting it off first

it("the design's tuning reaches the spec", () => {
  const d = designFromIdea("a hard fox platformer with a double jump against the clock");
  const r = specFromDesign(d, { seed: 2 });
  const ctrl = r.spec.player.behaviors.find((b) => b.type === "platformer-controller");
  assert.equal(ctrl?.params?.doubleJump, true);
  assert.ok(r.spec.rules.some((x) => x.type === "timer" && x.countDown));
  assert.equal(r.spec.rules.find((x) => x.type === "lives")?.count, d.tuning.lives);
});

it("world building: outline beats, reachability, difficulty budget", () => {
  const plans = outline(5, 0.5);
  assert.deepEqual(plans.map((p) => p.beat), ["intro", "teach", "test", "twist", "finale"]);
  assert.ok(plans[4].difficulty > plans[0].difficulty);
  assert.ok(plans[4].boss);
  const spec = samplePlatformer();
  for (const l of spec.levels) assert.ok(reachableSide(spec, l).ok, l.id);
  // Cutting the floor out under the goal makes it unreachable.
  const broken = structuredClone(spec);
  const l = broken.levels[0];
  l.tiles = l.tiles.map((row, y) => (y >= 10 ? row.slice(0, 50) + ".".repeat(row.length - 50) : row));
  assert.equal(reachableSide(broken, l).ok, false);
  assert.ok(reachableTop(sampleTopDown().levels[0]).ok);
  const lvl = spec.levels[1];
  assert.ok(difficultyCost(lvl) > 0);
  assert.ok(budgetFor("platformer", lvl, 1) > budgetFor("platformer", lvl, 0));
  // Physics numbers drive the chunk limits.
  const ph = { speed: 7, jumpHeight: 3.4, gravity: 60, doubleJump: false };
  assert.ok(jumpReach(ph, 0) > 4 && jumpReach(ph, 0) < 5.5);
  assert.ok(limits({ ...ph, doubleJump: true }).gap > limits(ph).gap);
});

it("level validation holds across many seeds (reachable and within budget)", () => {
  for (const genre of ["platformer", "runner", "top-down", "arena"] as const) {
    for (let seed = 1; seed <= 6; seed++) {
      const theme = { title: `Seeds ${seed}`, pitch: "", genre, hero: "fox" };
      const { levels, reports } = buildWorld(theme, { seed, count: 3, difficulty: 0.6, skipBot: true });
      const spec = assemble(theme, levels);
      assert.deepEqual(validateSpec(spec).errors, [], `${genre} ${seed}`);
      reports.forEach((r, i) => {
        assert.ok(r.reachable, `${genre} ${seed} ${r.id}: ${r.reason}`);
        assert.ok(r.budget.cost <= r.budget.limit, `${genre} ${seed} ${r.id} budget`);
        assert.ok(levels[i].music);
      });
    }
  }
});

it("puzzle rooms are generated backwards and always solvable", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const room = generatePuzzleRoom(seed, (seed % 5) / 4);
    assert.ok(room, `seed ${seed}`);
    const spec = assemble({ title: "P", pitch: "", genre: "puzzle" }, [{ id: "p", name: "P", size: [room.tiles[0].length, room.tiles.length], tileSize: 16, tileset: "tiles", tiles: room.tiles, spawn: room.spawn, placements: room.placements, background: [] }]);
    const moves = solvePuzzle(puzzleModel(spec, spec.levels[0]));
    assert.ok(moves && moves.length >= 6, `seed ${seed}`);
  }
});

it("wave function collapse keeps its adjacency rules", () => {
  const cells = wfcInterior(mulberry(3), 14, 10, [4, 3, 2]);
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 14; x++) {
      if (x === 0 || y === 0 || x === 13 || y === 9) assert.equal(cells[y][x], ".");
      if (cells[y][x] === "W") for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.equal(cells[y + dy]?.[x + dx] ?? ".", ".", "pillars stand alone");
    }
});

it("endless runners stream chunks forever, always joined to the ground", () => {
  const theme: Theme = { title: "Endless", pitch: "", genre: "runner", hero: "squirrel" };
  const spec = assemble(theme, [endlessLevel(9)]);
  assert.deepEqual(validateSpec(spec).errors, []);
  const g = new Game(spec, { streamer: makeStreamer(spec) });
  const w0 = g.s.grid.w;
  const p = g.player;
  // Carry the runner forward: new chunks appear ahead of it.
  for (let i = 0; i < 900 && g.s.status === "playing"; i++) {
    g.step(0);
    if (p.y > 5) p.y = 5;
  }
  assert.ok(g.s.grid.w > w0 + 50, `grew to ${g.s.grid.w}`);
  assert.ok(g.s.chunk >= 2);
  // Every streamed column past the start strip has ground within a jump of the base line,
  // or is a short gap: no gap is wider than the runner can clear.
  const { w, h, cells } = g.s.grid;
  let gap = 0, widest = 0;
  for (let x = w0; x < w; x++) {
    let ground = false;
    for (let y = h - 6; y < h; y++) if (cells[y * w + x] === 1) ground = true;
    gap = ground ? 0 : gap + 1;
    widest = Math.max(widest, gap);
  }
  assert.ok(widest <= 8, `widest gap ${widest}`);
});

it("words become checked patches; impossible physics is refused", () => {
  const spec = samplePlatformer();
  const cases: Record<string, (s: GameSpec) => boolean> = {
    "make the jump higher": (s) => Number(s.player.behaviors[0]?.params?.jumpHeight) > 3.4,
    "add a double jump": (s) => s.player.behaviors[0]?.params?.doubleJump === true,
    "make the boss slower": (s) => Number(s.entities.find((e) => e.id === "boss")?.behaviors[0]?.params?.speed) < 2.4,
    "more rain": (s) => (s.levels[0]?.weatherAmount ?? 0) > 0.6,
    "no rain please": (s) => s.levels.every((l) => l.weather === "none"),
    "give me 7 lives": (s) => s.rules.find((r) => r.type === "lives")?.count === 7,
    "call it Rainfox": (s) => s.meta.title === "Rainfox" && s.levels[0]?.weather === "rain",
    "make it painted style": (s) => s.meta.artStyle === "painted",
    "remove the boss": (s) => !s.levels[1]?.placements.some((p) => p.def === "boss"),
    "add a 90 second timer": (s) => s.rules.some((r) => r.type === "timer" && r.seconds === 90),
    "make the enemies faster": (s) => Number(s.entities.find((e) => e.id === "walker")?.behaviors[0]?.params?.speed) > 1.8,
  };
  for (const [text, check] of Object.entries(cases)) {
    const plan = planPatch(spec, text);
    assert.ok(plan, text);
    const r = safeApply(spec, plan.ops, plan.summary);
    assert.ok(r.ok, `${text}: ${r.ok ? "" : r.reason}`);
    assert.ok(check(r.spec), text);
  }
  assert.equal(planPatch(spec, "tell me a joke"), null);
  // Lowering the jump until a level breaks is refused with a reason.
  let s = spec, refused = null;
  for (let i = 0; i < 10 && !refused; i++) {
    const p = planPatch(s, "make the jump lower");
    const r = safeApply(s, p!.ops, p!.summary);
    if (r.ok) s = r.spec;
    else refused = r.reason;
  }
  assert.match(refused ?? "", /impossible to finish/);
  // Model patches go through the same gate.
  assert.equal(safeApply(spec, [{ op: "replace", path: "/player/behaviors/0/params/jumpHeight", value: 99 }]).ok, false);
  assert.match(specOutline(spec), /\/player id=hero/);
});

// The old desktop main-process module (local-only model calls, reply JSON parsing, play-frame
// network guard) has no counterpart in Beetle; the renderer side talks to globalThis.studio2d.
it.skip("desktop module: local-only model calls, JSON parsing, and a network guard for game frames (no desktop main-process module in Beetle)", () => {});

describe("desktop bridge (stub on globalThis.studio2d)", () => {
  const g = globalThis as { studio2d?: unknown };
  afterEach(() => {
    delete g.studio2d;
  });

  it("with no bridge the idea is read directly and unknown changes fail clearly", async () => {
    delete g.studio2d;
    const r = await makeDesign("a fox platformer in the forest");
    assert.equal(r.source, "idea");
    assert.equal(r.design.genre, "platformer");
    const c = await changeInWords(samplePlatformer(), "tell me a joke");
    assert.equal(c.ok, false);
    assert.match(c.reason, /local model is not available/);
  });

  it("the model's design goes through the bridge and is repaired onto the idea", async () => {
    const calls: { id: string; schema: object }[] = [];
    g.studio2d = {
      llm: async (p: { id: string; schema: object }) => {
        calls.push(p);
        return { ok: true, model: "stub", json: { title: "  ", genre: "mmo", art: { hero: "Brave Fox!!" }, difficulty: 7 } };
      },
    };
    const r = await makeDesign("a fox platformer in the forest");
    assert.equal(r.source, "model");
    assert.equal(r.model, "stub");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].schema, DESIGN_SCHEMA);
    assert.equal(r.design.genre, "platformer");
    assert.equal(r.design.art.hero, "brave fox");
    assert.equal(r.design.difficulty, 1);
  });

  it("a bridge failure falls back to the idea", async () => {
    g.studio2d = { llm: async () => { throw new Error("offline"); } };
    const r = await makeDesign("a fox platformer in the forest");
    assert.equal(r.source, "idea");
    assert.match(r.note ?? "", /offline/);
  });

  it("model patches from the bridge pass the same safety gate", async () => {
    const spec = samplePlatformer();
    g.studio2d = { llm: async () => ({ ok: true, json: { summary: "huge jump", ops: [{ op: "replace", path: "/player/behaviors/0/params/jumpHeight", value: 99 }] } }) };
    const bad = await changeInWords(spec, "tell me a joke");
    assert.equal(bad.via, "model");
    assert.equal(bad.ok, false);
    g.studio2d = { llm: async () => ({ ok: true, json: { summary: "Renamed", ops: [{ op: "replace", path: "/meta/title", value: "Rainfox" }] } }) };
    const good = await changeInWords(spec, "xyzzy plugh");
    assert.equal(good.via, "model");
    assert.equal(good.ok, true);
    assert.equal(good.ok && good.spec.meta.title, "Rainfox");
  });
});
