// Live run record: sends fresh prompts to a running Beetle server as the director and records every attempt honestly.
// Usage: npx tsx scripts/run-prompts.ts [--only briefs|edits] [--ids E1,B2] [--prompt "text" [--kind brief|edit]] [--repeat N]
// Needs a running server (BEETLE_SERVER_URL) with a connected agent worker. It never starts them.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, type AgentActivity, type BuildReport, type DirectorRequest, type RequestKind } from '@beetle/contracts';

type PromptDef = { id: string; kind: RequestKind; prompt: string; expected: string };
// Human copy with rationale: docs/PROMPTS.md. Keep both in sync.
const PROMPTS: PromptDef[] = [
  { id: 'E1', kind: 'edit', expected: 'pass', prompt: 'Add a second route: a 3 metre wide bridge from the Orchard Island in the east straight to the Lantern Island in the south, and retitle the world "Orchard Loop".' },
  { id: 'E2', kind: 'edit', expected: 'fail first: UNREACHABLE_RELIC, then repair', prompt: 'Remove the narrow western bridge, but keep the Moon Relic collectable.' },
  { id: 'E3', kind: 'edit', expected: 'fail first: GATE_HIDES_RELIC', prompt: 'Move the Sun Relic onto the Temple Island, right beside the shrine.' },
  { id: 'E4', kind: 'edit', expected: 'pass', prompt: 'Plant a ring of six bushes around the edge of the Hearth Island, well clear of the four bridge mouths, and add one lantern next to each spawn.' },
  { id: 'E5', kind: 'edit', expected: 'pass', prompt: 'Make the fall deadly: the hazard beneath the islands becomes lava. Rename the world "Ember Garden" to match.' },
  { id: 'E6', kind: 'edit', expected: 'fail first: BRIDGE_CROSSES_ISLAND', prompt: 'Add a straight bridge from the Orchard Island in the east directly across to the Mossy Island in the west.' },
  { id: 'B1', kind: 'brief', expected: 'pass', prompt: 'Four islands arranged in a diamond with water below. Both spawns on the west island, the gate on the east island, one relic each on the north, south and west islands. Bridge every island to its two ring neighbours so there are two ways round. Title it "Diamond Pond".' },
  { id: 'B2', kind: 'brief', expected: 'pass', prompt: 'A chain of six small islands running from the south-west corner to the north-east corner, each linked to the next by one bridge, lava below. Spawns on the first island, the gate on the last, relics on the second, fourth and fifth islands. A few rocks and bushes at the edges, never on the bridge mouths. Title it "Ember Chain".' },
  { id: 'B3', kind: 'brief', expected: 'pass', prompt: 'Seven islands in a ring around an empty centre with no island in the middle, water below. Each island is bridged only to its two ring neighbours. Spawns on the southern island, the gate on the northern island, three relics on three different islands spread around the ring. One shrine on each relic island.' },
  { id: 'B4', kind: 'brief', expected: 'pass', prompt: 'Eight islands on a two by four grid, lava below, bridges forming a ladder: every island joined to its grid neighbours. Spawns on the bottom-left island, the gate on the top-right island, relics in three different grid cells away from the spawn. A pillar on each corner island.' },
  { id: 'B5', kind: 'brief', expected: 'pass', prompt: 'Two separate starting islands far to the east and far to the west, one spawn on each, both bridged to a shared middle island that holds the gate. Three relics on three outlying islands to the north and south of the middle, each reachable by its own bridge. Water below and trees on the starting islands.' },
  { id: 'B6', kind: 'brief', expected: 'pass', prompt: 'Six islands with lava below. A main causeway of four islands running west to east joined by wide bridges, and two side islands hanging off the second and third causeway islands by narrow bridges. Spawns on the west end, the gate on the east end, relics on both side islands and on the third causeway island. Bushes and rocks away from the bridge mouths. Title it "Ember Causeway".' },
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_URL = (process.env.BEETLE_SERVER_URL ?? 'http://127.0.0.1:7700').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.BEETLE_RUN_TIMEOUT_MS ?? 240_000);
const POLL_MS = 1000;

type Attempt = {
  id: string; kind: RequestKind; prompt: string; expected: string; repeat: number;
  requestId: string | null; status: string; error?: { code: string; message: string } | string;
  worldVersionBefore: number | null; worldVersionAfter: number | null; elapsedMs: number;
  activity: AgentActivity[]; report: BuildReport | null; startedAt: string;
};

function parseArgs(argv: string[]) {
  const out: { only?: 'briefs' | 'edits'; ids?: string[]; prompt?: string; kind: RequestKind; repeat: number } = { kind: 'edit', repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--only') { const v = next(); if (v !== 'briefs' && v !== 'edits') throw new Error('--only must be briefs or edits'); out.only = v; }
    else if (a === '--ids') out.ids = next().split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--prompt') out.prompt = next();
    else if (a === '--kind') { const v = next(); if (v !== 'brief' && v !== 'edit') throw new Error('--kind must be brief or edit'); out.kind = v; }
    else if (a === '--repeat') { out.repeat = Number.parseInt(next(), 10); if (!(out.repeat >= 1)) throw new Error('--repeat must be >= 1'); }
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function directorToken(): Promise<string> {
  const fromEnv = process.env.BEETLE_DIRECTOR_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = path.join(process.env.BEETLE_DATA_DIR ?? path.join(REPO_ROOT, 'data'), 'secrets.json');
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { directorToken?: unknown };
    if (typeof parsed.directorToken === 'string' && parsed.directorToken.length >= 8) return parsed.directorToken;
  } catch { /* fall through */ }
  throw new Error(`director token not found: set BEETLE_DIRECTOR_TOKEN or create ${file}`);
}

type HttpResult = { status: number; body: any };
async function http(method: string, route: string, token: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(SERVER_URL + route, {
    method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed };
}

async function health(): Promise<any> {
  const res = await fetch(SERVER_URL + ROUTES.health, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${ROUTES.health} returned HTTP ${res.status}`);
  return res.json();
}

/** The request record may come back bare or wrapped as { request }. */
function asRequest(body: any): DirectorRequest | null {
  const r = body && typeof body === 'object' ? (body.request ?? body) : null;
  return r && typeof r.id === 'string' && typeof r.status === 'string' ? (r as DirectorRequest) : null;
}
function asList<T>(body: any, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && Array.isArray(body[key])) return body[key] as T[];
  return [];
}

async function runOne(def: PromptDef, repeat: number, token: string): Promise<Attempt> {
  const t0 = Date.now();
  const attempt: Attempt = {
    id: def.id, kind: def.kind, prompt: def.prompt, expected: def.expected, repeat, requestId: null, status: 'not_sent',
    worldVersionBefore: null, worldVersionAfter: null, elapsedMs: 0, activity: [], report: null, startedAt: new Date(t0).toISOString(),
  };
  try {
    attempt.worldVersionBefore = (await health()).worldVersion ?? null;
    const body: Record<string, unknown> = { kind: def.kind, prompt: def.prompt };
    if (def.kind === 'brief') body.authorizeNewWorld = true;
    const created = await http('POST', ROUTES.directorRequest, token, body);
    const req = asRequest(created.body);
    if (created.status >= 300 || !req) {
      attempt.status = 'rejected';
      attempt.error = `POST ${ROUTES.directorRequest} -> HTTP ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`;
      return attempt;
    }
    attempt.requestId = req.id;
    attempt.status = req.status;
    const deadline = t0 + TIMEOUT_MS;
    let activity: AgentActivity[] = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const polled = await http('GET', ROUTES.directorRequestById.replace(':id', req.id), token);
      const cur = asRequest(polled.body);
      if (!cur) { attempt.error = `GET request -> HTTP ${polled.status}: ${JSON.stringify(polled.body).slice(0, 200)}`; continue; }
      attempt.status = cur.status;
      if (cur.error) attempt.error = cur.error;
      if (Array.isArray(polled.body?.activity)) activity = polled.body.activity; // server returns { request, activity }
      if (cur.status === 'committed' || cur.status === 'failed' || cur.status === 'cancelled') break;
    }
    if (!['committed', 'failed', 'cancelled'].includes(attempt.status)) attempt.status = `timeout(${attempt.status})`;
    if (activity.length === 0) { // fallback: the global ring, filtered by request id
      const act = await http('GET', `${ROUTES.directorActivity}?limit=500`, token);
      activity = asList<AgentActivity>(act.body, 'entries');
    }
    attempt.activity = activity.filter((a) => a.requestId === req.id)
      .map(({ phase, message, codes, objectIds, elapsedMs, tool, worldVersion, at, id, requestId }) => ({ id, requestId, phase, message, at, elapsedMs, worldVersion, tool, codes, objectIds }));
    const reports = await http('GET', ROUTES.directorReports, token);
    attempt.report = asList<BuildReport>(reports.body, 'reports').find((r) => r.requestId === req.id) ?? null;
    attempt.worldVersionAfter = (await health()).worldVersion ?? null;
  } catch (err) {
    attempt.status = attempt.requestId ? `error(${attempt.status})` : 'error';
    attempt.error = (err as Error).message;
  } finally {
    attempt.elapsedMs = Date.now() - t0;
  }
  return attempt;
}

function codesOf(a: Attempt): string {
  const codes = new Set<string>();
  for (const e of a.activity) for (const c of e.codes ?? []) codes.add(c);
  for (const c of a.report?.validation.failedCodes ?? []) codes.add(c);
  if (a.error && typeof a.error === 'object') codes.add(a.error.code);
  return [...codes].join(' ') || '-';
}

function table(attempts: Attempt[]): string {
  const lines = ['| Id | Kind | Status | Version | Codes | Attempts | Elapsed | Repairs |', '|---|---|---|---|---|---|---|---|'];
  for (const a of attempts) {
    const repairs = a.activity.filter((e) => e.phase === 'repairing').length;
    lines.push(`| ${a.id}${a.repeat > 1 ? `#${a.repeat}` : ''} | ${a.kind} | ${a.status} | v${a.worldVersionBefore ?? '?'} -> v${a.worldVersionAfter ?? '?'} | ${codesOf(a)} | ${a.report?.validation.attempts ?? '-'} | ${(a.elapsedMs / 1000).toFixed(1)} s | ${repairs} |`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let selected: PromptDef[] = args.prompt
    ? [{ id: 'ADHOC', kind: args.kind, prompt: args.prompt, expected: 'unspecified' }]
    : PROMPTS.filter((p) => (!args.only || (args.only === 'briefs' ? p.kind === 'brief' : p.kind === 'edit')) && (!args.ids || args.ids.includes(p.id)));
  if (args.ids && !args.prompt) selected = args.ids.map((id) => selected.find((p) => p.id === id)).filter((p): p is PromptDef => Boolean(p));
  if (selected.length === 0) throw new Error('no prompts selected');

  let h: any;
  try { h = await health(); } catch (err) {
    console.error(`Beetle server is not reachable at ${SERVER_URL} (${(err as Error).message}). Start it first: npm start`);
    process.exit(2);
  }
  if (!h.ok) { console.error(`Server at ${SERVER_URL} reports not ok: ${JSON.stringify(h)}`); process.exit(2); }
  if (!h.agentConnected) { console.error(`No agent worker is connected to ${SERVER_URL} (health.agentConnected is false). Start it first: npm run agent`); process.exit(2); }
  const token = await directorToken();
  const outDir = path.join(REPO_ROOT, 'data', 'prompt-runs');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `run-${Date.now()}.json`);
  const record = { startedAt: new Date().toISOString(), serverUrl: SERVER_URL, timeoutMs: TIMEOUT_MS, healthAtStart: h, args, attempts: [] as Attempt[], finishedAt: null as string | null };
  const save = () => writeFile(outFile, JSON.stringify(record, null, 2) + '\n');
  await save();
  console.log(`Server ${SERVER_URL} ok, world v${h.worldVersion}, model ${JSON.stringify(h.model ?? null)}; recording to ${outFile}`);
  for (let rep = 1; rep <= args.repeat; rep++) {
    for (const def of selected) {
      console.log(`\n[${def.id}${args.repeat > 1 ? `#${rep}` : ''}] ${def.kind}: ${def.prompt}`);
      const attempt = await runOne(def, rep, token);
      record.attempts.push(attempt);
      await save();
      for (const e of attempt.activity) console.log(`  ${String(e.elapsedMs).padStart(6)} ms ${e.phase.padEnd(20)} ${e.message}${e.codes?.length ? ' [' + e.codes.join(', ') + ']' : ''}${e.objectIds?.length ? ' {' + e.objectIds.join(', ') + '}' : ''}`);
      console.log(`  -> ${attempt.status} in ${attempt.elapsedMs} ms, v${attempt.worldVersionBefore} -> v${attempt.worldVersionAfter}${attempt.error ? ' error: ' + JSON.stringify(attempt.error) : ''}`);
    }
  }
  record.finishedAt = new Date().toISOString();
  await save();
  console.log('\n' + table(record.attempts) + `\n\nWrote ${outFile}`);
}

main().catch((err) => { console.error('run-prompts failed: ' + (err as Error).message); process.exit(1); });
