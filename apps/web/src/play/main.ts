/// <reference types="vite/client" />
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActivityMessage, AgentActivity, AgentPhase, HelloMessage, PlayerStatus, TickMessage, WorldMessage } from '@beetle/contracts';
import { WORLD_LIMITS } from '@beetle/contracts';
import { BeetleSocket } from '../shared/ws-client.ts';
import { createRenderer } from '../renderer/index.ts';
import { takeDirectorToken } from '../shared/token.ts';
import { JoinPanel } from '../shared/JoinPanel.tsx';
import { isFixtureTitle, stripFixture, elapsedSeconds } from '../shared/format.ts';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;

// Same glyph as shared/Wordmark.tsx, copied as plain markup so the HUD stays React-free.
const GLYPH_SVG = `<svg class="hud-glyph" width="36" height="36" viewBox="0 0 64 64" role="img" aria-label="Beetle" xmlns="http://www.w3.org/2000/svg">
<g fill="none" stroke="#f0b45a" stroke-width="3" stroke-linecap="round"><path d="M22 10 L14 4"/><path d="M42 10 L50 4"/><path d="M12 30 L4 26"/><path d="M52 30 L60 26"/><path d="M13 42 L5 48"/><path d="M51 42 L59 48"/></g>
<ellipse cx="32" cy="38" rx="19" ry="22" fill="#e9e3d3"/><circle cx="32" cy="14" r="8" fill="#cfc6b0"/>
<path d="M32 20 V60" stroke="#0e2a2f" stroke-width="2.5"/><path d="M15 32 Q32 26 49 32" stroke="#0e2a2f" stroke-width="2.5" fill="none"/>
<circle cx="24" cy="42" r="3" fill="#0e2a2f"/><circle cx="40" cy="42" r="3" fill="#0e2a2f"/><circle cx="26" cy="52" r="2.2" fill="#0e2a2f"/><circle cx="38" cy="52" r="2.2" fill="#0e2a2f"/>
<circle cx="29" cy="12" r="1.8" fill="#0e2a2f"/><circle cx="35" cy="12" r="1.8" fill="#0e2a2f"/></svg>`;

const GEM_SVG = `<svg class="gem" viewBox="0 0 20 20" aria-hidden="true"><path class="gem-body" d="M10 1.5 L18 8 L10 18.5 L2 8 Z"/><path class="gem-facet" d="M10 1.5 L13.4 8 L10 18.5 L6.6 8 Z"/><path class="gem-line" d="M2 8 H18"/></svg>`;

const RELIC_TOTAL = WORLD_LIMITS.relics;
const OBJECTIVE_LOCKED = `Collect ${RELIC_TOTAL} relics to open the temple gate`;
const OBJECTIVE_OPEN = 'Gate open: reach the temple';
const OBJECTIVE_WON = 'Temple reached';

// ---------- HUD (plain DOM) ----------
hud.innerHTML = `
  <div class="hud-brand glass" id="brand">
    ${GLYPH_SVG}
    <div class="hud-brand-text">
      <div class="hud-wordmark">Beetle</div>
      <div class="hud-title-row">
        <span class="hud-world-title" id="title">Waiting for a world</span>
        <span class="hud-version" id="version" hidden>v0</span>
        <span class="hud-fixture" id="fixture" hidden>fixture world</span>
      </div>
    </div>
  </div>
  <div class="hud-objective glass" id="objective-panel" data-state="locked">
    <div class="hud-objective-text" id="objective">${OBJECTIVE_LOCKED}</div>
    <div class="hud-objective-row">
      <div class="hud-gems" id="gems" role="img" aria-label="0 of ${RELIC_TOTAL} relics collected">${GEM_SVG.repeat(RELIC_TOTAL)}</div>
      <div class="hud-score"><span class="hud-score-label">score</span><span class="hud-score-value" id="score">0</span></div>
    </div>
  </div>
  <div class="hud-agent glass" id="agent" hidden>
    <div class="hud-agent-line">
      <span class="hud-agent-phase" id="agent-phase">Planning</span>
      <span class="hud-agent-sep" aria-hidden="true"></span>
      <span class="hud-agent-msg" id="agent-msg"></span>
    </div>
    <span class="hud-agent-bar" aria-hidden="true"></span>
  </div>
  <div class="hud-players" id="players">
    <button type="button" class="hud-player hud-sound glass" id="sound" aria-pressed="false" title="Toggle sound" hidden>
      <span class="sound-icon" aria-hidden="true"></span><span class="name">Sound</span>
    </button>
  </div>
  <pre class="hud-debug mono" id="debug" hidden></pre>
  <div class="hud-empty glass" id="empty">
    <h2>No world yet</h2>
    <p>Open the director page and describe a world. This screen updates the moment it is committed.</p>
  </div>
`;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const titleEl = $('title');
const versionEl = $('version');
const fixtureEl = $('fixture');
const objectivePanel = $('objective-panel');
const objectiveEl = $('objective');
const gemsEl = $('gems');
const gemEls = Array.from(gemsEl.querySelectorAll<SVGElement>('.gem'));
const scoreEl = $('score');
const playersEl = $('players');
const agentEl = $('agent');
const agentPhase = $('agent-phase');
const agentMsg = $('agent-msg');
const debugEl = $('debug');
const emptyEl = $('empty');

const renderer = createRenderer(canvas);
const socket: BeetleSocket = new BeetleSocket({ hello: (): HelloMessage => ({ type: 'hello', role: 'display', worldVersion: Math.max(0, socket.worldVersion) }) });

// ---------- sound (optional module, feature guarded) ----------
// shared/audio.ts is owned elsewhere and may not exist yet. import.meta.glob resolves to an empty map
// when the file is absent, so the page builds and runs either way; the Sound chip appears once it loads.
type AudioTheme = 'serene' | 'volcanic';
type AudioEvent = 'relic' | 'gate_unlock' | 'win' | 'commit' | 'fall' | 'respawn' | 'request_queued' | 'request_failed';
type AudioApi = {
  start: () => void | Promise<void>;
  setEnabled: (on: boolean) => void;
  setTheme: (theme: AudioTheme, blendSeconds?: number) => void;
  onEvent: (event: AudioEvent) => void;
  setMasterVolume: (v: number) => void;
};
type AudioModule = { createAudio?: () => AudioApi };
let audio: AudioApi | null = null;
let audioTheme: AudioTheme | null = null;
let soundOn = false;
let soundStarted = false;
const soundBtn = $('sound') as HTMLButtonElement;
function audioEvent(event: AudioEvent) {
  if (!audio || !soundOn) return;
  try { audio.onEvent(event); } catch (err) { console.warn('[beetle audio] event failed', err); }
}
function applyAudioTheme(theme: AudioTheme) {
  audioTheme = theme;
  if (!audio) return;
  try { audio.setTheme(theme, 2); } catch (err) { console.warn('[beetle audio] theme failed', err); }
}
soundBtn.addEventListener('click', () => {
  if (!audio) return;
  const next = !soundOn;
  const apply = () => {
    if (!audio) return;
    soundOn = next;
    try { audio.setEnabled(next); } catch (err) { console.warn('[beetle audio] enable failed', err); }
    soundBtn.classList.toggle('on', next);
    soundBtn.setAttribute('aria-pressed', String(next));
  };
  if (next && !soundStarted) {
    soundStarted = true;
    Promise.resolve().then(() => audio?.start()).then(apply).catch((err) => { soundStarted = false; console.warn('[beetle audio] start failed', err); });
  } else {
    apply();
  }
});
const audioLoaders = import.meta.glob<AudioModule>('../shared/audio.ts');
const audioLoader = audioLoaders['../shared/audio.ts'];
if (audioLoader) {
  audioLoader().then((mod) => {
    const api = mod.createAudio?.();
    if (!api) return;
    audio = api;
    soundBtn.hidden = false;
    if (audioTheme) applyAudioTheme(audioTheme);
  }).catch((err) => { console.warn('[beetle audio] module unavailable', err); });
}

// ---------- world: title, version chip, hazard tint ----------
let shownVersion = -1;
function onWorld(msg: WorldMessage) {
  renderer.applyWorld(msg);
  emptyEl.hidden = true;
  const title = msg.spec.title || 'Untitled world';
  titleEl.textContent = stripFixture(title);
  fixtureEl.hidden = !isFixtureTitle(title);
  const lava = msg.spec.hazard?.kind === 'lava';
  document.body.dataset.hazard = lava ? 'lava' : 'water';
  applyAudioTheme(lava ? 'volcanic' : 'serene');
  if (msg.version !== shownVersion) {
    const first = shownVersion < 0;
    shownVersion = msg.version;
    versionEl.hidden = false;
    versionEl.textContent = `v${msg.version}`;
    if (!first) {
      versionEl.classList.remove('pulse');
      void versionEl.offsetWidth; // restart the animation
      versionEl.classList.add('pulse');
    }
  }
}

// ---------- tick: objective, relic gems, score, player chips ----------
type Chip = { row: HTMLElement; dot: HTMLElement; swatch: HTMLElement; name: HTMLElement };
const chips: Chip[] = [];
function makeChip(slot: number): Chip {
  const row = document.createElement('div');
  row.className = 'hud-player glass empty';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `Player ${slot + 1}`;
  const dot = document.createElement('span');
  dot.className = 'dot off';
  row.append(swatch, name, dot);
  playersEl.insertBefore(row, soundBtn);
  return { row, dot, swatch, name };
}
for (let slot = 0; slot < WORLD_LIMITS.spawns; slot += 1) chips.push(makeChip(slot));

let lastObjective = '';
let tickSeen = false;
let prevCollected = 0;
let prevUnlocked = false;
let prevWon = false;
const prevStatus = new Map<string, PlayerStatus>();
function tickSoundEvents(tick: TickMessage, collected: number, gate: { unlocked: boolean; won: boolean }) {
  const players = tick.players ?? [];
  if (tickSeen) {
    if (collected > prevCollected) audioEvent('relic');
    if (gate.unlocked && !prevUnlocked) audioEvent('gate_unlock');
    if (gate.won && !prevWon) audioEvent('win');
    for (const p of players) {
      const was = prevStatus.get(p.id);
      if (p.status === 'falling' && was !== 'falling') audioEvent('fall');
      if (was === 'respawning' && p.status !== 'respawning') audioEvent('respawn');
    }
  }
  tickSeen = true;
  prevCollected = collected;
  prevUnlocked = gate.unlocked;
  prevWon = gate.won;
  prevStatus.clear();
  for (const p of players) prevStatus.set(p.id, p.status);
}
function onTick(tick: TickMessage) {
  renderer.applyTick(tick);
  const relicStates = Object.values(tick.relics ?? {});
  const collected = relicStates.filter((s) => s === 'collected').length;
  gemEls.forEach((gem, i) => gem.classList.toggle('on', i < collected));
  gemsEl.setAttribute('aria-label', `${collected} of ${RELIC_TOTAL} relics collected`);
  scoreEl.textContent = String(tick.score ?? 0);

  const gate = tick.gate ?? { unlocked: false, won: false };
  tickSoundEvents(tick, collected, gate);
  const state = gate.won ? 'won' : gate.unlocked ? 'unlocked' : 'locked';
  const objective = gate.won ? OBJECTIVE_WON : gate.unlocked ? OBJECTIVE_OPEN : OBJECTIVE_LOCKED;
  if (objective !== lastObjective) {
    lastObjective = objective;
    objectiveEl.textContent = objective;
    objectivePanel.dataset.state = state;
    objectivePanel.classList.remove('changed');
    void objectivePanel.offsetWidth;
    objectivePanel.classList.add('changed');
  }

  const bySlot = new Map<number, TickMessage['players'][number]>();
  for (const p of tick.players ?? []) bySlot.set(p.slot, p);
  chips.forEach((chip, slot) => {
    const p = bySlot.get(slot);
    if (!p) {
      chip.row.classList.add('empty');
      chip.swatch.style.background = '';
      chip.name.textContent = `Player ${slot + 1}`;
      chip.dot.className = 'dot off';
      return;
    }
    chip.row.classList.remove('empty');
    chip.swatch.style.background = /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#9fb7b3';
    chip.name.textContent = p.label;
    chip.dot.className = `dot ${p.connected ? 'on' : 'off'}`;
    chip.dot.title = p.connected ? 'connected' : 'disconnected';
  });
}

// ---------- agent status (bottom centre) ----------
const IN_FLIGHT = new Set<AgentPhase>(['queued', 'planning', 'validating', 'repairing', 'awaiting_safe_commit']);
const STALE_TERMINAL_MS = 8000;
const LINGER_MS = 4000;
function agentPhaseLabel(a: AgentActivity): string {
  switch (a.phase) {
    case 'queued': return 'Queued';
    case 'planning': return 'Planning';
    case 'validating': return 'Validating';
    case 'repairing': return 'Repairing';
    case 'awaiting_safe_commit': return 'Awaiting a safe moment';
    case 'committed': return `Committed v${a.worldVersion ?? Math.max(0, socket.worldVersion)}`;
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return String(a.phase);
  }
}
let agentTimer: number | null = null;
function clearAgentTimer() {
  if (agentTimer !== null) { clearTimeout(agentTimer); agentTimer = null; }
}
const firedActivity = new Set<string>();
function activitySoundEvents(msg: ActivityMessage) {
  const now = Date.now();
  for (const e of Array.isArray(msg.entries) ? msg.entries : []) {
    if (!e || typeof e.id !== 'string' || firedActivity.has(e.id)) continue;
    firedActivity.add(e.id);
    if (firedActivity.size > 600) firedActivity.delete(firedActivity.values().next().value as string);
    if (now - e.at > STALE_TERMINAL_MS) continue; // replayed history on connect
    if (e.phase === 'queued') audioEvent('request_queued');
    else if (e.phase === 'committed') audioEvent('commit');
    else if (e.phase === 'failed') audioEvent('request_failed');
  }
}
function onActivity(msg: ActivityMessage) {
  activitySoundEvents(msg);
  const entries = socket.activity;
  if (entries.length === 0) return;
  const latest: AgentActivity = entries[entries.length - 1];
  const inFlight = IN_FLIGHT.has(latest.phase);
  clearAgentTimer();
  // Replayed history: do not resurface an old result on reconnect.
  if (!inFlight && agentEl.hidden && Date.now() - latest.at > STALE_TERMINAL_MS) return;
  agentEl.hidden = false;
  agentEl.classList.remove('fade');
  agentEl.classList.toggle('busy', inFlight);
  agentEl.dataset.phase = latest.phase;
  agentPhase.textContent = agentPhaseLabel(latest);
  agentMsg.textContent = latest.message;
  if (!inFlight) {
    agentTimer = window.setTimeout(() => {
      agentEl.classList.add('fade');
      agentTimer = window.setTimeout(() => { agentEl.hidden = true; agentEl.classList.remove('fade'); agentTimer = null; }, 700);
    }, LINGER_MS);
  }
}

socket.on('world', onWorld);
socket.on('tick', onTick);
socket.on('activity', onActivity);
socket.connect();

// ---------- debug overlay: backquote key or ?debug=1 ----------
let debugOn = false;
try { debugOn = new URLSearchParams(location.search).get('debug') === '1'; } catch { /* ignore */ }
function renderDebug() {
  const s = renderer.stats();
  const rtt = socket.rttMs === null ? 'n/a' : `${Math.round(socket.rttMs)} ms`;
  const age = s.tickAgeMs === null ? 'no ticks' : `${Math.round(s.tickAgeMs)} ms`;
  const latest = socket.activity[socket.activity.length - 1];
  const lines = [
    `conn      ${socket.state}`,
    `ws rtt    ${rtt}`,
    `tick age  ${age}`,
    `fps       ${Math.round(s.fps)}`,
    `meshes    ${s.meshes}`,
    `world     renderer v${s.worldVersion}, socket v${Math.max(0, socket.worldVersion)}`,
    `tick      ${socket.tick ? `#${socket.tick.tick}` : 'n/a'}`,
  ];
  if (latest) {
    const extra = [
      latest.codes && latest.codes.length ? `[${latest.codes.join(', ')}]` : '',
      latest.objectIds && latest.objectIds.length ? `(${latest.objectIds.join(', ')})` : '',
      elapsedSeconds(latest.elapsedMs),
    ].filter(Boolean).join(' ');
    lines.push(`agent     ${latest.phase}  req ${latest.requestId}  act ${latest.id}${latest.tool ? `  tool ${latest.tool}` : ''}`);
    lines.push(`          ${latest.message}${extra ? ` ${extra}` : ''}`);
  } else {
    lines.push('agent     no activity');
  }
  lines.push('toggle    backquote key');
  debugEl.textContent = lines.join('\n');
}
function setDebug(on: boolean) {
  debugOn = on;
  debugEl.hidden = !on;
  if (on) renderDebug();
}
setDebug(debugOn);
setInterval(() => { if (debugOn) renderDebug(); }, 500);
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Backquote' && e.key !== '`') return; // leaves WASD, arrows, E, Space and C to the game and renderer
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  setDebug(!debugOn);
});

// ---------- optional join drawer (same component as the director) ----------
const token = takeDirectorToken();
if (token) {
  const drawer = document.getElementById('join-drawer') as HTMLElement;
  const tab = document.getElementById('join-tab') as HTMLButtonElement;
  drawer.hidden = false;
  tab.addEventListener('click', () => {
    const open = drawer.classList.toggle('open');
    tab.setAttribute('aria-expanded', String(open));
  });
  const root = createRoot(document.getElementById('join-root') as HTMLElement);
  const render = () => root.render(createElement(JoinPanel, { token, controllers: socket.controllers, compact: false }));
  socket.on('controllers', render);
  render();
}

// Inspection hook for the integration owner (read-only use from the browser console).
(window as unknown as { __beetle?: unknown }).__beetle = { socket, renderer };
