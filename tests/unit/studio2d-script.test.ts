// Beetle 2D scripted games: templates, routing, the static check, auto-fix, smoke tests and export.
import { it } from "vitest";
import assert from "node:assert/strict";
import { ScriptGame, checkScript, autoFix, smokeTest, compileScript, scriptWrapper } from "../../apps/web/src/studio2d/runtime/script.ts";
import { SCRIPT_TEMPLATES, SCRIPT_SAMPLES, fillTemplate, findTemplate } from "../../apps/web/src/studio2d/samples/scripts.ts";
import { scriptedSpec, wantsScript, closestGenre, SCRIPT_SYSTEM } from "../../apps/web/src/studio2d/gen/script.ts";
import { designFromIdea, repairDesign } from "../../apps/web/src/studio2d/gen/design.ts";
import { specFromDesign } from "../../apps/web/src/studio2d/gen/build.ts";
import { templateSpec } from "../../apps/web/src/studio2d/gen/ai.ts";
import { validateSpec } from "../../apps/web/src/studio2d/spec/validate.ts";
import { exportHtml } from "../../apps/web/src/studio2d/export/export.ts";

it("every classic template passes the static check and a long random smoke test", () => {
  assert.ok(SCRIPT_TEMPLATES.length >= 12);
  for (const t of SCRIPT_TEMPLATES) {
    const code = fillTemplate(t.code, { enemy: "zombie", pickup: "apple" });
    assert.deepEqual(checkScript(code), [], t.id);
    assert.ok(!/\{\{/.test(code), `${t.id} placeholders filled`);
    for (const seed of [1, 2, 3]) {
      const r = smokeTest(compileScript(code), 1800, seed);
      assert.ok(r.ok, `${t.id} seed ${seed}: ${r.error}`);
    }
  }
});

it("templates are found from ideas, and their looks come from the idea", () => {
  assert.equal(findTemplate("make tetris but spooky")?.id, "tetris");
  assert.equal(findTemplate("a pong game")?.id, "pong");
  assert.equal(findTemplate("space invaders with cats")?.id, "invaders");
  assert.equal(findTemplate("a fox platformer"), null);
  const d = designFromIdea("space invaders, but the aliens are cats");
  assert.equal(d.route, "template");
  const spec = templateSpec("space invaders, but the aliens are cats", d);
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.match(spec.script!.code, /look: "cat"/);
  assert.equal(fillTemplate('look: "{{hero}} spaceship"', {}), 'look: "spaceship"');
});

it("ideas route to a genre, a template or a model-written script", () => {
  const route = (i: string) => designFromIdea(i).route;
  assert.equal(route("make a copy of plants vs zombies"), "genre");
  assert.equal(designFromIdea("make a copy of plants vs zombies").genre, "defense");
  assert.equal(route("tetris"), "template");
  assert.equal(route("a rhythm game where you tap to the beat"), "script");
  assert.equal(route("a chess game"), "script");
  assert.equal(route("a fox platformer in the forest"), "genre");
  assert.ok(wantsScript("mini golf with windmills"));
  assert.equal(closestGenre("asteroids"), "arena");
  // The model can say an idea fits no genre.
  const base = designFromIdea("a game about a cat");
  assert.equal(repairDesign({ fits: false }, base).route, "script");
  assert.equal(repairDesign({ fits: true }, base).route, "genre");
});

it("plants-vs-zombies style ideas become a playable, bot-verified lane defense game", () => {
  const d = designFromIdea("make a copy of plants vs zombies");
  const r = specFromDesign(d, { seed: 3 });
  assert.deepEqual(validateSpec(r.spec).errors, []);
  assert.equal(r.spec.meta.genre, "defense");
  assert.ok(r.spec.levels.every((l) => l.lanes && l.shop?.length === 3));
  assert.ok(r.reports.every((x) => x.passed), r.reports.map((x) => x.reason).join("; "));
  assert.ok(r.ms < 10000);
});

it("the static check refuses network, storage, page and timer APIs", () => {
  const bad = {
    'fetch("https://x.y")': /network/,
    "localStorage.setItem('a', 1)": /storage/,
    "document.body.innerHTML = ''": /the page itself/,
    "window.open('x')": /the page itself/,
    "eval('1')": /running other code/,
    "new Function('return 1')": /running other code/,
    "setTimeout(() => {}, 5)": /timers/,
  };
  for (const [line, re] of Object.entries(bad)) {
    const errs = checkScript(`function update(g) { ${line}; }`);
    assert.ok(errs.some((e) => re.test(e)), `${line}: ${errs.join("; ")}`);
  }
  // Words inside strings and comments are fine.
  assert.deepEqual(checkScript('// fetch the ball\nfunction update(g) { g.say("window seat"); }'), []);
  assert.match(checkScript("function create(g) {}").join(), /must define function update/);
});

it("common small-model slips are repaired or tolerated", () => {
  const fixed = autoFix('function create(g) {\n  g.every(1, "spawn") {\n    g.add({});\n  }\n}\nfunction update(g){}');
  assert.match(fixed.code, /if \(g\.every\(1, "spawn"\)\) \{/);
  assert.ok(fixed.fixes.length);
  // A forgotten "let" and key aliases do not crash the game.
  const mod = compileScript("function create(g) { g.p = g.add({ x: 1, y: 1 }); }\nfunction update(g) { dx = g.key.space ? 1 : 0; if (g.key.a) dx = -1; g.p.x += dx; }");
  const game = new ScriptGame(mod);
  game.step({ left: false, right: false, up: false, down: false, jump: true, action: false });
  assert.equal(game.objs[0].x, 2);
  game.step({ left: true, right: false, up: false, down: false, jump: false, action: false });
  assert.equal(game.objs[0].x, 1);
});

it("the smoke test catches crashes, empty games and frozen games", () => {
  assert.match(smokeTest(compileScript("function create(g){ g.add({}); }\nfunction update(g){ g.nothing.go(); }")).error ?? "", /update\(\) failed/);
  assert.match(smokeTest(compileScript("function update(g){}")).error ?? "", /nothing is on screen/);
  assert.match(smokeTest(compileScript("function create(g){ g.add({x:1,y:1}); }\nfunction update(g){}")).error ?? "", /nothing ever moves/);
  assert.match(smokeTest(compileScript("function create(g){ g.o = g.add({x:1,y:1}); }\nfunction update(g){ g.o.x = NaN; }")).error ?? "", /invalid position/);
});

it("scripted games validate, export with the script and an error reporter", () => {
  for (const [id, s] of Object.entries(SCRIPT_SAMPLES)) {
    const spec = scriptedSpec({ ...s, idea: id });
    assert.deepEqual(validateSpec(spec).errors, [], id);
    const html = exportHtml(spec, "/*runtime*/");
    assert.ok(html.includes("__studio2dScript"), id);
    assert.ok(html.includes("__studio2dErrors"), id);
    assert.equal((html.match(/<\/script>/g) || []).length, 4, "error reporter, spec, game, runtime");
  }
  const bad = scriptedSpec({ title: "x", pitch: "", code: "function update(g){}", idea: "x" });
  bad.script!.code = "function update(g){ fetch('x') }";
  assert.match(validateSpec(bad).errors.join(), /network/);
  assert.match(scriptWrapper("function update(g){}"), /__studio2dScript/);
  assert.match(SCRIPT_SYSTEM, /g\.add/);
});
