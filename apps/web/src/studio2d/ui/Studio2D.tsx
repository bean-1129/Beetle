// The Beetle 2D page: Idea (describe and approve a design), Build (watch it come together) and
// Play (play it, with an edit panel beside it). Every edit, typed or by hand, is a validated
// spec patch, and the game updates live.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Gamepad2, Sparkles, Hammer, Play, Download, FolderOpen, Save, Library, Check, X, LoaderCircle, Undo2, Wand2,
  RotateCcw, Image as ImageIcon, FileJson, Trash2, Pencil, Circle, ChevronRight, Cpu, WifiOff, Package, Box,
} from "lucide-react";
import { takeDirectorToken } from "../../shared/token.ts";
import type { GameSpec, Genre, Weather, ArtStyle } from "../spec/types.ts";
import { GENRES, WEATHERS, ART_STYLES } from "../spec/types.ts";
import { PALETTES } from "../spec/defaults.ts";
import { repairSpec, validateSpec } from "../spec/validate.ts";
import { applyPatch, setParamOps, type PatchOp } from "../spec/patch.ts";
import { SAMPLES } from "../samples/index.ts";
import type { DesignDoc } from "../gen/design.ts";
import { designFromIdea } from "../gen/design.ts";
import { safeApply } from "../gen/nlpatch.ts";
import { api, makeDesign, changeInWords, generateArt, templateSpec, writeScriptGame, changeScriptInWords, MODEL_SCRIPTS_ENABLED } from "../gen/ai.ts";
import { designFromIdea as readIdea } from "../gen/design.ts";
import type { LevelReport } from "../world/levels.ts";
import { reachableSide, reachableTop, makeStreamer } from "../world/levels.ts";
import { playtest } from "../world/bot.ts";
import { buildAssets } from "../assets/pipeline.ts";
import type { Pixels } from "../assets/pixels.ts";
import { exportHtml, projectFiles, fileName } from "../export/export.ts";
import { Studio2DPlayer } from "../runtime/player.ts";
import { checkScript } from "../runtime/script.ts";
import "./studio2d.css";

type View = "idea" | "build" | "play";
type StageId = "design" | "spec" | "assets" | "levels" | "playtest" | "assemble" | "art";
type Stage = { id: StageId; label: string; state: "wait" | "run" | "done" | "fail" | "skip"; detail?: string; ms?: number; t0?: number };
type Change = { summary: string; before: GameSpec; via: string };

const EXAMPLES = [
  "A fox who collects glowing seeds in a rainy forest, with moving platforms and a boss at the end",
  "An endless runner where a penguin dashes across icy cliffs",
  "A top-down dungeon where a knight searches for the key to an old portal",
  "A space arena shooter: a little robot survives waves of slimes",
  "A cosy puzzle game about a cat pushing crates onto pressure plates in the desert",
  "Build a contraption of planks and springs so the marble lands in the basket",
  "Plants versus zombies: sunflowers and pea shooters defend the house from waves of zombies",
  "Space invaders, but the aliens are cats",
  "Tetris where the blocks fall faster every level",
  "A rhythm game where you tap to the beat as notes fall",
];
const SAMPLE_LABELS: Record<string, string> = { platformer: "Seedlight", "top-down": "Moss Keep", runner: "Canopy Dash", arena: "Star Pit", puzzle: "Plates and Crates", builder: "Marble Works", defense: "Lawn Guard" };
const QUICK_BY_GENRE: Record<string, string[]> = {
  defense: ["More sun", "Tougher zombies", "Make the zombies slower", "Make it easier", "Make it harder", "Night colours"],
  "top-down": ["Make me faster", "Make the enemies slower", "Make it easier", "Make it harder", "More rain", "Night colours"],
  arena: ["Make me faster", "Tougher enemies", "Make it easier", "Make it harder", "Night colours"],
  puzzle: ["Make me faster", "Night colours", "Make it painted style"],
  builder: ["Bouncier springs", "Lower gravity", "Night colours"],
  runner: ["Make the jump higher", "Make me slower", "Add a double jump", "More rain", "Night colours"],
};
const QUICK = ["Make the jump higher", "Add a double jump", "More rain", "Make it easier", "Make it harder", "Make the enemies slower", "Night colours"];
const STAGES: Stage[] = [
  { id: "design", label: "Design doc", state: "wait" },
  { id: "spec", label: "Game Spec", state: "wait" },
  { id: "assets", label: "Art and sound", state: "wait" },
  { id: "levels", label: "Levels", state: "wait" },
  { id: "playtest", label: "Playtest bot", state: "wait" },
  { id: "assemble", label: "Ready to play", state: "wait" },
];
const cleanError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const newId = () => `game-${Date.now().toString(36)}`;

let runtimeCode: Promise<string> | null = null;
const runtime = () => (runtimeCode ??= import("virtual:studio2d-runtime").then((m) => m.default));

function pixelsUrl(p: Pixels, scale = 3): string {
  const c = document.createElement("canvas");
  c.width = p.w * scale;
  c.height = p.h * scale;
  const src = document.createElement("canvas");
  src.width = p.w;
  src.height = p.h;
  src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL();
}

// Idea prefilled from ?prompt= (the landing page forwards it). Read once on first mount, then
// stripped from the URL; cached so StrictMode's second mount still sees it.
let promptFromUrl: string | null = null;
function takePromptFromUrl(): string {
  if (promptFromUrl !== null) return promptFromUrl;
  promptFromUrl = "";
  try {
    const url = new URL(location.href);
    const p = url.searchParams.get("prompt");
    if (p === null) return promptFromUrl;
    url.searchParams.delete("prompt");
    history.replaceState(history.state, "", url.pathname + (url.search ? url.search : "") + url.hash);
    promptFromUrl = p.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, 1000);
  } catch {}
  return promptFromUrl;
}

export default function Studio2D({ notify }: { notify?: (m: string) => void }) {
  const [view, setView] = useState<View>("idea");
  const [idea, setIdea] = useState(takePromptFromUrl);
  const [design, setDesign] = useState<DesignDoc | null>(null);
  const [designNote, setDesignNote] = useState("");
  const [designing, setDesigning] = useState(false);
  const [spec, setSpec] = useState<GameSpec | null>(null);
  const [gameId, setGameId] = useState(newId);
  const [stages, setStages] = useState<Stage[]>(STAGES);
  const [reports, setReports] = useState<LevelReport[]>([]);
  const [building, setBuilding] = useState(false);
  const [aiArt, setAiArt] = useState(false);
  const [status, setStatus] = useState<{ online: boolean; models: string[]; image: { ready: boolean } } | null>(null);
  const [history, setHistory] = useState<Change[]>([]);
  const [library, setLibrary] = useState<{ id: string; title: string; genre?: string; savedAt: number; levels: number }[] | null>(null);
  const [toast, setToast] = useState("");
  const say = useCallback((m: string) => {
    setToast(m);
    notify?.(m);
    window.setTimeout(() => setToast((t) => (t === m ? "" : t)), 3200);
  }, [notify]);

  useEffect(() => {
    void api()?.status().then(setStatus).catch(() => {});
    // Get the model loaded while the person types.
    void api()?.warm?.().catch(() => {});
  }, []);

  const stage = (id: StageId, patch: Partial<Stage>) =>
    setStages((list) => list.map((s) => (s.id === id ? { ...s, ...patch, ms: patch.state === "done" || patch.state === "fail" ? (s.t0 ? Math.round(performance.now() - s.t0) : s.ms) : s.ms, t0: patch.state === "run" ? performance.now() : s.t0 } : s)));

  // ---------- Idea → design ----------

  async function onDesign() {
    const text = idea.trim();
    if (!text) return;
    // Templates play instantly and new kinds of games go straight to the model.
    const quick = readIdea(text);
    if (quick.route !== "genre") return void onBuild(quick);
    setDesigning(true);
    setDesignNote("");
    try {
      const r = await makeDesign(text);
      setDesign(r.design);
      setDesignNote(r.source === "model" ? `Designed by ${r.model ?? "the local model"} in ${(r.ms / 1000).toFixed(1)} s. Change anything, then build.` : `Read straight from your idea${r.note ? ` (${r.note})` : ""}. Change anything, then build.`);
    } finally {
      setDesigning(false);
    }
  }

  // ---------- Design → game ----------

  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  // Play now: skip waiting for the design doc and build straight from the idea.
  function onPlayNow() {
    const text = idea.trim();
    if (text) void onBuild(readIdea(text));
  }

  async function buildScripted(d: DesignDoc) {
    const text = idea.trim();
    // Model-written game code is off: a new kind of game is built from the closest genre.
    if (d.route === "script" && !MODEL_SCRIPTS_ENABLED) {
      say("Building this from the closest kind of game Beetle knows.");
      return void (await onBuild({ ...d, route: "genre" }));
    }
    setStages([
      { id: "design", label: "Idea", state: "done", detail: d.route === "template" ? `ready template: ${d.template}` : "a new kind of game" },
      { id: "spec", label: d.route === "template" ? "Game" : "Writing the game", state: "run" },
      { id: "playtest", label: "Checking it runs", state: "wait" },
      { id: "assemble", label: "Ready to play", state: "wait" },
    ]);
    const t0 = performance.now();
    if (d.route === "template") {
      const s = templateSpec(text, d);
      const r = await checkInSandbox(s);
      stage("spec", { state: "done", detail: s.meta.title });
      stage("playtest", { state: r.ok ? "done" : "fail", detail: r.ok ? "plays without errors" : r.error });
      stage("assemble", { state: "done", detail: `${((performance.now() - t0) / 1000).toFixed(1)} s` });
      loadSpec(s, d);
      return;
    }
    const r = await writeScriptGame(text, d, checkInSandbox, (step, detail) => {
      if (step === "writing") stage("spec", { state: "run", detail: "the local model is writing it (about a minute)" });
      if (step === "checking") {
        stage("spec", { state: "done" });
        stage("playtest", { state: "run", detail: detail });
      }
      if (step === "repairing") {
        stage("playtest", { state: "run", detail: `fixing: ${detail}` });
        stage("spec", { state: "run", detail: "the model is fixing a bug" });
      }
    });
    if ("spec" in r) {
      stage("spec", { state: "done", detail: r.spec.meta.title });
      stage("playtest", { state: "done", detail: r.attempts > 1 ? `works after ${r.attempts - 1} fix${r.attempts > 2 ? "es" : ""}` : "works first try" });
      stage("assemble", { state: "done", detail: `${((performance.now() - t0) / 1000).toFixed(1)} s` });
      loadSpec(r.spec, d);
      return;
    }
    // The model could not get it working: say so, and build the closest built-in game instead.
    stage("playtest", { state: "fail", detail: r.error });
    say("This one did not come together, so Beetle is building the closest kind of game it knows.");
    await onBuild({ ...d, route: "genre" });
  }

  async function onBuild(d: DesignDoc) {
    if (d.route === "template" || d.route === "script") {
      setBuilding(true);
      setView("build");
      setReports([]);
      try {
        await buildScripted(d);
      } catch (e) {
        say(cleanError(e));
      } finally {
        setBuilding(false);
      }
      return;
    }
    setBuilding(true);
    setView("build");
    setReports([]);
    setStages(STAGES.map((s) => (s.id === "design" ? { ...s, state: "done", detail: d.title } : { ...s })));
    stage("spec", { state: "run" });
    const t0 = performance.now();
    try {
      worker.current?.terminate();
      const w = new Worker(new URL("../gen/worker.ts", import.meta.url), { type: "module" });
      worker.current = w;
      const result = await new Promise<{ spec: GameSpec; reports: LevelReport[] }>((resolve, reject) => {
        w.onmessage = (e) => {
          const m = e.data;
          if (m.progress) {
            if (m.progress === "Building levels") {
              stage("spec", { state: "done", detail: `${d.genre} · ${d.levels.length} levels` });
              stage("assets", { state: "run" });
              // Placeholders are instant: build the art from the design while levels build.
              window.setTimeout(() => stage("assets", { state: "done", detail: "procedural sprites, tiles, sound and music" }), 0);
              stage("levels", { state: "run" });
            } else if (/^Playtesting/.test(m.progress)) {
              stage("levels", { state: "done" });
              stage("playtest", { state: "run", detail: m.progress });
            }
          } else if (m.error) reject(new Error(m.error));
          else if (m.result) resolve(m.result);
        };
        w.onerror = (e) => reject(new Error(e.message || "The builder stopped."));
        w.postMessage({ id: 1, design: d, seed: Math.floor(Math.random() * 1e6) });
      });
      w.terminate();
      worker.current = null;
      stage("levels", { state: "done", detail: `${result.spec.levels.length} levels` });
      const passed = result.reports.filter((r) => r.passed).length;
      stage("playtest", { state: passed === result.reports.length ? "done" : "fail", detail: `${passed}/${result.reports.length} levels finished by the bot` });
      setReports(result.reports);
      buildAssets(result.spec);
      stage("assemble", { state: "done", detail: `${((performance.now() - t0) / 1000).toFixed(1)} s from approval` });
      setSpec(result.spec);
      setHistory([]);
      setGameId(newId());
      setView("play");
      if (aiArt) void runArt(result.spec);
    } catch (e) {
      say(cleanError(e));
      setStages((list) => list.map((s) => (s.state === "run" ? { ...s, state: "fail", detail: cleanError(e) } : s)));
    } finally {
      setBuilding(false);
    }
  }

  const artCancel = useRef({ cancelled: false });
  const [artState, setArtState] = useState<{ running: boolean; done: number; total: number; note?: string }>({ running: false, done: 0, total: 0 });
  async function runArt(base: GameSpec) {
    const ids = ["hero", "enemy", "flyer", "pickup", "boss", "npc"].filter((id) => base.assets[id] && [base.player, ...base.entities].some((e) => e.sprite === id));
    artCancel.current = { cancelled: false };
    setArtState({ running: true, done: 0, total: ids.length });
    try {
      await generateArt(base, ids, (_id, next, ok, note) => {
        if (ok) setSpec((cur) => (cur && cur.meta.title === next.meta.title ? { ...cur, assets: { ...cur.assets, [_id]: next.assets[_id] } } : cur));
        setArtState((s) => ({ ...s, done: s.done + 1, note: ok ? s.note : note }));
      }, artCancel.current);
    } catch (e) {
      say(cleanError(e));
    } finally {
      setArtState((s) => ({ ...s, running: false }));
    }
  }

  // Run a game in a hidden sandboxed frame and wait for its own smoke test to report.
  const checkInSandbox = useCallback(async (s: GameSpec): Promise<{ ok: boolean; error?: string }> => {
    const b = api();
    if (!b) return { ok: true };
    const url = await b.stage(exportHtml(s, await runtime()));
    return new Promise((resolve) => {
      const f = document.createElement("iframe");
      f.name = "studio2d-play";
      f.setAttribute("sandbox", "allow-scripts");
      f.style.cssText = "position:fixed;left:-2000px;top:0;width:480px;height:272px;opacity:0;pointer-events:none";
      const done = (r: { ok: boolean; error?: string }) => {
        window.removeEventListener("message", on);
        clearTimeout(timer);
        f.remove();
        resolve(r);
      };
      const on = (e: MessageEvent) => {
        if (e.source !== f.contentWindow) return;
        const ev = e.data?.event;
        if (ev?.type === "script-check") done({ ok: !!ev.ok, error: ev.error });
      };
      const timer = window.setTimeout(() => done({ ok: false, error: "the game took too long to start (maybe an endless loop)" }), 10000);
      window.addEventListener("message", on);
      f.src = url;
      document.body.appendChild(f);
    });
  }, []);

  // ---------- samples, library, export ----------

  function loadSpec(s: GameSpec, fromDesign: DesignDoc | null = null, id = newId()) {
    setSpec(s);
    setDesign(fromDesign);
    setHistory([]);
    setGameId(id);
    setView("play");
  }
  async function onOpen() {
    const b = api();
    if (!b) return;
    const r = await b.openProject();
    if (!r.text) return;
    try {
      const { spec: s, fixes } = repairSpec(JSON.parse(r.text));
      loadSpec(s);
      say(fixes.length ? `Opened, with ${fixes.length} small repairs.` : "Opened.");
    } catch (e) {
      say(`That file is not a Beetle 2D game: ${cleanError(e)}`);
    }
  }
  async function onSave() {
    if (!spec) return;
    try {
      await api()?.save({ id: gameId, idea, design, spec });
      say("Saved to your library.");
      if (library) setLibrary(await api()!.library());
    } catch (err) {
      say(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async function onExport(kind: "html" | "project") {
    if (!spec) return;
    const code = await runtime();
    const b = api();
    if (kind === "html") {
      const html = exportHtml(spec, code);
      if (b) {
        const r = await b.exportHtml({ html, name: fileName(spec) });
        if (r.path) say(`Exported to ${r.path}`);
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        a.download = fileName(spec);
        a.click();
      }
    } else if (b) {
      const r = await b.exportProject({ files: projectFiles(spec, code), name: spec.meta.title });
      if (r.path) say(`Project saved in ${r.path}`);
    }
  }

  // ---------- edits ----------

  const commit = useCallback((next: GameSpec, summary: string, via: string) => {
    setSpec((cur) => {
      if (cur) setHistory((h) => [{ summary, before: cur, via }, ...h].slice(0, 40));
      return next;
    });
  }, []);
  const patch = useCallback((ops: PatchOp[], summary: string) => {
    if (!spec) return;
    const r = safeApply(spec, ops, summary);
    if (r.ok) commit(r.spec, summary, "hand");
    else say(r.reason);
  }, [spec, commit, say]);
  function undo() {
    const [last, ...rest] = history;
    if (!last) return;
    setSpec(last.before);
    setHistory(rest);
  }

  const online = status?.online;
  const home = useMemo(() => {
    const token = takeDirectorToken();
    return token ? `/director?token=${encodeURIComponent(token)}` : "/director";
  }, []);
  return (
    <div className="studio2d-studio">
      <header className="bb-top">
        <div className="bb-brand">
          <a className="bb-home" href={home} title="Back to Beetle 3D worlds">
            <Box size={14} />
            3D worlds
          </a>
          <Gamepad2 size={18} />
          <strong>Beetle 2D</strong>
          {spec && <span className="bb-title">{spec.meta.title}</span>}
        </div>
        <nav className="bb-tabs" role="tablist">
          {(["idea", "build", "play"] as View[]).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} disabled={v === "play" && !spec} onClick={() => setView(v)}>
              {v === "idea" ? <Sparkles size={14} /> : v === "build" ? <Hammer size={14} /> : <Play size={14} />}
              {v === "idea" ? "Idea" : v === "build" ? "Build" : "Play"}
            </button>
          ))}
        </nav>
        <div className="bb-actions">
          <span className={`bb-chip ${online ? "ok" : ""}`} title={online ? status?.models.join(", ") : "No local model: ideas are read directly"}>
            {online ? <Cpu size={13} /> : <WifiOff size={13} />}
            {online ? "Local model" : "Offline design"}
          </span>
          <button className="bb-icon" title="Open a game.json" onClick={() => void onOpen()} disabled={!api()}>
            <FolderOpen size={16} />
          </button>
          <button className="bb-icon" title="Library" onClick={async () => setLibrary(library ? null : ((await api()?.library()) ?? []))} disabled={!api()}>
            <Library size={16} />
          </button>
          <button className="bb-icon" title="Save to library" onClick={() => void onSave()} disabled={!spec || !api()}>
            <Save size={16} />
          </button>
          <button className="bb-icon" title="Export a single HTML file" onClick={() => void onExport("html")} disabled={!spec}>
            <Download size={16} />
          </button>
          <button className="bb-icon" title="Export a Beetle 2D project folder" onClick={() => void onExport("project")} disabled={!spec || !api()}>
            <Package size={16} />
          </button>
        </div>
      </header>
      {library && (
        <div className="bb-library">
          <div className="bb-library-head">
            <strong>Your games</strong>
            <button className="bb-icon" onClick={() => setLibrary(null)}>
              <X size={15} />
            </button>
          </div>
          {!library.length && <p className="bb-muted">Saved games appear here.</p>}
          {library.map((g) => (
            <div key={g.id} className="bb-library-row">
              <button
                className="bb-library-open"
                onClick={async () => {
                  const j = await api()!.load(g.id);
                  const { spec: s } = repairSpec(j.spec);
                  setIdea(j.idea ?? "");
                  loadSpec(s, j.design ?? null, g.id);
                  setLibrary(null);
                }}
              >
                <strong>{g.title}</strong>
                <span>
                  {g.genre} · {g.levels} levels · {new Date(g.savedAt).toLocaleDateString()}
                </span>
              </button>
              <button className="bb-icon" title="Delete" onClick={async () => { await api()!.remove(g.id); setLibrary(await api()!.library()); }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="bb-body">
        {view === "idea" && (
          <IdeaView
            idea={idea}
            setIdea={setIdea}
            onDesign={() => void onDesign()}
            onPlayNow={onPlayNow}
            designing={designing}
            design={design}
            setDesign={setDesign}
            note={designNote}
            onBuild={(d) => void onBuild(d)}
            building={building}
            aiArt={aiArt}
            setAiArt={setAiArt}
            imageReady={!!status?.image.ready}
            onSample={(k) => loadSpec(SAMPLES[k]())}
          />
        )}
        {view === "build" && <BuildView stages={stages} reports={reports} spec={spec} onPlay={() => setView("play")} artState={artState} />}
        {view === "play" && spec && (
          <PlayView
            spec={spec}
            history={history}
            onUndo={undo}
            onCommit={commit}
            onPatch={patch}
            say={say}
            artState={artState}
            onArt={() => void runArt(spec)}
            onStopArt={() => (artCancel.current.cancelled = true)}
            imageReady={!!status?.image.ready}
            check={checkInSandbox}
          />
        )}
      </div>
      {toast && !notify && <div className="bb-toast">{toast}</div>}
    </div>
  );
}

// ---------------- Idea ----------------

function IdeaView(p: {
  idea: string; setIdea: (s: string) => void; onDesign: () => void; onPlayNow: () => void; designing: boolean; design: DesignDoc | null; setDesign: (d: DesignDoc) => void; note: string;
  onBuild: (d: DesignDoc) => void; building: boolean; aiArt: boolean; setAiArt: (b: boolean) => void; imageReady: boolean; onSample: (k: string) => void;
}) {
  const d = p.design;
  const designRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // Bring a freshly written design into view (a new note means a new design).
    if (p.note) designRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [p.note]);
  const set = (patch: Partial<DesignDoc>) => d && p.setDesign({ ...d, ...patch });
  const setArt = (patch: Partial<DesignDoc["art"]>) => d && p.setDesign({ ...d, art: { ...d.art, ...patch } });
  const setTuning = (patch: Partial<DesignDoc["tuning"]>) => d && p.setDesign({ ...d, tuning: { ...d.tuning, ...patch } });
  return (
    <div className="bb-idea">
      <section className="bb-card bb-prompt">
        <span className="eyebrow">DESCRIBE YOUR GAME</span>
        <h1>What should we make?</h1>
        <textarea
          value={p.idea}
          placeholder="A fox who collects glowing seeds in a rainy forest, with moving platforms and a boss at the end"
          onChange={(e) => p.setIdea(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) p.onDesign();
          }}
          rows={3}
        />
        <div className="bb-row">
          <button className="primary-button" disabled={!p.idea.trim() || p.designing} onClick={p.onDesign}>
            {p.designing ? <LoaderCircle size={15} className="spin" /> : <Wand2 size={15} />}
            {p.designing ? "Designing…" : "Design it"}
          </button>
          <button className="secondary-button" disabled={!p.idea.trim() || p.building} onClick={p.onPlayNow} title="Skip the design doc and build straight from your idea">
            <Play size={15} /> Play now
          </button>
          <span className="bb-muted">Everything is made on this Mac. Nothing is downloaded.</span>
        </div>
        <div className="bb-examples">
          {EXAMPLES.map((x) => (
            <button key={x} onClick={() => p.setIdea(x)}>
              {x}
            </button>
          ))}
        </div>
        <div className="bb-samples">
          <span className="bb-muted">Or play a sample:</span>
          {Object.keys(SAMPLES).map((k) => (
            <button key={k} onClick={() => p.onSample(k)}>
              <Play size={12} /> {SAMPLE_LABELS[k]} <em>{k}</em>
            </button>
          ))}
        </div>
      </section>
      {d && (
        <section className="bb-card bb-design" ref={designRef}>
          <div className="bb-design-head">
            <div>
              <span className="eyebrow">DESIGN DOC</span>
              <input className="bb-h2" value={d.title} onChange={(e) => set({ title: e.target.value.slice(0, 60) })} aria-label="Title" />
            </div>
            <p className="bb-muted">{p.note}</p>
          </div>
          <label className="bb-field wide">
            <span>Pitch</span>
            <textarea rows={2} value={d.pitch} onChange={(e) => set({ pitch: e.target.value.slice(0, 300) })} />
          </label>
          <div className="bb-grid">
            <label className="bb-field">
              <span>Genre</span>
              <select value={d.genre} onChange={(e) => set({ genre: e.target.value as Genre })}>
                {GENRES.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label className="bb-field">
              <span>Difficulty</span>
              <input type="range" min={0} max={1} step={0.05} value={d.difficulty} onChange={(e) => set({ difficulty: Number(e.target.value) })} />
            </label>
            <label className="bb-field check">
              <input type="checkbox" checked={d.boss} onChange={(e) => set({ boss: e.target.checked })} />
              <span>Boss at the end</span>
            </label>
          </div>
          <label className="bb-field wide">
            <span>Core loop</span>
            <input value={d.coreLoop} onChange={(e) => set({ coreLoop: e.target.value.slice(0, 300) })} />
          </label>
          <div className="bb-field wide">
            <span>Mechanics</span>
            <div className="bb-tags">
              {d.mechanics.map((m, i) => (
                <span key={i} className="bb-tag">
                  {m}
                  <button aria-label={`Remove ${m}`} onClick={() => set({ mechanics: d.mechanics.filter((_, j) => j !== i) })}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div className="bb-field wide">
            <span>Levels</span>
            <ol className="bb-levels">
              {d.levels.map((l, i) => (
                <li key={i}>
                  <input value={l.name} onChange={(e) => set({ levels: d.levels.map((x, j) => (j === i ? { ...x, name: e.target.value.slice(0, 40) } : x)) })} />
                  <input value={l.story} placeholder="Story beat" onChange={(e) => set({ levels: d.levels.map((x, j) => (j === i ? { ...x, story: e.target.value.slice(0, 160) } : x)) })} />
                  <button className="bb-icon" disabled={d.levels.length <= 1} onClick={() => set({ levels: d.levels.filter((_, j) => j !== i) })} aria-label="Remove level">
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ol>
            {d.levels.length < 5 && (
              <button className="secondary-button bb-small" onClick={() => set({ levels: [...d.levels, { name: `Level ${d.levels.length + 1}`, story: "" }] })}>
                Add a level
              </button>
            )}
          </div>
          <div className="bb-grid">
            {(["hero", "enemy", "pickup", "setting"] as const).map((k) => (
              <label key={k} className="bb-field">
                <span>{k === "pickup" ? "Collectible" : k[0].toUpperCase() + k.slice(1)}</span>
                <input value={d.art[k]} onChange={(e) => setArt({ [k]: e.target.value.slice(0, 30) })} />
              </label>
            ))}
            <label className="bb-field">
              <span>Palette</span>
              <select value={d.art.palette} onChange={(e) => setArt({ palette: e.target.value })}>
                {Object.keys(PALETTES).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className="bb-field">
              <span>Art style</span>
              <select value={d.art.style} onChange={(e) => setArt({ style: e.target.value as ArtStyle })}>
                {ART_STYLES.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className="bb-field">
              <span>Weather</span>
              <select value={d.art.weather} onChange={(e) => setArt({ weather: e.target.value as Weather })}>
                {WEATHERS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className="bb-field">
              <span>Lives</span>
              <input type="number" min={1} max={5} value={d.tuning.lives} onChange={(e) => setTuning({ lives: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })} />
            </label>
          </div>
          <div className="bb-palette">
            {(PALETTES[d.art.palette] ?? []).map((c) => (
              <i key={c} style={{ background: c }} />
            ))}
          </div>
          <div className="bb-row bb-build-row">
            <label className="bb-field check" title={p.imageReady ? "Characters and items are painted by the image model after the game is playable." : "Generated art is not available here; procedural art is used."}>
              <input type="checkbox" checked={p.aiArt} disabled={!p.imageReady} onChange={(e) => p.setAiArt(e.target.checked)} />
              <span>
                <ImageIcon size={13} /> Generate art with the image model {p.imageReady ? "(slower, off by default)" : "(no image model installed)"}
              </span>
            </label>
            <button className="primary-button" disabled={p.building} onClick={() => p.onBuild(d)}>
              {p.building ? <LoaderCircle size={15} className="spin" /> : <Hammer size={15} />}
              Build the game
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------- Build ----------------

function BuildView({ stages, reports, spec, onPlay, artState }: { stages: Stage[]; reports: LevelReport[]; spec: GameSpec | null; onPlay: () => void; artState: { running: boolean; done: number; total: number } }) {
  const thumbs = useMemo(() => {
    if (!spec) return [];
    const b = buildAssets(spec);
    return Object.entries(b.sprites)
      .filter(([id]) => [spec.player, ...spec.entities].some((e) => e.sprite === id))
      .map(([id, s]) => ({ id, url: pixelsUrl(s.frames.idle![0], 3), source: spec.assets[id]?.source }));
  }, [spec]);
  return (
    <div className="bb-build">
      <section className="bb-card">
        <span className="eyebrow">BUILDING</span>
        <ol className="bb-stages">
          {stages.map((s) => (
            <li key={s.id} className={`st-${s.state}`}>
              <span className="bb-stage-icon">
                {s.state === "done" ? <Check size={14} /> : s.state === "fail" ? <X size={14} /> : s.state === "run" ? <LoaderCircle size={14} className="spin" /> : <Circle size={10} />}
              </span>
              <span className="bb-stage-label">{s.label}</span>
              <span className="bb-stage-detail">{s.detail}</span>
              <span className="bb-stage-ms">{s.ms != null ? `${(s.ms / 1000).toFixed(1)} s` : ""}</span>
            </li>
          ))}
        </ol>
        {!!reports.length && (
          <div className="bb-reports">
            {reports.map((r, i) => (
              <div key={r.id} className={r.passed ? "ok" : "bad"}>
                <strong>{spec?.levels[i]?.name ?? r.id}</strong>
                <span>{r.passed ? `Bot finished it${r.attempts > 1 ? ` after ${r.attempts - 1} repair${r.attempts > 2 ? "s" : ""}` : " first try"}${r.frames ? ` in ${(r.frames / 60).toFixed(1)} s of play` : ""}` : r.reason}</span>
                <span className="bb-muted">threat {r.budget.cost}/{r.budget.limit}</span>
              </div>
            ))}
          </div>
        )}
        {spec && (
          <button className="primary-button" onClick={onPlay}>
            <Play size={15} /> Play {spec.meta.title}
          </button>
        )}
      </section>
      {!!thumbs.length && (
        <section className="bb-card">
          <span className="eyebrow">ART {artState.running ? `· PAINTING ${artState.done}/${artState.total}` : ""}</span>
          <div className="bb-thumbs">
            {thumbs.map((t) => (
              <figure key={t.id}>
                <img src={t.url} alt={t.id} />
                <figcaption>
                  {t.id}
                  {t.source === "generated" ? " ✦" : ""}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------- Play ----------------

function PlayView(p: {
  spec: GameSpec; history: Change[]; onUndo: () => void; onCommit: (s: GameSpec, summary: string, via: string) => void; onPatch: (ops: PatchOp[], summary: string) => void;
  say: (m: string) => void; artState: { running: boolean; done: number; total: number; note?: string }; onArt: () => void; onStopArt: () => void; imageReady: boolean;
  check: (s: GameSpec) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { spec } = p;
  const frame = useRef<HTMLIFrameElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const local = useRef<Studio2DPlayer | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [fps, setFps] = useState<{ fps: number; stepMs: number; entities: number } | null>(null);
  const [level, setLevel] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"change" | "tune" | "level" | "code" | "spec">("change");
  const scripted = !!spec.script;
  const [bug, setBug] = useState("");
  const first = useRef(spec);
  const lastSent = useRef(spec);
  const embedded = !!api();

  // Start the player once per game (a new title means a new game).
  useEffect(() => {
    first.current = spec;
    lastSent.current = spec;
    setBug("");
    let cancelled = false;
    if (embedded) {
      void runtime().then(async (code) => {
        const url = await api()!.stage(exportHtml(spec, code));
        if (!cancelled) setSrc(url);
      });
    } else if (canvas.current) {
      local.current?.destroy();
      local.current = new Studio2DPlayer(canvas.current, spec, { streamer: makeStreamer(spec), skipTitle: true, onEvent: (e) => e.type === "stats" && setFps(e) });
      local.current.start();
    }
    return () => {
      cancelled = true;
      local.current?.destroy();
      local.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.meta.title, spec.meta.genre, embedded, spec.script?.code]);

  // Live updates: every later spec change is sent to the running game.
  useEffect(() => {
    if (spec === lastSent.current) return;
    lastSent.current = spec;
    if (spec.script) return; // a scripted game reloads with its new code instead
    if (embedded) frame.current?.contentWindow?.postMessage({ type: "studio2d:spec", spec, keep: true }, "*");
    else local.current?.setSpec(spec);
  }, [spec, embedded]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const ev = e.data?.event;
      if (!ev) return;
      if (ev.type === "stats") setFps(ev);
      if (ev.type === "script-check") setBug(ev.ok ? "" : ev.error || "The game stopped with an error.");
      if (ev.type === "level-start") setLevel(ev.level);
      if (ev.type === "ready" && lastSent.current !== first.current) frame.current?.contentWindow?.postMessage({ type: "studio2d:spec", spec: lastSent.current, keep: false }, "*");
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);

  const gotoLevel = (i: number) => {
    setLevel(i);
    if (embedded) frame.current?.contentWindow?.postMessage({ type: "studio2d:level", level: i }, "*");
    else local.current?.startLevel(i);
  };
  const focusGame = () => {
    frame.current?.focus();
    frame.current?.contentWindow?.postMessage({ type: "studio2d:focus" }, "*");
    canvas.current?.focus();
  };

  async function onChange(t = text) {
    const req = t.trim();
    if (!req) return;
    setBusy(true);
    try {
      const r = spec.script ? { ...(await changeScriptInWords(spec, req, p.check)), via: "model" } : await changeInWords(spec, req);
      if (r.ok) {
        p.onCommit(r.spec, r.summary, r.via);
        p.say(r.summary);
        setText("");
      } else p.say(r.reason);
    } finally {
      setBusy(false);
      focusGame();
    }
  }

  return (
    <div className="bb-play">
      <div className="bb-stage">
        {embedded ? (
          src ? <iframe ref={frame} name="studio2d-play" title={spec.meta.title} src={src} sandbox="allow-scripts" allow="gamepad; autoplay" onLoad={focusGame} /> : <div className="bb-loading"><LoaderCircle className="spin" /></div>
        ) : (
          <canvas ref={canvas} tabIndex={0} className="bb-canvas" />
        )}
        <div className="bb-stage-bar">
          <select value={level} onChange={(e) => gotoLevel(Number(e.target.value))} aria-label="Level">
            {spec.levels.map((l, i) => (
              <option key={l.id} value={i}>
                {i + 1}. {l.name}
              </option>
            ))}
          </select>
          <button className="bb-icon" title="Restart level" onClick={() => gotoLevel(level)}>
            <RotateCcw size={15} />
          </button>
          {fps && (
            <span className="bb-muted mono">
              {fps.fps} fps · {fps.stepMs} ms/step · {fps.entities} entities
            </span>
          )}
          <span className="bb-muted">Esc pauses · F5 saves · F9 loads</span>
        </div>
      </div>
      <aside className="bb-panel">
        <nav className="bb-subtabs">
          {(scripted ? (["change", "code", "spec"] as const) : (["change", "tune", "level", "spec"] as const)).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "change" ? "Change" : t === "tune" ? "Tune" : t === "level" ? "Level" : t === "code" ? "Code" : "Spec"}
            </button>
          ))}
        </nav>
        {bug && (
          <div className="bb-bug">
            <strong>The game hit a bug</strong>
            <span className="mono">{bug}</span>
            <button
              className="secondary-button bb-small"
              disabled={busy}
              onClick={() => void onChange(`Fix this bug: ${bug}`)}
            >
              Ask the model to fix it
            </button>
          </div>
        )}
        {tab === "change" && (
          <div className="bb-change">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void onChange();
              }}
            >
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Make the boss slower, add a double jump, more rain…" />
              <button className="primary-button" disabled={busy || !text.trim()}>
                {busy ? <LoaderCircle size={14} className="spin" /> : <ChevronRight size={14} />}
              </button>
            </form>
            <div className="bb-quick">
              {(scripted
                ? ["Make it faster", "Make it easier", "Add more enemies", "Change the colours"]
                : QUICK_BY_GENRE[spec.meta.genre] ?? QUICK
              ).map((q) => (
                <button key={q} onClick={() => void onChange(q)} disabled={busy}>
                  {q}
                </button>
              ))}
            </div>
            <div className="bb-history">
              <div className="bb-history-head">
                <strong>Changes</strong>
                <button className="bb-icon" title="Undo" disabled={!p.history.length} onClick={p.onUndo}>
                  <Undo2 size={15} />
                </button>
              </div>
              {!p.history.length && <p className="bb-muted">Every change is a small, checked edit to the Game Spec. Undo any time.</p>}
              {p.history.map((h, i) => (
                <div key={i} className="bb-history-row">
                  <span>{h.summary}</span>
                  <em>{h.via}</em>
                </div>
              ))}
            </div>
            <div className="bb-artbox">
              <strong>
                <ImageIcon size={14} /> Art
              </strong>
              {p.artState.running ? (
                <>
                  <span className="bb-muted">
                    Painting {p.artState.done}/{p.artState.total} with the image model…
                  </span>
                  <button className="secondary-button bb-small" onClick={p.onStopArt}>
                    Stop
                  </button>
                </>
              ) : (
                <>
                  <span className="bb-muted">{p.imageReady ? "Procedural pixel art now. Generated art is optional and runs one image at a time." : "Procedural pixel art, generated on this machine."}</span>
                  <button className="secondary-button bb-small" disabled={!p.imageReady} onClick={p.onArt}>
                    Generate art
                  </button>
                </>
              )}
              {p.artState.note && <span className="bb-muted">{p.artState.note}</span>}
            </div>
          </div>
        )}
        {tab === "tune" && <TunePanel spec={spec} onPatch={p.onPatch} />}
        {tab === "level" && <LevelEditor spec={spec} level={level} onPatch={p.onPatch} say={p.say} />}
        {tab === "code" && scripted && <CodePanel spec={spec} onCommit={p.onCommit} say={p.say} check={p.check} />}
        {tab === "spec" && <SpecPanel spec={spec} onCommit={p.onCommit} say={p.say} />}
      </aside>
    </div>
  );
}

// Sliders and pickers; each change is a patch.
type LibraryAsset = { id: string; recipe: string; kind: string; data: string; from: string };

function TunePanel({ spec, onPatch }: { spec: GameSpec; onPatch: (ops: PatchOp[], summary: string) => void }) {
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  useEffect(() => {
    void api()?.assets().then(setLibrary).catch(() => {});
  }, []);
  const pc = spec.player.behaviors.find((b) => b.type === "platformer-controller");
  const tc = spec.player.behaviors.find((b) => b.type === "top-down-controller");
  const ctrl = pc ?? tc;
  const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
  const setParam = (behavior: string, name: string, v: unknown, label: string) => {
    const ops = setParamOps(spec, spec.player.id, behavior, name, v);
    if (ops) onPatch(ops, label);
  };
  const enemies = spec.entities.filter((e) => e.kind === "enemy" && e.behaviors.some((b) => b.type === "patrol" || b.type === "chase"));
  const enemySpeed = num(enemies[0]?.behaviors.find((b) => b.type === "patrol" || b.type === "chase")?.params?.speed, 2);
  const lives = spec.rules.findIndex((r) => r.type === "lives");
  const lvl = spec.levels[0];
  return (
    <div className="bb-tune">
      {pc && (
        <>
          <Slider label="Jump height" unit="tiles" min={1.5} max={7} step={0.1} value={num(pc.params?.jumpHeight, 3.4)} onChange={(v) => setParam("platformer-controller", "jumpHeight", v, `Jump height ${v}`)} />
          <label className="bb-field check">
            <input type="checkbox" checked={!!pc.params?.doubleJump} onChange={(e) => setParam("platformer-controller", "doubleJump", e.target.checked, e.target.checked ? "Double jump on" : "Double jump off")} />
            <span>Double jump</span>
          </label>
        </>
      )}
      {ctrl && <Slider label="Speed" unit="tiles/s" min={2} max={12} step={0.5} value={num(ctrl.params?.speed, 7)} onChange={(v) => setParam(ctrl.type, "speed", v, `Speed ${v}`)} />}
      {!!enemies.length && (
        <Slider
          label="Enemy speed"
          unit="tiles/s"
          min={0.5}
          max={6}
          step={0.1}
          value={enemySpeed}
          onChange={(v) => {
            const ops: PatchOp[] = [];
            for (const e of enemies) for (const b of ["patrol", "chase"]) ops.push(...(setParamOps(spec, e.id, b, "speed", v) ?? []));
            onPatch(ops, `Enemy speed ${v}`);
          }}
        />
      )}
      {lives >= 0 && <Slider label="Lives" min={1} max={9} step={1} value={(spec.rules[lives] as { count: number }).count} onChange={(v) => onPatch([{ op: "replace", path: `/rules/${lives}/count`, value: v }], `${v} lives`)} />}
      {lvl && (
        <>
          <label className="bb-field">
            <span>Weather (all levels)</span>
            <select value={lvl.weather ?? "none"} onChange={(e) => onPatch(spec.levels.map((_, i) => ({ op: "add" as const, path: `/levels/${i}/weather`, value: e.target.value })), `Weather: ${e.target.value}`)}>
              {WEATHERS.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </label>
          <Slider label="Weather amount" min={0} max={1} step={0.05} value={lvl.weatherAmount ?? 0.5} onChange={(v) => onPatch(spec.levels.map((_, i) => ({ op: "add" as const, path: `/levels/${i}/weatherAmount`, value: v })), `Weather ${Math.round(v * 100)}%`)} />
        </>
      )}
      <label className="bb-field">
        <span>Palette</span>
        <select value={Object.entries(PALETTES).find(([, v]) => v.join() === spec.meta.palette.join())?.[0] ?? ""} onChange={(e) => onPatch([{ op: "replace", path: "/meta/palette", value: PALETTES[e.target.value] }], `${e.target.value} colours`)}>
          <option value="" disabled>
            custom
          </option>
          {Object.keys(PALETTES).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label className="bb-field">
        <span>Art style</span>
        <select value={spec.meta.artStyle} onChange={(e) => onPatch([{ op: "replace", path: "/meta/artStyle", value: e.target.value }], `${e.target.value} art`)}>
          {ART_STYLES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <ControlsBlock spec={spec} onPatch={onPatch} />
      <div className="bb-field wide">
        <span>Sprites (what each thing looks like)</span>
        {Object.entries(spec.assets)
          .filter(([id, a]) => a.kind === "sprite" && [spec.player, ...spec.entities].some((e) => e.sprite === id))
          .slice(0, 12)
          .map(([id, a]) => (
            <RecipeRow key={id} id={id} recipe={a.recipe} generated={a.source === "generated"} library={library} onUse={(item) => onPatch([{ op: "replace", path: `/assets/${id}`, value: { ...a, source: "user", data: item.data, prompt: `from the library: ${item.recipe}` } }], `${id} uses ${item.recipe} from the library`)} onChange={(r) => {
                const { data: _drop, ...rest } = a;
                void _drop;
                onPatch([{ op: "replace", path: `/assets/${id}`, value: { ...rest, recipe: r.slice(0, 80), source: "procedural" } }], `${id} is now a ${r}`);
              }} />
          ))}
      </div>
    </div>
  );
}

function RecipeRow({ id, recipe, generated, onChange, library, onUse }: { id: string; recipe: string; generated: boolean; onChange: (r: string) => void; library: LibraryAsset[]; onUse: (a: LibraryAsset) => void }) {
  const [v, setV] = useState(recipe);
  const [picking, setPicking] = useState(false);
  useEffect(() => setV(recipe), [recipe]);
  return (
    <>
    <form
      className="bb-recipe"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim() && v !== recipe) onChange(v.trim());
      }}
    >
      <span>{id}</span>
      <input value={v} onChange={(e) => setV(e.target.value)} />
      {generated && <em title="Generated art">✦</em>}
      <button className="bb-icon" title="Redraw" disabled={!v.trim() || v === recipe}>
        <Pencil size={13} />
      </button>
      <button type="button" className="bb-icon" title="Use art from your asset library" disabled={!library.length} onClick={() => setPicking((x) => !x)}>
        <Library size={13} />
      </button>
    </form>
    {picking && (
      <div className="bb-picker">
        {library.map((a) => (
          <button key={a.id} title={`${a.recipe} · from ${a.from}`} onClick={() => { onUse(a); setPicking(false); }}>
            <img src={a.data} alt={a.recipe} />
          </button>
        ))}
      </div>
    )}
    </>
  );
}

// Remappable controls: each action's keys, as a comma-separated list.
function ControlsBlock({ spec, onPatch }: { spec: GameSpec; onPatch: (ops: PatchOp[], summary: string) => void }) {
  const actions = (["left", "right", "up", "down", "jump", "action", "pause"] as const).filter((a) => spec.controls[a].length || a === "jump" || a === "action");
  return (
    <details className="bb-controls">
      <summary>Controls</summary>
      {actions.map((a) => (
        <KeyRow key={a} action={a} keys={spec.controls[a]} onChange={(keys) => onPatch([{ op: "replace", path: `/controls/${a}`, value: keys }], `${a} is now ${keys.filter((k) => !k.startsWith("pad:")).join(", ") || "unbound"}`)} />
      ))}
    </details>
  );
}
function KeyRow({ action, keys, onChange }: { action: string; keys: string[]; onChange: (k: string[]) => void }) {
  const [listening, setListening] = useState(false);
  const pads = keys.filter((k) => k.startsWith("pad:"));
  const board = keys.filter((k) => !k.startsWith("pad:"));
  return (
    <div className="bb-keyrow">
      <span>{action}</span>
      <span className="mono">{board.map((k) => k.replace(/^Key|^Arrow|^Digit/, "")).join(" ") || "—"}</span>
      <button
        className="secondary-button bb-small"
        onKeyDown={(e) => {
          if (!listening) return;
          e.preventDefault();
          setListening(false);
          if (e.code === "Escape") return;
          onChange([e.code, ...board.filter((k) => k !== e.code).slice(0, 2), ...pads]);
        }}
        onBlur={() => setListening(false)}
        onClick={() => setListening(true)}
      >
        {listening ? "Press a key…" : "Set"}
      </button>
    </div>
  );
}

function Slider({ label, unit, min, max, step, value, onChange }: { label: string; unit?: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="bb-field">
      <span>
        {label} <b>{v}</b> {unit}
      </span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))} onPointerUp={() => v !== value && onChange(v)} onKeyUp={() => v !== value && onChange(v)} />
    </label>
  );
}

// ---------------- Level editor ----------------

const TILE_COLORS: Record<string, string> = { ".": "transparent", "#": "#7a5232", "=": "#c9a26a", "^": "#c8ccd6", "~": "#3c8cd2", B: "#d68a45", W: "#5a5f72" };
const TILE_NAMES: Record<string, string> = { "#": "Ground", "=": "Ledge", "^": "Spikes", "~": "Water", B: "Breakable", W: "Wall", ".": "Erase" };

function LevelEditor({ spec, level, onPatch, say }: { spec: GameSpec; level: number; onPatch: (ops: PatchOp[], summary: string) => void; say: (m: string) => void }) {
  const lvl = spec.levels[level];
  const [rows, setRows] = useState<string[]>(lvl?.tiles ?? []);
  const [places, setPlaces] = useState(lvl?.placements ?? []);
  const [brush, setBrush] = useState<string>("#");
  const [mode, setMode] = useState<"tiles" | "things">("tiles");
  const [thing, setThing] = useState<string>(spec.entities[0]?.id ?? "");
  const [check, setCheck] = useState<string>("");
  const cv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ index: number } | null>(null);
  const painting = useRef(false);
  useEffect(() => {
    setRows(lvl?.tiles ?? []);
    setPlaces(lvl?.placements ?? []);
    setCheck("");
  }, [lvl]);
  const [w, h] = lvl?.size ?? [0, 0];
  const cell = Math.max(4, Math.min(14, Math.floor(300 / Math.max(1, h)), Math.floor(1400 / Math.max(1, w))));
  useEffect(() => {
    const c = cv.current;
    if (!c || !lvl) return;
    c.width = w * cell;
    c.height = h * cell;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = spec.meta.palette[0] ?? "#111";
    ctx.fillRect(0, 0, c.width, c.height);
    rows.forEach((r, y) => [...r].forEach((ch, x) => {
      if (ch === ".") return;
      ctx.fillStyle = TILE_COLORS[ch] ?? "#888";
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }));
    for (const pl of places) {
      const def = spec.entities.find((e) => e.id === pl.def);
      ctx.fillStyle = def?.kind === "enemy" ? "#ff5c6b" : def?.kind === "pickup" ? "#ffd35c" : def?.kind === "goal" ? "#5cf2a6" : "#9fb4ff";
      ctx.beginPath();
      ctx.arc((pl.x + 0.5) * cell, (pl.y + 0.5) * cell, cell * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(lvl.spawn[0] * cell + cell * 0.25, lvl.spawn[1] * cell, cell * 0.5, cell);
  }, [rows, places, cell, w, h, lvl, spec]);
  if (!lvl) return null;
  const at = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) / r.width) * w), Math.floor(((e.clientY - r.top) / r.height) * h)] as const;
  };
  const paint = (x: number, y: number, ch: string) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    setRows((rs) => rs.map((r, yy) => (yy === y ? r.slice(0, x) + ch + r.slice(x + 1) : r)));
  };
  const dirty = rows.join() !== lvl.tiles.join() || JSON.stringify(places) !== JSON.stringify(lvl.placements);
  const apply = () => {
    onPatch([{ op: "replace", path: `/levels/${level}/tiles`, value: rows }, { op: "replace", path: `/levels/${level}/placements`, value: places }], `Edited ${lvl.name}`);
  };
  const verify = () => {
    const trial = { ...spec, levels: spec.levels.map((l, i) => (i === level ? { ...l, tiles: rows, placements: places } : l)) };
    const v = validateSpec(trial);
    if (!v.ok) return setCheck(v.errors[0]);
    const side = spec.meta.genre === "platformer" || spec.meta.genre === "runner";
    const reach = side ? reachableSide(trial, trial.levels[level]) : spec.meta.genre === "top-down" ? reachableTop(trial.levels[level]) : { ok: true, missing: [] as string[] };
    if (!reach.ok) return setCheck(`Can't reach: ${reach.missing.join(", ")}`);
    const bot = playtest({ ...trial, levels: [trial.levels[level]] }, 0, { streamer: makeStreamer(trial) });
    setCheck(bot.passed ? `The bot finished it in ${(bot.frames / 60).toFixed(1)} s.` : `The bot could not finish: ${bot.reason}`);
    if (!bot.passed) say("The bot could not finish this level yet.");
  };
  return (
    <div className="bb-editor">
      <div className="bb-row">
        <button className={`secondary-button bb-small ${mode === "tiles" ? "on" : ""}`} onClick={() => setMode("tiles")}>
          Tiles
        </button>
        <button className={`secondary-button bb-small ${mode === "things" ? "on" : ""}`} onClick={() => setMode("things")}>
          Things
        </button>
      </div>
      {mode === "tiles" ? (
        <div className="bb-brushes">
          {Object.keys(TILE_NAMES).map((k) => (
            <button key={k} className={brush === k ? "on" : ""} onClick={() => setBrush(k)}>
              <i style={{ background: TILE_COLORS[k] === "transparent" ? "none" : TILE_COLORS[k] }} />
              {TILE_NAMES[k]}
            </button>
          ))}
        </div>
      ) : (
        <label className="bb-field">
          <span>Click to add, drag to move, right-click to remove</span>
          <select value={thing} onChange={(e) => setThing(e.target.value)}>
            {spec.entities.filter((e) => !e.id.startsWith("__")).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name ?? e.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="bb-editor-canvas">
        <canvas
          ref={cv}
          style={{ width: w * cell, height: h * cell }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            const [x, y] = at(e);
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            if (mode === "tiles") {
              painting.current = true;
              paint(x, y, e.button === 2 ? "." : brush);
              return;
            }
            const hit = places.findIndex((q) => Math.floor(q.x) === x && Math.floor(q.y) === y);
            if (e.button === 2) {
              if (hit >= 0) setPlaces((ps) => ps.filter((_, i) => i !== hit));
            } else if (hit >= 0) drag.current = { index: hit };
            else if (thing) setPlaces((ps) => [...ps, { def: thing, x, y }]);
          }}
          onPointerMove={(e) => {
            const [x, y] = at(e);
            if (mode === "tiles" && painting.current) paint(x, y, e.buttons === 2 ? "." : brush);
            if (drag.current) setPlaces((ps) => ps.map((q, i) => (i === drag.current!.index ? { ...q, x, y } : q)));
          }}
          onPointerUp={() => {
            painting.current = false;
            drag.current = null;
          }}
        />
      </div>
      <div className="bb-row">
        <button className="primary-button bb-small" disabled={!dirty} onClick={apply}>
          Apply
        </button>
        <button className="secondary-button bb-small" disabled={!dirty} onClick={() => { setRows(lvl.tiles); setPlaces(lvl.placements); }}>
          Reset
        </button>
        <button className="secondary-button bb-small" onClick={verify}>
          Playtest
        </button>
      </div>
      {check && <p className="bb-muted">{check}</p>}
    </div>
  );
}

// A scripted game's code, editable by hand. Changes are checked before they apply.
function CodePanel({ spec, onCommit, say, check }: { spec: GameSpec; onCommit: (s: GameSpec, summary: string, via: string) => void; say: (m: string) => void; check: (s: GameSpec) => Promise<{ ok: boolean; error?: string }> }) {
  const code = spec.script?.code ?? "";
  const [text, setText] = useState(code);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(code), [code]);
  return (
    <div className="bb-spec">
      <p className="bb-muted">
        <FileJson size={13} /> This game is written in Beetle 2D Script{spec.script?.model ? ` by ${spec.script.model}` : ""}. It runs sandboxed, with no network.
      </p>
      <textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      <button
        className="primary-button bb-small"
        disabled={text === code || busy}
        onClick={async () => {
          const problems = checkScript(text);
          if (problems.length) return say(problems[0]);
          setBusy(true);
          const next: GameSpec = { ...spec, script: { ...spec.script!, code: text } };
          const r = await check(next);
          setBusy(false);
          if (!r.ok) return say(`Not applied: ${r.error}`);
          onCommit(next, "Edited the code", "hand");
        }}
      >
        {busy ? "Checking…" : "Apply"}
      </button>
    </div>
  );
}

// The Game Spec itself, editable as JSON.
function SpecPanel({ spec, onCommit, say }: { spec: GameSpec; onCommit: (s: GameSpec, summary: string, via: string) => void; say: (m: string) => void }) {
  const light = useMemo(() => {
    const s = structuredClone(spec);
    for (const a of Object.values(s.assets)) if (a.data) a.data = `${a.data.slice(0, 40)}…`;
    return JSON.stringify(s, null, 2);
  }, [spec]);
  const [text, setText] = useState(light);
  useEffect(() => setText(light), [light]);
  return (
    <div className="bb-spec">
      <p className="bb-muted">
        <FileJson size={13} /> The whole game is this document. Edit it and apply; it is validated first.
      </p>
      <textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      <button
        className="primary-button bb-small"
        disabled={text === light}
        onClick={() => {
          try {
            const parsed = JSON.parse(text);
            // Keep generated art that was shortened for display.
            for (const [id, a] of Object.entries<any>(parsed.assets ?? {})) if (typeof a.data === "string" && a.data.endsWith("…")) a.data = spec.assets[id]?.data;
            const v = validateSpec(parsed);
            if (!v.ok) return say(v.errors.slice(0, 2).join("; "));
            onCommit(applyPatch(parsed, []), "Edited the spec", "hand");
          } catch (e) {
            say(cleanError(e));
          }
        }}
      >
        Apply
      </button>
    </div>
  );
}

void designFromIdea;
