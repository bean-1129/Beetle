// Beetle 2D assets and audio: sprites, tiles, backgrounds, sprite sheets, generated-art cutouts, sfx and music.
import { it } from "vitest";
import assert from "node:assert/strict";
import { SAMPLES, samplePlatformer } from "../../apps/web/src/studio2d/samples/index.ts";
import { buildAssets, processGenerated, rigFromImage, assetPrompt } from "../../apps/web/src/studio2d/assets/pipeline.ts";
import { makeCharacter, makeItem, archetypeOf } from "../../apps/web/src/studio2d/assets/sprites.ts";
import { makeTileset, checkTileset, seamScore, BLOB_MASKS, EDGE_MASKS, canonical, BLOB_INDEX, blobIndexAt } from "../../apps/web/src/studio2d/assets/tiles.ts";
import { makeBackground } from "../../apps/web/src/studio2d/assets/backgrounds.ts";
import { checkSprite, frameDrift } from "../../apps/web/src/studio2d/assets/checks.ts";
import { packSheet } from "../../apps/web/src/studio2d/assets/sheet.ts";
import { pixels, rect, ellipse, rampPalette, get, hex } from "../../apps/web/src/studio2d/assets/pixels.ts";
import { ANIMS, FRAME_COUNT } from "../../apps/web/src/studio2d/assets/rig.ts";
import { renderSfx, sfxParams } from "../../apps/web/src/studio2d/audio/sfx.ts";
import { compose, renderScore } from "../../apps/web/src/studio2d/audio/music.ts";
import { PALETTES } from "../../apps/web/src/studio2d/spec/defaults.ts";
import { SFX_PRESETS, MOODS } from "../../apps/web/src/studio2d/spec/types.ts";

it("a full asset set builds fast and every asset passes its checks, for every sample", () => {
  for (const [name, make] of Object.entries(SAMPLES)) {
    const spec = make();
    const built = buildAssets(spec);
    assert.ok(built.ms < 3000, `${name} took ${built.ms}ms`);
    const bad = built.report.filter((r) => !r.ok);
    assert.deepEqual(bad.map((r) => `${r.id}: ${r.problems.join(", ")}`), [], name);
    for (const id of Object.keys(spec.assets)) assert.ok(built.sprites[id] || built.tilesets[id] || built.backgrounds[id], `${name}: ${id} built`);
  }
});

it("pixel-art characters stay on palette, are cut out and readable", () => {
  const pal = PALETTES.forest;
  for (const recipe of ["fox", "slime", "bat", "knight", "beetle", "robot", "wizard", "frog", "giant slime", "mystery thing"]) {
    const s = makeCharacter(recipe, [0.9, 0.9], 16, "pixel", pal, 42);
    const f = s.frames.idle![0];
    const r = checkSprite(f, { w: s.w, h: s.h });
    assert.ok(r.ok, `${recipe}: ${r.problems.join(", ")}`);
    assert.equal(get(f, 0, 0)[3], 0, `${recipe} has a transparent background`);
  }
  assert.equal(archetypeOf("a sleepy red fox"), "quadruped");
  assert.equal(archetypeOf("tiny bat"), "flyer");
  assert.equal(archetypeOf("blue robot knight"), "biped");
});

it("cutout animation: every animation has its frames and frames never drift in colour", () => {
  const s = makeCharacter("fox", [0.8, 0.9], 16, "pixel", PALETTES.forest, 7);
  for (const a of ANIMS) assert.equal(s.frames[a]!.length, FRAME_COUNT[a], a);
  // Walking frames differ in pose but share the same pixels (perfect consistency).
  const [a, b] = s.frames.walk!;
  assert.notDeepEqual(a.data, b.data);
  assert.ok(frameDrift(a, b) < 0.12, `drift ${frameDrift(a, b)}`);
  for (const f of s.frames.run!) assert.ok(frameDrift(s.frames.idle![0], f) < 0.15);
});

it("tilesets: 47 blob variants, 16 edge variants, and clean seams", () => {
  assert.equal(BLOB_MASKS.length, 47);
  assert.equal(new Set(EDGE_MASKS.map(canonical)).size, 16);
  for (const recipe of ["forest ground", "desert sand", "snow", "space station", "castle stone", "candy land", "lava cave"]) {
    const t = makeTileset(recipe, 16, "pixel", PALETTES.forest, 3, true);
    assert.equal(t.solid.length, 47);
    const c = checkTileset(t);
    assert.ok(c.ok, `${recipe}: ${c.failures.join("; ")}`);
  }
  // The seam check catches a texture that does not wrap: a left-to-right gradient.
  const broken = pixels(16, 16);
  for (let x = 0; x < 16; x++) rect(broken, x, 0, 1, 16, [x * 16, x * 12, 60, 255]);
  assert.equal(seamScore(broken, broken, "x").ok, false);
  assert.equal(seamScore(broken, broken, "y").ok, true);
  // Neighbour lookup picks the right variant.
  const solid = (_x: number, y: number) => y >= 1;
  assert.equal(blobIndexAt(solid, 5, 1), BLOB_INDEX.get(canonical(0xff & ~(1 | 2 | 128))));
  assert.equal(blobIndexAt(() => true, 5, 5), BLOB_INDEX.get(255));
});

it("parallax backgrounds tile horizontally without a seam", () => {
  for (const recipe of ["forest sky", "forest hills", "forest trees", "desert hills", "city trees", "space sky"]) {
    const bg = makeBackground(recipe, 384, 272, "pixel", PALETTES.forest, 5);
    let diff = 0;
    for (let y = 0; y < bg.h; y++) {
      const a = get(bg, bg.w - 1, y), b = get(bg, 0, y);
      diff += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);
    }
    assert.ok(diff / bg.h < 40, `${recipe} wrap step ${diff / bg.h}`);
  }
});

it("items and props draw from their recipes", () => {
  for (const r of ["coin", "glowing seed", "heart", "key", "flag", "portal", "crate", "spikes", "spring", "door", "switch", "turret", "lantern", "gem"]) {
    const s = makeItem(r, [0.8, 0.8], 16, "pixel", PALETTES.forest, 3);
    const f = s.frames.idle![0];
    let opaque = 0;
    for (let i = 3; i < f.data.length; i += 4) if (f.data[i]) opaque++;
    assert.ok(opaque > 10, r);
  }
  assert.equal(makeItem("coin", [0.6, 0.6], 16, "pixel", PALETTES.forest, 1).frames.idle!.length, 4, "coins spin");
});

it("sprite sheet packing keeps every image without overlap", () => {
  const items = Array.from({ length: 40 }, (_, i) => {
    const p = pixels(8 + (i % 7) * 3, 6 + (i % 5) * 4);
    rect(p, 0, 0, p.w, p.h, [i * 5, 100, 200, 255]);
    return { key: `k${i}`, img: p };
  });
  const a = packSheet(items, 128);
  const rects = Object.values(a.rects);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const [ax, ay, aw, ah] = rects[i], [bx, by, bw, bh] = rects[j];
      assert.ok(ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay, "no overlap");
    }
  assert.ok(a.image.w <= 128);
});

it("generated art is cut down to size, snapped to the palette, checked and rigged", () => {
  const spec = samplePlatformer();
  // A fake 256px generation: a big orange blob on transparent background.
  const img = pixels(256, 256);
  ellipse(img, 128, 140, 80, 100, [224, 120, 44, 255]);
  ellipse(img, 128, 60, 50, 45, [240, 200, 160, 255]);
  const r = processGenerated(img, spec, "hero", 16);
  assert.ok(r.set, r.problems.join(","));
  const pal = rampPalette(spec.meta.palette);
  const check = checkSprite(r.set.frames.idle![0], { palette: pal });
  assert.ok(check.ok, check.problems.join(","));
  assert.equal(r.set.frames.walk!.length, FRAME_COUNT.walk, "rigged into parts");
  assert.ok(rigFromImage(r.set.frames.idle![0]).parts.length >= 4);
  // An empty or boxed image is rejected so the procedural twin stays.
  const boxed = pixels(64, 64);
  rect(boxed, 0, 0, 64, 64, [255, 255, 255, 255]);
  assert.equal(processGenerated(boxed, spec, "hero", 16).set, null);
  assert.match(assetPrompt(spec, spec.assets.hero), /pixel art/);
});

it("sound effects synthesize for every preset, seeded and bounded", () => {
  for (const p of SFX_PRESETS) {
    const a = renderSfx(sfxParams(p, 1));
    const b = renderSfx(sfxParams(p, 1));
    assert.deepEqual(a, b, `${p} deterministic`);
    assert.ok(a.length > 100 && a.length < 22050 * 1.2, p);
    let peak = 0;
    for (const v of a) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak > 0.02 && peak <= 1, `${p} peak ${peak}`);
    assert.ok(Math.abs(a[a.length - 1]) < 0.05, `${p} fades out`);
  }
  assert.notDeepEqual(renderSfx(sfxParams("jump", 1)), renderSfx(sfxParams("jump", 2)));
});

it("music: every mood composes a clean loop", () => {
  for (const mood of MOODS) {
    const score = compose({ id: mood, mood, seed: 3 });
    assert.equal(score.beats, 32);
    assert.ok(score.notes.every((n) => n.t >= 0 && n.t < score.seconds), mood);
    const buf = renderScore(score, 11025);
    assert.equal(buf.length, Math.round(score.seconds * 11025));
    // The loop point is seamless: the jump from the last sample to the first is ordinary.
    let maxStep = 0;
    for (let i = 1; i < buf.length; i++) maxStep = Math.max(maxStep, Math.abs(buf[i] - buf[i - 1]));
    assert.ok(Math.abs(buf[0] - buf[buf.length - 1]) <= maxStep + 1e-6, `${mood} loop join`);
    assert.ok(buf.every((v) => Math.abs(v) <= 1));
  }
  const calm = compose({ id: "c", mood: "calm", seed: 1 }), boss = compose({ id: "b", mood: "boss", seed: 1 });
  assert.ok(boss.tempo > calm.tempo);
});

it("generated art cutouts: Vision masks and plain-background flood fill", async () => {
  const { applyMask, cutoutPlainBackground } = await import("../../apps/web/src/studio2d/assets/pipeline.ts");
  const img = pixels(40, 40);
  rect(img, 0, 0, 40, 40, [250, 250, 250, 255]);
  ellipse(img, 20, 20, 10, 12, [200, 80, 40, 255]);
  const cut = cutoutPlainBackground(img);
  assert.equal(get(cut, 0, 0)[3], 0);
  assert.equal(get(cut, 20, 20)[3], 255);
  const mask = pixels(20, 20);
  rect(mask, 5, 5, 10, 10, [255, 255, 255, 255]);
  const m = applyMask(img, mask);
  assert.equal(get(m, 2, 2)[3], 0);
  assert.equal(get(m, 20, 20)[3], 255);
});
