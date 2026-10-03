// Writes every fixture world to tests/fixtures/<name>.json so other packages and tools can load them without TypeScript.
// Run: npx tsx tests/fixtures/write-fixtures.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIXTURE_NAMES, fixtureWorld } from '@beetle/world';

for (const name of FIXTURE_NAMES) {
  const path = fileURLToPath(new URL(`./${name}.json`, import.meta.url));
  writeFileSync(path, JSON.stringify(fixtureWorld(name), null, 2) + '\n');
  console.log('wrote', path);
}
