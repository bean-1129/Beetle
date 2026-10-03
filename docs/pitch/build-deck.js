// Beetle 2D pitch deck generator (six slides). Output: docs/pitch/Beetle-pitch.pptx
// This file is CommonJS. The repo package.json sets "type": "module", so run it from a copy named *.cjs
// outside the repo with NODE_PATH pointing at a directory that holds pptxgenjs (not a repo dependency):
//   cp docs/pitch/build-deck.js <scratch>/build-deck.cjs && NODE_PATH=<scratch>/node_modules node <scratch>/build-deck.cjs docs/pitch/Beetle-pitch.pptx
//   soffice --headless --convert-to pdf --outdir docs/pitch docs/pitch/Beetle-pitch.pptx
const path = require("path");
const pptxgen = require("pptxgenjs");
const { applyTheme } = require(
  "/home/dell/.config/Claude/local-agent-mode-sessions/skills-plugin/b86eeabd-2b83-49a3-bb48-30189de41dca/5199b613-4614-4215-a564-851667941726/skills/pptx/scripts/apply_theme.js"
);

const OUT = process.argv[2] || "/home/dell/Beetle/docs/pitch/Beetle-pitch.pptx";

// One cohesive palette: deep blue-green background, pale stone text, warm amber accent,
// lava red used exactly once (the "Stop" chip on slide 1).
const THEME = {
  name: "Beetle Deep Garden",
  headFontFace: "Arial",
  bodyFontFace: "Arial",
  colors: {
    dk1: "EDE7DB", // pale stone (text1)
    lt1: "0E3534", // deep blue-green (background1)
    dk2: "BDB3A2", // muted stone (text2)
    lt2: "1B4A48", // card teal (background2)
    accent1: "E8A33D", // warm amber
    accent2: "D8402B", // lava red (used once)
    accent3: "7FB5B1", // soft teal
    accent4: "2E6B68", // outline teal
    accent5: "3F8582", // mid teal
    accent6: "C9A15A", // dim amber
    hlink: "E8A33D",
    folHlink: "7FB5B1",
  },
};

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "Beetle pitch";
pres.author = "Beetle team";
const C = pres.SchemeColor;

// ---------- layout ----------
pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: THEME.colors.lt1 },
  objects: [
    {
      placeholder: {
        options: {
          name: "title",
          type: "title",
          x: 0.5,
          y: 0.38,
          w: 7.4,
          h: 0.75,
          fontSize: 26,
          bold: true,
          color: C.text1,
          align: "left",
          valign: "middle",
          margin: 0,
        },
        text: "Slide title",
      },
    },
    {
      text: {
        text: "Beetle. One prompt, a playable 2D game, on this machine.",
        options: {
          x: 0.5,
          y: 5.2,
          w: 7,
          h: 0.25,
          fontSize: 9,
          color: C.text2,
          margin: 0,
          isTextBox: true,
          objectName: "footer",
        },
      },
    },
  ],
  slideNumber: { x: 9.1, y: 5.2, w: 0.4, h: 0.25, fontSize: 9, color: THEME.colors.dk2, align: "right" },
});

// ---------- helpers ----------
function beetleGlyph(slide, x, y, s) {
  // s = overall height in inches. Body ellipse, head ellipse, elytra split, six legs, two antennae.
  const bw = s * 0.62,
    bh = s * 0.72;
  const bx = x + (s - bw) / 2,
    by = y + s * 0.26;
  const hw = s * 0.3,
    hh = s * 0.24;
  const hx = x + (s - hw) / 2,
    hy = y + s * 0.08;
  const legLine = () => ({ color: C.text1, width: 1.25 });
  // legs (three per side)
  const legs = [
    [bx + bw * 0.15, by + bh * 0.2, -s * 0.22, -s * 0.12],
    [bx + bw * 0.05, by + bh * 0.5, -s * 0.24, 0],
    [bx + bw * 0.12, by + bh * 0.8, -s * 0.22, s * 0.12],
    [bx + bw * 0.85, by + bh * 0.2, s * 0.22, -s * 0.12],
    [bx + bw * 0.95, by + bh * 0.5, s * 0.24, 0],
    [bx + bw * 0.88, by + bh * 0.8, s * 0.22, s * 0.12],
  ];
  for (const [lx, ly, dx, dy] of legs) {
    const opts = { line: legLine(), objectName: "beetle leg" };
    if (dx < 0) {
      opts.x = lx + dx;
      opts.w = -dx;
      opts.flipH = true;
    } else {
      opts.x = lx;
      opts.w = dx;
    }
    if (dy < 0) {
      opts.y = ly + dy;
      opts.h = -dy;
      opts.flipV = true;
    } else {
      opts.y = ly;
      opts.h = dy;
    }
    if (opts.h === 0) opts.h = 0.001;
    slide.addShape(pres.ShapeType.line, opts);
  }
  // antennae
  slide.addShape(pres.ShapeType.line, {
    x: hx - s * 0.14,
    y: y,
    w: s * 0.16,
    h: s * 0.12,
    flipV: true,
    line: legLine(),
    objectName: "beetle antenna",
  });
  slide.addShape(pres.ShapeType.line, {
    x: hx + hw - s * 0.02,
    y: y,
    w: s * 0.16,
    h: s * 0.12,
    line: legLine(),
    objectName: "beetle antenna",
  });
  // head
  slide.addShape(pres.ShapeType.ellipse, {
    x: hx,
    y: hy,
    w: hw,
    h: hh,
    fill: { color: C.accent1 },
    line: { color: C.accent1, width: 0.5 },
    objectName: "beetle head",
  });
  // body
  slide.addShape(pres.ShapeType.ellipse, {
    x: bx,
    y: by,
    w: bw,
    h: bh,
    fill: { color: C.accent1 },
    line: { color: C.accent1, width: 0.5 },
    objectName: "beetle body",
  });
  // elytra split
  slide.addShape(pres.ShapeType.line, {
    x: x + s / 2,
    y: by + bh * 0.12,
    w: 0.001,
    h: bh * 0.8,
    line: { color: C.background1, width: 1.5 },
    objectName: "beetle split",
  });
}

function wordmark(slide, x, y, s, fontSize) {
  beetleGlyph(slide, x, y, s);
  slide.addText("BEETLE", {
    x: x + s + 0.08,
    y: y,
    w: fontSize * 0.09 + 0.3,
    h: s,
    fontSize,
    bold: true,
    color: C.text1,
    charSpacing: 4,
    valign: "middle",
    margin: 0,
    isTextBox: true,
    objectName: "wordmark",
  });
}

function smallWordmark(slide) {
  wordmark(slide, 8.0, 0.42, 0.42, 16);
}

function card(slide, x, y, w, h, name) {
  slide.addShape(pres.ShapeType.roundRect, {
    x,
    y,
    w,
    h,
    rectRadius: 0.08,
    fill: { color: C.background2 },
    line: { color: C.accent4, width: 0.75 },
    objectName: name || "card",
  });
}

function label(slide, text, x, y, w, opts = {}) {
  slide.addText(text, {
    x,
    y,
    w,
    h: 0.25,
    fontSize: 10,
    bold: true,
    color: C.accent1,
    charSpacing: 2,
    margin: 0,
    isTextBox: true,
    objectName: "label " + text,
    ...opts,
  });
}

function body(slide, text, x, y, w, h, opts = {}) {
  slide.addText(text, {
    x,
    y,
    w,
    h,
    fontSize: 13,
    color: C.text1,
    valign: "top",
    margin: 0,
    isTextBox: true,
    objectName: "body text",
    ...opts,
  });
}

function arrow(slide, x1, y1, x2, y2, color, width) {
  const opts = {
    line: { color: color || C.accent3, width: width || 1.5, endArrowType: "triangle" },
    objectName: "arrow",
  };
  opts.x = Math.min(x1, x2);
  opts.y = Math.min(y1, y2);
  opts.w = Math.abs(x2 - x1) || 0.001;
  opts.h = Math.abs(y2 - y1) || 0.001;
  if (x2 < x1) opts.flipH = true;
  if (y2 < y1) opts.flipV = true;
  slide.addShape(pres.ShapeType.line, opts);
}

function bullets(items, fontSize = 13) {
  return items.map((t, i) => ({
    text: t,
    options: { bullet: { indent: 12 }, fontSize, color: C.text1, breakLine: i < items.length - 1, paraSpaceAfter: 5 },
  }));
}


pres.addSection({ title: "Beetle pitch" });
const SEC = { sectionTitle: "Beetle pitch" };

function slideWith(title) {
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText(title, { placeholder: "title" });
  smallWordmark(s);
  return s;
}

function stat(s, x, y, w, big, small) {
  card(s, x, y, w, 1.25, "stat " + small);
  s.addText(big, { x: x + 0.15, y: y + 0.12, w: w - 0.3, h: 0.6, fontSize: 26, bold: true, color: C.accent1, margin: 0, isTextBox: true, valign: "middle" });
  s.addText(small, { x: x + 0.15, y: y + 0.72, w: w - 0.3, h: 0.45, fontSize: 11, color: C.text2, margin: 0, isTextBox: true, valign: "top" });
}

// ====================== Slide 1: problem ======================
{
  const s = slideWith("A game idea should be playable today");
  label(s, "THE PROBLEM", 0.5, 1.3, 4.4);
  body(s, "Trying a game idea takes days of setup before anyone can play it. Cloud generators send the idea away and often return code that does not run.", 0.5, 1.58, 4.4, 1.1);
  label(s, "THE USER", 0.5, 2.85, 4.4);
  body(s, "Designers, students and hobbyists who want to feel an idea in their hands before they commit to it.", 0.5, 3.13, 4.4, 0.9);
  card(s, 5.3, 1.3, 4.2, 3.5, "promise card");
  s.addText("Type one prompt.", { x: 5.55, y: 1.6, w: 3.7, h: 0.5, fontSize: 20, bold: true, color: C.text1, margin: 0, isTextBox: true });
  s.addText("Play a 2D game seconds later.", { x: 5.55, y: 2.15, w: 3.7, h: 0.5, fontSize: 20, bold: true, color: C.accent1, margin: 0, isTextBox: true });
  body(s, "Made on this machine by a local model. Change it in plain words. Take it away as one HTML file.", 5.55, 2.9, 3.7, 1.5, { color: C.text2 });
  s.addNotes("Name the cost of today's loop, then the promise in one sentence.");
}

// ====================== Slide 2: how it works ======================
{
  const s = slideWith("From prompt to playable");
  const steps = [
    ["IDEA", "one sentence"],
    ["DESIGN", "local model writes a design doc, JSON schema"],
    ["BUILD", "genre kit plus level generator"],
    ["PLAYTEST", "a bot finishes every level"],
    ["PLAY", "validated spec runs in the page"],
  ];
  const w = 1.6, gap = 0.3, y = 1.6;
  steps.forEach(([t, d], i) => {
    const x = 0.5 + i * (w + gap);
    card(s, x, y, w, 1.6, "step " + t);
    label(s, t, x + 0.15, y + 0.18, w - 0.3);
    body(s, d, x + 0.15, y + 0.5, w - 0.3, 1.0, { fontSize: 12 });
    if (i < steps.length - 1) arrow(s, x + w + 0.04, y + 0.8, x + w + gap - 0.04, y + 0.8);
  });
  label(s, "THEN", 0.5, 3.6, 9);
  body(s, "Change it in plain words (\"make the jumps higher\", \"more rain\"). Every change is validated and must keep every level beatable. Export one offline HTML file; save to the library in the browser.", 0.5, 3.88, 9, 0.9);
  s.addNotes("The model writes data, not code. Everything after the design is deterministic game code.");
}

// ====================== Slide 3: what it makes ======================
{
  const s = slideWith("Seven genres, one text box");
  const genres = ["Platformer", "Runner", "Top-down", "Arena", "Puzzle", "Builder", "Lane defense"];
  genres.forEach((g, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const x = 0.5 + col * 2.28, y = 1.35 + row * 0.85;
    card(s, x, y, 2.08, 0.65, "genre " + g);
    s.addText(g, { x: x + 0.15, y, w: 1.8, h: 0.65, fontSize: 14, bold: true, color: C.text1, valign: "middle", margin: 0, isTextBox: true });
  });
  label(s, "EVERY GAME GETS", 0.5, 3.15, 4.4);
  s.addText(bullets(["Procedural pixel sprites, tiles, backgrounds", "Generated sound and music", "Several levels, each finished by the bot"], 12), { x: 0.5, y: 3.43, w: 4.4, h: 1.4, valign: "top", margin: 0 });
  label(s, "OUTSIDE THE GENRES", 5.1, 3.15, 4.4);
  body(s, "Classic games (tetris, pong, snake, breakout and more) use hand-written templates. Anything else maps to the closest genre, and the studio says so.", 5.1, 3.43, 4.4, 1.4, { fontSize: 12 });
  s.addNotes("Be plain about the boundary: seven genres plus templates.");
}

// ====================== Slide 4: measured ======================
{
  const s = slideWith("Measured on this machine");
  stat(s, 0.5, 1.35, 2.85, "6 of 6", "prompts became validated, playtested games");
  stat(s, 3.575, 1.35, 2.85, "10.7 to 16.9 s", "prompt to playable spec, model loaded");
  stat(s, 6.65, 1.35, 2.85, "0", "validator errors and repair fixes");
  body(s, "qwen3.5:4b on Ollama, loopback only, shared GPU. Prompts: fox platformer, dungeon with keys and doors, bee tower defense, candy sliding puzzle, \"a game like Red Ball 5\", stickman fight. Model time 10.3 to 12.7 s per design; side-view genres add about 3.8 to 4.6 s while the bot plays every level. Source: docs/RESULTS.md.", 0.5, 2.9, 9, 1.6, { fontSize: 12, color: C.text2 });
  s.addNotes("Warm-up call excluded: 14.0 s, of which 5.5 s was model load.");
}

// ====================== Slide 5: safe by construction ======================
{
  const s = slideWith("Private and safe by construction");
  const items = [
    ["LOCAL MODEL", "Ollama on loopback. No cloud model, no cloud fallback. The server refuses any non-loopback model address."],
    ["NO MODEL CODE", "The model writes a design or patch operations, checked by schema and validator. Model-written game code is turned off."],
    ["OFFLINE EXPORT", "One HTML file with runtime, spec and art inlined; its content security policy blocks all network access."],
  ];
  items.forEach(([t, d], i) => {
    const x = 0.5 + i * 3.075;
    card(s, x, 1.35, 2.85, 2.6, "safety " + t);
    label(s, t, x + 0.18, 1.55, 2.5);
    body(s, d, x + 0.18, 1.9, 2.5, 1.9, { fontSize: 12 });
  });
  body(s, "The director token is handed only to pages opened on this machine.", 0.5, 4.2, 9, 0.5, { fontSize: 12, color: C.text2 });
  s.addNotes("This is why every result plays: the engine is fixed, only data changes.");
}

// ====================== Slide 6: limits and next ======================
{
  const s = slideWith("Limits, said plainly, and what is next");
  label(s, "LIMITS", 0.5, 1.3, 4.4);
  s.addText(bullets(["Seven genres plus classic templates; other ideas become the closest genre", "No new game types at run time while model code is off", "One machine, one designer; library lives in this browser", "Benchmark excludes asset painting and the worker hop"], 12), { x: 0.5, y: 1.58, w: 4.4, h: 2.8, valign: "top", margin: 0 });
  label(s, "NEXT", 5.1, 1.3, 4.4);
  s.addText(bullets(["More genres and templates", "A declarative way to describe new mechanics, so new game types need no executable model output", "Sharing libraries between machines"], 12), { x: 5.1, y: 1.58, w: 4.4, h: 2.8, valign: "top", margin: 0 });
  s.addText("One prompt, a playable game, on your machine.", { x: 0.5, y: 4.55, w: 9, h: 0.45, fontSize: 12, italic: true, color: C.text2, valign: "middle", margin: 0, isTextBox: true, objectName: "closing line" });
  s.addNotes("Close on the limits; they are the honest frame for the numbers.");
}

(async () => {
  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote", OUT);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
