// Procedural sprites: characters built as cutout rigs from a small set of body plans, and
// items, props and parts drawn from shape recipes. Colors come from the recipe words when
// they name a creature or material, otherwise from the game's palette.
import { pixels, ellipse, rect, poly, line, outline, lightEdges, hex, shade, mix, nearest, rampPalette, put, type Pixels, type RGBA } from "./pixels.ts";
import { bakeRig, type Anim, type Part, type Rig } from "./rig.ts";
import { mulberry } from "../engine/rng.ts";

export type Style = "pixel" | "flat" | "painted";
export type SpriteSet = { w: number; h: number; frames: Partial<Record<Anim, Pixels[]>>; rig?: Rig; archetype: string };

const ARCHETYPES: [string, RegExp][] = [
  ["ball", /\b(ball|marble|orb)\b/],
  ["flyer", /\b(bat|bird|bee|wisp|drone|ghost|fairy|owl|dragonfly|butterfly|moth|crow|firefly|jellyfish|ufo)\b/],
  ["blob", /\b(slime|jelly|blob|goo|fish|mushroom|puff)\b/],
  ["bug", /\b(beetle|spider|ant|crab|bug|scorpion|snail)\b/],
  ["quadruped", /\b(fox|cat|dog|wolf|squirrel|rabbit|bunny|bear|deer|mouse|raccoon|panda|frog|toad|lion|tiger|pig|horse|hedgehog|otter|dragon|dino|dinosaur|lizard|boar|kitten|puppy|hamster|turtle)\b/],
  ["biped", /\b(knight|robot|kid|child|girl|boy|elder|wizard|hero|ninja|pirate|astronaut|person|farmer|princess|prince|monk|witch|explorer|skeleton|zombie|goblin|alien|cowboy|chef|scientist|king|queen|penguin|monkey|bot)\b/],
];
export function archetypeOf(recipe: string, fallback = "blob"): string {
  const r = recipe.toLowerCase();
  for (const [a, re] of ARCHETYPES) if (re.test(r)) return a;
  return fallback;
}

const CREATURE_COLORS: [RegExp, string, string][] = [
  [/fox/, "#e0782c", "#fff1d6"],
  [/cat|kitten/, "#8d8f9e", "#e9e4dc"],
  [/squirrel|acorn/, "#a0562e", "#f2c07a"],
  [/rabbit|bunny/, "#e8e0d4", "#f2a6b4"],
  [/wolf|mouse|hamster/, "#7b7f8e", "#d8d8d8"],
  [/bear|boar|dog|puppy/, "#7a4a2a", "#d6a878"],
  [/panda/, "#f2f2f2", "#222222"],
  [/zombie/, "#6b5a8a", "#a88e6a"],
  [/frog|toad|goblin|lizard|dino|dragon|turtle/, "#4fa64a", "#c8e87a"],
  [/robot|bot|drone|knight|astronaut|ufo|turret/, "#9aa7b8", "#5b8fd6"],
  [/slime|jelly|goo|blob/, "#58c46b", "#c8f5b0"],
  [/bat|crow/, "#5a3d7a", "#b58ad6"],
  [/bee|firefly/, "#f2c43c", "#2a2a2a"],
  [/bird|owl/, "#4a90e2", "#ffd35c"],
  [/ghost|wisp|skeleton/, "#e6f0ff", "#7fd6ff"],
  [/beetle|ant|spider|scorpion/, "#2f5d5a", "#6fbfaa"],
  [/crab/, "#d64a3a", "#ffb09a"],
  [/penguin/, "#2a2f4a", "#f2f2f2"],
  [/elder|monk|wizard|witch/, "#6b4fa0", "#f2e8b6"],
  [/princess|prince|king|queen/, "#d6607f", "#ffd35c"],
  [/fish/, "#f2883c", "#ffe0a0"],
  [/mushroom/, "#c43d3d", "#fff1d6"],
  [/tiger|lion/, "#f2a03c", "#fff1d6"],
  [/pig/, "#f2a6b4", "#ffd6dc"],
  [/marble|ball|orb/, "#d64a5a", "#ffd6dc"],
];

export function colorsFor(recipe: string, palette: string[], seed: number): { main: RGBA; accent: RGBA; dark: RGBA; eye: RGBA } {
  const r = recipe.toLowerCase();
  const rng = mulberry(seed);
  let main: RGBA, accent: RGBA;
  const hit = CREATURE_COLORS.find(([re]) => re.test(r));
  if (hit) {
    main = hex(hit[1]);
    accent = hex(hit[2]);
  } else {
    const bright = palette.map(hex).filter((c) => { const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; return l > 60 && l < 230; });
    main = bright.length ? bright[rng.int(0, bright.length - 1)] : hex("#d68a45");
    accent = shade(main, 0.45);
  }
  if (/giant|boss|king/.test(r)) main = shade(main, -0.15);
  if (/glow|light|star/.test(r)) accent = hex("#fff4a0");
  return { main, accent, dark: shade(mix(main, hex("#1a1426"), 0.6), -0.2), eye: hex("#1a1426") };
}

function finish(p: Pixels, style: Style, pal: RGBA[] | null, dark: RGBA): Pixels {
  let out = style === "painted" ? p : lightEdges(p, 0.16);
  if (pal) out = snapTo(out, pal);
  return style === "painted" ? out : outline(out, pal ? nearest(pal, dark) : dark);
}
function snapTo(p: Pixels, pal: RGBA[]): Pixels {
  for (let i = 0; i < p.data.length; i += 4) {
    if (!p.data[i + 3]) continue;
    const c = nearest(pal, [p.data[i], p.data[i + 1], p.data[i + 2], 255]);
    p.data[i] = c[0];
    p.data[i + 1] = c[1];
    p.data[i + 2] = c[2];
    p.data[i + 3] = 255;
  }
  return p;
}

// Frame size: a bit larger than the hitbox so characters read clearly.
export function frameSize(sizeTiles: [number, number], tile: number): [number, number] {
  const w = Math.max(10, Math.round(sizeTiles[0] * tile * 1.3));
  const h = Math.max(10, Math.round(sizeTiles[1] * tile * 1.3));
  const s = Math.max(w, h);
  return [s, s];
}

const part = (name: string, img: Pixels, pivot: [number, number], at: [number, number], z: number): Part => ({ name, img, pivot, at, z });

export function makeCharacter(recipe: string, sizeTiles: [number, number], tile: number, style: Style, palette: string[], seed: number): SpriteSet {
  const [W, H] = frameSize(sizeTiles, tile);
  const arch = archetypeOf(recipe, /giant|boss/.test(recipe) ? "blob" : "blob");
  const col = colorsFor(recipe, palette, seed);
  const pal = style === "pixel" ? rampPalette(palette.concat(["#1a1426", "#ffffff"])).concat([col.main, col.accent, shade(col.main, -0.3), shade(col.main, 0.3), col.dark]) : null;
  const F = (p: Pixels) => finish(p, style, pal, col.dark);
  const u = W / 24; // design grid: 24 units per frame
  const P = (w: number, h: number) => pixels(Math.max(2, Math.ceil(w * u)), Math.max(2, Math.ceil(h * u)));
  const parts: Part[] = [];
  const rng = mulberry(seed);
  const r = recipe.toLowerCase();
  const eyeDot = (img: Pixels, x: number, y: number) => {
    rect(img, x, y, Math.max(1, Math.round(u * 1.2)), Math.max(1, Math.round(u * 1.6)), col.eye);
    put(img, x, y, [255, 255, 255, 255]);
  };
  if (arch === "quadruped") {
    const tall = /frog|toad|turtle/.test(r) ? 0.8 : 1;
    const body = P(15, 9 * tall);
    ellipse(body, body.w / 2, body.h / 2, body.w / 2 - 0.5, body.h / 2 - 0.5, (_x, y) => (y > body.h * 0.6 ? col.accent : col.main));
    const head = P(10, 9);
    ellipse(head, head.w * 0.45, head.h * 0.55, head.w * 0.42, head.h * 0.42, col.main);
    // Snout to the right (the facing direction).
    ellipse(head, head.w * 0.8, head.h * 0.68, head.w * 0.22, head.h * 0.2, col.accent);
    put(head, Math.round(head.w * 0.98) - 1, Math.round(head.h * 0.62), col.eye);
    eyeDot(head, Math.round(head.w * 0.58), Math.round(head.h * 0.4));
    const ear = P(8, 6);
    const pointy = /fox|cat|wolf|kitten|tiger|lion/.test(r);
    const long = /rabbit|bunny/.test(r);
    const earH = long ? ear.h : pointy ? ear.h : ear.h * 0.6;
    if (!/frog|toad|turtle|dino|lizard|dragon/.test(r)) {
      poly(ear, [[ear.w * 0.1, ear.h], [ear.w * 0.3, ear.h - earH], [ear.w * 0.5, ear.h]], col.main);
      poly(ear, [[ear.w * 0.5, ear.h], [ear.w * 0.72, ear.h - earH], [ear.w * 0.95, ear.h]], shade(col.main, -0.1));
    }
    const tail = P(9, 7);
    const bushy = /fox|squirrel|wolf|raccoon/.test(r);
    if (bushy) {
      ellipse(tail, tail.w * 0.45, tail.h * 0.5, tail.w * 0.45, tail.h * 0.4, col.main);
      ellipse(tail, tail.w * 0.18, tail.h * 0.5, tail.w * 0.18, tail.h * 0.3, col.accent);
    } else if (!/frog|toad|panda|bear|rabbit|bunny|turtle/.test(r)) line(tail, tail.w, tail.h * 0.7, 1, tail.h * 0.2, col.main, Math.max(1, u * 1.5));
    const leg = (dark: boolean) => {
      const l = P(3, 6);
      rect(l, 0, 0, l.w, l.h, dark ? shade(col.main, -0.25) : col.main);
      rect(l, 0, l.h - Math.max(1, u * 1.2), l.w, Math.max(1, u * 1.2), shade(col.main, -0.4));
      return F(l);
    };
    const by = H - 6 * u - body.h * 0.55;
    parts.push(part("tail", F(tail), [tail.w, tail.h * 0.6], [4 * u, by + 1 * u], 0));
    parts.push(part("legBackFar", leg(true), [1.5 * u, 0], [7 * u, by + body.h * 0.6], 1));
    parts.push(part("legFrontFar", leg(true), [1.5 * u, 0], [15 * u, by + body.h * 0.6], 1));
    parts.push(part("body", F(body), [body.w / 2, body.h / 2], [11 * u, by + body.h / 2], 2));
    parts.push(part("legBackNear", leg(false), [1.5 * u, 0], [8.5 * u, by + body.h * 0.65], 3));
    parts.push(part("legFrontNear", leg(false), [1.5 * u, 0], [16.5 * u, by + body.h * 0.65], 3));
    parts.push(part("ear", F(ear), [ear.w / 2, ear.h], [16.5 * u, by - 2.5 * u], 4));
    parts.push(part("head", F(head), [head.w * 0.4, head.h * 0.7], [17 * u, by + 2 * u], 5));
  } else if (arch === "biped") {
    const body = P(8, 9);
    const robe = /elder|wizard|witch|monk|princess|queen/.test(r);
    rect(body, 0, 0, body.w, body.h, col.main);
    if (robe) poly(body, [[0, body.h], [body.w / 2, 0], [body.w, body.h]], shade(col.main, -0.1));
    rect(body, 0, body.h * 0.55, body.w, Math.max(1, u), col.accent);
    const head = P(9, 9);
    const skin = /robot|bot|knight|astronaut|skeleton/.test(r) ? col.main : /zombie|goblin|orc|alien/.test(r) ? hex("#9fc47a") : hex("#f2c9a0");
    ellipse(head, head.w / 2, head.h / 2, head.w / 2 - 0.5, head.h / 2 - 0.5, skin);
    if (/knight/.test(r)) rect(head, head.w * 0.35, head.h * 0.35, head.w * 0.65, Math.max(1, u * 1.5), col.dark);
    else if (/robot|bot|astronaut/.test(r)) rect(head, head.w * 0.25, head.h * 0.3, head.w * 0.7, head.h * 0.3, col.accent);
    else {
      eyeDot(head, Math.round(head.w * 0.62), Math.round(head.h * 0.4));
      rect(head, 0, 0, head.w, head.h * 0.28, /elder/.test(r) ? hex("#e6e6e6") : shade(col.main, -0.35));
    }
    if (/elder|wizard/.test(r)) poly(head, [[head.w * 0.4, head.h * 0.7], [head.w, head.h * 0.65], [head.w * 0.7, head.h]], hex("#f2f2f2"));
    const hat = P(10, 7);
    if (/wizard|witch/.test(r)) poly(hat, [[0, hat.h], [hat.w * 0.55, 0], [hat.w, hat.h]], col.main);
    else if (/robot|bot/.test(r)) {
      line(hat, hat.w / 2, hat.h, hat.w / 2, hat.h * 0.3, col.dark);
      ellipse(hat, hat.w / 2, hat.h * 0.3, u, u, col.accent);
    } else if (/king|queen|princess|prince/.test(r)) poly(hat, [[hat.w * 0.2, hat.h], [hat.w * 0.2, hat.h * 0.4], [hat.w * 0.4, hat.h * 0.7], [hat.w * 0.5, hat.h * 0.3], [hat.w * 0.6, hat.h * 0.7], [hat.w * 0.8, hat.h * 0.4], [hat.w * 0.8, hat.h]], hex("#ffd35c"));
    const limb = (w: number, h: number, c: RGBA) => {
      const l = P(w, h);
      rect(l, 0, 0, l.w, l.h, c);
      return F(l);
    };
    const hipY = H - 7 * u;
    parts.push(part("legFar", limb(3, 7, shade(col.dark, 0.2)), [1.5 * u, 0], [11 * u, hipY], 0));
    parts.push(part("armFar", limb(2.5, 7, shade(col.main, -0.25)), [1.2 * u, 0.5 * u], [11 * u, hipY - 8 * u], 1));
    parts.push(part("body", F(body), [body.w / 2, body.h], [12 * u, hipY + 1 * u], 2));
    parts.push(part("legNear", limb(3, 7, col.dark), [1.5 * u, 0], [13 * u, hipY], 3));
    parts.push(part("head", F(head), [head.w / 2, head.h * 0.9], [12.5 * u, hipY - 8 * u], 4));
    parts.push(part("hat", F(hat), [hat.w / 2, hat.h], [12.5 * u, hipY - 14 * u], 5));
    parts.push(part("armNear", limb(2.5, 7, col.main), [1.2 * u, 0.5 * u], [13.5 * u, hipY - 8 * u], 6));
  } else if (arch === "flyer") {
    const body = P(10, 8);
    ellipse(body, body.w / 2, body.h / 2, body.w / 2 - 0.5, body.h / 2 - 0.5, (_x, y) => (y > body.h * 0.65 ? col.accent : col.main));
    eyeDot(body, Math.round(body.w * 0.66), Math.round(body.h * 0.3));
    if (/ghost|wisp/.test(r)) poly(body, [[0, body.h * 0.5], [body.w * 0.25, body.h], [body.w * 0.5, body.h * 0.75], [body.w * 0.75, body.h], [body.w, body.h * 0.5]], col.main);
    const wing = P(10, 7);
    if (/bat|dragon/.test(r)) poly(wing, [[0, wing.h], [wing.w * 0.2, 0], [wing.w, wing.h * 0.2], [wing.w * 0.7, wing.h * 0.6], [wing.w * 0.4, wing.h * 0.5]], shade(col.main, -0.15));
    else if (/bee|dragonfly|fairy|firefly|butterfly|moth/.test(r)) ellipse(wing, wing.w / 2, wing.h / 2, wing.w / 2 - 0.5, wing.h / 2 - 0.5, [230, 245, 255, 200]);
    else if (/drone|ufo/.test(r)) rect(wing, 0, wing.h * 0.6, wing.w, Math.max(1, u * 1.2), col.dark);
    else poly(wing, [[0, wing.h], [wing.w * 0.3, 0], [wing.w, wing.h * 0.5]], shade(col.main, -0.1));
    const tail = P(5, 4);
    if (/bird|owl|crow/.test(r)) poly(tail, [[tail.w, 0], [0, tail.h / 2], [tail.w, tail.h]], shade(col.main, -0.2));
    parts.push(part("wingFar", F(wing), [wing.w * 0.8, wing.h], [12 * u, 11 * u], 0));
    parts.push(part("tail", F(tail), [tail.w, tail.h / 2], [7 * u, 13 * u], 1));
    parts.push(part("body", F(body), [body.w / 2, body.h / 2], [12 * u, 13 * u], 2));
    parts.push(part("wingNear", F(wing), [wing.w * 0.8, wing.h], [13 * u, 12 * u], 3));
  } else if (arch === "bug") {
    const body = P(14, 8);
    ellipse(body, body.w / 2, body.h * 0.6, body.w / 2 - 0.5, body.h * 0.55, (_x, y) => (y < body.h * 0.35 ? shade(col.main, 0.2) : col.main));
    line(body, body.w / 2, body.h * 0.15, body.w / 2, body.h, shade(col.main, -0.3));
    const head = P(6, 6);
    ellipse(head, head.w / 2, head.h / 2, head.w / 2 - 0.5, head.h / 2 - 0.5, col.dark);
    eyeDot(head, Math.round(head.w * 0.55), Math.round(head.h * 0.3));
    const leg = () => {
      const l = P(2, 5);
      rect(l, 0, 0, l.w, l.h, col.dark);
      return l;
    };
    const base = H - 5 * u;
    parts.push(part("legA", leg(), [u, 0], [8 * u, base], 0));
    parts.push(part("legB", leg(), [u, 0], [12 * u, base], 0));
    parts.push(part("legC", leg(), [u, 0], [16 * u, base], 0));
    parts.push(part("body", F(body), [body.w / 2, body.h], [12 * u, base + u], 1));
    parts.push(part("head", F(head), [head.w * 0.2, head.h * 0.6], [18 * u, base - 3 * u], 2));
  } else if (arch === "ball") {
    const body = P(22, 22);
    ellipse(body, body.w / 2, body.h / 2, body.w / 2 - 1, body.h / 2 - 1, (_x, _y, uu, vv) => {
      const l = -uu * 0.5 - vv * 0.6;
      return shade(col.main, Math.max(-0.35, Math.min(0.45, l * 0.5)));
    });
    ellipse(body, body.w * 0.36, body.h * 0.32, body.w * 0.1, body.h * 0.08, [255, 255, 255, 230]);
    parts.push(part("body", F(body), [body.w / 2, body.h / 2], [12 * u, 12 * u], 0));
  } else {
    // Blob: a squashy body with eyes that ride on top.
    const body = P(18, 14);
    const cx = body.w / 2, cy = body.h * 0.62;
    ellipse(body, cx, cy, body.w / 2 - 0.5, body.h * 0.62 - 0.5, (_x, y) => (y < body.h * 0.4 ? shade(col.main, 0.15) : col.main));
    rect(body, 0, body.h - 1, body.w, 1, [0, 0, 0, 0]);
    if (/mushroom/.test(r)) ellipse(body, cx, body.h * 0.35, body.w / 2, body.h * 0.35, hex("#c43d3d"));
    const eyes = P(10, 5);
    eyeDot(eyes, Math.round(eyes.w * 0.25), 1);
    eyeDot(eyes, Math.round(eyes.w * 0.65), 1);
    parts.push(part("body", F(body), [body.w / 2, body.h], [12 * u, H - 0.5 * u], 0));
    parts.push(part("eyes", eyes, [eyes.w / 2, eyes.h / 2], [13 * u, H - body.h * 0.6], 1));
  }
  void rng;
  const rig: Rig = { w: W, h: H, parts, archetype: arch };
  const frames = bakeRig(rig);
  return { w: W, h: H, frames, rig, archetype: arch };
}

// ---------- items, props and parts ----------

export function makeItem(recipe: string, sizeTiles: [number, number], tile: number, style: Style, palette: string[], seed: number): SpriteSet {
  const r = recipe.toLowerCase();
  const W = Math.max(6, Math.round(sizeTiles[0] * tile)), H = Math.max(6, Math.round(sizeTiles[1] * tile));
  const col = colorsFor(recipe, palette, seed);
  const pal = style === "pixel" ? rampPalette(palette.concat(["#1a1426", "#ffffff", "#ffd35c"])) : null;
  const F = (p: Pixels) => finish(p, style, pal, col.dark);
  const gold = hex("#ffd35c"), wood = hex("#a0662e"), stone = hex("#8a8fa0"), red = hex("#d64a4a");
  const mat = materialOf(r, palette);
  const frames: Pixels[] = [];
  const one = () => pixels(W, H);
  if (/coin|seed|acorn|gem|star|crystal|orb|berry|apple|shell|pearl|leaf|sparkle/.test(r) && !/platform/.test(r)) {
    // Four-frame spin or pulse.
    for (let f = 0; f < 4; f++) {
      const p = one();
      const squeeze = /coin/.test(r) ? [1, 0.6, 0.2, 0.6][f] : 1;
      const pulse = /coin/.test(r) ? 1 : [1, 0.94, 0.9, 0.94][f];
      const cx = W / 2, cy = H / 2, rx = (W / 2 - 1) * squeeze * pulse, ry = (H / 2 - 1) * pulse;
      if (/gem|crystal/.test(r)) poly(p, [[cx, cy - ry], [cx + rx, cy - ry * 0.2], [cx, cy + ry], [cx - rx, cy - ry * 0.2]], hex("#5cd6f2"));
      else if (/star/.test(r)) {
        const pts: [number, number][] = [];
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 - Math.PI / 2, rr = i % 2 ? 0.45 : 1;
          pts.push([cx + Math.cos(a) * rx * rr, cy + Math.sin(a) * ry * rr]);
        }
        poly(p, pts, gold);
      } else if (/seed|acorn/.test(r)) {
        ellipse(p, cx, cy + ry * 0.15, rx * 0.7, ry * 0.8, /acorn/.test(r) ? hex("#a0562e") : hex("#c8f56b"));
        rect(p, cx - rx * 0.6, cy - ry * 0.8, rx * 1.2, ry * 0.45, /acorn/.test(r) ? hex("#5e3423") : hex("#58a653"));
      } else if (/leaf/.test(r)) ellipse(p, cx, cy, rx * 0.5, ry, hex("#58a653"));
      else ellipse(p, cx, cy, Math.max(0.8, rx), ry, /berry|apple/.test(r) ? red : gold);
      const glow = /glow|light|seed|star|crystal|gem/.test(r);
      if (glow) put(p, Math.round(cx - rx * 0.3), Math.round(cy - ry * 0.4), [255, 255, 255, 255]);
      frames.push(F(p));
    }
    return { w: W, h: H, frames: { idle: frames }, archetype: "item" };
  }
  const p = one();
  const leaf = hex("#4fa64a"), stem = hex("#3d7a35");
  if (/flower|sunflower|bloom|daisy/.test(r) && !/platform/.test(r)) {
    // Stem and leaves, then a ring of petals around a face.
    rect(p, W * 0.45, H * 0.45, Math.max(1, W * 0.1), H * 0.55, stem);
    ellipse(p, W * 0.3, H * 0.78, W * 0.16, H * 0.07, leaf);
    ellipse(p, W * 0.7, H * 0.7, W * 0.16, H * 0.07, leaf);
    const petal = /sun|gold|light/.test(r) ? hex("#ffd35c") : col.main;
    const cx = W / 2, cy = H * 0.3, R = Math.min(W, H) * 0.3;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      ellipse(p, cx + Math.cos(a) * R * 0.75, cy + Math.sin(a) * R * 0.75, R * 0.3, R * 0.3, petal);
    }
    ellipse(p, cx, cy, R * 0.5, R * 0.5, hex("#8a5a2e"));
    put(p, Math.round(cx - R * 0.2), Math.round(cy - R * 0.1), col.eye);
    put(p, Math.round(cx + R * 0.2), Math.round(cy - R * 0.1), col.eye);
    return { w: W, h: H, frames: { idle: [F(p)] }, archetype: "item" };
  }
  if (/shooter|pea|cactus|blaster|cannon plant|archer|tower/.test(r)) {
    // A plant (or tower) with a barrel facing right, toward the incoming lanes.
    const body = /tower|archer/.test(r) ? stone : /cactus/.test(r) ? hex("#58a653") : hex("#6cc04a");
    rect(p, W * 0.44, H * 0.5, Math.max(1, W * 0.12), H * 0.5, /tower|archer/.test(r) ? shade(stone, -0.2) : stem);
    ellipse(p, W * 0.42, H * 0.36, W * 0.3, H * 0.26, body);
    rect(p, W * 0.6, H * 0.28, W * 0.34, H * 0.16, shade(body, -0.1));
    ellipse(p, W * 0.93, H * 0.36, W * 0.07, H * 0.1, shade(body, -0.45));
    put(p, Math.round(W * 0.42), Math.round(H * 0.3), col.eye);
    ellipse(p, W * 0.3, H * 0.86, W * 0.18, H * 0.07, leaf);
    ellipse(p, W * 0.66, H * 0.86, W * 0.18, H * 0.07, leaf);
    return { w: W, h: H, frames: { idle: [F(p)] }, archetype: "item" };
  }
  if (/nut|wall|rock|shield|boulder|barricade/.test(r) && !/platform|block|brick/.test(r)) {
    const shell = /rock|boulder/.test(r) ? stone : hex("#b07a3c");
    ellipse(p, W / 2, H * 0.55, W * 0.44, H * 0.44, (_x, y) => (y < H * 0.35 ? shade(shell, 0.15) : shell));
    put(p, Math.round(W * 0.4), Math.round(H * 0.45), col.eye);
    put(p, Math.round(W * 0.6), Math.round(H * 0.45), col.eye);
    line(p, W * 0.42, H * 0.62, W * 0.58, H * 0.62, shade(shell, -0.4));
    return { w: W, h: H, frames: { idle: [F(p)] }, archetype: "item" };
  }
  if (/spaceship|space ship|rocket|starship|\bship\b|\bjet\b|ufo/.test(r)) {
    const hull = /red/.test(r) ? red : /gold|yellow/.test(r) ? gold : stone;
    poly(p, [[W / 2, 0], [W * 0.95, H * 0.95], [W / 2, H * 0.75], [W * 0.05, H * 0.95]], shade(hull, 0.1));
    ellipse(p, W / 2, H * 0.42, W * 0.12, H * 0.14, hex("#5cf2d6"));
    rect(p, W * 0.38, H * 0.8, W * 0.24, H * 0.2, hex("#ff9a3c"));
    return { w: W, h: H, frames: { idle: [F(p)] }, archetype: "item" };
  }
  if (/\b(car|taxi|truck|van|bus|kart)\b/.test(r)) {
    // Seen from above, pointing up the screen.
    const paint = /red/.test(r) ? red : /yellow|taxi/.test(r) ? gold : /green/.test(r) ? hex("#4fa64a") : /white/.test(r) ? hex("#f2f2f2") : /blue/.test(r) ? hex("#4a90e2") : col.main;
    rect(p, W * 0.05, H * 0.12, W * 0.12, H * 0.2, hex("#1a1426"));
    rect(p, W * 0.83, H * 0.12, W * 0.12, H * 0.2, hex("#1a1426"));
    rect(p, W * 0.05, H * 0.68, W * 0.12, H * 0.2, hex("#1a1426"));
    rect(p, W * 0.83, H * 0.68, W * 0.12, H * 0.2, hex("#1a1426"));
    rect(p, W * 0.12, H * 0.04, W * 0.76, H * 0.92, paint);
    rect(p, W * 0.2, H * 0.24, W * 0.6, H * 0.16, hex("#9fd6ff"));
    rect(p, W * 0.2, /truck|van|bus/.test(r) ? H * 0.5 : H * 0.62, W * 0.6, H * 0.1, shade(paint, -0.25));
    return { w: W, h: H, frames: { idle: [F(p)] }, archetype: "item" };
  }
  if (/snake/.test(r)) {
    ellipse(p, W / 2, H / 2, W * 0.46, H * 0.46, /head/.test(r) ? hex("#a6e36b") : hex("#7ac74f"));
    if (/head/.test(r)) {
      put(p, Math.round(W * 0.35), Math.round(H * 0.35), col.eye);
      put(p, Math.round(W * 0.65), Math.round(H * 0.35), col.eye);
    }
    return { w: W, h: H, frames: { idle: [F(p)] }, archetype: "item" };
  }
  if (/heart/.test(r)) {
    ellipse(p, W * 0.3, H * 0.35, W * 0.25, H * 0.25, red);
    ellipse(p, W * 0.7, H * 0.35, W * 0.25, H * 0.25, red);
    poly(p, [[W * 0.06, H * 0.42], [W * 0.94, H * 0.42], [W * 0.5, H * 0.95]], red);
  } else if (/key/.test(r)) {
    ellipse(p, W * 0.3, H * 0.35, W * 0.25, H * 0.25, gold);
    ellipse(p, W * 0.3, H * 0.35, W * 0.1, H * 0.1, [0, 0, 0, 0]);
    for (let i = 0; i < p.data.length; i += 4) if (p.data[i + 3] && p.data[i] === 0) p.data[i + 3] = 0;
    rect(p, W * 0.45, H * 0.3, W * 0.5, H * 0.14, gold);
    rect(p, W * 0.8, H * 0.44, W * 0.12, H * 0.2, gold);
  } else if (/flag/.test(r)) {
    rect(p, W * 0.2, 0, Math.max(1, W * 0.12), H, stone);
    poly(p, [[W * 0.32, 1], [W * 0.98, H * 0.18], [W * 0.32, H * 0.36]], red);
    rect(p, W * 0.05, H - 2, W * 0.5, 2, shade(stone, -0.2));
  } else if (/portal/.test(r)) {
    ellipse(p, W / 2, H / 2, W / 2 - 0.5, H / 2 - 0.5, hex("#7a5cf2"));
    ellipse(p, W / 2, H / 2, W / 2 - 3, H / 2 - 3, hex("#c8b8ff"));
    ellipse(p, W / 2, H / 2, W / 5, H / 5, hex("#ffffff"));
  } else if (/basket|cup/.test(r)) {
    poly(p, [[0, H * 0.2], [W, H * 0.2], [W * 0.85, H], [W * 0.15, H]], wood);
    for (let x = 2; x < W; x += 3) line(p, x, H * 0.25, x * 0.9 + W * 0.05, H - 1, shade(wood, -0.25));
  } else if (/lantern|checkpoint|torch/.test(r)) {
    rect(p, W * 0.42, H * 0.3, Math.max(1, W * 0.16), H * 0.7, stone);
    ellipse(p, W / 2, H * 0.22, W * 0.38, H * 0.18, hex("#ffcf5c"));
    ellipse(p, W / 2, H * 0.22, W * 0.18, H * 0.1, hex("#fff4d6"));
  } else if (/door|gate/.test(r)) {
    rect(p, 0, 0, W, H, shade(wood, -0.1));
    for (let x = 0; x < W; x += Math.max(2, Math.round(W / 4))) rect(p, x, 0, 1, H, shade(wood, -0.35));
    rect(p, W * 0.7, H * 0.5, Math.max(1, W * 0.12), Math.max(1, H * 0.12), gold);
  } else if (/switch|plate|button/.test(r)) {
    rect(p, W * 0.1, H * 0.7, W * 0.8, H * 0.3, shade(stone, -0.2));
    rect(p, W * 0.2, H * 0.55, W * 0.6, H * 0.2, red);
  } else if (/crate|box/.test(r)) {
    rect(p, 0, 0, W, H, wood);
    rect(p, 1, 1, W - 2, H - 2, shade(wood, 0.1));
    line(p, 1, 1, W - 2, H - 2, shade(wood, -0.3));
    line(p, W - 2, 1, 1, H - 2, shade(wood, -0.3));
  } else if (/spring|trampoline/.test(r)) {
    for (let i = 0; i < 3; i++) line(p, W * 0.2, H * (0.45 + i * 0.18), W * 0.8, H * (0.55 + i * 0.18), stone);
    rect(p, 0, 0, W, H * 0.35, red);
    rect(p, W * 0.1, H - 2, W * 0.8, 2, shade(stone, -0.3));
  } else if (/spike/.test(r)) {
    const n = Math.max(2, Math.round(W / 5));
    for (let i = 0; i < n; i++) poly(p, [[(i / n) * W, H], [((i + 0.5) / n) * W, 0], [((i + 1) / n) * W, H]], stone);
  } else if (/turret|cannon/.test(r)) {
    rect(p, W * 0.1, H * 0.45, W * 0.8, H * 0.55, stone);
    ellipse(p, W / 2, H * 0.45, W * 0.32, H * 0.3, shade(stone, 0.15));
    rect(p, W * 0.5, H * 0.35, W * 0.5, H * 0.18, col.dark);
  } else if (/plank|board/.test(r)) {
    rect(p, 0, 0, W, H, wood);
    for (let x = 3; x < W; x += 7) put(p, x, Math.floor(H / 2), shade(wood, -0.3));
  } else if (/fan/.test(r)) {
    rect(p, 0, H - Math.max(3, W * 0.4), W, Math.max(3, W * 0.4), stone);
    for (let y = 2; y < H - W * 0.4; y += 4) line(p, W * 0.2, y, W * 0.8, y + 1, [200, 230, 255, 110]);
  } else if (/wind|updraft/.test(r)) {
    for (let y = 1; y < H; y += 5) for (let x = (y % 3) + 1; x < W; x += 6) line(p, x, y, x + 1, y + 3, [220, 240, 255, 90]);
  } else if (/platform/.test(r)) {
    rect(p, 0, 0, W, H, mat.top);
    rect(p, 0, Math.max(1, H * 0.4), W, H * 0.6, mat.body);
    if (/crumbl/.test(r)) for (let x = 2; x < W; x += 5) line(p, x, H * 0.3, x + 2, H, shade(mat.body, -0.35));
  } else if (/block|brick/.test(r)) {
    rect(p, 0, 0, W, H, mat.body);
    rect(p, 1, 1, W - 2, H - 2, shade(mat.body, 0.15));
    rect(p, 0, Math.floor(H / 2), W, 1, shade(mat.body, -0.3));
    rect(p, Math.floor(W / 2), 0, 1, Math.floor(H / 2), shade(mat.body, -0.3));
  } else {
    // Unknown props become a readable rounded marker in the palette.
    ellipse(p, W / 2, H / 2, W / 2 - 0.5, H / 2 - 0.5, col.main);
  }
  return { w: W, h: H, frames: { idle: [F(p)] }, archetype: "item" };
}

// Materials for tiles and platforms, keyed by the setting words.
export function materialOf(recipe: string, palette: string[]): { top: RGBA; body: RGBA; accent: RGBA; name: string } {
  const r = recipe.toLowerCase();
  const table: [RegExp, string, string, string, string][] = [
    [/snow|ice|frost|winter|arctic/, "snow", "#f2fbff", "#7fa6c2", "#c7e6f5"],
    [/desert|sand|beach|dune|egypt/, "sand", "#f2d08a", "#c98a4a", "#e8b86a"],
    [/lava|volcano|fire|hell/, "basalt", "#f2781c", "#3d2a2a", "#7a2418"],
    [/space|moon|mars|star|galaxy|asteroid|sci/, "metal", "#9fb4d6", "#3a4262", "#5b6fa0"],
    [/candy|sweet|cake|sugar/, "candy", "#ff9ecb", "#8a4a6e", "#ffd6ea"],
    [/cave|dungeon|castle|stone|temple|ruin/, "stone", "#a4a8b8", "#4a4e62", "#6c7088"],
    [/ocean|sea|water|coral|reef/, "coral", "#7fe0c8", "#2a6f8a", "#f07a5a"],
    [/city|street|urban|roof/, "brick", "#c4c4c4", "#8a4a3a", "#a45c48"],
  ];
  const hit = table.find(([re]) => re.test(r));
  if (hit) return { name: hit[1], top: hex(hit[2]), body: hex(hit[3]), accent: hex(hit[4]) };
  void palette;
  return { name: "grass", top: hex("#6cc04a"), body: hex("#7a5232"), accent: hex("#a47448") };
}
