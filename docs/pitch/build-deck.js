// Beetle pitch deck generator (six slides). Output: docs/pitch/Beetle-pitch.pptx
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
        text: "Beetle. Local-first prototyping teammate for small game studios.",
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

// ====================== Slide 1: problem and user ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("Every edit stops the playtest", { placeholder: "title" });
  smallWordmark(s);

  // Left column
  label(s, "THE USER", 0.5, 1.3, 4.4);
  body(
    s,
    "Technical designers at small studios iterate on playable prototypes with real playtesters in the room.",
    0.5,
    1.58,
    4.4,
    0.75
  );
  label(s, "THE COST", 0.5, 2.45, 4.4);
  body(
    s,
    "Every stop costs the thing they are trying to observe: how people actually play.",
    0.5,
    2.73,
    4.4,
    0.7
  );
  // Promise card
  s.addShape(pres.ShapeType.roundRect, {
    x: 0.5,
    y: 3.65,
    w: 4.4,
    h: 1.15,
    rectRadius: 0.08,
    fill: { color: C.accent1 },
    line: { color: C.accent1, width: 0.5 },
    objectName: "promise card",
  });
  s.addText(
    [
      { text: "Beetle's promise", options: { fontSize: 11, bold: true, color: C.background1, charSpacing: 2, breakLine: true, paraSpaceAfter: 4 } },
      { text: "Change the game without stopping the game.", options: { fontSize: 18, bold: true, color: C.background1 } },
    ],
    { x: 0.75, y: 3.78, w: 3.95, h: 0.9, valign: "middle", margin: 0, isTextBox: true, objectName: "promise text" }
  );

  // Right: the stop-edit-rebuild-regather loop
  label(s, "TODAY'S LOOP", 5.5, 1.3, 4);
  const cx = 5.5,
    cy = 1.65,
    cw = 1.65,
    ch = 0.62,
    gapX = 0.85,
    gapY = 1.0;
  const chips = [
    { t: "Stop the session", x: cx, y: cy, lava: true },
    { t: "Edit the prototype", x: cx + cw + gapX, y: cy },
    { t: "Rebuild", x: cx + cw + gapX, y: cy + ch + gapY },
    { t: "Re-gather playtesters", x: cx, y: cy + ch + gapY },
  ];
  for (const c of chips) {
    s.addShape(pres.ShapeType.roundRect, {
      x: c.x,
      y: c.y,
      w: cw,
      h: ch,
      rectRadius: 0.08,
      fill: { color: c.lava ? C.accent2 : C.background2 },
      line: { color: c.lava ? C.accent2 : C.accent4, width: 0.75 },
      objectName: "loop chip " + c.t,
    });
    s.addText(c.t, {
      x: c.x,
      y: c.y,
      w: cw,
      h: ch,
      fontSize: 12,
      bold: !!c.lava,
      color: C.text1,
      align: "center",
      valign: "middle",
      margin: 0.05,
      isTextBox: true,
      objectName: "loop chip text " + c.t,
    });
  }
  const mid = ch / 2;
  arrow(s, cx + cw + 0.08, cy + mid, cx + cw + gapX - 0.08, cy + mid);
  arrow(s, cx + cw + gapX + cw / 2, cy + ch + 0.08, cx + cw + gapX + cw / 2, cy + ch + gapY - 0.08);
  arrow(s, cx + cw + gapX - 0.08, cy + ch + gapY + mid, cx + cw + 0.08, cy + ch + gapY + mid);
  arrow(s, cx + cw / 2, cy + ch + gapY - 0.08, cx + cw / 2, cy + ch + 0.08);
  s.addText("Each turn of the loop loses the live playtest you were trying to watch.", {
    x: 5.5,
    y: 4.05,
    w: 4,
    h: 0.75,
    fontSize: 11,
    italic: true,
    color: C.text2,
    margin: 0,
    isTextBox: true,
    objectName: "loop caption",
  });

  s.addNotes(
    "Our user is a technical designer at a small studio. Each stop-edit-rebuild-regather cycle throws away the live playtest. Beetle's promise is to change the game without stopping the game."
  );
}

// ====================== Slide 2: any game, one prompt, then keep changing it ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("Any game, one prompt, then keep changing it while they play", { placeholder: "title", fontSize: 21 });
  smallWordmark(s);

  // Top: four steps on a spine
  const steps = [
    ["Any game request", "\"king of the hill on a frozen arena, hold ten seconds\""],
    ["Mapped to the closest mode and biome", "the agent fills the parameters and says which it chose"],
    ["Playable world", "two phones join by QR, validated by game code first"],
    ["Keep changing it while they play", "mode, biome, speed, bridges, hazard; no reset"],
  ];
  const n = steps.length;
  const left = 0.5,
    right = 9.5;
  const span = (right - left - 1.3) / (n - 1);
  const lineY = 1.45;
  s.addShape(pres.ShapeType.line, {
    x: left + 0.65,
    y: lineY,
    w: span * (n - 1),
    h: 0.001,
    line: { color: C.accent4, width: 2 },
    objectName: "workflow spine",
  });
  steps.forEach(([t, sub], i) => {
    const cxi = left + 0.65 + span * i;
    const d = 0.44;
    s.addShape(pres.ShapeType.ellipse, {
      x: cxi - d / 2,
      y: lineY - d / 2,
      w: d,
      h: d,
      fill: { color: C.accent1 },
      line: { color: C.accent1, width: 0.5 },
      objectName: "step circle " + (i + 1),
    });
    s.addText(String(i + 1), {
      x: cxi - d / 2,
      y: lineY - d / 2,
      w: d,
      h: d,
      fontSize: 13,
      bold: true,
      color: C.background1,
      align: "center",
      valign: "middle",
      margin: 0,
      isTextBox: true,
      objectName: "step number " + (i + 1),
    });
    s.addText(
      [
        { text: t, options: { fontSize: 11, bold: true, color: C.text1, breakLine: true, paraSpaceAfter: 2 } },
        { text: sub, options: { fontSize: 9, color: C.text2 } },
      ],
      { x: cxi - 1.05, y: lineY + 0.3, w: 2.1, h: 0.75, align: "center", valign: "top", margin: 0, isTextBox: true, objectName: "step text " + (i + 1) }
    );
  });

  // Middle: the mode library as a table (packages/contracts/src/limits.ts GAME_MODES and MODE_LIMITS)
  label(s, "MODE LIBRARY (ENGINE MECHANICS, NOT MODEL-WRITTEN RULES)", 0.5, 2.5, 6.5, { fontSize: 9, h: 0.2 });
  const hdr = (t) => ({ text: t, options: { bold: true, color: THEME.colors.accent1, fontSize: 8.5, fill: { color: THEME.colors.lt2 }, valign: "middle" } });
  const cell = (t, bold) => ({ text: t, options: { color: bold ? THEME.colors.dk1 : THEME.colors.dk2, fontSize: 8, bold: !!bold, fill: { color: THEME.colors.lt2 }, valign: "middle" } });
  const rows = [
    [hdr("Mode"), hdr("What players do"), hdr("Win condition"), hdr("Parameters (contract ranges)")],
    [cell("relic_hunt", true), cell("collect relics over the bridges, enter the gate"), cell("gate unlocks after relicsRequired relics; a player reaches it"), cell("relicsRequired 1 to 3 (default all)")],
    [cell("time_trial", true), cell("the same relic hunt against a clock"), cell("finish before timeLimitSec; lost when it expires"), cell("timeLimitSec 20 to 600 s (default 120)")],
    [cell("king_of_the_hill", true), cell("reach the gate island (the hill) and stand in its zone"), cell("first player whose held time reaches holdSeconds"), cell("holdSeconds 3 to 60 s (default 10)")],
    [cell("checkpoint_race", true), cell("reach the relics as checkpoints, in order, then the gate"), cell("every checkpoint, then the gate"), cell("orderedCheckpoints; at least 2 relics")],
    [cell("survival", true), cell("grab a relic and reach the gate while the hazard rises and bridges submerge"), cell("relic plus gate before timeLimitSec; lost when it expires"), cell("hazard.rise afterSec, metersPerSec, maxElevation; timeLimitSec")],
  ];
  s.addTable(rows, {
    x: 0.5,
    y: 2.72,
    w: 9.0,
    colW: [1.3, 2.9, 2.6, 2.2],
    rowH: 0.25,
    border: { type: "solid", color: THEME.colors.accent4, pt: 0.5 },
    margin: 0.03,
    fontFace: "Arial",
    objectName: "mode library table",
  });

  s.addText(
    [
      { text: "Biomes ", options: { fontSize: 9, bold: true, color: C.accent1 } },
      { text: "garden, volcanic, frost, desert, night.   ", options: { fontSize: 9, color: C.text1 } },
      { text: "Hazard and pace ", options: { fontSize: 9, bold: true, color: C.accent1 } },
      { text: "water or lava below, a rising hazard, movement 3 to 7 m/s, 11 decoration types.   ", options: { fontSize: 9, color: C.text1 } },
      { text: "Changed live, no reset ", options: { fontSize: 9, bold: true, color: C.accent1 } },
      { text: "set_mode, set_biome, set_movement beside add_bridge, set_hazard and the other structural ops; every patch validated and committed as a new version.", options: { fontSize: 9, color: C.text1 } },
    ],
    { x: 0.5, y: 4.36, w: 9.0, h: 0.4, valign: "top", margin: 0, isTextBox: true, objectName: "library text" }
  );

  s.addText(
    "Adapted from one-prompt game generators: the one-prompt front door and instant playable output. Added: live editing without a reset, deterministic validation and repair before publish, local-only inference, phones as controllers (docs/COMPETITIVE.md). A request outside the library lands on the nearest mode and the agent says so.",
    { x: 0.5, y: 4.78, w: 9.0, h: 0.38, fontSize: 8, italic: true, color: C.text2, margin: 0, isTextBox: true, objectName: "category note" }
  );

  s.addNotes(
    "Walk the four steps: any request, mapped to the closest mode and biome and named, a playable world two phones join, then keep changing it while they play. Read two rows of the mode table, not all five. Say plainly: the library is bounded and growing; the model never writes rules, it picks from the engine. Status at 14:27 CDT: contract, validator, patch ops, server rule per mode, mapping prompt and biome palettes exist in code; BUILD_STATUS.md says what is tested; mode briefs are not measured yet (slide 5)."
  );
}

// ====================== Slide 3: the working video ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("The working video", { placeholder: "title" });
  smallWordmark(s);

  // Large placeholder frame (16:9)
  const fx = 0.5,
    fy = 1.3,
    fw = 5.3,
    fh = (fw * 9) / 16;
  s.addShape(pres.ShapeType.roundRect, {
    x: fx,
    y: fy,
    w: fw,
    h: fh,
    rectRadius: 0.06,
    fill: { color: C.background2 },
    line: { color: C.accent3, width: 1.5, dashType: "dash" },
    objectName: "video placeholder frame",
  });
  // play triangle
  const pd = 0.7;
  s.addShape(pres.ShapeType.ellipse, {
    x: fx + fw / 2 - pd / 2,
    y: fy + fh / 2 - pd / 2 - 0.25,
    w: pd,
    h: pd,
    fill: { color: C.accent1 },
    line: { color: C.accent1, width: 0.5 },
    objectName: "play circle",
  });
  s.addShape(pres.ShapeType.triangle, {
    x: fx + fw / 2 - 0.13,
    y: fy + fh / 2 - 0.16 - 0.25,
    w: 0.3,
    h: 0.32,
    rotate: 90,
    fill: { color: C.background1 },
    line: { color: C.background1, width: 0.5 },
    objectName: "play triangle",
  });
  s.addText(
    [
      { text: "[VIDEO PLACEHOLDER]", options: { fontSize: 14, bold: true, color: C.text1, breakLine: true, paraSpaceAfter: 3 } },
      { text: "Insert the rehearsal recording here (90 to 120 s). Not yet recorded at 13:40 CDT.", options: { fontSize: 11, color: C.text2, breakLine: true } },
      { text: "The caption names the agent mode used; any time compression is labelled on screen", options: { fontSize: 11, color: C.text2 } },
    ],
    {
      x: fx + 0.3,
      y: fy + fh / 2 + 0.3,
      w: fw - 0.6,
      h: 1.0,
      align: "center",
      valign: "top",
      margin: 0,
      isTextBox: true,
      objectName: "video placeholder text",
    }
  );
  s.addText("Fresh world, two phones, a live edit, preserved progress, a conflicting edit caught by the validator, the repaired version committed.", {
    x: fx,
    y: fy + fh + 0.15,
    w: fw,
    h: 0.6,
    fontSize: 11,
    italic: true,
    color: C.text2,
    margin: 0,
    isTextBox: true,
    objectName: "video summary",
  });

  // Caption list from the storyboard
  const cx = 6.1,
    cw = 3.4;
  label(s, "ON-SCREEN CAPTIONS", cx, 1.3, cw);
  const caps = [
    ["0 to 6 s", "Beetle. Change the game without stopping the game."],
    ["6 to 22 s", "A local model composes the world. Validated by game code before it is published."],
    ["22 to 34 s", "Two players join from their phones. Same screen, their phones only send controls."],
    ["34 to 58 s", "Edits land live. No disconnect, no reset."],
    ["58 to 90 s", "The validator refuses a world nobody can finish (DISCONNECTED_GOAL). The agent repairs it and commits only a passing version."],
    ["90 to 105 s", "Measured on one GB10. Local model, local agent in [direct or OpenClaw] mode, no cloud."],
    ["105 to 115 s", "Beetle"],
  ];
  const runs = [];
  caps.forEach(([t, c], i) => {
    runs.push({ text: t + "  ", options: { fontSize: 10, bold: true, color: C.accent1 } });
    runs.push({ text: c, options: { fontSize: 10, color: C.text1, breakLine: i < caps.length - 1, paraSpaceAfter: 5 } });
  });
  s.addText(runs, { x: cx, y: 1.6, w: cw, h: 3.4, valign: "top", margin: 0, isTextBox: true, objectName: "caption list" });

  s.addNotes("Play the recording here. Captions follow docs/STORYBOARD.md; the mode caption is set to whichever agent mode was green at recording time. Rehearsal timings: brief 14 s on a quiet GPU, edits 2 to 14 s, DISCONNECTED_GOAL refused and repaired in 3.0 s. Shots that cannot be produced honestly are cut, not faked.");
}

// ====================== Slide 4: agent architecture and validation ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("Agent architecture and validation", { placeholder: "title" });
  smallWordmark(s);

  const nodes = [
    ["Director", "any game request or edit"],
    ["OpenClaw agent", "reads state, proposes, repairs in a bounded budget"],
    ["Map to mode + biome", "closest of 5 modes, 5 biomes; parameters from the brief; named in the summary"],
    ["Beetle tools", "schema-checked JSON only, nothing executed"],
    ["Server validator and commit", "deterministic game code, server-issued proof"],
    ["Players", "same session, same progress, new version"],
  ];
  const n = nodes.length;
  const nx = 0.5,
    ny = 1.3,
    nh = 0.7,
    gap = 0.22,
    nw = (9.0 - gap * (n - 1)) / n;
  nodes.forEach(([h, sub], i) => {
    const x = nx + i * (nw + gap);
    const isValidator = i === 4;
    const isMap = i === 2;
    s.addShape(pres.ShapeType.roundRect, {
      x,
      y: ny,
      w: nw,
      h: nh,
      rectRadius: 0.08,
      fill: { color: isValidator ? C.accent1 : C.background2 },
      line: { color: isValidator ? C.accent1 : isMap ? C.accent3 : C.accent4, width: isMap ? 1.5 : 0.75, dashType: isMap ? "sysDash" : "solid" },
      objectName: "node " + h,
    });
    s.addText(h, {
      x,
      y: ny,
      w: nw,
      h: nh,
      fontSize: 10.5,
      bold: true,
      color: isValidator ? C.background1 : C.text1,
      align: "center",
      valign: "middle",
      margin: 0.05,
      isTextBox: true,
      objectName: "node title " + h,
    });
    s.addText(sub, {
      x: x - 0.08,
      y: ny + nh + 0.06,
      w: nw + 0.16,
      h: 0.62,
      fontSize: 8.5,
      color: C.text2,
      align: "center",
      valign: "top",
      margin: 0,
      isTextBox: true,
      objectName: "node sub " + h,
    });
    if (i < n - 1) {
      arrow(s, x + nw + 0.04, ny + nh / 2, x + nw + gap - 0.04, ny + nh / 2, C.accent3, 1.75);
    }
  });
  // feedback loop: validator issues go back to the agent (bounded repair attempts)
  const agentX = nx + 1 * (nw + gap) + nw / 2;
  const valX = nx + 4 * (nw + gap) + nw / 2;
  const loopY = ny + nh + 0.9;
  const loopTop = ny + nh + 0.7;
  s.addShape(pres.ShapeType.line, {
    x: valX,
    y: loopTop,
    w: 0.001,
    h: loopY - loopTop,
    line: { color: C.accent1, width: 1.25, dashType: "sysDash" },
    objectName: "loop down",
  });
  s.addShape(pres.ShapeType.line, {
    x: agentX,
    y: loopY,
    w: valX - agentX,
    h: 0.001,
    line: { color: C.accent1, width: 1.25, dashType: "sysDash" },
    objectName: "loop across",
  });
  arrow(s, agentX, loopY, agentX, loopTop, C.accent1, 1.25);
  s.addText("validation issues (including MODE_INVALID) go back for repair, at most 2 attempts, then the request fails honestly", {
    x: agentX + 0.15,
    y: loopY + 0.05,
    w: valX - agentX - 0.3,
    h: 0.3,
    fontSize: 9,
    italic: true,
    color: C.accent1,
    align: "center",
    valign: "top",
    margin: 0,
    isTextBox: true,
    objectName: "loop caption",
  });

  // Lower half: two cards
  const cy = 3.3,
    ch = 1.75;
  card(s, 0.5, cy, 4.35, ch, "state card");
  label(s, "TWO KINDS OF STATE", 0.7, cy + 0.15, 4);
  s.addText(
    bullets(
      [
        "WorldSpec is structure, now with mode, biome, movement and hazard.rise. It changes only when a transaction commits, one version per commit.",
        "SessionState is players, relics, score and the mode objective (timer, hold time, next checkpoint, hazard height). The simulation advances it; the agent never writes it.",
        "Commit needs a server-issued proof.",
      ],
      10.5
    ),
    { x: 0.7, y: cy + 0.42, w: 4.0, h: ch - 0.5, valign: "top", margin: 0, isTextBox: true, objectName: "state bullets" }
  );
  card(s, 5.15, cy, 4.35, ch, "validation card");
  label(s, "VALIDATION IS GAME CODE", 5.35, cy + 0.15, 4);
  s.addText(
    bullets(
      [
        "Geometry, bridge sockets, walk field, reachability with the gate locked, occupied support at commit time.",
        "MODE_INVALID: relics required above the count, a race with under 2 checkpoints, survival without a rising hazard, a timer outside 20 to 600 s.",
        "The mode rule is engine code picked by an enum. An LLM saying valid is never approval. Output is schema-checked JSON only.",
      ],
      10.5
    ),
    { x: 5.35, y: cy + 0.42, w: 4.0, h: ch - 0.5, valign: "top", margin: 0, isTextBox: true, objectName: "validation bullets" }
  );

  s.addNotes(
    "Left to right: director, OpenClaw agent, the mapping step (closest mode and biome, parameters from the brief, named in the summary), Beetle tools, server validator and commit, players. Structured output means only a listed mode, a listed biome and in-range parameters can come out of the model. Only the server decides validity; the model only proposes JSON."
  );
}

// ====================== Slide 5: measured local-first results ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("Measured local-first results", { placeholder: "title" });
  smallWordmark(s);

  // Rebuilt 2026-10-03 14:26 CDT. Every value is copied from the file named in the card; see docs/pitch/FILL_IN.md.
  const cells = [
    ["MODEL", "qwen3.5:4b, Q4_K_M", "4.7B, 3.4 GB, Ollama 0.35.1 on loopback. qwen3.8:27b not benchmarked: pull failed once, second pull stopped. docs/MODEL_SELECTION.md"],
    ["BRIEF, WARM, QUIET GPU", "26.2 / 26.5 / 27.7 s", "min / p50 / max, 3 runs, first draft valid (bench-...1791049348895.json). 10 s target not met. 14 s once after normalization (RESULTS.md run 3); 33.4 s via OpenClaw."],
    ["MODE BRIEFS, ONE PROMPT", "not yet measured", "mode, biome and brief-to-commit per request are being appended to docs/RESULTS.md 'Game modes from one prompt'; this card is rebuilt from those rows only."],
    ["COLD / CONTENDED GPU", "23.1 s load; 58 to 214 s", "cold: 23.1 s load in a 54.4 s first draft (probe-run.log). Contended drafts 58.8 to 214.1 s, one edit 45.1 s (bench-...1791050596040.json)."],
    ["EDIT TO COMMIT", "2.0 / 8.0 / 14.0 s", "min / p50 / max, 6 edits, 5 of 6 committed; run 3 after normalization, quiet GPU, direct (run-1791052136845.json). Run 2 before: 2 of 6."],
    ["EDIT WHILE 2 PLAY", "8.0 s, 15 of 15", "acceptance run 2: both controllers walking, lava + bridge committed, relic and score unchanged, sockets open, max tick gap 67 ms (ACCEPTANCE.md)."],
    ["INVALID EDITS CAUGHT", "6 of 12 refused", "runs 2 and 3 (RESULTS.md); repairs that then committed: 1; invalid worlds committed: 0. garden5: DISCONNECTED_GOAL refused 1.7 s, repaired and committed 3.0 s."],
    ["NORMALIZATION EFFECT", "2 of 30 to 13 of 30", "corpus validity without vs with the deterministic normalizer (MODEL_FAILURE_MODES.md). Live edits committed: 2 of 6 to 5 of 6."],
    ["OPENCLAW LIVE", "20.0 s edit, 33.4 s brief", "real tool calls, v2 at 13:43 CDT; brief to v1 at 14:08 CDT; gated test 38.9 s, 7 tool calls (RESULTS.md, BUILD_STATUS.md 17)."],
    ["LATENCY, LOOPBACK", "0.48 ms RTT, 18.8 ms tick", "p50, scripted controllers (p95 0.81 and 33.1 ms; LATENCY.md). Not input to photon: no phone, Wi-Fi, browser or display."],
    ["PHONES", "not yet with devices", "controller page under mobile emulation and 23 integration tests with real sockets pass (BUILD_STATUS.md 12); no physical phone joined today."],
    ["OFFLINE PROOF", "not run", "only a before record exists (offline-proof/1791049273707.json: egress not blocked, server not up). Procedure: docs/OFFLINE_PROOF.md. Nothing claimed."],
  ];
  const cols = 4,
    gx = 0.12,
    gy = 0.06,
    cw = (9.0 - gx * (cols - 1)) / cols,
    ch = 1.08,
    x0 = 0.5,
    y0 = 1.22;
  cells.forEach(([lab, big, sub], i) => {
    const x = x0 + (i % cols) * (cw + gx);
    const y = y0 + Math.floor(i / cols) * (ch + gy);
    card(s, x, y, cw, ch, "result card " + lab);
    label(s, lab, x + 0.12, y + 0.07, cw - 0.24, { fontSize: 7.5, h: 0.18 });
    s.addText(big, {
      x: x + 0.12,
      y: y + 0.25,
      w: cw - 0.24,
      h: 0.28,
      fontSize: 11,
      bold: true,
      color: C.accent1,
      valign: "middle",
      margin: 0,
      isTextBox: true,
      objectName: "result value " + lab,
    });
    s.addText(sub, {
      x: x + 0.12,
      y: y + 0.55,
      w: cw - 0.24,
      h: 0.5,
      fontSize: 6.8,
      color: C.text2,
      valign: "top",
      margin: 0,
      isTextBox: true,
      objectName: "result sub " + lab,
    });
  });
  s.addText(
    "Direct-harness timings are labelled [direct] in every report; OpenClaw timings are from the real server after the Ollama daemon restart at 13:43 CDT. Each card names its GPU state because the daemon was shared for most of the day. Mode briefs: not yet measured; the card is filled only from docs/RESULTS.md.",
    {
      x: 0.5,
      y: 4.66,
      w: 9.0,
      h: 0.46,
      fontSize: 8,
      italic: true,
      color: C.text2,
      margin: 0,
      isTextBox: true,
      objectName: "sources note",
    }
  );

  s.addNotes(
    "Read the cards. Say out loud: the 10 s brief target is not met; a valid brief takes 24 to 28 s warm on a quiet GPU, 14 s was seen once after normalization, 33.4 s through OpenClaw. Edits commit in 2 to 14 s, and 8.0 s with two players moving and nothing reset. Game modes from one prompt are not yet measured; say so rather than guessing. Phones and the offline proof are covered by tests or procedure but not yet measured live. The 27b was never benchmarked."
  );
}

// ====================== Slide 6: business hypothesis and next validation ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("Business hypothesis and next validation", { placeholder: "title" });
  smallWordmark(s);

  const cols = [
    [
      "HYPOTHESIS",
      [
        "Studios will pay for faster prototype iteration that keeps playtests running.",
        "Their data stays on their machines, which matters to studios with unreleased IP.",
      ],
      true,
    ],
    [
      "NOT CLAIMED",
      ["Market size.", "Pricing.", "Customer traction.", "Speed-up percentages without a measured baseline."],
      false,
    ],
    [
      "NEXT VALIDATION",
      [
        "Time a conventional edit-rebuild-regather loop with the same designers and the same change list.",
        "Compare it against Beetle's measured edit-to-commit times.",
      ],
      false,
    ],
  ];
  const cw = 2.9,
    gx = 0.15,
    cy = 1.3,
    ch = 3.15;
  cols.forEach(([h, items, hi], i) => {
    const x = 0.5 + i * (cw + gx);
    s.addShape(pres.ShapeType.roundRect, {
      x,
      y: cy,
      w: cw,
      h: ch,
      rectRadius: 0.08,
      fill: { color: hi ? C.accent1 : C.background2 },
      line: { color: hi ? C.accent1 : C.accent4, width: 0.75 },
      objectName: "column " + h,
    });
    s.addText(h, {
      x: x + 0.2,
      y: cy + 0.18,
      w: cw - 0.4,
      h: 0.3,
      fontSize: 11,
      bold: true,
      charSpacing: 2,
      color: hi ? C.background1 : C.accent1,
      margin: 0,
      isTextBox: true,
      objectName: "column label " + h,
    });
    s.addText(
      items.map((t, j) => ({
        text: t,
        options: {
          bullet: { indent: 12 },
          fontSize: 12.5,
          color: hi ? C.background1 : C.text1,
          breakLine: j < items.length - 1,
          paraSpaceAfter: 7,
        },
      })),
      { x: x + 0.2, y: cy + 0.55, w: cw - 0.4, h: ch - 0.7, valign: "top", margin: 0, isTextBox: true, objectName: "column body " + h }
    );
  });
  wordmark(s, 0.5, 4.6, 0.45, 16);
  s.addText("Change the game without stopping the game.", {
    x: 2.9,
    y: 4.6,
    w: 6.6,
    h: 0.45,
    fontSize: 12,
    italic: true,
    color: C.text2,
    valign: "middle",
    margin: 0,
    isTextBox: true,
    objectName: "closing line",
  });

  s.addNotes("State the hypothesis, say plainly what we do not claim, and name the one comparison that would test it next.");
}

(async () => {
  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote", OUT);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
