// The browser side of Beetle 2D's host API, installed at window.studio2d. The local model
// runs behind the Beetle server (/api/2d/*); everything else (sandbox staging, downloads,
// opening files, the game and asset library) is done in the page itself.
import type { Studio2DApi } from "./gen/ai.ts";
import { takeDirectorToken } from "../shared/token.ts";

declare global {
  interface Window {
    studio2d?: Studio2DApi;
  }
}

const ART_UNAVAILABLE = "Generated art is not available; procedural art is used.";
const OFFLINE = "The local model is not reachable. Is the Beetle server running on this machine?";

// ---------- server calls ----------

type Json = Record<string, unknown>;

async function call(path: string, body?: Json, signal?: AbortSignal): Promise<Json> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  const token = takeDirectorToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal, credentials: "same-origin" });
  let data: Json = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") data = parsed as Json;
  } catch {
    /* not JSON */
  }
  if (!res.ok && data.ok !== false) {
    const reason = res.status === 401 || res.status === 403 ? "Not authorised: open this page from the Beetle director link." : res.status === 404 ? OFFLINE : `The server answered ${res.status}.`;
    return { ok: false, error: typeof data.error === "string" ? data.error : reason };
  }
  return data;
}

const errText = (e: unknown) => (e instanceof DOMException && e.name === "AbortError" ? "Cancelled." : e instanceof TypeError ? OFFLINE : String((e as Error)?.message || e));
const asStr = (v: unknown) => (typeof v === "string" ? v : undefined);

const inflight = new Map<string, AbortController>();
let seq = 0;

const status: Studio2DApi["status"] = async () => {
  const image = { ready: false, detail: ART_UNAVAILABLE };
  try {
    const r = await call("/api/2d/status");
    const models = Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === "string") : [];
    return { online: r.online === true, models, image };
  } catch {
    return { online: false, models: [], image };
  }
};

const warm: Studio2DApi["warm"] = async () => {
  try {
    const r = await call("/api/2d/warm", {});
    return r.ok === true ? { ok: true, model: asStr(r.model) } : { ok: false, error: asStr(r.error) || "The model did not load." };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
};

const llm: Studio2DApi["llm"] = async (p) => {
  const id = p.id || `llm-${Date.now().toString(36)}-${++seq}`;
  inflight.get(id)?.abort();
  const ctl = new AbortController();
  inflight.set(id, ctl);
  // The server keeps its own limits; this only stops waiting on a stuck connection.
  let timedOut = false;
  const timer = p.timeoutMs ? window.setTimeout(() => { timedOut = true; ctl.abort(); }, p.timeoutMs + 15000) : 0;
  try {
    const r = await call("/api/2d/llm", { id, system: p.system, prompt: p.prompt, schema: p.schema, temperature: p.temperature, maxTokens: p.maxTokens, numCtx: p.numCtx }, ctl.signal);
    if (r.ok !== true) return { ok: false, error: asStr(r.error) || "The model did not answer." };
    return { ok: true, json: r.json, model: asStr(r.model), ms: typeof r.ms === "number" ? r.ms : undefined };
  } catch (e) {
    return { ok: false, error: timedOut ? "The model took too long to answer." : errText(e) };
  } finally {
    if (timer) clearTimeout(timer);
    if (inflight.get(id) === ctl) inflight.delete(id);
  }
};

const cancel: Studio2DApi["cancel"] = async (id) => {
  const ctl = inflight.get(id);
  inflight.delete(id);
  ctl?.abort();
  try {
    await call("/api/2d/cancel", { id });
  } catch {
    /* nothing to cancel */
  }
};

// ---------- sandbox staging ----------

// Games run in <iframe sandbox="allow-scripts"> from a blob: URL, so they get an opaque
// origin and talk to the page only through postMessage. The newest few URLs stay alive.
const staged: string[] = [];
const stage: Studio2DApi["stage"] = async (html) => {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  staged.push(url);
  while (staged.length > 8) URL.revokeObjectURL(staged.shift()!);
  return url;
};

// ---------- downloads and files ----------

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const safeName = (s: string, fallback: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").trim().slice(0, 80) || fallback;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "game";

// A minimal stored (uncompressed) zip, enough to hand a project folder over as one download.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, string>): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // utf-8 names
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint16(12, time, true);
    head.setUint16(14, date, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, data.length, true);
    head.setUint32(24, data.length, true);
    head.setUint16(28, n.length, true);
    head.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), n, data);
    central.push(new Uint8Array(head.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: "application/zip" });
}

const exportHtml: Studio2DApi["exportHtml"] = async ({ html, name }) => {
  const base = safeName(name, "Beetle 2D game");
  const file = /\.html?$/i.test(base) ? base : `${base}.html`;
  download(file, new Blob([html], { type: "text/html" }));
  return { ok: true, path: file };
};

const exportProject: Studio2DApi["exportProject"] = async ({ files, name }) => {
  const folder = slug(name);
  const entries: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) entries[`${folder}/${k.replace(/^[/\\]+|\.\.[/\\]/g, "")}`] = String(v);
  const file = `${folder}.zip`;
  download(file, zip(entries));
  return { ok: true, path: file };
};

const MAX_OPEN = 20 * 1024 * 1024;
const openProject: Studio2DApi["openProject"] = () =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    let settled = false;
    const finish = (r: { text?: string; canceled?: boolean }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(r);
    };
    // Older browsers have no cancel event: when focus returns with no file, it was cancelled.
    const onFocus = () => setTimeout(() => { if (!input.files?.length) finish({ canceled: true }); }, 1000);
    input.addEventListener("cancel", () => finish({ canceled: true }));
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      if (!f || f.size > MAX_OPEN) return finish({ canceled: true });
      try {
        finish({ text: await f.text() });
      } catch {
        finish({ canceled: true });
      }
    });
    document.body.appendChild(input);
    window.addEventListener("focus", onFocus);
    input.click();
  });

// ---------- library (localStorage) ----------

const PREFIX = "beetle2d:";
const GAME = `${PREFIX}game:`;
const INDEX = `${PREFIX}library`;
const ASSETS = `${PREFIX}assets`;
const MAX_GAME = 4 * 1024 * 1024; // characters of one saved game
const MAX_ASSET = 512 * 1024; // characters of one asset's data URL
const MAX_ASSETS_TOTAL = 2 * 1024 * 1024;
const MAX_ASSET_COUNT = 300;

type Entry = { id: string; title: string; genre?: string; savedAt: number; levels: number };
type Saved = Parameters<Studio2DApi["save"]>[0] & { savedAt?: number };
type Asset = Awaited<ReturnType<Studio2DApi["assets"]>>[number];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function drop(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
function parse<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
const cleanId = (id: unknown) => String(id ?? "").replace(/[^\w-]/g, "").slice(0, 80);

function entryOf(id: string, g: Saved): Entry {
  return { id, title: g.spec?.meta?.title || "Untitled", genre: g.spec?.meta?.genre, savedAt: g.savedAt || 0, levels: g.spec?.levels?.length || 0 };
}

function readIndex(): Entry[] {
  const list = parse<Entry[]>(read(INDEX));
  if (Array.isArray(list)) return list.filter((e) => e && typeof e.id === "string");
  // Rebuild from the saved games when the index is missing or unreadable.
  const out: Entry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(GAME)) continue;
      const g = parse<Saved>(read(k));
      if (g?.spec) out.push(entryOf(k.slice(GAME.length), g));
    }
  } catch {
    /* storage unavailable */
  }
  return out;
}
const writeIndex = (list: Entry[]) => write(INDEX, JSON.stringify(list));

const library: Studio2DApi["library"] = async () => [...readIndex()].sort((a, b) => b.savedAt - a.savedAt);

const save: Studio2DApi["save"] = async (p) => {
  const id = cleanId(p?.id);
  if (!id) throw new Error("That game has no id to save under.");
  const g: Saved = { savedAt: Date.now(), id, idea: typeof p.idea === "string" ? p.idea : "", design: p.design ?? null, spec: p.spec };
  const text = JSON.stringify(g);
  if (text.length > MAX_GAME) throw new Error("That game is too large to save in this browser. Export it instead.");
  if (!write(GAME + id, text)) throw new Error("This browser's storage is full or blocked. Delete a saved game or export this one.");
  const list = readIndex().filter((e) => e.id !== id);
  list.unshift(entryOf(id, g));
  writeIndex(list);
  return { id };
};

const load: Studio2DApi["load"] = async (id) => {
  const g = parse<Saved>(read(GAME + cleanId(id)));
  if (!g?.spec) throw new Error("That saved game could not be found.");
  return { idea: g.idea, design: g.design ?? null, spec: g.spec };
};

const remove: Studio2DApi["remove"] = async (id) => {
  const key = cleanId(id);
  drop(GAME + key);
  writeIndex(readIndex().filter((e) => e.id !== key));
  return true;
};

const readAssets = (): Asset[] => {
  const list = parse<Asset[]>(read(ASSETS));
  return Array.isArray(list) ? list.filter((a) => a && typeof a.id === "string" && typeof a.data === "string") : [];
};

const assets: Studio2DApi["assets"] = async () => readAssets();

const saveAsset: Studio2DApi["saveAsset"] = async (a) => {
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  const id = cleanId(a?.id);
  const data = typeof a?.data === "string" ? a.data : "";
  if (!id || !data.startsWith("data:image/") || data.length > MAX_ASSET) throw new Error("That asset cannot be saved in this browser.");
  const item: Asset = { id, recipe: str(a.recipe, 120), kind: str(a.kind || "sprite", 20), data, from: str(a.from, 80), savedAt: Date.now() };
  let list = [item, ...readAssets().filter((x) => x.id !== id)].slice(0, MAX_ASSET_COUNT);
  // Oldest assets make room for new ones.
  let text = JSON.stringify(list);
  while (text.length > MAX_ASSETS_TOTAL && list.length > 1) {
    list = list.slice(0, -1);
    text = JSON.stringify(list);
  }
  while (!write(ASSETS, text)) {
    if (list.length <= 1) throw new Error("This browser's storage is full or blocked.");
    list = list.slice(0, Math.ceil(list.length / 2));
    text = JSON.stringify(list);
  }
  return { id };
};

const art: Studio2DApi["art"] = async () => ({ ok: false, error: ART_UNAVAILABLE });

export const studio2dBridge: Studio2DApi = { status, stage, warm, llm, cancel, art, exportHtml, exportProject, openProject, library, save, load, remove, assets, saveAsset };

/** Installs the bridge at window.studio2d unless a host already provided one. */
export function installStudio2DBridge(): Studio2DApi {
  if (typeof window === "undefined") return studio2dBridge;
  if (!window.studio2d) window.studio2d = studio2dBridge;
  return window.studio2d;
}

installStudio2DBridge();
