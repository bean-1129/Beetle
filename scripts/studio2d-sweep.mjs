// Studio2D level sweep: generate worlds across many seeds for every genre and report how many
// levels the playtest bot finishes on the first or second try.
//   node scripts/studio2d-sweep.mjs [seeds=40] [genre]
import { buildWorld } from "../apps/web/src/studio2d/world/levels.ts";

const seeds = Number(process.argv[2] || 40);
const only = process.argv[3];
const genres = only ? [only] : ["platformer", "runner", "top-down", "arena", "puzzle", "builder", "defense"];
let all = 0, allPass = 0;
for (const genre of genres) {
  let total = 0, first = 0, second = 0;
  const fails = [];
  const t0 = Date.now();
  for (let seed = 1; seed <= seeds; seed++) {
    const theme = { title: `Sweep ${genre} ${seed}`, pitch: "", genre, hero: "fox", setting: "forest" };
    const { reports } = buildWorld(theme, { seed, count: 3, difficulty: 0.3 + ((seed * 37) % 60) / 100 });
    for (const r of reports) {
      total++;
      if (r.passed && r.attempts === 1) first++;
      if (r.passed && r.attempts <= 2) second++;
      else fails.push(`seed ${seed} ${r.id}: ${r.attempts} tries, ${r.reason}`);
    }
  }
  all += total;
  allPass += second;
  console.log(`${genre.padEnd(10)} levels ${total}  first try ${((first / total) * 100).toFixed(1)}%  within two ${((second / total) * 100).toFixed(1)}%  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const f of fails.slice(0, 5)) console.log(`   ${f}`);
}
console.log(`all genres: ${allPass}/${all} = ${((allPass / all) * 100).toFixed(1)}% within two tries`);
