import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentActivity, HelloMessage, TickMessage, WorldMessage } from '@beetle/contracts';
import { WORLD_LIMITS } from '@beetle/contracts';
import { BeetleSocket } from '../shared/ws-client.ts';
import { createRenderer } from '../renderer/index.ts';
import { takeDirectorToken } from '../shared/token.ts';
import { JoinPanel } from '../shared/JoinPanel.tsx';
import { isFixtureTitle, phaseLabel, stripFixture, elapsedSeconds } from '../shared/format.ts';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;

// ---------- HUD (plain DOM) ----------
hud.innerHTML = `
  <div class="hud-top">
    <div class="hud-title">
      <span class="title-text" id="title">Beetle</span>
      <span class="badge" id="version">v0</span>
      <span class="tag" id="fixture" hidden>fixture</span>
    </div>
    <div class="hud-stats">
      <span><span class="label">relics</span><span id="relics">0/${WORLD_LIMITS.relics}</span></span>
      <span><span class="label">score</span><span id="score">0</span></span>
      <span><span class="label">gate</span><span id="gate" class="gate-state">locked</span></span>
    </div>
  </div>
  <div class="hud-players" id="players"></div>
  <div class="hud-ticker" id="ticker" hidden>
    <span class="phase" id="ticker-phase">queued</span>
    <span class="msg" id="ticker-msg"></span>
    <span class="when" id="ticker-when"></span>
  </div>
  <div class="hud-readout" id="readout">connecting</div>
  <div class="hud-empty" id="empty">
    <h2>No world yet</h2>
    <p>Open the director page and describe a world. This screen updates the moment it is committed.</p>
  </div>
`;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const titleEl = $('title');
const versionEl = $('version');
const fixtureEl = $('fixture');
const relicsEl = $('relics');
const scoreEl = $('score');
const gateEl = $('gate');
const playersEl = $('players');
const tickerEl = $('ticker');
const tickerPhase = $('ticker-phase');
const tickerMsg = $('ticker-msg');
const tickerWhen = $('ticker-when');
const readoutEl = $('readout');
const emptyEl = $('empty');

const renderer = createRenderer(canvas);
const socket: BeetleSocket = new BeetleSocket({ hello: (): HelloMessage => ({ type: 'hello', role: 'display', worldVersion: Math.max(0, socket.worldVersion) }) });

let shownVersion = -1;
function onWorld(msg: WorldMessage) {
  renderer.applyWorld(msg);
  emptyEl.hidden = true;
  const title = msg.spec.title || 'Untitled world';
  titleEl.textContent = stripFixture(title);
  fixtureEl.hidden = !isFixtureTitle(title);
  if (msg.version !== shownVersion) {
    shownVersion = msg.version;
    versionEl.textContent = `v${msg.version}`;
    versionEl.classList.remove('pulse');
    void versionEl.offsetWidth; // restart the animation
    versionEl.classList.add('pulse');
  }
}

const playerRows = new Map<string, { row: HTMLElement; dot: HTMLElement; status: HTMLElement }>();
function onTick(tick: TickMessage) {
  renderer.applyTick(tick);
  const relicStates = Object.values(tick.relics ?? {});
  const total = relicStates.length || WORLD_LIMITS.relics;
  const collected = relicStates.filter((s) => s === 'collected').length;
  relicsEl.textContent = `${collected}/${total}`;
  scoreEl.textContent = String(tick.score ?? 0);
  const gate = tick.gate ?? { unlocked: false, won: false };
  gateEl.textContent = gate.won ? 'won' : gate.unlocked ? 'unlocked' : 'locked';
  gateEl.className = `gate-state ${gate.won ? 'won' : gate.unlocked ? 'unlocked' : ''}`;

  const seen = new Set<string>();
  for (const p of tick.players ?? []) {
    seen.add(p.id);
    let entry = playerRows.get(p.id);
    if (!entry) {
      const row = document.createElement('div');
      row.className = 'hud-player';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#9fb7b3';
      const name = document.createElement('span');
      name.textContent = p.label;
      const status = document.createElement('span');
      status.className = 'status';
      row.append(dot, swatch, name, status);
      playersEl.appendChild(row);
      entry = { row, dot, status };
      playerRows.set(p.id, entry);
    }
    entry.dot.className = `dot ${p.connected ? 'on' : 'off'}`;
    entry.status.textContent = p.connected ? (p.status === 'active' ? '' : p.status) : 'disconnected';
  }
  for (const [id, entry] of playerRows) {
    if (!seen.has(id)) { entry.row.remove(); playerRows.delete(id); }
  }
}

function onActivity() {
  const entries = socket.activity;
  if (entries.length === 0) return;
  const latest: AgentActivity = entries[entries.length - 1];
  tickerEl.hidden = false;
  tickerPhase.textContent = phaseLabel(latest.phase);
  tickerPhase.className = `phase ${latest.phase}`;
  let msg = latest.message;
  if (latest.codes && latest.codes.length) msg += ` [${latest.codes.join(', ')}]`;
  if (latest.objectIds && latest.objectIds.length) msg += ` (${latest.objectIds.join(', ')})`;
  tickerMsg.textContent = msg;
  tickerWhen.textContent = elapsedSeconds(latest.elapsedMs);
}

socket.on('world', onWorld);
socket.on('tick', onTick);
socket.on('activity', onActivity);
socket.connect();

setInterval(() => {
  const s = renderer.stats();
  const rtt = socket.rttMs === null ? 'n/a' : `${Math.round(socket.rttMs)} ms`;
  const age = s.tickAgeMs === null ? 'no ticks' : `${Math.round(s.tickAgeMs)} ms`;
  readoutEl.textContent = `${socket.state} | WebSocket RTT ${rtt} | tick age ${age} | ${Math.round(s.fps)} fps`;
}, 500);

// ---------- optional join panel (same component as the director) ----------
const token = takeDirectorToken();
if (token) {
  const root = createRoot(document.getElementById('join-root') as HTMLElement);
  const render = () => root.render(createElement(JoinPanel, { token, controllers: socket.controllers, compact: false }));
  socket.on('controllers', render);
  render();
}

// Inspection hook for the integration owner (read-only use from the browser console).
(window as unknown as { __beetle?: unknown }).__beetle = { socket, renderer };
