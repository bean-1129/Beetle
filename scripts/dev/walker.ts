// Scripted controller for rehearsals: joins via invite and keeps a player walking back and forth on its island.
// Usage: BEETLE_SERVER_URL=http://127.0.0.1:7781 BEETLE_DIRECTOR_TOKEN=... npx tsx scripts/dev/walker.ts [seconds] [axis x|z]
import WebSocket from 'ws';

const server = process.env.BEETLE_SERVER_URL ?? 'http://127.0.0.1:7781';
const token = process.env.BEETLE_DIRECTOR_TOKEN ?? '';
const seconds = Number(process.argv[2] ?? 600);
const axis = (process.argv[3] ?? 'x') as 'x' | 'z';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const invite = await (await fetch(`${server}/api/director/invite`, { method: 'POST', headers })).json();
const joined = await (await fetch(`${server}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteCode: invite.inviteCode }) })).json();
console.log(`joined as ${joined.label} (${joined.playerId})`);

const ws = new WebSocket(server.replace(/^http/, 'ws') + '/ws');
let seq = 0;
let dir = 1;
let lastTick = Date.now();
let ticks = 0;
let worldVersion = -1;
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', role: 'controller', token: joined.controllerToken }));
  const start = Date.now();
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const t = (Date.now() - start) / 1000;
    if (Math.floor(t / 1.6) % 2 === 0) dir = 1; else dir = -1;
    const axes = axis === 'x' ? { x: dir, z: 0 } : { x: 0, z: dir };
    ws.send(JSON.stringify({ type: 'input', seq: ++seq, axes, interact: false, t: Date.now() }));
    if (t > seconds) { clearInterval(timer); ws.send(JSON.stringify({ type: 'input', seq: ++seq, axes: { x: 0, z: 0 }, interact: false })); setTimeout(() => ws.close(), 200); }
  }, 50);
});
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'tick') {
    ticks++; lastTick = Date.now();
    if (m.worldVersion !== worldVersion) { worldVersion = m.worldVersion; console.log(`world v${worldVersion} (tick ${m.tick}) relics=${JSON.stringify(m.relics)} score=${m.score}`); }
    if (ticks % 300 === 0) { const me = m.players.find((p: { id: string }) => p.id === joined.playerId); console.log(`alive: ${me ? `${me.x.toFixed(1)},${me.z.toFixed(1)} on ${me.supportId} ${me.status}` : 'missing'}`); }
  } else if (m.type === 'error') console.log('error', m.code, m.message);
});
ws.on('close', (code) => { console.log(`closed ${code} after ${ticks} ticks, last tick ${Date.now() - lastTick} ms ago`); process.exit(0); });
