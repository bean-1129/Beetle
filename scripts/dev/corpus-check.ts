import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { expandDraft, validateSpec, applyPatch, fixtureWorld } from '@beetle/world';
const root = 'tests/fixtures/corpus';
const g5 = fixtureWorld('garden5');
for (const kind of ['world', 'draft', 'brief', 'patch', 'edit']) {
  const dir = `${root}/${kind}`;
  if (!existsSync(dir)) continue;
  let total = 0, parsed = 0, ok = 0; const codes: Record<string, number> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const sample = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    const raw = sample.raw ?? sample.rawContent ?? sample.content ?? sample.response?.content;
    if (typeof raw !== 'string') continue;
    total++;
    let obj: unknown; try { obj = JSON.parse(raw); } catch { continue; }
    parsed++;
    let issues: { code: string }[] = [];
    if (kind === 'patch' || kind === 'edit') {
      const r = applyPatch(g5, obj as never);
      if (!r.ok) issues = r.issues; else { const v = validateSpec(r.spec); if (!v.ok) issues = v.issues; }
    } else {
      const r = expandDraft(obj, { seed: 1, worldId: 'c' });
      if (!r.ok) issues = r.issues; else { const v = validateSpec(r.spec); if (!v.ok) issues = v.issues; }
    }
    if (issues.length === 0) ok++; else for (const i of issues.slice(0, 3)) codes[i.code] = (codes[i.code] ?? 0) + 1;
  }
  console.log(`${kind}: samples=${total} jsonParsed=${parsed} validAfterNormalization=${ok}`, JSON.stringify(codes));
}
