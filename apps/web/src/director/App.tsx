import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentActivity, BuildReport, CommitResult, HelloMessage, RequestKind } from '@beetle/contracts';
import { WORLD_LIMITS } from '@beetle/contracts';
import { createDirectorRequest, describeError, getActivity, getHealth, getReports, undo, type HealthInfo } from '../shared/api.ts';
import { takeDirectorToken } from '../shared/token.ts';
import { useBeetleSocket } from '../shared/use-socket.ts';
import { createRenderer, type BeetleRenderer } from '../renderer/index.ts';
import { JoinPanel } from '../shared/JoinPanel.tsx';
import { Wordmark } from '../shared/Wordmark.tsx';
import { ActivityTrail } from './ActivityTrail.tsx';
import { useKeyboardPlayer } from './useKeyboardPlayer.ts';
import { isFixtureTitle, msLabel, stripFixture } from '../shared/format.ts';

export function DirectorApp() {
  const token = useMemo(() => takeDirectorToken(), []);
  const hello = useCallback((): HelloMessage => (token ? { type: 'hello', role: 'director', token } : { type: 'hello', role: 'display' }), [token]);
  const view = useBeetleSocket(hello);
  const { socket, state, rttMs, world, tick, controllers } = view;

  // ---- renderer ----
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

  // ---- panel ----
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen((o) => !o); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { rendererRef.current?.resize(); }, [open]);

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

  // ---- prompt form ----
  const hasWorld = !!world;
  const [kind, setKind] = useState<RequestKind>('brief');
  useEffect(() => { if (!hasWorld) setKind('brief'); }, [hasWorld]);
  const [prompt, setPrompt] = useState('');
  const [authorize, setAuthorize] = useState(false);
  const [submitState, setSubmitState] = useState<{ busy: boolean; note: string | null; error: string | null }>({ busy: false, note: null, error: null });
  const playersConnected = (tick?.players.some((p) => p.connected) ?? false) || controllers.some((c) => c.connected);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    const text = prompt.trim();
    if (!text) return;
    setSubmitState({ busy: true, note: null, error: null });
    try {
      const body: { kind: RequestKind; prompt: string; authorizeNewWorld?: boolean } = { kind, prompt: text };
      if (kind === 'brief' && playersConnected && authorize) body.authorizeNewWorld = true;
      const r = await createDirectorRequest(token, body);
      const id = r?.request?.id ?? 'unknown';
      setSubmitState({ busy: false, note: `Request ${id} ${r?.request?.status ?? 'queued'} (${kind}, base v${r?.request?.worldVersionAtRequest ?? world?.version ?? 0})`, error: null });
    } catch (err) {
      setSubmitState({ busy: false, note: null, error: describeError(err) });
    }
  };

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

  const title = world?.spec.title ?? '';
  const lastReport = reports.length ? reports[reports.length - 1] : null;
  const connLabel = state === 'connected' ? (token ? 'director connected' : 'display only') : state;

  return (
    <div className={`director-layout ${open ? 'panel-open' : 'panel-closed'}`}>
      <canvas ref={canvasRef} id="scene" aria-label="Beetle world" />

      <div className="scene-overlay">
        <div className="scene-title">
          <span className="badge">{world ? `v${world.version}` : 'no world'}</span>
          <span className="title-text">{world ? stripFixture(title) : 'Waiting for a world'}</span>
          {isFixtureTitle(title) && <span className="tag">fixture</span>}
        </div>
        <div className="scene-readout mono">
          {connLabel} | WebSocket RTT {rttMs === null ? 'n/a' : `${Math.round(rttMs)} ms`} | tick age {stats.tickAgeMs === null ? 'no ticks' : `${Math.round(stats.tickAgeMs)} ms`} | {Math.round(stats.fps)} fps
        </div>
      </div>

      <button
        type="button"
        className="panel-toggle"
        aria-expanded={open}
        aria-controls="director-panel"
        onClick={() => setOpen((o) => !o)}
        title="Toggle the panel (Escape)"
      >
        {open ? 'Hide panel' : 'Show panel'}
      </button>

      <aside id="director-panel" className="panel" aria-label="Director panel" aria-hidden={!open} inert={!open ? true : undefined}>
        <header className="panel-header">
          <Wordmark />
          <span className="muted small">director</span>
        </header>

        {!token && (
          <section className="panel-section notice" role="alert">
            No director token. Open the director link printed by the server at startup (it carries ?token=). The scene still renders as a display.
          </section>
        )}

        <section className="panel-section">
          <form onSubmit={submit} className="prompt-form">
            <label htmlFor="prompt" className="section-title">Prompt</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={1000}
              placeholder={hasWorld ? 'Describe an edit, for example: add a bridge from the north island to the east island and switch the hazard to lava' : 'Describe a world, for example: five garden islands around a shrine with a lava moat'}
              disabled={!token || submitState.busy}
              rows={4}
            />
            <div className="kind-row" role="radiogroup" aria-label="Request kind">
              <label className={`kind ${kind === 'brief' ? 'selected' : ''}`}>
                <input type="radio" name="kind" value="brief" checked={kind === 'brief'} onChange={() => setKind('brief')} disabled={!token} />
                brief
              </label>
              <label className={`kind ${kind === 'edit' ? 'selected' : ''} ${!hasWorld ? 'disabled' : ''}`} title={hasWorld ? '' : 'edit needs a world first'}>
                <input type="radio" name="kind" value="edit" checked={kind === 'edit'} onChange={() => setKind('edit')} disabled={!token || !hasWorld} />
                edit
              </label>
            </div>
            {kind === 'brief' && playersConnected && (
              <label className="check">
                <input type="checkbox" checked={authorize} onChange={(e) => setAuthorize(e.target.checked)} />
                Authorize a new world while players are connected (positions reset to spawns, players and relic tombstones kept)
              </label>
            )}
            <div className="row">
              <button type="submit" className="primary" disabled={!token || submitState.busy || !prompt.trim()}>
                {submitState.busy ? 'Sending' : kind === 'brief' ? 'Build world' : 'Apply edit'}
              </button>
              <span className="muted small">v{world?.version ?? 0}{world ? `, ${stripFixture(title)}` : ', no world'}</span>
            </div>
            {submitState.note && <div className="note">{submitState.note}</div>}
            {submitState.error && <div className="error" role="alert">{submitState.error}</div>}
          </form>
          <details className="hints">
            <summary>What the agent can do</summary>
            <ul>
              <li>Add or remove bridges between islands</li>
              <li>Switch the hazard between water and lava</li>
              <li>Add, move or remove decorations: trees, rocks, lanterns, pillars, bushes, shrines</li>
              <li>Move relics to another island</li>
              <li>Retitle the world</li>
              <li>Build a fresh world from a brief (needs authorization while players are connected)</li>
            </ul>
            <p className="muted small">
              Limits: {WORLD_LIMITS.islands.min} to {WORLD_LIMITS.islands.max} islands, up to {WORLD_LIMITS.bridges.max} bridges, {WORLD_LIMITS.relics} relics, one gate,
              up to {WORLD_LIMITS.decorations.max} decorations, up to {WORLD_LIMITS.patchOps.max} operations per edit. Every change is validated and committed only when players stay supported.
            </p>
          </details>
        </section>

        <section className="panel-section">
          <h2 className="section-title">Activity</h2>
          <ActivityTrail entries={activity} />
        </section>

        <section className="panel-section status-grid">
          <h2 className="section-title">Model</h2>
          {health ? (
            <dl>
              <dt>Model</dt><dd className="mono">{health.model.name}</dd>
              <dt>Ollama</dt><dd><span className={`dot ${health.model.reachable ? 'on' : 'off'}`} />{health.model.reachable ? 'reachable' : 'unreachable'}</dd>
              <dt>Present</dt><dd><span className={`dot ${health.model.present ? 'on' : 'off'}`} />{health.model.present ? 'pulled' : 'not pulled'}</dd>
              <dt>Agent worker</dt><dd><span className={`dot ${health.agentConnected ? 'on' : 'off'}`} />{health.agentConnected ? 'claiming requests' : 'not seen'}</dd>
              <dt>Public URL</dt><dd className="mono small">{health.publicUrl}</dd>
            </dl>
          ) : (
            <p className="muted">{healthError ? `Health unavailable: ${healthError}` : 'Checking'}</p>
          )}
        </section>

        <section className="panel-section">
          {token ? <JoinPanel token={token} controllers={controllers} /> : <p className="muted">Invites need the director token.</p>}
        </section>

        <section className="panel-section">
          <h2 className="section-title">Keyboard player</h2>
          <p className="muted small">Joins as a controller from this page. WASD or arrows move, E or Space interact. Keys are ignored while typing in a field.</p>
          <div className="row">
            {kb.state.phase === 'active' ? (
              <button type="button" onClick={kb.stop}>Leave</button>
            ) : (
              <button type="button" onClick={() => { void kb.start(); }} disabled={!token || kb.state.phase === 'joining'}>
                {kb.state.phase === 'joining' ? 'Joining' : 'Join as keyboard player'}
              </button>
            )}
            {kb.state.phase === 'active' && (
              <span className="small">
                <span className={`dot ${kb.state.connection === 'connected' ? 'on' : 'warn'}`} />
                <span style={{ color: kb.state.color ?? undefined }}>{kb.state.label}</span>
                <span className="muted"> {kb.state.connection}, seq {kb.state.seq}{kb.state.lastInputSeq !== null ? `, acked ${kb.state.lastInputSeq}` : ''}</span>
              </span>
            )}
          </div>
          {kb.state.error && <div className="error" role="alert">{kb.state.error}</div>}
        </section>

        <section className="panel-section status-grid">
          <h2 className="section-title">Measured timings</h2>
          {lastReport ? (
            <>
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
              <p className="muted small">Wall clock times measured by the agent on this machine for the last request, mode {lastReport.mode}. Not a benchmark.</p>
            </>
          ) : (
            <p className="muted">No build report yet.</p>
          )}
        </section>

        <section className="panel-section">
          <h2 className="section-title">Undo</h2>
          <div className="row">
            <button type="button" onClick={doUndo} disabled={!token || undoState.busy || !hasWorld}>{undoState.busy ? 'Undoing' : 'Undo last commit'}</button>
            <span className="muted small">Previous spec, re-validated with live players, committed as a new version.</span>
          </div>
          {undoState.result && <div className="note">{undoState.result}</div>}
        </section>
      </aside>
    </div>
  );
}
