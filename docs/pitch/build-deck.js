// Beetle pitch deck generator (six slides; 2D plus 3D scope from 16:05 CDT). Output: docs/pitch/Beetle-pitch.pptx
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

// ====================== Slide 2: describe any game, 2D or 3D, then keep changing it ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText([{ text: "Describe any game: Beetle builds it in 2D or 3D, then keeps changing it while people play", options: { fontSize: 19, bold: true } }], { placeholder: "title" });
  smallWordmark(s);

  // Top: five steps on a spine
  const steps = [
    ["Describe any game", "\"hold the frozen hill ten seconds\" or \"a tower defense where bees protect a hive\""],
    ["2D or 3D, and named", "mapped to a 2D genre or a 3D mode and biome; Beetle says which it chose"],
    ["Playable at once", "3D: the world starts where the players are. 2D: sprites, tiles, sound and music made for it"],
    ["Checked before it lands", "game code validates every spec and patch; the model only proposes JSON"],
    ["Keep changing it while they play", "edits in plain words; in 3D they land while players move, no reset"],
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
        { text: sub, options: { fontSize: 8.5, color: C.text2 } },
      ],
      { x: cxi - 0.9, y: lineY + 0.3, w: 1.8, h: 0.78, align: "center", valign: "top", margin: 0, isTextBox: true, objectName: "step text " + (i + 1) }
    );
  });

  // Middle: the two engines side by side
  const ey = 2.6,
    eh = 2.12,
    ew = 4.42;
  const engines = [
    [
      "3D WORLDS (THE EXISTING PIPELINE)",
      [
        "5 engine modes: relic_hunt, time_trial, king_of_the_hill, checkpoint_race, survival. The model picks one and fills its parameters; it never writes rules.",
        "5 biomes, 2 terrains, water or lava, a rising hazard, 3 to 7 m/s, 11 decoration types.",
        "Streams ahead of players near an edge, up to 24 islands and 48 bridges; the director can switch it off.",
        "Live validated edits (set_mode, set_biome, set_movement, structural ops), each a new version. Phones are the controllers.",
      ],
    ],
    [
      "BEETLE 2D STUDIO (/2d)",
      [
        "Platformer, top-down, puzzle, defense, runner, arena and other level-based games, generated by the same local model through the server's loopback endpoint.",
        "Procedural pixel sprites, tiles, sound and music, made for the game; no asset pack needed.",
        "Edits in plain words: known requests are patched directly, the rest are proposed by the model as patch ops.",
        "The Game Spec is validated by game code and repaired or refused with the exact list. Export as a single-file HTML game.",
      ],
    ],
  ];
  engines.forEach(([title, items], i) => {
    const x = 0.5 + i * (ew + 0.16);
    card(s, x, ey, ew, eh, "engine card " + (i + 1));
    label(s, title, x + 0.15, ey + 0.1, ew - 0.3, { fontSize: 9, h: 0.22 });
    s.addText(bullets(items, 9), { x: x + 0.15, y: ey + 0.38, w: ew - 0.3, h: eh - 0.45, valign: "top", margin: 0, isTextBox: true, objectName: "engine card bullets " + (i + 1) });
  });

  s.addText(
    "Adapted from one-prompt game generators: the one-prompt front door and instant playable output. Added: 2D and 3D from one prompt on one local model, live editing without a reset, deterministic validation and repair before publish, local-only inference, phones as controllers (docs/COMPETITIVE.md). A request outside a library lands on the nearest genre or mode and Beetle says so.",
    { x: 0.5, y: 4.8, w: 9.0, h: 0.36, fontSize: 7.5, italic: true, color: C.text2, margin: 0, isTextBox: true, objectName: "category note" }
  );

  s.addNotes(
    "One product, two engines. Walk the five steps: describe any game; Beetle maps it to a 2D genre or a 3D mode and biome and names the choice; it is playable at once (in 3D the world starts where the players are and grows as they move, in 2D the studio makes sprites, tiles, sound and music for the game); game code checks every spec and patch before it lands; then keep changing it in plain words. Left card: the 3D pipeline, measured all day (slide 5). Right card: the 2D studio at /2d, same local model through the server's loopback endpoint, single-file HTML export. Say plainly: the 3D numbers are measured all day; the 2D number is one run of six prompts (slide 5): every prompt reached a validated, bot-playtested spec on the first model call in 10.7 to 16.9 s, in a Node harness against the local model, without asset painting or the browser. Streaming is measured: in the acceptance runs (contended GPU) 4 of 6 automatic extensions committed in 10.6 to 65.9 s, and one quiet-GPU run committed in 9.5 s. Mode briefs measured 14:25 to 14:42 CDT, 18 of 18 sensible modes."
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

  s.addNotes("Play the recording here. Captions follow docs/STORYBOARD.md; the mode caption is set to whichever agent mode was green at recording time. Rehearsal timings: brief 14 s on a quiet GPU, edits 2 to 14 s, DISCONNECTED_GOAL refused and repaired in 3.0 s. Shots that cannot be produced honestly are cut, not faked. Optional shot 'the world grows' (docs/STORYBOARD.md 6c): a player walks toward an edge, 'Beetle is building ahead' appears and the new island assembles; measured 10.6 to 65.9 s request to commit on a contended GPU (docs/ACCEPTANCE.md) and 9.5 s once on a quiet GPU (docs/RESULTS.md), not yet rehearsed on camera, so it is shown only from a real take, never compressed without a label. Optional shot 'the 2D studio' (docs/STORYBOARD.md 6d): an idea typed at /2d becomes a playable pixel game with its own sprites, tiles, sound and music, one edit in plain words, then the single-file HTML export; shown only from a real take, with the take's own time on screen; measured 10.7 to 16.9 s prompt to validated spec in a Node harness (docs/RESULTS.md 16:04 CDT), not on camera.");
}

// ====================== Slide 4: two engines, one local model, one validation discipline ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText([{ text: "Two engines, one local model, one validation discipline", options: { fontSize: 19, bold: true } }], { placeholder: "title" });
  smallWordmark(s);

  function flowRow(rowLabel, nodes, y, hiIndex, dashIndex) {
    label(s, rowLabel, 0.5, y - 0.27, 9.0, { fontSize: 8.5, h: 0.2 });
    const n = nodes.length;
    const nh = 0.5,
      gap = 0.2,
      nw = (9.0 - gap * (n - 1)) / n;
    nodes.forEach(([h, sub], i) => {
      const x = 0.5 + i * (nw + gap);
      const hi = i === hiIndex;
      const dash = i === dashIndex;
      s.addShape(pres.ShapeType.roundRect, {
        x,
        y,
        w: nw,
        h: nh,
        rectRadius: 0.08,
        fill: { color: hi ? C.accent1 : C.background2 },
        line: { color: hi ? C.accent1 : dash ? C.accent3 : C.accent4, width: dash ? 1.5 : 0.75, dashType: dash ? "sysDash" : "solid" },
        objectName: rowLabel + " node " + h,
      });
      s.addText(h, {
        x,
        y,
        w: nw,
        h: nh,
        fontSize: 9.5,
        bold: true,
        color: hi ? C.background1 : C.text1,
        align: "center",
        valign: "middle",
        margin: 0.04,
        isTextBox: true,
        objectName: rowLabel + " node title " + h,
      });
      s.addText(sub, {
        x: x - 0.06,
        y: y + nh + 0.04,
        w: nw + 0.12,
        h: 0.44,
        fontSize: 7.5,
        color: C.text2,
        align: "center",
        valign: "top",
        margin: 0,
        isTextBox: true,
        objectName: rowLabel + " node sub " + h,
      });
      if (i < n - 1) arrow(s, x + nw + 0.03, y + nh / 2, x + nw + gap - 0.03, y + nh / 2, C.accent3, 1.5);
    });
  }

  flowRow(
    "3D WORLDS: REQUEST TO COMMITTED VERSION",
    [
      ["Director or frontier", "a typed request, or a player near a rim with no crossing beyond"],
      ["OpenClaw agent", "reads state, proposes, repairs at most 2 times, then fails honestly"],
      ["Map to mode + biome", "closest of 5 modes, 5 biomes; named in the summary"],
      ["Beetle tools", "schema-checked JSON only, nothing executed; add_island to grow"],
      ["Server validator and commit", "deterministic game code, server-issued proof"],
      ["Players", "same session, same progress, new version"],
    ],
    1.47,
    4,
    2
  );
  flowRow(
    "BEETLE 2D STUDIO (/2d): IDEA TO PLAYABLE GAME",
    [
      ["Idea in words", "the genre the person names wins over the model's guess"],
      ["Design doc", "local model, schema-constrained JSON through /api/2d/llm"],
      ["Game Spec and assets", "procedural pixel sprites, tiles, sound and music"],
      ["Spec validator and repair", "game code: a valid spec, or the exact list of what could not be fixed"],
      ["Play, edit in words, export", "known edits patched directly, the rest as model patch ops; single-file HTML"],
    ],
    2.82,
    3,
    1
  );

  // Lower: three cards
  const cy = 3.88,
    ch = 1.27,
    cgap = 0.15,
    cwd = (9.0 - cgap * 2) / 3;
  const lowerCards = [
    [
      "ONE LOCAL MODEL",
      [
        "Both engines call the same configured model (qwen3.5:4b) on Ollama at 127.0.0.1; no cloud fallback host exists.",
        "2D model calls go through the server's loopback endpoint, director token required.",
      ],
    ],
    [
      "ONE VALIDATION DISCIPLINE",
      [
        "The model only proposes JSON; game code decides. An LLM saying valid is never approval.",
        "3D: geometry, sockets, reachability, MODE_INVALID, commit proof. 2D: strict Game Spec checks, repair or refuse.",
      ],
    ],
    [
      "3D STATE AND GROWTH",
      [
        "WorldSpec is structure; SessionState is players, relics, score. The agent never writes SessionState.",
        "Extensions add 1 to 2 islands, at least 12 s apart, up to 24 islands and 48 bridges.",
      ],
    ],
  ];
  lowerCards.forEach(([title, items], i) => {
    const x = 0.5 + i * (cwd + cgap);
    card(s, x, cy, cwd, ch, "lower card " + (i + 1));
    label(s, title, x + 0.12, cy + 0.08, cwd - 0.24, { fontSize: 8.5, h: 0.2 });
    s.addText(bullets(items, 8), { x: x + 0.12, y: cy + 0.32, w: cwd - 0.24, h: ch - 0.38, valign: "top", margin: 0, isTextBox: true, objectName: "lower card bullets " + (i + 1) });
  });

  s.addNotes(
    "Two engines, one local model, one validation discipline. Top row, 3D: director or the frontier trigger, OpenClaw agent, the mapping step (closest mode and biome, named in the summary), Beetle tools, server validator and commit, players. Validation issues including MODE_INVALID go back for repair, at most 2 attempts, then the request fails honestly and the world is untouched. Streaming uses the same path: add_island, 1 to 2 islands, the same validator; growth stops at 24 islands and 48 bridges and the director can switch it off. Second row, 2D: the idea becomes a design doc written by the same local model through a schema, then a Game Spec with procedural pixel sprites, tiles, sound and music; the spec is validated by game code and either repaired or refused with the exact list of what could not be fixed; then play, edit in words and export a single-file HTML game. Same rule in both engines: the model proposes JSON, game code decides."
  );
}

// ====================== Slide 5: measured local-first results ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("Measured local-first results", { placeholder: "title" });
  smallWordmark(s);

  // Rebuilt 2026-10-03 14:50 CDT, streaming line and latency card updated 15:15 CDT. Every value is copied from the
  // file named in the card; see docs/pitch/FILL_IN.md.
  const LATENCY_BIG = "0.46 ms RTT, 0.78 ms tick";
  const LATENCY_SUB = "p50 idle, scripted controllers (p95 0.74 and 1.15 ms; under 2 x 30 inputs/s tick p95 12.3 ms; LATENCY.md 20:26Z). Not input to photon.";
  // Streaming: docs/ACCEPTANCE.md streaming section (3 runs, contended GPU) plus one quiet-GPU run in docs/RESULTS.md (15:16 CDT).
  const STREAMING_LINE = "Streaming, extension request to commit: 10.6 to 65.9 s, 4 of 6 committed, GPU contended (ACCEPTANCE.md, run 3 PASS 21 of 21: 56.0 s and 10.6 s); 9.5 s once on a quiet GPU (RESULTS.md). Trigger to request under 0.3 s; player, relic and score kept.";
  const TWO_D_LINE = "6 of 6 prompts to a validated, bot-playtested spec in 10.7 to 16.9 s (model 10.3 to 12.7 s), first model call, 0 repairs, 6 genres. Direct Ollama, shared GPU, Node harness: asset painting, worker hop and the browser not included (RESULTS.md 16:04 CDT).";
  const cells = [
    ["MODEL", "qwen3.5:4b, Q4_K_M", "4.7B, 3.4 GB, Ollama 0.35.1 on loopback. qwen3.8:27b not benchmarked: pull failed once, second pull stopped. docs/MODEL_SELECTION.md"],
    ["BRIEF, WARM, QUIET GPU", "26.2 / 26.5 / 27.7 s", "min / p50 / max, 3 runs, first draft valid (bench-...1791049348895.json). 10 s target not met. 14 s once after normalization (RESULTS.md run 3); 33.4 s via OpenClaw."],
    ["MODE BRIEFS", "18 of 18 right mode", "committed briefs 13.0 to 44.1 s; exact mode missed twice; 8 of 14 final-prompt attempts committed, failures all geometry; mode and biome edits 3.0 s (RESULTS.md 'Game modes from one prompt', direct)."],
    ["COLD / CONTENDED GPU", "23.1 s load; 58 to 214 s", "cold: 23.1 s load in a 54.4 s first draft (probe-run.log). Contended drafts 58.8 to 214.1 s, one edit 45.1 s (bench-...1791050596040.json)."],
    ["EDIT TO COMMIT", "2.0 / 8.0 / 14.0 s", "min / p50 / max, 6 edits, 5 of 6 committed; run 3 after normalization, quiet GPU, direct (run-1791052136845.json). Run 2 before: 2 of 6."],
    ["EDIT WHILE 2 PLAY", "8.0 s, 15 of 15", "acceptance run 2: both controllers walking, lava + bridge committed, relic and score unchanged, sockets open, max tick gap 67 ms (ACCEPTANCE.md)."],
    ["INVALID EDITS CAUGHT", "6 of 12 refused", "runs 2 and 3 (RESULTS.md); repairs that then committed: 1; invalid worlds committed: 0. garden5: DISCONNECTED_GOAL refused 1.7 s, repaired and committed 3.0 s."],
    ["NORMALIZATION EFFECT", "2 of 30 to 13 of 30", "corpus validity without vs with the deterministic normalizer (MODEL_FAILURE_MODES.md). Live edits committed: 2 of 6 to 5 of 6."],
    ["OPENCLAW LIVE", "20.0 s edit, 33.4 s brief", "real tool calls, v2 at 13:43 CDT; brief to v1 at 14:08 CDT; gated test 38.9 s, 7 tool calls (RESULTS.md, BUILD_STATUS.md 17)."],
    ["LATENCY, LOOPBACK", LATENCY_BIG, LATENCY_SUB],
    ["PHONES", "not yet with devices", "controller page under mobile emulation and 23 integration tests with real sockets pass (BUILD_STATUS.md 12); no physical phone joined today."],
    ["OFFLINE PROOF", "not run", "only a before record exists (offline-proof/1791049273707.json: egress not blocked, server not up). Procedure: docs/OFFLINE_PROOF.md."],
  ];
  const cols = 4,
    gx = 0.12,
    gy = 0.06,
    cw = (9.0 - gx * (cols - 1)) / cols,
    ch = 1.0,
    x0 = 0.5,
    y0 = 1.2;
  cells.forEach(([lab, big, sub], i) => {
    const x = x0 + (i % cols) * (cw + gx);
    const y = y0 + Math.floor(i / cols) * (ch + gy);
    card(s, x, y, cw, ch, "result card " + lab);
    label(s, lab, x + 0.12, y + 0.06, cw - 0.24, { fontSize: 7.5, h: 0.18 });
    s.addText(big, {
      x: x + 0.12,
      y: y + 0.22,
      w: cw - 0.24,
      h: 0.26,
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
      y: y + 0.49,
      w: cw - 0.24,
      h: 0.49,
      fontSize: 6.8,
      color: C.text2,
      valign: "top",
      margin: 0,
      isTextBox: true,
      objectName: "result sub " + lab,
    });
  });
  s.addText(STREAMING_LINE, {
    x: 0.5,
    y: 4.36,
    w: 9.0,
    h: 0.27,
    fontSize: 8,
    bold: true,
    color: C.accent1,
    margin: 0,
    isTextBox: true,
    objectName: "streaming status",
  });
  // Beetle 2D: filled from docs/RESULTS.md "Beetle 2D: prompt to playable" (16:04 to 16:06 CDT, data/studio2d-runs/run-1791061567084.json).
  s.addText(
    [
      { text: "BEETLE 2D, PROMPT TO PLAYABLE  ", options: { fontSize: 8, bold: true, color: C.accent1, charSpacing: 1 } },
      { text: TWO_D_LINE, options: { fontSize: 8, bold: true, color: C.text1 } },
    ],
    { x: 0.5, y: 4.64, w: 9.0, h: 0.27, valign: "top", margin: 0, isTextBox: true, objectName: "2d status" }
  );
  s.addText(
    "Direct-harness timings are labelled [direct] in every report; OpenClaw timings are from the real server after the Ollama daemon restart at 13:43 CDT. Each card names its GPU state because the daemon was shared for most of the day. Mode briefs were measured at 14:25 to 14:42 CDT in direct mode with no controllers connected (docs/RESULTS.md). The 12 cards are the 3D engine; the 2D line is the 2D studio.",
    {
      x: 0.5,
      y: 4.93,
      w: 9.0,
      h: 0.26,
      fontSize: 6.8,
      italic: true,
      color: C.text2,
      margin: 0,
      isTextBox: true,
      objectName: "sources note",
    }
  );

  s.addNotes(
    "Read the cards. Say out loud: the 10 s brief target is not met; a valid brief takes 24 to 28 s warm on a quiet GPU, 14 s was seen once after normalization, 33.4 s through OpenClaw. Edits commit in 2 to 14 s, and 8.0 s with two players moving and nothing reset. Game modes from one prompt: the mode was sensible on 18 of 18 briefs and the exact mode was missed twice; committed mode briefs took 13 to 44 s and the failures were geometry, never the mode rule; mode and biome edits on a running world took 3.0 s. Phones and the offline proof are covered by tests or procedure but not yet measured live. Streaming: the frontier trigger opens the request within 0.3 s; the model is the slow part. Acceptance runs on a contended GPU: 4 of 6 extensions committed in 10.6 to 65.9 s, one failed schema validation, one hit the 80 s model timeout, and each failure left the world untouched; run 3 passed 21 of 21 with player, relic and score kept and the player walking onto both new islands. Quiet GPU, once: 9.5 s. No spawn-zone build time is quoted. The 27b was never benchmarked. Every card is the 3D engine. Beetle 2D, one run of six prompts at 16:04 to 16:06 CDT on a possibly shared GPU: all six reached a validated spec on the first model call with zero repairs, model 10.3 to 12.7 s, prompt to validated and bot-playtested spec 10.7 to 16.9 s; genres chosen platformer, top-down, defense, puzzle, runner and arena. Say what it excludes: the Web Worker hop, procedural asset painting, generated art and the browser; 2D edits in words and the HTML export are not timed."
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
