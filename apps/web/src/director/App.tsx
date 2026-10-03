import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentActivity, AgentPhase, BuildReport, CommitResult, DirectorRequest, GameMode, HelloMessage, RequestKind } from '@beetle/contracts';
import { MODE_LIMITS, STREAMING, WORLD_LIMITS } from '@beetle/contracts';
import { Box, Check, Circle, Cpu, Hammer, ListChecks, LoaderCircle, PanelRightClose, PanelRightOpen, Play, Sparkles, WifiOff, X } from 'lucide-react';
import { createDirectorRequest, createInvite, describeError, getActivity, getDirectorRequest, getHealth, getReports, setDirectorSettings, undo, type HealthInfo, type InviteResult } from '../shared/api.ts';
import { takeDirectorToken } from '../shared/token.ts';
import { useBeetleSocket } from '../shared/use-socket.ts';
import { createRenderer, type BeetleRenderer } from '../renderer/index.ts';
import { platformLinks } from '../shared/platform-header.ts';
import { qrDataUrl } from '../shared/qr.ts';
import { ActivityTrail } from './ActivityTrail.tsx';
import { useKeyboardPlayer } from './useKeyboardPlayer.ts';
import { isFixtureTitle, msLabel, stripFixture } from '../shared/format.ts';

const MODE_NAMES: Record<GameMode, string> = {
  relic_hunt: 'Relic hunt',
  time_trial: 'Time trial',
  king_of_the_hill: 'King of the hill',
  checkpoint_race: 'Checkpoint race',
  survival: 'Survival',
};
const MODE_HINTS: { mode: GameMode; what: string; example: string }[] = [
  { mode: 'relic_hunt', what: 'collect the relics, then enter the temple gate', example: 'a garden of five islands with three hidden relics and a shrine' },
  { mode: 'time_trial', what: 'the relic hunt against a countdown', example: 'a race across three islands with a 90 second limit' },
  { mode: 'king_of_the_hill', what: 'stand on the hill and hold it for the target time', example: 'king of the hill on a frozen arena, hold 10 seconds' },
  { mode: 'checkpoint_race', what: 'pass the relics in order, then reach the gate', example: 'a checkpoint race through desert ruins, relics in order' },
  { mode: 'survival', what: 'the hazard rises; stay above it until the clock runs out', example: 'survive the rising lava for two minutes' },
];
const BIOME_HINTS: { biome: string; what: string; example: string }[] = [
  { biome: 'garden', what: 'green islands, trees and lanterns', example: 'a quiet garden with a lantern path' },
  { biome: 'volcanic', what: 'black rock, lava moat, glowing cracks', example: 'a volcanic crater ringed by pillars' },
  { biome: 'frost', what: 'snow, ice and pale crystal', example: 'a frozen arena with crystal spires' },
  { biome: 'desert', what: 'sand, dunes and sun bleached ruins', example: 'desert ruins around a dry well' },
  { biome: 'night', what: 'dark sky, moonlight and glowing mushrooms', example: 'a night garden lit by mushrooms' },
];
type AutoReason = NonNullable<DirectorRequest['autoReason']>;
/** Activity entries may carry the auto flag directly once the server copies it from the request; otherwise it comes from the request cache. */
type ActivityWithAuto = AgentActivity & { auto?: boolean; autoReason?: AutoReason };
type View = 'idea' | 'build' | 'play';
type StepState = 'wait' | 'run' | 'done' | 'fail' | 'skip';
const STEPS: { phase: AgentPhase; label: string }[] = [
  { phase: 'planning', label: 'Planning' },
  { phase: 'validating', label: 'Validating' },
  { phase: 'repairing', label: 'Repairing' },
  { phase: 'awaiting_safe_commit', label: 'Awaiting safe commit' },
  { phase: 'committed', label: 'Committed' },
];
const SLOTS = [0, 1] as const;

/** "extending north of Hearth Island for Amber" */
function describeAutoReason(reason: AutoReason, islandName: (id: string) => string, playerName: (id: string) => string): string {
  return `extending ${reason.direction} of ${islandName(reason.islandId)} for ${playerName(reason.playerId)}`;
}
function modeName(kind: string | undefined): string {
  return (MODE_NAMES as Record<string, string>)[kind ?? ''] ?? MODE_NAMES.relic_hunt;
}
function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}
/** Prompt prefilled from ?prompt= (the landing page forwards it). Read once, then stripped from the URL. */
function takePromptFromUrl(): string {
  try {
    const url = new URL(location.href);
    const p = url.searchParams.get('prompt');
    if (p === null) return '';
    url.searchParams.delete('prompt');
    history.replaceState(history.state, '', url.pathname + (url.search ? url.search : '') + url.hash);
    return p.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 1000);
  } catch { return ''; }
}
// Read once at module load: StrictMode runs mount initializers twice and the URL is already stripped the second time.
const PREFILL_PROMPT = takePromptFromUrl();
const DEBUG_DEFAULT = (() => { try { return new URL(location.href).searchParams.has('debug'); } catch { return false; } })();

export function DirectorApp() {
  const token = useMemo(() => takeDirectorToken(), []);
  const hello = useCallback((): HelloMessage => (token ? { type: 'hello', role: 'director', token } : { type: 'hello', role: 'display' }), [token]);
  const view = useBeetleSocket(hello);
  const { socket, state, rttMs, world, tick, controllers } = view;

  // ---- renderer (canvas stays mounted; hidden until a world is playing) ----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BeetleRenderer | null>(null);
  const [stats, setStats] = useState({ fps: 0, tickAgeMs: null as number | null });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = createRenderer(canvas);
    rendererRef.current = r;
    (window as unknown as { __beetle?: unknown }).__beetle = { socket, renderer: r };
    if (socket.world) r.applyWorld(socket.world);
    const offs = [socket.on('world', (m) => r.applyWorld(m)), socket.on('tick', (t) => r.applyTick(t))];
    const timer = window.setInterval(() => { const s = r.stats(); setStats({ fps: s.fps, tickAgeMs: s.tickAgeMs }); }, 500);
    return () => { for (const off of offs) off(); clearInterval(timer); r.dispose(); rendererRef.current = null; };
  }, [socket]);

  // ---- panel and drawers ----
  const [open, setOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const [debug, setDebug] = useState(DEBUG_DEFAULT);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (logOpen) setLogOpen(false); else setOpen((o) => !o); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [logOpen]);

  // ---- health, activity, reports ----
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [reports, setReports] = useState<BuildReport[]>([]);
  const [seedActivity, setSeedActivity] = useState<AgentActivity[]>([]);
  const refreshReports = useCallback(() => {
    if (!token) return;
    getReports(token).then(setReports).catch(() => { /* keep the last list */ });
  }, [token]);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      getHealth().then((h) => { if (alive) { setHealth(h); setHealthError(null); } }).catch((err) => { if (alive) setHealthError(describeError(err)); });
    };
    poll();
    const t = window.setInterval(poll, 5000);
    const t2 = window.setInterval(refreshReports, 5000);
    refreshReports();
    if (token) getActivity(token, 100).then((a) => { if (alive) setSeedActivity(a); }).catch(() => { /* socket replays recent entries anyway */ });
    return () => { alive = false; clearInterval(t); clearInterval(t2); };
  }, [token, refreshReports]);

  const activity = useMemo(() => {
    const byId = new Map<string, AgentActivity>();
    for (const e of seedActivity) byId.set(e.id, e);
    for (const e of view.activity) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.at - b.at || a.elapsedMs - b.elapsedMs);
  }, [seedActivity, view.activity]);
  useEffect(() => {
    const last = activity[activity.length - 1];
    if (last && (last.phase === 'committed' || last.phase === 'failed')) refreshReports();
  }, [activity, refreshReports]);

  // ---- request cache: which requests Beetle created itself (streaming extensions) ----
  const [requestsById, setRequestsById] = useState<Record<string, DirectorRequest>>({});
  const fetchedRequests = useRef(new Set<string>());
  const rememberRequest = useCallback((r: DirectorRequest | null | undefined) => {
    if (!r || !r.id) return;
    fetchedRequests.current.add(r.id);
    setRequestsById((m) => (m[r.id] === r ? m : { ...m, [r.id]: r }));
  }, []);
  useEffect(() => {
    if (!token) return;
    for (const e of activity as ActivityWithAuto[]) {
      if (typeof e.auto === 'boolean' || fetchedRequests.current.has(e.requestId)) continue;
      fetchedRequests.current.add(e.requestId);
      getDirectorRequest(token, e.requestId).then(rememberRequest).catch(() => { fetchedRequests.current.delete(e.requestId); });
    }
  }, [activity, token, rememberRequest]);
  const trailEntries = useMemo(() => {
    const islandName = (id: string) => world?.spec.islands.find((i) => i.id === id)?.name ?? id;
    const playerName = (id: string) => controllers.find((c) => c.id === id)?.label ?? id;
    const seen = new Set<string>();
    return activity.map((raw) => {
      const e = raw as ActivityWithAuto;
      const req = requestsById[e.requestId];
      const auto = e.auto ?? req?.auto ?? false;
      if (!auto) return raw;
      const first = !seen.has(e.requestId);
      seen.add(e.requestId);
      const reason = e.autoReason ?? req?.autoReason;
      const why = first && reason ? ` (${describeAutoReason(reason, islandName, playerName)})` : '';
      return { ...raw, message: `auto · ${e.message}${why}` };
    });
  }, [activity, requestsById, world, controllers]);

  // ---- streaming generation toggle ----
  const [autoExpand, setAutoExpand] = useState(true);
  const [autoExpandState, setAutoExpandState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const serverAutoExpand = health?.autoExpand ?? null;
  useEffect(() => {
    if (serverAutoExpand !== null && !autoExpandState.busy) setAutoExpand(serverAutoExpand);
  }, [serverAutoExpand, autoExpandState.busy]);
  const toggleAutoExpand = async (next: boolean) => {
    if (!token) return;
    const previous = autoExpand;
    setAutoExpand(next);
    setAutoExpandState({ busy: true, error: null });
    try {
      const r = await setDirectorSettings(token, { autoExpand: next });
      setAutoExpand(r.autoExpand);
      setAutoExpandState({ busy: false, error: null });
    } catch (err) {
      setAutoExpand(previous);
      setAutoExpandState({ busy: false, error: describeError(err) });
    }
  };

  // ---- per request timeline (build steps, built in, changed in) ----
  const byRequest = useMemo(() => {
    const m = new Map<string, AgentActivity[]>();
    for (const e of activity) {
      const list = m.get(e.requestId) ?? [];
      list.push(e);
      m.set(e.requestId, list);
    }
    return m;
  }, [activity]);
  const durationOf = useCallback((requestId: string): number | null => {
    const report = reports.find((r) => r.requestId === requestId && r.outcome === 'committed');
    if (report && typeof report.timings?.totalMs === 'number') return report.timings.totalMs;
    const c = byRequest.get(requestId)?.find((e) => e.phase === 'committed');
    return c ? c.elapsedMs : null;
  }, [reports, byRequest]);
  const isAuto = useCallback((id: string) => {
    const e = byRequest.get(id)?.[0] as ActivityWithAuto | undefined;
    return e?.auto ?? requestsById[id]?.auto ?? false;
  }, [byRequest, requestsById]);
  /** Committed requests in order. The latest committed brief is "Built in"; later ones are changes. */
  const commits = useMemo(() => {
    const out: { id: string; at: number; kind: RequestKind | 'unknown'; ms: number | null; prompt: string; auto: boolean }[] = [];
    for (const [id, list] of byRequest) {
      const c = list.find((e) => e.phase === 'committed');
      if (!c) continue;
      const req = requestsById[id];
      out.push({ id, at: c.at, kind: req?.kind ?? 'unknown', ms: durationOf(id), prompt: req?.prompt ?? '', auto: isAuto(id) });
    }
    return out.sort((a, b) => a.at - b.at);
  }, [byRequest, requestsById, durationOf, isAuto]);
  const buildCommit = useMemo(() => {
    for (let i = commits.length - 1; i >= 0; i--) if (commits[i].kind === 'brief') return commits[i];
    return commits[0] ?? null;
  }, [commits]);
  const changes = useMemo(() => (buildCommit ? commits.filter((c) => c.at > buildCommit.at) : []), [commits, buildCommit]);

  // ---- prompt form ----
  const hasWorld = !!world;
  const [kind, setKind] = useState<RequestKind>('brief');
  useEffect(() => { setKind(hasWorld ? 'edit' : 'brief'); }, [hasWorld]);
  const [prompt, setPrompt] = useState(PREFILL_PROMPT);
  const [editPrompt, setEditPrompt] = useState('');
  const [authorize, setAuthorize] = useState(false);
  const [submitState, setSubmitState] = useState<{ busy: boolean; note: string | null; error: string | null }>({ busy: false, note: null, error: null });
  const [activeRequest, setActiveRequest] = useState<{ id: string; createdAt: number; kind: RequestKind } | null>(null);
  const playersConnected = (tick?.players.some((p) => p.connected) ?? false) || controllers.some((c) => c.connected);

  const send = async (k: RequestKind, text: string, onSent: () => void) => {
    if (!token || !text.trim()) return;
    setSubmitState({ busy: true, note: null, error: null });
    try {
      const body: { kind: RequestKind; prompt: string; authorizeNewWorld?: boolean } = { kind: k, prompt: text.trim() };
      if (k === 'brief' && playersConnected && authorize) body.authorizeNewWorld = true;
      const r = await createDirectorRequest(token, body);
      rememberRequest(r?.request);
      const id = r?.request?.id ?? 'unknown';
      if (r?.request?.id) setActiveRequest({ id: r.request.id, createdAt: r.request.createdAt ?? Date.now(), kind: k });
      setSubmitState({ busy: false, note: `Request ${id} ${r?.request?.status ?? 'queued'} (${k}, base v${r?.request?.worldVersionAtRequest ?? world?.version ?? 0})`, error: null });
      onSent();
    } catch (err) {
      setSubmitState({ busy: false, note: null, error: describeError(err) });
    }
  };
  const submitIdea = (e: React.FormEvent) => { e.preventDefault(); void send('brief', prompt, () => setTab('build')); };
  const submitEdit = (e: React.FormEvent) => { e.preventDefault(); void send(kind, editPrompt, () => setEditPrompt('')); };

  // ---- tabs: idea until something is asked, build while the agent works, play once a world commits ----
  const [tab, setTab] = useState<View>('idea');
  const tabTouched = useRef(!!PREFILL_PROMPT);
  useEffect(() => { if (hasWorld && !tabTouched.current && !activeRequest) setTab('play'); }, [hasWorld, activeRequest]);
  // After a reload, pick up a director request that is still in flight so Build keeps tracking it.
  useEffect(() => {
    if (activeRequest) return;
    const last = activity[activity.length - 1] as ActivityWithAuto | undefined;
    if (!last || Date.now() - last.at > 120_000) return;
    const list = byRequest.get(last.requestId) ?? [];
    if (list.some((e) => e.phase === 'committed' || e.phase === 'failed' || e.phase === 'cancelled')) return;
    const req = requestsById[last.requestId];
    if (last.auto ?? req?.auto) return;
    const kindOf: RequestKind = req?.kind ?? 'brief';
    setActiveRequest({ id: last.requestId, createdAt: last.at - last.elapsedMs, kind: kindOf });
    if (!hasWorld) setTab('build');
  }, [activity, activeRequest, byRequest, requestsById, hasWorld]);
  const activeEntries = useMemo(() => (activeRequest ? byRequest.get(activeRequest.id) ?? [] : []), [activeRequest, byRequest]);
  const activeDone = activeEntries.some((e) => e.phase === 'committed' || e.phase === 'failed' || e.phase === 'cancelled');
  const activeCommitted = activeEntries.some((e) => e.phase === 'committed');
  useEffect(() => {
    if (activeCommitted && activeRequest?.kind === 'brief' && hasWorld) setTab('play');
  }, [activeCommitted, activeRequest, hasWorld]);
  const chooseTab = (v: View) => { tabTouched.current = true; setTab(v); };

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const activeStart = activeEntries.length ? activeEntries[0].at - activeEntries[0].elapsedMs : activeRequest?.createdAt ?? now;
  const activeLast = activeEntries[activeEntries.length - 1];
  const activeElapsed = activeDone && activeLast ? activeLast.elapsedMs : now - activeStart;
  const steps = useMemo(() => {
    const seen = new Map<AgentPhase, AgentActivity>();
    for (const e of activeEntries) if (!seen.has(e.phase)) seen.set(e.phase, e);
    const failed = activeEntries.find((e) => e.phase === 'failed' || e.phase === 'cancelled');
    const lastPhase = activeLast?.phase;
    const reached = STEPS.map((s) => seen.has(s.phase));
    const lastReached = reached.lastIndexOf(true);
    const rows: { label: string; state: StepState; at: number | null; detail: string }[] = STEPS.map((s, i) => {
      const e = seen.get(s.phase);
      let st: StepState = 'wait';
      if (e) st = s.phase === lastPhase && !activeDone ? 'run' : 'done';
      else if (s.phase === 'repairing' && lastReached > i) st = 'skip';
      else if (i === 0 && !activeEntries.length && activeRequest && !activeDone) st = 'run';
      if (failed && st === 'run') st = 'fail';
      return { label: s.label, state: st, at: e ? e.elapsedMs : null, detail: e?.message ?? '' };
    });
    if (failed) rows.push({ label: failed.phase === 'cancelled' ? 'Cancelled' : 'Failed', state: 'fail', at: failed.elapsedMs, detail: failed.message });
    return rows.filter((r) => r.state !== 'skip');
  }, [activeEntries, activeLast, activeDone, activeRequest]);

  // ---- invites: two QR codes made right after the first commit, refreshed on expiry ----
  const [invites, setInvites] = useState<(InviteResult & { qr?: string })[]>([]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const inviteBusy = useRef(false);
  const refreshInvite = useCallback(async (slot: number): Promise<boolean> => {
    if (!token) return false;
    try {
      const r = await createInvite(token);
      if (!r || typeof r.url !== 'string') throw new Error('invite response had no url');
      const qr = await qrDataUrl(r.url).catch(() => undefined);
      setInvites((list) => { const next = [...list]; next[slot] = { ...r, qr }; return next; });
      setInviteError(null);
      return true;
    } catch (err) {
      setInviteError(describeError(err));
      return false;
    }
  }, [token]);
  useEffect(() => {
    if (!token || !hasWorld || inviteBusy.current) return;
    const due = SLOTS.filter((s) => !invites[s] || invites[s].expiresAt - now < 5000);
    if (!due.length) return;
    inviteBusy.current = true;
    (async () => { let ok = true; for (const s of due) ok = (await refreshInvite(s)) && ok; return ok; })()
      .then((ok) => { window.setTimeout(() => { inviteBusy.current = false; }, ok ? 0 : 5000); });
  }, [token, hasWorld, invites, now, refreshInvite]);

  // ---- undo ----
  const [undoState, setUndoState] = useState<{ busy: boolean; result: string | null }>({ busy: false, result: null });
  const doUndo = async () => {
    if (!token) return;
    setUndoState({ busy: true, result: null });
    try {
      const r: CommitResult = await undo(token);
      if (r && r.ok) setUndoState({ busy: false, result: `Undo committed as v${r.worldVersion}${r.deferredMs ? ` after ${Math.round(r.deferredMs)} ms deferral` : ''}` });
      else if (r) setUndoState({ busy: false, result: `Undo refused: ${r.code}. ${r.message}${r.objectIds?.length ? ` (${r.objectIds.join(', ')})` : ''}` });
      else setUndoState({ busy: false, result: 'Undo returned nothing' });
    } catch (err) {
      setUndoState({ busy: false, result: `Undo failed: ${describeError(err)}` });
    }
  };

  // ---- keyboard player ----
  const kb = useKeyboardPlayer(token);

  const playing = tab === 'play' && hasWorld;
  useEffect(() => { rendererRef.current?.resize(); }, [open, playing]);
  const title = world?.spec.title ?? '';
  const modeLabel = world ? modeName(world.spec.mode?.kind) : null;
  const biomeLabel = world ? (world.spec.biome ?? 'garden') : null;
  const lastReport = reports.length ? reports[reports.length - 1] : null;
  const links = useMemo(() => platformLinks(), []);
  const connLabel = state === 'connected' ? (token ? 'director connected' : 'display only') : state;
  const online = !!health?.model.reachable && !!health?.model.present;
  const pending = !!activeRequest && !activeDone;

  return (
    <div className={`d3 bp ${playing ? 'is-playing' : ''} ${open ? 'panel-open' : 'panel-closed'}`}>
      <header className="bp-top d3-top">
        <nav className="bp-switch" aria-label="Choose 2D or 3D">
          <a href={links.href2d}>2D games</a>
          <a href={links.href3d} aria-current="page">3D worlds</a>
        </nav>
        <div className="d3-brand">
          <Box size={18} aria-hidden />
          <strong>Beetle 3D</strong>
          {world && <span className="d3-title">{stripFixture(title)}</span>}
        </div>
        <nav className="d3-tabs" role="tablist" aria-label="Steps">
          {(['idea', 'build', 'play'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={tab === v}
              className={tab === v ? 'on' : ''}
              disabled={(v === 'play' && !hasWorld) || (v === 'build' && !activeRequest)}
              onClick={() => chooseTab(v)}
            >
              {v === 'idea' ? <Sparkles size={14} aria-hidden /> : v === 'build' ? <Hammer size={14} aria-hidden /> : <Play size={14} aria-hidden />}
              {v === 'idea' ? 'Idea' : v === 'build' ? 'Build' : 'Play'}
            </button>
          ))}
        </nav>
        <div className="d3-actions">
          <span className={`d3-chip ${online ? 'ok' : ''}`} title={health ? `${health.model.name}: ${online ? 'ready' : health.model.reachable ? 'not pulled' : 'unreachable'}` : 'Checking the model'}>
            {online ? <Cpu size={13} aria-hidden /> : <WifiOff size={13} aria-hidden />}
            {online ? 'Local model' : health ? 'Model offline' : 'Checking'}
          </span>
          <button type="button" className="d3-icon" title="Activity log" aria-label="Activity log" aria-expanded={logOpen} aria-controls="d3-log" onClick={() => setLogOpen((o) => !o)}>
            <ListChecks size={16} aria-hidden />
          </button>
          {playing && (
            <button type="button" className="d3-icon" title="Toggle the panel (Escape)" aria-label={open ? 'Hide panel' : 'Show panel'} aria-expanded={open} aria-controls="director-panel" onClick={() => setOpen((o) => !o)}>
              {open ? <PanelRightClose size={16} aria-hidden /> : <PanelRightOpen size={16} aria-hidden />}
            </button>
          )}
        </div>
      </header>

      <div className="d3-body">
        <div className={`d3-stage ${playing ? 'visible' : ''}`} aria-hidden={!playing}>
          <canvas ref={canvasRef} id="scene" aria-label="Beetle world" />
          {playing && modeLabel && (
            <div className="d3-scene-tag">
              <span>{modeLabel}, {biomeLabel}</span>
              {isFixtureTitle(title) && <span className="tag">fixture</span>}
            </div>
          )}
        </div>

        {!token && (
          <div className="d3-notice" role="alert">
            No director token. Open the director link printed by the server at startup (it carries ?token=). The scene still renders as a display.
          </div>
        )}

        {tab === 'idea' && (
          <div className="d3-idea">
            <form className="d3-card d3-prompt" onSubmit={submitIdea}>
              <span className="eyebrow">DESCRIBE YOUR GAME</span>
              <h1>What should we make?</h1>
              <textarea
                id="prompt"
                aria-label="Describe your game"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitIdea(e); }}
                maxLength={1000}
                placeholder="A garden of five islands with three hidden relics and a shrine"
                disabled={!token || submitState.busy}
                rows={4}
              />
              {hasWorld && playersConnected && (
                <label className="d3-check">
                  <input type="checkbox" checked={authorize} onChange={(e) => setAuthorize(e.target.checked)} />
                  Players are connected: allow a new world (positions reset to spawns)
                </label>
              )}
              <div className="d3-row">
                <button type="submit" className="d3-primary" disabled={!token || submitState.busy || !prompt.trim()}>
                  {submitState.busy ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Sparkles size={15} aria-hidden />}
                  {submitState.busy ? 'Sending' : 'Make the 3D world'}
                </button>
                <span className="d3-muted">Made by the local model on this machine.</span>
              </div>
              {submitState.error && <div className="d3-error" role="alert">{submitState.error}</div>}
              <div className="d3-pills" aria-label="Game modes">
                {MODE_HINTS.map((h) => (
                  <button key={h.mode} type="button" onClick={() => setPrompt(h.example)} disabled={!token} title={`${MODE_NAMES[h.mode]}: ${h.what}`}>
                    {MODE_NAMES[h.mode]}
                  </button>
                ))}
              </div>
              <div className="d3-pills" aria-label="Biomes">
                {BIOME_HINTS.map((h) => (
                  <button key={h.biome} type="button" onClick={() => setPrompt(h.example)} disabled={!token} title={h.what}>
                    {h.biome.charAt(0).toUpperCase() + h.biome.slice(1)}
                  </button>
                ))}
              </div>
            </form>
          </div>
        )}

        {tab === 'build' && (
          <div className="d3-build">
            <section className="d3-card" aria-live="polite">
              <div className="d3-build-head">
                <span className="eyebrow">{activeDone ? (activeCommitted ? 'BUILT' : 'STOPPED') : 'BUILDING'}</span>
                <span className="d3-clock mono">{seconds(activeElapsed)}</span>
              </div>
              {activeRequest && requestsById[activeRequest.id]?.prompt && <p className="d3-quote">{requestsById[activeRequest.id].prompt}</p>}
              <ol className="d3-steps">
                {steps.map((s) => (
                  <li key={s.label} className={`st-${s.state}`}>
                    <span className="d3-step-icon">
                      {s.state === 'done' ? <Check size={14} aria-hidden /> : s.state === 'fail' ? <X size={14} aria-hidden /> : s.state === 'run' ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Circle size={10} aria-hidden />}
                    </span>
                    <span className="d3-step-label">{s.label}</span>
                    <span className="d3-step-detail">{s.detail}</span>
                    <span className="d3-step-time mono">{s.at !== null ? seconds(s.at) : s.state === 'run' ? seconds(activeElapsed) : ''}</span>
                  </li>
                ))}
              </ol>
              <div className="d3-row">
                {activeCommitted && hasWorld && <button type="button" className="d3-primary" onClick={() => chooseTab('play')}><Play size={15} aria-hidden />Play</button>}
                {activeDone && !activeCommitted && <button type="button" className="d3-secondary" onClick={() => chooseTab('idea')}>Try another idea</button>}
              </div>
            </section>
          </div>
        )}

        {playing && (
          <aside id="director-panel" className="d3-side" aria-label="World panel" aria-hidden={!open} inert={!open ? true : undefined}>
            {buildCommit?.ms != null && (
              <section className="d3-section d3-built">
                <span className="eyebrow">BUILT IN</span>
                <div className="d3-big mono" aria-label={`Built in ${seconds(buildCommit.ms)}`}>{seconds(buildCommit.ms)}</div>
                <span className="d3-muted">from the request to the committed world{modeLabel ? `, ${modeLabel.toLowerCase()} in ${biomeLabel}` : ''}</span>
              </section>
            )}

            <section className="d3-section">
              <span className="eyebrow">JOIN FROM YOUR PHONE</span>
              {!token ? <p className="d3-muted">Invites need the director token.</p> : (
                <div className="d3-qrs">
                  {SLOTS.map((s) => {
                    const inv = invites[s];
                    const ctl = controllers[s];
                    const left = inv ? Math.max(0, Math.round((inv.expiresAt - now) / 1000)) : 0;
                    return (
                      <div key={s} className="d3-qr">
                        <div className="d3-qr-head">
                          <span className={`dot ${ctl?.connected ? 'on' : 'off'}`} aria-hidden />
                          <strong>Player {s + 1}</strong>
                          <span className="d3-muted">{ctl?.connected ? `${ctl.label} connected` : 'waiting'}</span>
                        </div>
                        {inv?.qr ? <img src={inv.qr} alt={`QR code to join as player ${s + 1}`} /> : <div className="d3-qr-empty"><LoaderCircle size={16} className="spin" aria-hidden /></div>}
                        {inv && <div className="d3-url mono">{inv.url}</div>}
                        {inv && <span className="d3-muted">renews in {left} s</span>}
                      </div>
                    );
                  })}
                </div>
              )}
              {inviteError && <div className="d3-error" role="alert">{inviteError}</div>}
            </section>

            <section className="d3-section">
              <form onSubmit={submitEdit} className="d3-edit">
                <label htmlFor="edit-prompt" className="eyebrow">CHANGE IT WHILE THEY PLAY</label>
                <textarea
                  id="edit-prompt"
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitEdit(e); }}
                  maxLength={1000}
                  placeholder={kind === 'brief' ? 'Describe a new world' : 'Make the hazard lava and add a bridge'}
                  disabled={!token || submitState.busy}
                  rows={3}
                />
                <div className="d3-seg" role="radiogroup" aria-label="Request kind">
                  <label className={kind === 'edit' ? 'on' : ''}>
                    <input type="radio" name="kind" value="edit" checked={kind === 'edit'} onChange={() => setKind('edit')} disabled={!token || !hasWorld} />
                    Edit
                  </label>
                  <label className={kind === 'brief' ? 'on' : ''}>
                    <input type="radio" name="kind" value="brief" checked={kind === 'brief'} onChange={() => setKind('brief')} disabled={!token} />
                    New world
                  </label>
                </div>
                {kind === 'brief' && playersConnected && (
                  <label className="d3-check">
                    <input type="checkbox" checked={authorize} onChange={(e) => setAuthorize(e.target.checked)} />
                    Allow a new world while players are connected (positions reset to spawns)
                  </label>
                )}
                <div className="d3-row">
                  <button type="submit" className="d3-primary" disabled={!token || submitState.busy || !editPrompt.trim()}>
                    {submitState.busy || pending ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Hammer size={15} aria-hidden />}
                    {submitState.busy ? 'Sending' : kind === 'brief' ? 'Make a new world' : 'Apply change'}
                  </button>
                  {pending && <span className="d3-muted mono">working {seconds(activeElapsed)}</span>}
                  <button type="button" className="d3-secondary" onClick={doUndo} disabled={!token || undoState.busy || !hasWorld}>{undoState.busy ? 'Undoing' : 'Undo'}</button>
                </div>
                {submitState.error && <div className="d3-error" role="alert">{submitState.error}</div>}
                {undoState.result && <div className="d3-muted">{undoState.result}</div>}
              </form>
              {changes.length > 0 && (
                <ol className="d3-history" aria-label="Changes">
                  {[...changes].reverse().map((c) => (
                    <li key={c.id}>
                      <span className="d3-history-time">{c.auto ? 'Grew' : 'Changed'} in {c.ms != null ? seconds(c.ms) : 'n/a'}</span>
                      {c.prompt && <span className="d3-muted">{c.prompt}</span>}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="d3-section">
              <label className="d3-check" title={`When a player comes within ${STREAMING.frontierMeters} m of an island rim with no crossing beyond it, Beetle asks the agent for ${STREAMING.islandsPerExtension.min} to ${STREAMING.islandsPerExtension.max} more islands in that direction (up to ${STREAMING.maxIslands} islands)`}>
                <input id="auto-expand" type="checkbox" checked={autoExpand} onChange={(e) => { void toggleAutoExpand(e.target.checked); }} disabled={!token || autoExpandState.busy} />
                Grow the world as players explore
              </label>
              {autoExpandState.error && <div className="d3-error" role="alert">Could not change the setting: {autoExpandState.error}</div>}
              <div className="d3-row">
                {kb.state.phase === 'active' ? (
                  <button type="button" className="d3-secondary" onClick={kb.stop}>Leave keyboard play</button>
                ) : (
                  <button type="button" className="d3-secondary" onClick={() => { void kb.start(); }} disabled={!token || kb.state.phase === 'joining'}>
                    {kb.state.phase === 'joining' ? 'Joining' : 'Play with the keyboard'}
                  </button>
                )}
                {kb.state.phase === 'active' && (
                  <span className="d3-muted">
                    <span className={`dot ${kb.state.connection === 'connected' ? 'on' : 'warn'}`} aria-hidden />
                    <span style={{ color: kb.state.color ?? undefined }}>{kb.state.label}</span> WASD or arrows, E or Space
                  </span>
                )}
              </div>
              {kb.state.error && <div className="d3-error" role="alert">{kb.state.error}</div>}
            </section>
          </aside>
        )}

        <aside id="d3-log" className={`d3-log ${logOpen ? 'open' : ''}`} aria-label="Activity log" aria-hidden={!logOpen} inert={!logOpen ? true : undefined}>
          <div className="d3-log-head">
            <span className="eyebrow">ACTIVITY</span>
            <button type="button" className="d3-icon" aria-label="Close the activity log" onClick={() => setLogOpen(false)}><X size={16} aria-hidden /></button>
          </div>
          <ActivityTrail entries={trailEntries} />
          <label className="d3-check">
            <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
            Show developer details
          </label>
          {debug && (
            <div className="d3-debug">
              {submitState.note && <div className="mono small">{submitState.note}</div>}
              {health ? (
                <dl>
                  <dt>Model</dt><dd className="mono">{health.model.name}</dd>
                  <dt>Ollama</dt><dd>{health.model.reachable ? 'reachable' : 'unreachable'}</dd>
                  <dt>Present</dt><dd>{health.model.present ? 'pulled' : 'not pulled'}</dd>
                  <dt>Agent worker</dt><dd>{health.agentConnected ? 'claiming requests' : 'not seen'}</dd>
                  <dt>Public URL</dt><dd className="mono">{health.publicUrl}</dd>
                  <dt>World</dt><dd className="mono">v{world?.version ?? 0}</dd>
                </dl>
              ) : (
                <p className="d3-muted">{healthError ? `Health unavailable: ${healthError}` : 'Checking'}</p>
              )}
              {lastReport && (
                <dl>
                  <dt>Outcome</dt><dd>{lastReport.outcome} (v{lastReport.baseWorldVersion} to v{lastReport.worldVersion})</dd>
                  <dt>Total</dt><dd className="mono">{msLabel(lastReport.timings.totalMs)}</dd>
                  <dt>First model reply</dt><dd className="mono">{msLabel(lastReport.timings.firstModelResponseMs)}</dd>
                  <dt>Validated at</dt><dd className="mono">{msLabel(lastReport.timings.validatedMs)}</dd>
                  <dt>Committed at</dt><dd className="mono">{msLabel(lastReport.timings.committedMs)}</dd>
                  <dt>Validation attempts</dt><dd className="mono">{lastReport.validation.attempts}{lastReport.validation.failedCodes.length ? ` (${lastReport.validation.failedCodes.join(', ')})` : ''}</dd>
                  <dt>Mode</dt><dd className="mono">{lastReport.mode}</dd>
                  <dt>Model</dt><dd className="mono">{lastReport.model}</dd>
                </dl>
              )}
              <p className="d3-muted">
                Limits: {WORLD_LIMITS.islands.min} to {WORLD_LIMITS.islands.max} islands, up to {WORLD_LIMITS.bridges.max} bridges, {WORLD_LIMITS.relics} relics,
                up to {WORLD_LIMITS.decorations.max} decorations, up to {WORLD_LIMITS.patchOps.max} operations per edit. Time limits {MODE_LIMITS.timeLimitSec.min} to {MODE_LIMITS.timeLimitSec.max} s,
                hold times {MODE_LIMITS.holdSeconds.min} to {MODE_LIMITS.holdSeconds.max} s, walking speed {MODE_LIMITS.movementSpeed.min} to {MODE_LIMITS.movementSpeed.max} m/s.
              </p>
              {kb.state.phase === 'active' && <div className="mono small">keyboard {kb.state.connection}, seq {kb.state.seq}{kb.state.lastInputSeq !== null ? `, acked ${kb.state.lastInputSeq}` : ''}</div>}
              <div className="mono small">{connLabel} | WebSocket RTT {rttMs === null ? 'n/a' : `${Math.round(rttMs)} ms`} | tick age {stats.tickAgeMs === null ? 'no ticks' : `${Math.round(stats.tickAgeMs)} ms`} | {Math.round(stats.fps)} fps</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
