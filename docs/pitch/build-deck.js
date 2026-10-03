// Beetle pitch deck generator (six slides). Output: docs/pitch/Beetle-pitch.pptx
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

// ====================== Slide 2: the Beetle workflow ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("The Beetle workflow", { placeholder: "title" });
  smallWordmark(s);

  const steps = [
    "Brief becomes a playable world",
    "Two phones join by QR",
    "Designer edits while people play",
    "Agent validates and repairs",
    "New version lands, no reset",
    "Version report",
  ];
  const n = steps.length;
  const left = 0.5,
    right = 9.5;
  const span = (right - left - 1.3) / (n - 1); // centre to centre
  const lineY = 2.15;
  s.addShape(pres.ShapeType.line, {
    x: left + 0.65,
    y: lineY,
    w: span * (n - 1),
    h: 0.001,
    line: { color: C.accent4, width: 2 },
    objectName: "workflow spine",
  });
  steps.forEach((t, i) => {
    const cxi = left + 0.65 + span * i;
    const d = 0.5;
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
      fontSize: 14,
      bold: true,
      color: C.background1,
      align: "center",
      valign: "middle",
      margin: 0,
      isTextBox: true,
      objectName: "step number " + (i + 1),
    });
    s.addText(t, {
      x: cxi - 0.75,
      y: lineY + 0.4,
      w: 1.5,
      h: 0.8,
      fontSize: 12,
      color: C.text1,
      align: "center",
      valign: "top",
      margin: 0,
      isTextBox: true,
      objectName: "step text " + (i + 1),
    });
  });

  // Bottom: the local-only stance as four chips
  label(s, "WHAT IT RUNS ON", 0.5, 3.55, 4);
  const chips = [
    ["One machine", "a single GB10 on the studio LAN"],
    ["One local model", "Ollama on loopback"],
    ["One real agent runtime", "OpenClaw with Beetle tools"],
    ["Zero cloud", "no fallback exists"],
  ];
  const cw = 2.1,
    gap = 0.2,
    cy = 3.9,
    ch = 0.95;
  chips.forEach(([h, sub], i) => {
    const x = 0.5 + i * (cw + gap);
    card(s, x, cy, cw, ch, "chip " + h);
    s.addText(
      [
        { text: h, options: { fontSize: 13, bold: true, color: C.text1, breakLine: true, paraSpaceAfter: 3 } },
        { text: sub, options: { fontSize: 10.5, color: C.text2 } },
      ],
      { x: x + 0.15, y: cy, w: cw - 0.3, h: ch, valign: "middle", margin: 0, isTextBox: true, objectName: "chip text " + h }
    );
  });

  s.addNotes(
    "Walk the six steps left to right, then land on the stance: one machine, one local model, one real OpenClaw runtime, zero cloud."
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
      { text: "90 to 120 second demo recording, dropped in after rehearsal", options: { fontSize: 11, color: C.text2, breakLine: true } },
      { text: "Any time compression is labelled on screen", options: { fontSize: 11, color: C.text2 } },
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
    ["58 to 90 s", "The validator refuses a world nobody can finish. The agent repairs it and commits only a passing version."],
    ["90 to 105 s", "Measured on one GB10. Local model, local agent, no cloud."],
    ["105 to 115 s", "Beetle"],
  ];
  const runs = [];
  caps.forEach(([t, c], i) => {
    runs.push({ text: t + "  ", options: { fontSize: 10, bold: true, color: C.accent1 } });
    runs.push({ text: c, options: { fontSize: 10, color: C.text1, breakLine: i < caps.length - 1, paraSpaceAfter: 5 } });
  });
  s.addText(runs, { x: cx, y: 1.6, w: cw, h: 3.4, valign: "top", margin: 0, isTextBox: true, objectName: "caption list" });

  s.addNotes("Play the recording here. Captions follow the storyboard; shots that cannot be produced honestly are cut, not faked.");
}

// ====================== Slide 4: agent architecture and validation ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("Agent architecture and validation", { placeholder: "title" });
  smallWordmark(s);

  const nodes = [
    ["Director", "brief or edit request"],
    ["OpenClaw agent", "reads state, proposes, repairs in a bounded budget"],
    ["Beetle tools", "schema-checked JSON only, nothing executed"],
    ["Server validator and commit", "deterministic game code, server-issued proof"],
    ["Players", "same session, same progress, new version"],
  ];
  const n = nodes.length;
  const nx = 0.5,
    ny = 1.3,
    nw = 1.5,
    nh = 0.7,
    gap = (9.0 - n * nw) / (n - 1);
  nodes.forEach(([h, sub], i) => {
    const x = nx + i * (nw + gap);
    const isValidator = i === 3;
    s.addShape(pres.ShapeType.roundRect, {
      x,
      y: ny,
      w: nw,
      h: nh,
      rectRadius: 0.08,
      fill: { color: isValidator ? C.accent1 : C.background2 },
      line: { color: isValidator ? C.accent1 : C.accent4, width: 0.75 },
      objectName: "node " + h,
    });
    s.addText(h, {
      x,
      y: ny,
      w: nw,
      h: nh,
      fontSize: 11.5,
      bold: true,
      color: isValidator ? C.background1 : C.text1,
      align: "center",
      valign: "middle",
      margin: 0.05,
      isTextBox: true,
      objectName: "node title " + h,
    });
    s.addText(sub, {
      x: x - 0.1,
      y: ny + nh + 0.08,
      w: nw + 0.2,
      h: 0.6,
      fontSize: 9.5,
      color: C.text2,
      align: "center",
      valign: "top",
      margin: 0,
      isTextBox: true,
      objectName: "node sub " + h,
    });
    if (i < n - 1) {
      arrow(s, x + nw + 0.05, ny + nh / 2, x + nw + gap - 0.05, ny + nh / 2, C.accent3, 1.75);
    }
  });
  // feedback loop: validator issues go back to the agent (bounded repair attempts)
  const agentX = nx + 1 * (nw + gap) + nw / 2;
  const valX = nx + 3 * (nw + gap) + nw / 2;
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
  s.addText("validation issues go back for repair, at most [max attempts] attempts, then the request fails honestly", {
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
        "WorldSpec is structure. It changes only when a transaction commits, one version per commit.",
        "SessionState is players, relics, score. The simulation advances it; the agent never writes it.",
        "Commit needs a server-issued proof.",
      ],
      11
    ),
    { x: 0.7, y: cy + 0.42, w: 4.0, h: ch - 0.5, valign: "top", margin: 0, isTextBox: true, objectName: "state bullets" }
  );
  card(s, 5.15, cy, 4.35, ch, "validation card");
  label(s, "VALIDATION IS GAME CODE", 5.35, cy + 0.15, 4);
  s.addText(
    bullets(
      [
        "Geometry, bridge sockets, walk field, reachability with the gate locked, occupied support at commit time.",
        "An LLM saying valid is never approval.",
        "Nothing from the model runs. Output is schema-checked JSON only.",
      ],
      11
    ),
    { x: 5.35, y: cy + 0.42, w: 4.0, h: ch - 0.5, valign: "top", margin: 0, isTextBox: true, objectName: "validation bullets" }
  );

  s.addNotes(
    "Left to right: director, OpenClaw agent, Beetle tools, server validator and commit, players. Only the server decides validity; the model only proposes JSON."
  );
}

// ====================== Slide 5: measured local-first results ======================
{
  const s = pres.addSlide({ masterName: "CONTENT", ...SEC });
  s.addText("Measured local-first results", { placeholder: "title" });
  smallWordmark(s);

  const cells = [
    ["MODEL", "[model tag], [quantization]", "on the GB10 via Ollama on loopback"],
    ["BRIEF TO PLAYABLE", "[min] / [p50] / [max] s", "over [N] runs, cold load [cold s] reported separately"],
    ["EDIT TO COMMIT", "[min] / [p50] / [max] s", "edit request to committed version"],
    ["INVALID EDITS CAUGHT", "[caught] of [attempts]", "repairs that succeeded: [repaired]"],
    ["SESSION CONTINUITY", "[players kept] players, [relics kept] relics", "[reconnects] reconnects across [N commits] commits"],
    ["OFFLINE PROOF", "[what was disconnected]", "still worked: [what still worked]"],
  ];
  const cols = 3,
    cw = 2.9,
    ch = 1.45,
    gx = 0.15,
    gy = 0.18,
    x0 = 0.5,
    y0 = 1.3;
  cells.forEach(([lab, big, sub], i) => {
    const x = x0 + (i % cols) * (cw + gx);
    const y = y0 + Math.floor(i / cols) * (ch + gy);
    card(s, x, y, cw, ch, "result card " + lab);
    label(s, lab, x + 0.18, y + 0.14, cw - 0.36);
    s.addText(big, {
      x: x + 0.18,
      y: y + 0.42,
      w: cw - 0.36,
      h: 0.6,
      fontSize: 15,
      bold: true,
      color: C.accent1,
      valign: "middle",
      margin: 0,
      isTextBox: true,
      objectName: "result value " + lab,
    });
    s.addText(sub, {
      x: x + 0.18,
      y: y + 1.06,
      w: cw - 0.36,
      h: 0.38,
      fontSize: 10,
      color: C.text2,
      valign: "top",
      margin: 0,
      isTextBox: true,
      objectName: "result sub " + lab,
    });
  });
  s.addText(
    "Every bracketed value is a placeholder. Values come only from data/benchmarks/*.json and data/reports/*.json. Nothing unmeasured goes on a slide.",
    {
      x: 0.5,
      y: 4.62,
      w: 9.0,
      h: 0.45,
      fontSize: 10,
      italic: true,
      color: C.text2,
      margin: 0,
      isTextBox: true,
      objectName: "placeholder note",
    }
  );

  s.addNotes("Read the measured numbers from the filled cards. If a card is still bracketed, say that the measurement is pending rather than guessing.");
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
