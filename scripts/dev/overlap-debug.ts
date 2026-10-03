import { readdirSync, readFileSync } from 'node:fs';
import { expandDraft, validateSpec, normalizeDraft } from '@beetle/world';
const dir = 'tests/fixtures/corpus/draft';
for (const f of readdirSync(dir)) {
  const sample = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  const raw = sample.raw ?? sample.rawContent ?? sample.content;
  let obj: any; try { obj = JSON.parse(raw); } catch { continue; }
  const r = expandDraft(obj, { seed: 1, worldId: 'c' });
  const issues = r.ok ? validateSpec(r.spec).issues : r.issues;
  const ov = issues.filter((i) => i.code === 'ISLAND_OVERLAP');
  if (ov.length) {
    const n = normalizeDraft(obj);
    const isl = (n.draft as any).islands.map((i: any) => `${i.id}(${i.center.x},${i.center.z},r${i.radius})`).join(' ');
    console.log(f, ov[0].message, '| normalizations:', n.normalizations.length, '|', isl);
  }
}
