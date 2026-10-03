/// <reference types="vite/client" />
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActivityMessage, AgentActivity, AgentPhase, GameMode, HelloMessage, MarkerMessage, ObjectiveState, PlayerStatus, TickMessage, WorldMessage, WorldSpec } from '@beetle/contracts';
import { MODE_LIMITS, WORLD_LIMITS } from '@beetle/contracts';
import { BeetleSocket } from '../shared/ws-client.ts';
import { createRenderer } from '../renderer/index.ts';
import { takeDirectorToken } from '../shared/token.ts';
import { JoinPanel } from '../shared/JoinPanel.tsx';
import { isFixtureTitle, stripFixture, elapsedSeconds } from '../shared/format.ts';
import { getDirectorRequest } from '../shared/api.ts';

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

// Hold ring: a track circle plus an arc that fills clockwise from the top (r = 20, circumference ~ 125.66).
const RING_R = 20;
const RING_C = 2 * Math.PI * RING_R;
const RING_SVG = `<svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle class="ring-track" cx="24" cy="24" r="${RING_R}"/><circle class="ring-arc" cx="24" cy="24" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/></svg>`;

const RELIC_TOTAL = WORLD_LIMITS.relics;
const OBJECTIVE_OPEN = 'Gate open: reach the temple';

const MODE_NAMES: Record<GameMode, string> = {
  relic_hunt: 'Relic hunt',
  time_trial: 'Time trial',
  king_of_the_hill: 'King of the hill',
  checkpoint_race: 'Checkpoint race',
  survival: 'Survival',
};
const WON_TITLES: Record<GameMode, string> = {
  relic_hunt: 'Temple reached',
  time_trial: 'Time trial complete',
  king_of_the_hill: 'Hill held',
  checkpoint_race: 'Race complete',
  survival: 'Temple reached',
};
function modeName(kind: string | undefined): string {
  return (MODE_NAMES as Record<string, string>)[kind ?? ''] ?? MODE_NAMES.relic_hunt;
}
function collectLine(n: number): string {
  return n === 1 ? 'Collect 1 relic to open the temple gate' : `Collect ${n} relics to open the temple gate`;
}
function mmss(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- HUD (plain DOM) ----------
hud.innerHTML = `
  <div class="hud-brand glass" id="brand">
    ${GLYPH_SVG}
    <div class="hud-brand-text">
      <div class="hud-wordmark">Beetle</div>
      <div class="hud-title-row">
        <span class="hud-world-title" id="title">Waiting for a world</span>
        <span class="hud-version" id="version" hidden>v0</span>
        <span class="hud-mode-chip" id="mode-chip" hidden></span>
        <span class="hud-fixture" id="fixture" hidden>fixture world</span>
        <span class="hud-built" id="built" hidden aria-live="polite"></span>
      </div>
    </div>
  </div>
  <div class="hud-objective glass" id="objective-panel" data-state="locked" data-mode="relic_hunt">
    <div class="hud-timer" id="timer" data-level="calm" hidden aria-live="off">
      <span class="hud-timer-value" id="timer-value">00:00</span>
      <span class="hud-timer-label" id="timer-label"></span>
    </div>
    <div class="hud-objective-text" id="objective">${collectLine(RELIC_TOTAL)}</div>
    <div class="hud-hazard" id="hazard" hidden>
      <span class="hud-hazard-label" id="hazard-label">The lava is rising</span>
      <span class="hud-hazard-meter" aria-hidden="true"><span class="hud-hazard-fill" id="hazard-fill"></span></span>
    </div>
    <div class="hud-holds" id="holds" hidden></div>
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
      <span class="name">Sound off</span>
    </button>
  </div>
  <pre class="hud-debug mono" id="debug" hidden></pre>
  <div class="hud-empty" id="empty" role="status">
    <h2>Waiting for a game</h2>
    <p>Describe a game on the director screen</p>
  </div>
  <div class="hud-toast glass" id="toast" hidden role="status" aria-live="polite"></div>
  <div class="hud-outcome glass" id="outcome" data-result="won" hidden role="status" aria-live="polite">
    <div class="hud-outcome-kicker" id="outcome-kicker">Victory</div>
    <h2 class="hud-outcome-title" id="outcome-title">Temple reached</h2>
    <p class="hud-outcome-sub" id="outcome-sub"></p>
    <div class="hud-outcome-score"><span class="hud-score-label">final score</span><span class="hud-outcome-score-value" id="outcome-score">0</span></div>
  </div>
`;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const titleEl = $('title');
const versionEl = $('version');
const modeChipEl = $('mode-chip');
const fixtureEl = $('fixture');
const builtEl = $('built');
const objectivePanel = $('objective-panel');
const objectiveEl = $('objective');
const timerEl = $('timer');
const timerValueEl = $('timer-value');
const timerLabelEl = $('timer-label');
const hazardEl = $('hazard');
const hazardLabelEl = $('hazard-label');
const hazardFillEl = $('hazard-fill');
const holdsEl = $('holds');
const gemsEl = $('gems');
const gemEls = Array.from(gemsEl.querySelectorAll<SVGElement>('.gem'));
const scoreEl = $('score');
const playersEl = $('players');
const agentEl = $('agent');
const agentPhase = $('agent-phase');
const agentMsg = $('agent-msg');
const debugEl = $('debug');
const emptyEl = $('empty');
const outcomeEl = $('outcome');
const outcomeKickerEl = $('outcome-kicker');
const outcomeTitleEl = $('outcome-title');
const outcomeSubEl = $('outcome-sub');
const outcomeScoreEl = $('outcome-score');
const toastEl = $('toast');

const renderer = createRenderer(canvas);
const socket: BeetleSocket = new BeetleSocket({ hello: (): HelloMessage => ({ type: 'hello', role: 'display', worldVersion: Math.max(0, socket.worldVersion) }) });

// ---------- sound (optional module, feature guarded) ----------
// shared/audio.ts is owned elsewhere and may not exist yet. import.meta.glob resolves to an empty map
// when the file is absent, so the page builds and runs either way; the Sound chip appears once it loads.
type AudioTheme = 'serene' | 'volcanic' | 'frost' | 'desert' | 'night';
type AudioEvent = 'relic' | 'gate_unlock' | 'win' | 'commit' | 'fall' | 'respawn' | 'request_queued' | 'request_failed'
  | 'checkpoint' | 'tick_warning' | 'hill_tick' | 'lost' | 'biome_change';
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
/** Biome first (frost, desert, night have their own beds), then lava or volcanic rock, else serene. */
function biomeTheme(biome: string, hazardKind: 'lava' | 'water'): AudioTheme {
  if (biome === 'frost' || biome === 'desert' || biome === 'night') return biome;
  if (biome === 'volcanic' || hazardKind === 'lava') return 'volcanic';
  return 'serene';
}
function legacyTheme(theme: AudioTheme): 'serene' | 'volcanic' {
  return theme === 'volcanic' ? 'volcanic' : 'serene';
}
function applyAudioTheme(theme: AudioTheme) {
  audioTheme = theme;
  if (!audio) return;
  try {
    audio.setTheme(theme, 2);
  } catch (err) {
    // An older audio module only knows serene and volcanic.
    try { audio.setTheme(legacyTheme(theme), 2); } catch (err2) { console.warn('[beetle audio] theme failed', err, err2); }
  }
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
    (soundBtn.querySelector('.name') as HTMLElement).textContent = next ? 'Sound on' : 'Sound off';
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

// ---------- world: title, version chip, mode chip, hazard tint ----------
// What the HUD needs from the spec; everything is optional on the wire so defaults apply (relic_hunt, all relics).
type WorldInfo = {
  mode: GameMode;
  biome: string;
  relicsRequired: number;
  holdSeconds: number;
  timeLimitSec: number | null;
  relicOrder: { id: string; name: string }[];
  hazardKind: 'lava' | 'water';
  hazardBase: number;
  hazardMax: number;
};
let worldInfo: WorldInfo | null = null;
function readWorldInfo(spec: WorldSpec): WorldInfo {
  const relics = Array.isArray(spec.relics) ? spec.relics : [];
  const m = spec.mode ?? { kind: 'relic_hunt' as const };
  const kind: GameMode = (m.kind && m.kind in MODE_NAMES ? m.kind : 'relic_hunt');
  const relicsRequired = Math.min(m.relicsRequired ?? relics.length, relics.length) || 1;
  const timed = kind === 'time_trial' || kind === 'survival';
  const base = typeof spec.hazard?.planeElevation === 'number' ? spec.hazard.planeElevation : -2.5;
  const max = typeof spec.hazard?.rise?.maxElevation === 'number' ? spec.hazard.rise.maxElevation : MODE_LIMITS.hazardRise.maxElevation.max;
  return {
    mode: kind,
    biome: typeof spec.biome === 'string' ? spec.biome : 'garden',
    relicsRequired,
    holdSeconds: m.holdSeconds ?? MODE_LIMITS.holdSeconds.default,
    timeLimitSec: m.timeLimitSec ?? (timed ? MODE_LIMITS.timeLimitSec.default : null),
    relicOrder: relics.map((r, i) => ({ id: r.id, name: r.name && r.name.trim() ? r.name : `Relic ${i + 1}` })),
    hazardKind: spec.hazard?.kind === 'lava' ? 'lava' : 'water',
    hazardBase: base,
    hazardMax: Math.max(max, base + 0.01),
  };
}
let shownVersion = -1;
let shownBiome: string | null = null;
// Before the first world the canvas stays mounted but hidden (play.css, body.has-world) so no ocean or sky shows.
let hasWorld = false;
let autoOpenJoin: (() => void) | null = null; // set by the join drawer when a director token is present
// "Built in X.X s" / "Changed in X.X s": elapsedMs of the committed activity entry for the shown world version.
const CHANGED_MS = 6000;
let builtText = '';
let timedVersion = -1;
let firstTimedVersion = -1;
let builtTimer: number | null = null;
function updateBuildTiming() {
  if (shownVersion < 0 || timedVersion === shownVersion) return;
  const entries = socket.activity;
  let hit: AgentActivity | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.phase === 'committed' && e.worldVersion === shownVersion && typeof e.elapsedMs === 'number' && Number.isFinite(e.elapsedMs)) { hit = e; break; }
  }
  if (!hit) return;
  timedVersion = shownVersion;
  const secs = elapsedSeconds(hit.elapsedMs);
  if (builtTimer !== null) { clearTimeout(builtTimer); builtTimer = null; }
  builtEl.hidden = false;
  if (firstTimedVersion < 0) {
    firstTimedVersion = shownVersion;
    builtText = `Built in ${secs}`;
    builtEl.textContent = builtText;
    builtEl.classList.remove('changed');
    return;
  }
  builtEl.textContent = `Changed in ${secs}`;
  builtEl.classList.add('changed');
  builtTimer = window.setTimeout(() => {
    builtTimer = null;
    builtEl.classList.remove('changed');
    builtEl.textContent = builtText;
    builtEl.hidden = !builtText;
  }, CHANGED_MS);
}
function onWorld(msg: WorldMessage) {
  // The renderer is owned elsewhere; a failure there must not take the HUD down with it.
  try { renderer.applyWorld(msg); } catch (err) { console.error('[beetle renderer] world failed', err); }
  emptyEl.hidden = true;
  if (!hasWorld && msg.spec) {
    hasWorld = true;
    document.body.classList.add('has-world'); // fades the canvas in
    autoOpenJoin?.();
  }
  const title = msg.spec.title || 'Untitled world';
  titleEl.textContent = stripFixture(title);
  fixtureEl.hidden = !isFixtureTitle(title);
  worldInfo = readWorldInfo(msg.spec);
  const lava = worldInfo.hazardKind === 'lava';
  document.body.dataset.hazard = lava ? 'lava' : 'water';
  document.body.dataset.biome = worldInfo.biome;
  if (shownBiome !== null && shownBiome !== worldInfo.biome) audioEvent('biome_change');
  shownBiome = worldInfo.biome;
  applyAudioTheme(biomeTheme(worldInfo.biome, worldInfo.hazardKind));
  modeChipEl.hidden = false;
  modeChipEl.textContent = `${modeName(worldInfo.mode)}, ${worldInfo.biome}`;
  modeChipEl.title = `${modeName(worldInfo.mode)} in the ${worldInfo.biome} biome`;
  objectivePanel.dataset.mode = worldInfo.mode;
  hazardLabelEl.textContent = lava ? 'The lava is rising' : 'The water is rising';
  lastObjective = ''; // the next tick re-renders the objective for the new mode
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
  updateBuildTiming();
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

// Hold rings (king of the hill): one per player slot, created once and updated per tick.
type HoldRing = { row: HTMLElement; arc: SVGCircleElement; name: HTMLElement; secs: HTMLElement };
const holdRings: HoldRing[] = [];
function makeHoldRing(slot: number): HoldRing {
  const row = document.createElement('div');
  row.className = 'hud-hold empty';
  row.innerHTML = `${RING_SVG}<span class="hud-hold-secs mono">0 s</span><span class="hud-hold-name">Player ${slot + 1}</span>`;
  const arc = row.querySelector<SVGCircleElement>('.ring-arc') as SVGCircleElement;
  const secs = row.querySelector<HTMLElement>('.hud-hold-secs') as HTMLElement;
  const name = row.querySelector<HTMLElement>('.hud-hold-name') as HTMLElement;
  holdsEl.appendChild(row);
  return { row, arc, name, secs };
}
for (let slot = 0; slot < WORLD_LIMITS.spawns; slot += 1) holdRings.push(makeHoldRing(slot));

function safeColor(c: string | undefined): string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#9fb7b3';
}

const playerLabels = new Map<string, string>();
let lastObjective = '';
let tickSeen = false;
let prevCollected = 0;
let prevUnlocked = false;
let prevWon = false;
const prevStatus = new Map<string, PlayerStatus>();
let prevLost = false;
let prevNextCheckpointId: string | null = null;
let lastWarnSecond = -1;
const prevHoldWhole = new Map<string, number>();
function tickSoundEvents(tick: TickMessage, collected: number, gate: { unlocked: boolean; won: boolean }, obj: ObjectiveState | undefined, info: WorldInfo) {
  const players = tick.players ?? [];
  const lost = !gate.won && !!obj?.lost;
  const relicStates = tick.relics ?? {};
  // Whole seconds held per player; a step up means the hill is being held right now.
  const holdWhole = new Map<string, number>();
  for (const p of players) holdWhole.set(p.id, Math.floor(Math.max(0, obj?.holdSec?.[p.id] ?? 0)));
  const remaining = typeof obj?.remainingSec === 'number' && Number.isFinite(obj.remainingSec) ? Math.ceil(Math.max(0, obj.remainingSec)) : -1;
  if (tickSeen) {
    if (collected > prevCollected) {
      // Checkpoint race: the relic that was next just got taken in order.
      const inOrder = info.mode === 'checkpoint_race' && !!prevNextCheckpointId && relicStates[prevNextCheckpointId] === 'collected';
      audioEvent(inOrder ? 'checkpoint' : 'relic');
    }
    if (gate.unlocked && !prevUnlocked) audioEvent('gate_unlock');
    if (gate.won && !prevWon) audioEvent('win');
    if (lost && !prevLost) audioEvent('lost');
    for (const p of players) {
      const was = prevStatus.get(p.id);
      if (p.status === 'falling' && was !== 'falling') audioEvent('fall');
      if (was === 'respawning' && p.status !== 'respawning') audioEvent('respawn');
    }
    // Countdown warning: once per second at 10 s or less, never after the timer expired or the round was won.
    if (!lost && !gate.won && remaining >= 0 && remaining <= 10 && remaining !== lastWarnSecond) {
      audioEvent('tick_warning');
      lastWarnSecond = remaining;
    }
    // Hill tick: once per second while any player's hold time is climbing.
    if (info.mode === 'king_of_the_hill' && !gate.won) {
      let climbing = false;
      for (const [id, whole] of holdWhole) {
        const was = prevHoldWhole.get(id);
        if (was !== undefined && whole > was) climbing = true;
      }
      if (climbing) audioEvent('hill_tick');
    }
  }
  tickSeen = true;
  prevCollected = collected;
  prevUnlocked = gate.unlocked;
  prevWon = gate.won;
  prevLost = lost;
  prevNextCheckpointId = typeof obj?.nextCheckpointId === 'string' ? obj.nextCheckpointId : null;
  if (remaining < 0 || remaining > 10) lastWarnSecond = -1;
  prevStatus.clear();
  for (const p of players) prevStatus.set(p.id, p.status);
  prevHoldWhole.clear();
  for (const [id, whole] of holdWhole) prevHoldWhole.set(id, whole);
}

function setObjectiveText(text: string, state: string) {
  if (text === lastObjective && objectivePanel.dataset.state === state) return;
  lastObjective = text;
  objectiveEl.textContent = text;
  objectivePanel.dataset.state = state;
  objectivePanel.classList.remove('changed');
  void objectivePanel.offsetWidth;
  objectivePanel.classList.add('changed');
}

function renderTimer(obj: ObjectiveState | undefined, info: WorldInfo, won: boolean) {
  const timed = info.mode === 'time_trial' || info.mode === 'survival';
  if (!timed) { timerEl.hidden = true; return; }
  timerEl.hidden = false;
  const lost = !!obj?.lost;
  const remaining = typeof obj?.remainingSec === 'number' && Number.isFinite(obj.remainingSec) ? Math.max(0, obj.remainingSec) : (info.timeLimitSec ?? 0);
  if (lost) {
    timerValueEl.textContent = '00:00';
    timerLabelEl.textContent = 'Time is up';
    timerEl.dataset.level = 'expired';
    return;
  }
  timerValueEl.textContent = mmss(remaining);
  timerLabelEl.textContent = '';
  timerEl.dataset.level = won ? 'done' : remaining < 10 ? 'red' : remaining < 20 ? 'amber' : 'calm';
}

function renderHolds(tick: TickMessage, obj: ObjectiveState | undefined, info: WorldInfo) {
  if (info.mode !== 'king_of_the_hill') { holdsEl.hidden = true; return; }
  holdsEl.hidden = false;
  const target = Math.max(1, obj?.holdTarget ?? info.holdSeconds);
  const bySlot = new Map<number, TickMessage['players'][number]>();
  for (const p of tick.players ?? []) bySlot.set(p.slot, p);
  holdRings.forEach((ring, slot) => {
    const p = bySlot.get(slot);
    if (!p) {
      ring.row.classList.add('empty');
      ring.row.classList.remove('full');
      ring.row.style.removeProperty('--ring-color');
      ring.name.textContent = `Player ${slot + 1}`;
      ring.secs.textContent = '0 s';
      ring.arc.setAttribute('stroke-dashoffset', RING_C.toFixed(2));
      return;
    }
    const held = Math.max(0, obj?.holdSec?.[p.id] ?? 0);
    const frac = Math.min(1, held / target);
    ring.row.classList.remove('empty');
    ring.row.classList.toggle('full', frac >= 1);
    ring.row.style.setProperty('--ring-color', safeColor(p.color));
    ring.name.textContent = p.label;
    ring.secs.textContent = `${Math.floor(Math.min(held, target))} s`;
    ring.arc.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(2));
    ring.row.setAttribute('aria-label', `${p.label} held the hill for ${Math.floor(held)} of ${target} seconds`);
  });
}

function renderHazard(obj: ObjectiveState | undefined, info: WorldInfo) {
  if (info.mode !== 'survival') { hazardEl.hidden = true; return; }
  hazardEl.hidden = false;
  const elev = typeof obj?.hazardElevation === 'number' && Number.isFinite(obj.hazardElevation) ? obj.hazardElevation : info.hazardBase;
  const frac = Math.min(1, Math.max(0, (elev - info.hazardBase) / (info.hazardMax - info.hazardBase)));
  hazardFillEl.style.width = `${(frac * 100).toFixed(1)}%`;
  hazardEl.dataset.level = frac > 0.8 ? 'high' : frac > 0.4 ? 'mid' : 'low';
  hazardEl.setAttribute('aria-label', `${info.hazardKind === 'lava' ? 'Lava' : 'Water'} at ${Math.round(frac * 100)} percent of its rise`);
}

function renderGems(tick: TickMessage, info: WorldInfo, collected: number, nextId: string | null | undefined) {
  const relicStates = tick.relics ?? {};
  if (info.mode === 'checkpoint_race') {
    // Gems in world order: lit when that relic is collected, the next one highlighted.
    gemEls.forEach((gem, i) => {
      const relic = info.relicOrder[i];
      const on = !!relic && relicStates[relic.id] === 'collected';
      gem.classList.toggle("hidden", !relic);
      gem.classList.toggle('on', on);
      gem.classList.toggle('next', !!relic && !on && relic.id === nextId);
    });
    gemsEl.setAttribute('aria-label', `${collected} of ${info.relicOrder.length} checkpoints passed`);
    return;
  }
  const shown = info.mode === 'relic_hunt' ? info.relicsRequired : Math.max(info.relicOrder.length, 1);
  gemEls.forEach((gem, i) => {
    gem.classList.toggle("hidden", i >= shown);
    gem.classList.toggle('on', i < collected);
    gem.classList.remove('next');
  });
  gemsEl.setAttribute('aria-label', `${Math.min(collected, shown)} of ${shown} relics collected`);
}

let outcomeShown: 'won' | 'lost' | null = null;
function renderOutcome(result: 'won' | 'lost' | null, info: WorldInfo, score: number) {
  if (result === null) {
    if (outcomeShown !== null) { outcomeShown = null; outcomeEl.hidden = true; }
    return;
  }
  outcomeScoreEl.textContent = String(score);
  if (result === outcomeShown) return;
  outcomeShown = result;
  outcomeEl.hidden = false;
  outcomeEl.dataset.result = result;
  outcomeSubEl.textContent = '';
  if (result === 'won') {
    outcomeKickerEl.textContent = 'Won';
    outcomeTitleEl.textContent = WON_TITLES[info.mode];
  } else {
    outcomeKickerEl.textContent = 'Time is up';
    outcomeTitleEl.textContent = info.mode === 'survival' ? `The ${info.hazardKind} took the islands` : 'The gate stayed closed';
  }
}

function onTick(tick: TickMessage) {
  try { renderer.applyTick(tick); } catch (err) { console.error('[beetle renderer] tick failed', err); }
  const info = worldInfo ?? readWorldInfo({ relics: [], hazard: undefined } as unknown as WorldSpec);
  const obj: ObjectiveState | undefined = tick.objective && typeof tick.objective === 'object' ? tick.objective : undefined;
  const relicStates = Object.values(tick.relics ?? {});
  const collected = relicStates.filter((s) => s === 'collected').length;
  const score = tick.score ?? 0;
  scoreEl.textContent = String(score);

  const gate = tick.gate ?? { unlocked: false, won: false };
  tickSoundEvents(tick, collected, gate, obj, info);
  const lost = !gate.won && !!obj?.lost;
  const state = gate.won ? 'won' : lost ? 'lost' : gate.unlocked ? 'unlocked' : 'locked';

  const nextId = obj?.nextCheckpointId;
  renderGems(tick, info, collected, nextId);
  renderTimer(obj, info, gate.won);
  renderHolds(tick, obj, info);
  renderHazard(obj, info);

  let text: string;
  if (gate.won) {
    text = WON_TITLES[info.mode];
  } else if (lost) {
    text = 'Time is up';
  } else if (info.mode === 'king_of_the_hill') {
    text = `Hold the hill for ${obj?.holdTarget ?? info.holdSeconds} s`;
  } else if (info.mode === 'checkpoint_race') {
    const n = info.relicOrder.length;
    const nextIndex = nextId ? info.relicOrder.findIndex((r) => r.id === nextId) : -1;
    if (gate.unlocked || (nextIndex < 0 && collected >= n)) text = 'All checkpoints passed: reach the temple gate';
    else {
      const k = nextIndex >= 0 ? nextIndex + 1 : Math.min(n, collected + 1);
      const name = nextIndex >= 0 ? info.relicOrder[nextIndex].name : info.relicOrder[Math.min(n - 1, collected)]?.name ?? '';
      text = name ? `Checkpoint ${k} of ${n}: ${name}` : `Checkpoint ${k} of ${n}`;
    }
  } else if (gate.unlocked) {
    text = OBJECTIVE_OPEN;
  } else if (info.mode === 'time_trial' && info.timeLimitSec) {
    // the clock is the goal: say it, so a racing brief never reads as a plain relic hunt
    const n = info.relicsRequired;
    text = `${n === 1 ? 'Grab 1 relic' : `Grab ${n} relics`}, reach the temple before ${mmss(info.timeLimitSec)}`;
  } else {
    // Survival shows "The lava is rising" on the hazard meter below; the objective line stays the relic count.
    text = collectLine(info.relicsRequired);
  }
  setObjectiveText(text, state);
  renderOutcome(gate.won ? 'won' : lost ? 'lost' : null, info, score);

  const bySlot = new Map<number, TickMessage['players'][number]>();
  playerLabels.clear();
  for (const p of tick.players ?? []) { bySlot.set(p.slot, p); playerLabels.set(p.id, p.label); }
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
    chip.swatch.style.background = safeColor(p.color);
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
// Automatic streaming extensions: Beetle asks its own agent for new ground ahead of a player near an island edge.
// They get one quiet line instead of the phase readout, and never surface request or island ids.
const directorToken = takeDirectorToken();
const AUTO_PREFIX = 'extend the world';
const AUTO_LINGER_MS = 3000;
const AUTO_FADE_MS = 900;
type AutoInfo = { direction: string | null };
type AutoFields = { auto?: unknown; autoReason?: unknown; request?: unknown; requests?: unknown; requestId?: unknown; id?: unknown };
const autoRequests = new Map<string, AutoInfo>();
const autoChecked = new Map<string, 'pending' | 'done'>();
const DIRECTIONS: Record<string, string> = {
  n: 'north', north: 'north', s: 'south', south: 'south', e: 'east', east: 'east', w: 'west', west: 'west',
  ne: 'northeast', northeast: 'northeast', nw: 'northwest', northwest: 'northwest',
  se: 'southeast', southeast: 'southeast', sw: 'southwest', southwest: 'southwest',
  up: 'north', down: 'south', left: 'west', right: 'east',
  '+x': 'east', '-x': 'west', '+z': 'south', '-z': 'north', px: 'east', nx: 'west', pz: 'south', nz: 'north',
};
/** A compass word or nothing: the HUD never echoes free text or ids from the wire. */
function directionWord(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/([a-z])[\s_-]+(?=[a-z])/g, '$1');
  return DIRECTIONS[key] ?? null;
}
function directionFromText(text: string): string | null {
  const m = /\b(north[\s_-]?east|north[\s_-]?west|south[\s_-]?east|south[\s_-]?west|north|south|east|west)\b/i.exec(text);
  return m ? directionWord(m[1]) : null;
}
function autoReasonDirection(reason: unknown): string | null {
  return reason && typeof reason === 'object' ? directionWord((reason as { direction?: unknown }).direction) : null;
}
function markAuto(requestId: unknown, direction: string | null) {
  if (typeof requestId !== 'string' || !requestId) return;
  const known = autoRequests.get(requestId);
  autoRequests.set(requestId, { direction: direction ?? known?.direction ?? null });
  if (autoRequests.size > 200) autoRequests.delete(autoRequests.keys().next().value as string);
}
/** Request-shaped objects riding on the activity message or entry: { id, auto, autoReason }. */
function noteRequestLike(r: unknown, fallbackId?: unknown) {
  if (!r || typeof r !== 'object') return;
  const f = r as AutoFields;
  if (f.auto === true || (f.autoReason && typeof f.autoReason === 'object')) markAuto(typeof f.id === 'string' ? f.id : fallbackId, autoReasonDirection(f.autoReason));
}
function checkAutoByRequest(requestId: string) {
  if (!directorToken || autoChecked.has(requestId)) return;
  autoChecked.set(requestId, 'pending');
  if (autoChecked.size > 400) autoChecked.delete(autoChecked.keys().next().value as string);
  getDirectorRequest(directorToken, requestId).then((req) => {
    autoChecked.set(requestId, 'done');
    if (!req || req.auto !== true) return;
    markAuto(requestId, autoReasonDirection(req.autoReason));
    if (socket.activity[socket.activity.length - 1]?.requestId === requestId) renderAgent(false);
  }).catch(() => { autoChecked.set(requestId, 'done'); });
}
function noteAutoActivity(msg: ActivityMessage) {
  const m = msg as ActivityMessage & AutoFields;
  // Message-level flag: every entry in this message belongs to the automatic request.
  if (m.auto === true || (m.autoReason && typeof m.autoReason === 'object')) {
    const dir = autoReasonDirection(m.autoReason);
    for (const e of Array.isArray(msg.entries) ? msg.entries : []) if (e) markAuto(e.requestId, dir);
  }
  noteRequestLike(m.request);
  if (Array.isArray(m.requests)) for (const r of m.requests) noteRequestLike(r);
  for (const e of Array.isArray(msg.entries) ? msg.entries : []) {
    if (!e || typeof e.requestId !== 'string') continue;
    const f = e as AgentActivity & AutoFields;
    if (f.auto === true || (f.autoReason && typeof f.autoReason === 'object')) { markAuto(e.requestId, autoReasonDirection(f.autoReason)); continue; }
    noteRequestLike(f.request, e.requestId);
    if (autoRequests.get(e.requestId)?.direction) continue;
    // The server's own wording for an automatic request; with a director token the request record settles it.
    if (typeof e.message === 'string' && e.message.trim().toLowerCase().startsWith(AUTO_PREFIX)) markAuto(e.requestId, directionFromText(e.message));
    if (directorToken) checkAutoByRequest(e.requestId);
  }
}
function autoLine(info: AutoInfo, committed: boolean): string {
  if (committed) return info.direction ? `New ground to the ${info.direction}` : 'New ground ahead';
  return info.direction ? `Beetle is building ahead to the ${info.direction}` : 'Beetle is building ahead';
}
function hideAgentSoon(lingerMs: number, fadeMs: number) {
  agentTimer = window.setTimeout(() => {
    agentEl.classList.add('fade');
    agentTimer = window.setTimeout(() => { agentEl.hidden = true; agentEl.classList.remove('fade'); agentTimer = null; }, fadeMs);
  }, lingerMs);
}
function renderAgent(fresh: boolean) {
  const entries = socket.activity;
  if (entries.length === 0) return;
  const latest: AgentActivity = entries[entries.length - 1];
  const inFlight = IN_FLIGHT.has(latest.phase);
  const auto = autoRequests.get(latest.requestId) ?? null;
  // A late lookup only matters while that request is still the one on screen.
  if (!fresh && agentEl.hidden && !inFlight) return;
  clearAgentTimer();
  // Replayed history: do not resurface an old result on reconnect.
  if (!inFlight && agentEl.hidden && Date.now() - latest.at > STALE_TERMINAL_MS) return;
  if (auto && (latest.phase === 'failed' || latest.phase === 'cancelled')) {
    // Background work that did not land stays quiet: the line simply fades.
    if (agentEl.hidden) return;
    agentEl.classList.remove('busy');
    hideAgentSoon(0, AUTO_FADE_MS);
    return;
  }
  agentEl.hidden = false;
  agentEl.classList.remove('fade');
  agentEl.classList.toggle('busy', inFlight);
  agentEl.classList.toggle('auto', !!auto);
  agentEl.dataset.phase = latest.phase;
  if (auto) {
    agentPhase.textContent = '';
    agentMsg.textContent = autoLine(auto, latest.phase === 'committed');
  } else {
    agentPhase.textContent = agentPhaseLabel(latest);
    agentMsg.textContent = latest.message;
  }
  if (!inFlight) {
    if (auto) hideAgentSoon(AUTO_LINGER_MS, AUTO_FADE_MS);
    else hideAgentSoon(LINGER_MS, 700);
  }
}
function onActivity(msg: ActivityMessage) {
  activitySoundEvents(msg);
  noteAutoActivity(msg);
  renderAgent(true);
  updateBuildTiming();
}

// ---------- markers: forwarded to the renderer, with a quiet "<player> pinged" toast ----------
const TOAST_MS = 1500;
let toastTimer: number | null = null;
function showToast(text: string) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('show');
    toastTimer = window.setTimeout(() => { toastEl.hidden = true; toastTimer = null; }, 200);
  }, TOAST_MS);
}
function onMarker(m: MarkerMessage) {
  const r = renderer as { applyMarker?: (m: MarkerMessage) => void };
  try { r.applyMarker?.(m); } catch (err) { console.error('[beetle renderer] marker failed', err); }
  const label = playerLabels.get(m.playerId) ?? socket.tick?.players.find((p) => p.id === m.playerId)?.label ?? 'A player';
  showToast(`${label} pinged`);
}

socket.on('world', onWorld);
socket.on('tick', onTick);
socket.on('activity', onActivity);
socket.on('message', (m) => { if (m.type === 'marker') onMarker(m); });
socket.connect();

// ---------- debug overlay: backquote key or ?debug=1 ----------
let debugOn = false;
try { debugOn = new URLSearchParams(location.search).get('debug') === '1'; } catch { /* ignore */ }
function renderDebug() {
  const s = renderer.stats();
  const rtt = socket.rttMs === null ? 'n/a' : `${Math.round(socket.rttMs)} ms`;
  const age = s.tickAgeMs === null ? 'no ticks' : `${Math.round(s.tickAgeMs)} ms`;
  const latest = socket.activity[socket.activity.length - 1];
  const obj = socket.tick?.objective;
  const lines = [
    `conn      ${socket.state}`,
    `ws rtt    ${rtt}`,
    `tick age  ${age}`,
    `fps       ${Math.round(s.fps)}`,
    `meshes    ${s.meshes}`,
    `world     renderer v${s.worldVersion}, socket v${Math.max(0, socket.worldVersion)}`,
    `tick      ${socket.tick ? `#${socket.tick.tick}` : 'n/a'}`,
    `mode      ${worldInfo ? `${worldInfo.mode}, ${worldInfo.biome}` : 'n/a'}`,
    `objective ${obj ? JSON.stringify(obj) : 'n/a'}`,
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
const token = directorToken;
if (token) {
  const drawer = document.getElementById('join-drawer') as HTMLElement;
  const tab = document.getElementById('join-tab') as HTMLButtonElement;
  drawer.hidden = false;
  tab.addEventListener('click', () => {
    const open = drawer.classList.toggle('open');
    tab.setAttribute('aria-expanded', String(open));
  });
  // Open once, the first time a world appears, so the join QR codes are visible; the tab still toggles it after.
  let autoOpened = false;
  autoOpenJoin = () => {
    if (autoOpened) return;
    autoOpened = true;
    drawer.classList.add('open');
    tab.setAttribute('aria-expanded', 'true');
  };
  if (hasWorld) autoOpenJoin();
  const root = createRoot(document.getElementById('join-root') as HTMLElement);
  const render = () => root.render(createElement(JoinPanel, { token, controllers: socket.controllers, compact: false }));
  socket.on('controllers', render);
  render();
}

// Inspection hook for the integration owner (read-only use from the browser console).
(window as unknown as { __beetle?: unknown }).__beetle = { socket, renderer };
