import { BIOMES, GAME_MODES, type Biome, type GameMode } from '@beetle/contracts';
import { getHealth, describeError } from '../shared/api.ts';
import { wordmarkHtml } from '../shared/Wordmark.tsx';

const el = (id: string) => document.getElementById(id) as HTMLElement;
el('wordmark').innerHTML = wordmarkHtml(48);

// ---------- director token: from ?token= on this URL, kept in memory and stripped from the address bar ----------
let token: string | null = null;
try {
  const url = new URL(location.href);
  const t = url.searchParams.get('token');
  if (t && t.length >= 8) {
    token = t;
    try { sessionStorage.setItem('beetle.directorToken', t); } catch { /* ignore */ }
    url.searchParams.delete('token');
    history.replaceState(history.state, '', url.pathname + (url.search ? url.search : '') + url.hash);
  }
} catch { /* ignore */ }
if (!token) {
  try { token = sessionStorage.getItem('beetle.directorToken'); } catch { token = null; }
  if (token && token.length < 8) token = null;
}

// ---------- prompt box with mode and biome chips ----------
const MODE_CHIPS: { mode: GameMode; label: string; phrase: string }[] = [
  { mode: 'relic_hunt', label: 'Relic hunt', phrase: 'a relic hunt across five garden islands' },
  { mode: 'time_trial', label: 'Time trial', phrase: 'a race across three islands with a 90 second limit' },
  { mode: 'king_of_the_hill', label: 'King of the hill', phrase: 'king of the hill on a frozen arena, hold 10 seconds' },
  { mode: 'checkpoint_race', label: 'Checkpoint race', phrase: 'a checkpoint race through desert ruins, relics in order' },
  { mode: 'survival', label: 'Survival', phrase: 'survive the rising lava for two minutes' },
];
const BIOME_CHIPS: { biome: Biome; label: string; phrase: string; words: RegExp }[] = [
  { biome: 'garden', label: 'Garden', phrase: 'in a quiet garden', words: /garden/i },
  { biome: 'volcanic', label: 'Volcanic', phrase: 'on black volcanic rock', words: /volcan|lava/i },
  { biome: 'frost', label: 'Frost', phrase: 'on a frozen arena', words: /frost|frozen|ice|snow/i },
  { biome: 'desert', label: 'Desert', phrase: 'among desert ruins', words: /desert|dune|sand/i },
  { biome: 'night', label: 'Night', phrase: 'under a night sky', words: /night|moon/i },
];
// Keep the chip lists honest against the contract: a mode or biome the engine drops disappears from the page.
const modeChips = MODE_CHIPS.filter((c) => (GAME_MODES as readonly string[]).includes(c.mode));
const biomeChips = BIOME_CHIPS.filter((c) => (BIOMES as readonly string[]).includes(c.biome));

const form = el('prompt-form') as HTMLFormElement;
const promptEl = el('prompt') as HTMLTextAreaElement;
const startBtn = el('start') as HTMLButtonElement;
const noteEl = el('start-note');
const navDirector = el('nav-director') as HTMLAnchorElement;

function makeChip(label: string, onPick: () => void, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', () => { onPick(); promptEl.focus(); updateNote(); });
  return b;
}
const modeChipsEl = el('mode-chips');
for (const c of modeChips) {
  modeChipsEl.appendChild(makeChip(c.label, () => {
    // A mode chip starts a fresh sentence; a biome chip appends a setting to it.
    promptEl.value = c.phrase;
  }, `Start from: ${c.phrase}`));
}
const biomeChipsEl = el('biome-chips');
for (const c of biomeChips) {
  biomeChipsEl.appendChild(makeChip(c.label, () => {
    const cur = promptEl.value.trim();
    if (c.words.test(cur)) return; // the sentence already names this biome
    promptEl.value = cur ? `${cur} ${c.phrase}` : `a relic hunt ${c.phrase}`;
  }, `Add: ${c.phrase}`));
}

function directorUrl(prompt: string): string {
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (prompt) params.set('prompt', prompt);
  const q = params.toString();
  return `/director${q ? `?${q}` : ''}`;
}
function updateNote() {
  if (!token) {
    noteEl.textContent = 'No director token on this link. The server prints the director link with its token at startup; open this page from that link.';
    noteEl.hidden = false;
    startBtn.textContent = 'Open the director';
    return;
  }
  noteEl.textContent = '';
  noteEl.hidden = true;
  startBtn.textContent = 'Start';
}
promptEl.addEventListener('input', updateNote);
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = promptEl.value.trim().slice(0, 1000);
  if (!token) {
    noteEl.textContent = 'No director token on this link. Open the director link printed by the server at startup; it carries the token.';
    noteEl.hidden = false;
    return;
  }
  location.assign(directorUrl(text));
});
navDirector.href = directorUrl('');
updateNote();

// ---------- server status ----------
async function refresh() {
  try {
    const h = await getHealth();
    const publicUrl = el('publicUrl');
    publicUrl.textContent = '';
    const a = document.createElement('a');
    a.href = h.publicUrl;
    a.textContent = h.publicUrl;
    publicUrl.appendChild(a);
    el('world').textContent = h.hasWorld ? `v${h.worldVersion}, ${h.connectedControllers} of ${h.players} controllers connected` : 'none yet';
    el('model').textContent = `${h.model.name}: ${h.model.present ? 'present' : 'not pulled'}, Ollama ${h.model.reachable ? 'reachable' : 'unreachable'}`;
    el('agent').textContent = h.agentConnected ? 'connected' : 'not claiming requests';
  } catch (err) {
    el('publicUrl').textContent = `server not reachable (${describeError(err)})`;
    el('world').textContent = 'unknown';
    el('model').textContent = 'unknown';
    el('agent').textContent = 'unknown';
  }
}

refresh();
setInterval(refresh, 5000);
