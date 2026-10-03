import { getHealth, describeError } from '../shared/api.ts';
import { wordmarkHtml } from '../shared/Wordmark.tsx';

const el = (id: string) => document.getElementById(id) as HTMLElement;
el('wordmark').innerHTML = wordmarkHtml(48);

async function refresh() {
  try {
    const h = await getHealth();
    const publicUrl = el('publicUrl');
    publicUrl.textContent = '';
    const a = document.createElement('a');
    a.href = h.publicUrl;
    a.textContent = h.publicUrl;
    publicUrl.appendChild(a);
    el('world').textContent = h.hasWorld ? `v${h.worldVersion}, ${h.players} player slots, ${h.connectedControllers} controllers connected` : 'no world yet (ask the director for a brief)';
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
