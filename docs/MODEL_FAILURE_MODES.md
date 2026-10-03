# Model failure modes (qwen3.5:4b, current prompts)

Source: `tests/fixtures/corpus/summary.json`, built by `scripts/build-corpus.ts` (every number below is copied from
that file; the raw samples sit in `tests/fixtures/corpus/{draft,patch,probe}/*.json` and `tests/unit/corpus.test.ts`
replays all of them through the world pipeline on every test run). Nothing here is estimated.

## Run facts (honest scope)

| Item | Value |
|---|---|
| Model | qwen3.5:4b (Q4_K_M) on Ollama 127.0.0.1:11434, called directly (`/api/chat`, `stream false`, `think false`, `format` = JSON schema from `@beetle/contracts`, `num_ctx 8192`, `num_predict` 2048 drafts / 1536 patches) |
| Planned | 12 brief prompts x 2 temperatures (0.4, 0.8) x 3 samples = 72 drafts; 12 edit prompts x 2 x 3 = 72 patches; 4 concurrent requests |
| Stored | **30 samples** (15 drafts b01 to b08, 15 patches e01 to e08, one sample per prompt and temperature, sample index 0 only) plus 4 probe patches. 114 planned samples were never run |
| Why only 30 | The Ollama daemon was shared with other owners' benchmark and agent runs for the whole window (queue wait per request p50 51.5 s for drafts, 70.8 s for patches, max 136 s; compute totals 537 s drafts, 64 s patches versus 1948 s spent queued). The daemon was restarted externally at about 13:02:30 CDT, which turned 137 queued jobs into `fetch failed` in one second (those files were discarded by the resume pass). The resumed run (13:04:30 to 13:14:50 CDT) was stopped on the coordinator's request to free the GPU for the demo rehearsal. The summary was then recomputed from disk with `CORPUS_RESUME=1 CORPUS_BUDGET_SEC=0 CORPUS_PROBE=0` (no model calls; every stored sample re-validated against the current `packages/world`) |
| Temperature split | 0.4: 8 drafts, 8 patches; 0.8: 7 drafts, 7 patches. With one sample per cell the per-temperature differences below are **not** statistically meaningful; treat them as a first look |
| Exceptions thrown by the pipeline | **0** across 34 stored samples (`expandDraft`, `applyPatch`, `validateSpec`, `compileWorld`, `runPlayabilityChecks`) |

## How a sample is scored

Each sample is the raw `message.content` of one `/api/chat` call using the unchanged system prompts from
`packages/agent/src/prompts.ts` (`worldDraftSystemPrompt`, `patchDraftSystemPrompt` with
`describeWorld(garden5, buildSessionSummary(...))`). It then goes through the same boundary the server uses:

1. `JSON.parse` (a failure here was always a truncation: `done_reason: "length"`),
2. zod (`WorldDraftSchema` / `PatchDraftSchema`) on the raw object, recorded with error paths (kept as a report of
   what the model wrote; it is not the gate any more),
3. `expandDraft` (drafts) or `applyPatch` against garden5 (patches); both run `packages/world/src/normalize.ts` first,
   which maps display names and compass words to real ids, converts world coordinates and over-radius offsets, clamps
   widths, radii and centres, and pushes overlapping islands apart. Every correction is stored on the sample
   (`pipeline.*.normalizations`) and counted below as the raw failure it repaired, because the prompt still produced it,
4. `validateSpec`, then `compileWorld` + `runPlayabilityChecks`.

"Valid" means the validator and the playability checks both passed. A sample can show several failure modes.

## Validity by kind and temperature

| Cell | Samples | JSON parses | Raw zod ok | expandDraft / applyPatch ok | validateSpec ok | Valid (validator + playability) | Validity rate | Truncated | Wall p50 | Wall max | Output tokens p50 | Model tok/s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| draft @0.4 | 8 | 3 | 2 | 3 | 2 | 2 | 25% | 5 | 73.4 s | 136.0 s | 2048 | 50.7 |
| draft @0.8 | 7 | 5 | 4 | 5 | 3 | 3 | 42.9% | 2 | 83.7 s | 138.5 s | 1475 | 47.9 |
| patch @0.4 | 8 | 8 | 7 | 7 | 4 | 4 | 50% | 0 | 75.5 s | 139.4 s | 97 | 50.8 |
| patch @0.8 | 7 | 7 | 6 | 7 | 4 | 4 | 57.1% | 0 | 81.5 s | 137.7 s | 96 | 48.9 |
| draft (all) | 15 | 8 | 6 | 8 | 5 | 5 | 33.3% | 7 | 83.7 s | 138.5 s | 1986 | 49.5 |
| patch (all) | 15 | 15 | 13 | 14 | 8 | 8 | 53.3% | 0 | 81.5 s | 139.4 s | 97 | 49.9 |
| all | 30 | 23 | 19 | 22 | 13 | 13 | 43.3% | 7 | 81.5 s | 139.4 s | 751 | 49.5 |

Wall times are dominated by queueing behind other clients (see Run facts); the model itself ran at 48 to 51 output
tokens per second in every cell. Four of the seven patch rejections were the intended validator catches (e02 x2
UNREACHABLE_RELIC, e03 x2 GATE_HIDES_RELIC, e06 x2 BRIDGE_CROSSES_ISLAND are the prompts designed to be rejected), so
the patch validity rate on prompts that *should* pass is 8 of 9 (e08 failed on an invented relic id).

## Failure modes (number of samples showing the mode; one sample can show several)

| Failure mode | draft @0.4 | draft @0.8 | patch @0.4 | patch @0.8 | draft (all) | patch (all) | all |
|---|---|---|---|---|---|---|---|
| Invented ids, still INVALID_REFERENCE after normalisation | 0 | 0 | 1 | 0 | 0 | 1 | 1 |
| Invented ids, repaired by normalize.ts (name or compass mapped to a real id) | 0 | 0 | 4 | 4 | 0 | 8 | 8 |
| Coordinates out of range (island centre beyond the schema's ±60) | 0 | 1 | 0 | 0 | 1 | 0 | 1 |
| Coordinates clamped by normalize.ts | 0 | 1 | 0 | 0 | 1 | 0 | 1 |
| localPosition misuse (world coordinate outside ±20 in the raw output) | 0 | 0 | 1 | 1 | 0 | 2 | 2 |
| localPosition pulled inside the island by normalize.ts (world coordinate or over-radius offset) | 3 | 4 | 2 | 1 | 7 | 3 | 10 |
| Truncated output (`done_reason: length`, JSON unparseable) | 5 | 2 | 0 | 0 | 7 | 0 | 7 |
| Overlapping islands still ISLAND_OVERLAP after normalisation | 1 | 0 | 0 | 0 | 1 | 0 | 1 |
| Overlapping islands pushed apart by normalize.ts (drafts with at least one "moved apart" entry) | 3 | 3 | 0 | 0 | 6 | 0 | 6 |
| Unreachable relics (UNREACHABLE_RELIC) | 0 | 0 | 1 | 1 | 0 | 2 | 2 |
| Missing bridge to the gate island (DISCONNECTED_GOAL) | 0 | 1 | 0 | 0 | 1 | 0 | 1 |
| Gate hides a relic (GATE_HIDES_RELIC) | 0 | 0 | 1 | 1 | 0 | 2 | 2 |
| Bridge geometry (BRIDGE_CROSSES_ISLAND in all four cases) | 1 | 1 | 1 | 1 | 2 | 2 | 4 |
| Duplicate ids (DUPLICATE_ID) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Wrong enum or literal (hazard, decoration type, op) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Other raw schema error (bridge width 4.5 > 4; islandId "Temple Island" not a slug) | 1 | 0 | 0 | 1 | 1 | 1 | 2 |

Duplicate ids and wrong enums did not occur in 23 parsed samples: the JSON-schema grammar in `format` pins the enums,
and the model numbers its ids (`island_01`, `dec_16`). Every truncation happened in a draft while it was still
emitting decorations (16, 19, 28, 21, 18, 18 and 30 decorations written when the 2048-token budget ran out, at
4.4 to 5.0 kB of pretty-printed JSON). Parsed drafts contained 5 to 18 decorations. Island ids in drafts were
`snake_case` 44 times out of 45 (`west_island`, `ring_island_03`), never the `kebab-case` the fixtures use.

## Normalization (packages/world/src/normalize.ts) and what it bought

| Cell | Samples | Valid | Valid only because of normalization | of which raw zod had rejected | Valid without any normalization | Validity rate without normalization | Samples with at least one normalization | Total normalization entries |
|---|---|---|---|---|---|---|---|---|
| draft @0.4 | 8 | 2 | 2 | 0 | 0 | 0% | 3 | 400 |
| draft @0.8 | 7 | 3 | 3 | 1 | 0 | 0% | 5 | 273 |
| patch @0.4 | 8 | 4 | 3 | 0 | 1 | 12.5% | 5 | 18 |
| patch @0.8 | 7 | 4 | 3 | 0 | 1 | 14.3% | 4 | 15 |
| draft (all) | 15 | 5 | 5 | 1 | 0 | 0% | 8 | 673 |
| patch (all) | 15 | 8 | 6 | 0 | 2 | 13.3% | 9 | 33 |
| all | 30 | 13 | 11 | 1 | 2 | 6.7% | 17 | 706 |

Measured number for the pitch: **11 of the 13 valid samples (85%) are valid only because the world boundary
normalised the model's output; without normalisation the validity rate would be 2 of 30 (6.7%) instead of 13 of 30
(43.3%), and no draft at all would have passed.** The normaliser only rewrites what the schema or the validator
would otherwise reject, so "valid with at least one normalization" is the same as "would have failed raw".

Normalization entries by category (706 in total): overlapping islands moved apart 602 (iterative, see note below);
island reference resolved by name or direction 27 (`orchard-island` -> `east`, `lantern-island` -> `south`,
`"Temple Island"` -> `temple`); offset exceeded island radius, scaled 56; world coordinate converted to island offset
12; bridge width clamped to [1.6, 4] 6; island centre clamped 3.

Note for the world reviewer (observed, not fixed here): the push-apart pass records one entry per iteration per
island pair, so a single 8-island draft produced 139 entries (`b07-t04-s0`), most of them sub-millimetre
(`overlap 0.001 m`). It also did not converge in `b04-t04-s0` (ISLAND_OVERLAP still reported at 0.249 m after 136
entries) and it moved a ring of islands 14.87 m in `b04-t08-s0`, after which the gate island was disconnected
(DISCONNECTED_GOAL). The agent UI will want these collapsed to one entry per island with the net displacement.

## What the failure modes look like in the raw output

- Invented ids (patches, 9 of 15): the model slugifies the display name it was given. `e01`:
  `"from": "orchard-island", "to": "lantern-island"` (real ids `east`, `south`); `e07`: `"islandId": "orchard-island"`;
  `e03 @0.8`: `"islandId": "Temple Island"` (fails the slug regex, then resolved). The one that survived
  normalisation, `e08-t04-s0`: `"op": "move_relic", "id": "relic-star"` for the Star Relic whose id is `relic-south`
  (INVALID_REFERENCE[relic-star]); the prompt listed `relic-south` under `relics:` but the name "Star Relic" only
  appears in the fixture, so the model guessed a slug.
- World coordinates in `localPosition` (patches e03 x2, drafts b01, b05): `"localPosition": {"x": 0.5, "z": 28.5}`
  for "beside the shrine on the Temple Island" (temple centre is (0, 28)); draft `b05-t08-s0` put both spawns at
  `{"x": -15, "z": -3}` and a relic at `{"x": -20, "z": 0}` on an island of radius 8 (the island row starts at
  x = -36, so these are not world coordinates either, just offsets copied from the island spacing).
- Over-radius offsets (drafts, 7 of 8 parsed): `b01-t08-s0` relics at `{"x": 3, "z": 10}` and `{"x": 3, "z": -15}`
  on radius-9 islands; the normaliser scales them to radius - 1.2.
- Island centres out of the schema range: `b02-t08-s0` sixth island at `{"x": 75, "z": 65}` after the brief said
  "north-east corner" (clamped to 50, 50, then the next island overlapped it).
- Overlaps: `b04-t04-s0` eight ring islands with `radius 12` at 30 m from the origin (neighbours 23 m apart, so they
  overlap by 1 m and bridge widths of 4.5 exceed the limit); `b01-t04-s0` four radius-10 islands at 20 m from the
  origin (0.12 m apart).
- Gate rule: `b04-t08-s0` put the gate on `ring_island_08` and bridged the ring everywhere except to that island.
  `e03` both temperatures moved the Sun Relic onto the temple exactly as asked, which the validator correctly rejects
  with GATE_HIDES_RELIC; `e06` both temperatures drew the east-west bridge straight through the centre island.
- Truncation: every truncated draft ends mid-decoration, for example `b02-t04-s0` after `"id": "dec_16"`, with
  pretty-printed JSON (two-space indentation, one key per line) at 2048 tokens.

## Throughput and concurrency

- Model speed was flat at 48 to 51 output tokens per second in every cell (eval-time measure, independent of
  queueing). A 2048-token draft therefore costs about 42 s of GPU time; a 100-token patch about 2 s plus 0.3 s of
  prompt evaluation for the 770-token patch system prompt.
- Concurrency probe (2 identical e05 patch requests, 0.4): sequential 60.6 s wall, concurrent 31.3 s wall,
  **speedup 1.94x**; per-request eval was unchanged (1325/1344 ms sequential vs 1287/1340 ms concurrent) and
  per-request wall was 29 to 31 s in both phases. The speedup is entirely queue amortisation on the shared daemon
  (both concurrent requests waited the same 28 s behind other clients), not GPU batching; the daemon reported
  `context_length 8192` for the loaded model, consistent with `OLLAMA_NUM_PARALLEL` 1, so with the daemon to itself
  four concurrent callers would only hide client latency, not add throughput. The first smoke run before the probe
  (one draft and one patch issued together) confirmed serialisation: the 112-token patch finished 2.4 s after the
  57.6 s draft, not before it.
- Main loop under contention: 30 samples in about 12 minutes of wall time with 4 in flight; queue wait total
  1948 s versus compute total 601 s.

## Recommendations for `packages/agent/src/prompts.ts`

Ordered by how much of the measured failure they address. None of these change the schema or the validator.

1. **Put the id table first, in a fixed form, and say "use ids exactly as listed".** 9 of 15 patches referenced an
   island, relic or decoration by a slug of its display name. The patch prompt currently writes
   `island east "Orchard Island" east at (24, 0) r=7; ...`; the model reads the name, not the id. Replace the prose
   with a table the model can copy from, and include every relic and decoration name next to its id (the `relic-star`
   failure happened because the relic names are not in the prompt at all):

   ```
   ids you may use (copy them exactly; never invent or slugify a name):
   island id | name            | compass | radius | max offset | bridges
   centre    | Hearth Island   | centre  | 9      | 7.5        | bridge-north, bridge-east, bridge-west, bridge-south
   east      | Orchard Island  | east    | 7      | 5.5        | bridge-east
   relic id    | name       | on island
   relic-south | Star Relic | south
   decoration id | type | on island | offset
   rock-1        | rock | east      | (-1, 4)
   ```

   End the system prompt with `Allowed islandId values: centre, temple, east, west, south.` The normaliser now catches
   the unambiguous cases; the prompt should not rely on it, because names that share a word stay ambiguous.

2. **Island-relative offsets with an explicit radius table.** 10 of 30 samples wrote a world coordinate or an
   over-radius offset into `localPosition`. State the rule as a formula with a worked number, `localPosition is
   measured from the island centre; |x| and |z| must each be <= radius - 1.5 (radius 7 -> at most 5.5)`, and repeat
   the per-island maximum next to each id as in the table above. For briefs, ask the model to write the island list
   first and then only reuse those radii.

3. **Cap decorations hard, and ask for compact JSON.** 7 of 15 drafts (47%) hit `num_predict` while still listing
   decorations (16 to 30 written), with pretty-printed JSON at about 2.3 characters per token. Say `at most 8
   decorations in total, at most 2 per island` and `output minified JSON on one line`; both together bring a
   6-island draft to about 900 tokens and leave head-room under 2048. The same wording keeps a 12-op patch under the
   1536-token patch budget.

4. **One worked example per prompt.** A single short valid `WorldDraft` (4 islands, 3 bridges, both spawns on one
   island, 3 relics, gate on its own island with one bridge, 2 decorations) and a single two-op `PatchDraft` using
   real garden5 ids. The 4B model copies structure far more reliably than it follows prose; the example also fixes
   the id style (`centre`, `relic-east`) so it stops generating `west_island` / `dec_16`.

5. **Make the ring geometry arithmetic explicit.** Both eight-island drafts overlapped because the model chose
   `radius 12` for islands 23 m apart. Give the formula once: `centre distance >= r1 + r2 + 1, and <= r1 + r2 + 36`,
   and add `for N islands on a ring of radius R the neighbour distance is about 6.28 R / N, so pick radii below half
   of that`. For corner briefs (±45) warn that a corner-to-centre bridge is longer than 36 m.

6. **Make the gate rule a checklist.** "Put the gate on its own island with exactly one bridge" produced a gate
   island with no bridge at all (`b04-t08-s0`). State it in order: `(a) gate island has exactly one bridge; (b) no
   relic and no spawn on the gate island; (c) every other island reaches the spawn island through bridges`.

7. **Repair messages must restate the id table and the radius.** `validatorRepairPrompt` quotes codes and object ids
   but not the allowed ids; in docs/RESULTS.md the second attempt repeated the same invented id (E2, E3, E6). Append
   `allowed ids: ...` whenever INVALID_REFERENCE is present, and for OBJECT_NOT_ON_SURFACE the radius of the island.

8. **Temperature.** In this corpus 0.8 was not worse than 0.4 for either kind (3/7 vs 2/8 drafts, 4/7 vs 4/8
   patches, with 5 vs 2 truncations at 0.4), but one sample per cell cannot separate the two; keep 0.4 for patches
   (nothing in an edit benefits from sampling noise) until a full 3-sample run says otherwise.

## Things the corpus did not measure

- Intent adherence (did the world match the brief) beyond what the validator checks.
- Live-player constraints (PLAYER_CUT_OFF, OCCUPIED_SUPPORT): no session state was attached.
- Repair loops: every sample is a first attempt; the agent's repair prompts were not exercised.
- Prompts b09 to b12 and e09 to e12 (never reached before the run was stopped), and samples 1 and 2 of every cell.
  Re-run with `npx tsx scripts/build-corpus.ts` on an idle daemon (about 55 minutes of GPU time for the full 144) or
  `CORPUS_RESUME=1` to fill only the missing cells.
