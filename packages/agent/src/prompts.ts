// System prompts for the local model. Short, convention-driven, no event-history replay.
import {
  BIOMES,
  COORDINATES,
  GAME_MODES,
  MODE_LIMITS,
  WORLD_LIMITS,
  PATCH_OP_NAMES,
  DECORATION_TYPES,
  HAZARD_KINDS,
  compassName,
  type SessionSummary,
  type WorldSpec,
} from '@beetle/contracts';
import type { IssueList } from './tools.ts';
import { STREAMING_BRIEF_RULE, briefWantsStreaming } from './expansion-prompts.ts';

const L = WORLD_LIMITS;
const M = MODE_LIMITS;

export const CONVENTION = [
  `Coordinates: walk plane ${COORDINATES.walkPlane}, up is ${COORDINATES.up}, north is ${COORDINATES.north}, east is ${COORDINATES.east}, units ${COORDINATES.units}, origin at the ${COORDINATES.origin}.`,
  `Islands are circles (center, radius ${L.island.minRadius} to ${L.island.maxRadius}) that must keep a gap of at least 1 m from each other. Keep every centre within plus or minus ${L.bounds.halfExtent - L.island.maxRadius - 2}.`,
  `Bridges join two different islands by id, width ${L.bridge.minWidth} to ${L.bridge.maxWidth}, length ${L.bridge.minLength} to ${L.bridge.maxLength} m between the island rims, and must not cross a third island.`,
  `Objects (spawns, relics, gate, decorations) sit on an island; localPosition is an offset from that island centre in metres (not a world position) and must stay within the island radius minus 1.5.`,
  `Ids are lowercase slugs (letters, digits, dash, underscore, max 32 chars) and unique across the whole world.`,
].join('\n');

/** One line per game mode: what the players do and what wins. Shared by the draft prompt and the OpenClaw instruction. */
export const MODE_LINES = [
  `relic_hunt: collect relicsRequired relics (default all ${L.relics}) then enter the gate.`,
  'time_trial: relic hunt against the clock; enter the gate before timeLimitSec runs out.',
  'king_of_the_hill: stand on the gate island (the hill) for holdSeconds in total; tag or capture maps here.',
  'checkpoint_race: pass the relics as checkpoints in order, then the gate; a race maps here.',
  'survival: the hazard rises after hazardRise.afterSec; stay out of it until timeLimitSec.',
].join(' ');

export const BIOME_LINE = `"biome" is one of ${BIOMES.join(', ')} (snow is frost, dark is night, sand is desert). "movementSpeed" is player speed in m/s, ${M.movementSpeed.min} to ${M.movementSpeed.max}, default ${M.movementSpeed.default}. timeLimitSec ${M.timeLimitSec.min} to ${M.timeLimitSec.max}, holdSeconds ${M.holdSeconds.min} to ${M.holdSeconds.max}, relicsRequired 1 to ${L.relics}.`;

export const MODE_RULE = 'Always set "terrain", "biome" and "mode" as top-level fields, e.g. "terrain":"ground","biome":"frost","mode":{"kind":"relic_hunt"},"movementSpeed":5. time_trial only when the brief names a clock. Use the biome the brief names. Set timeLimitSec, holdSeconds or relicsRequired only when the mode uses them. "hazardRise" only for survival. hazard is water unless the brief names lava or fire.';

/** Terrain choice: ground (one landmass, zones joined by paths) or islands (floating platforms over the hazard). */
export const TERRAIN_RULE = '"terrain": "ground" is one landmass with nothing to fall into (islands are its zones or clearings, bridges are paths); "islands" float over the hazard. Ground for forest, field, meadow, canyon, valley, park, street, city, arena, battlefield, jungle, swamp, village, farm or on the ground; islands for floating, sky, archipelago, islands, lagoon, lava sea. Otherwise ground for relic hunts and arenas, islands only when water or lava is the fun.';

/** Honest mapping: build the closest playable game and say plainly what the unsupported request became. */
export const HONEST_MAPPING_RULE = 'No shooting, enemies, combat, first-person view, vehicles or building exist: still build the closest playable game and say plainly in the title what it became, e.g. "shoot walking trees" is "Walking Trees Hunt (relic hunt, no shooting)", a dense forest with tree decorations as the walking trees. Name any other mapping too, e.g. "Tag Arena (king of the hill)".';

/** Draft-only compact mode and biome line; MODE_LINES and BIOME_LINE above keep the longer wording for other callers. */
const DRAFT_MODE_LINE = `Modes: relic_hunt (collect relics, then the gate), time_trial (relic hunt within timeLimitSec), king_of_the_hill (hold the gate island for holdSeconds; tag, capture), checkpoint_race (relics in order, then the gate; races), survival (the hazard rises; outlast timeLimitSec). biome: ${BIOMES.join(', ')} (snow is frost, sand is desert). movementSpeed ${M.movementSpeed.min} to ${M.movementSpeed.max} m/s.`;

/** Keep the draft short: generation time is the build floor, so every token the model writes costs latency. */
export const DRAFT_SHAPE_RULE = 'Island ids i0, i1, i2 (i0 holds the spawns); bridge ids b1, b2; relic ids r1, r2, r3 (in the relics array, never in islands); decoration ids d1, d2. Whole numbers. Bridge width 3. 0 to 4 decorations.';

export function worldDraftSystemPrompt(opts: { streaming?: boolean } = {}): string {
  return [
    'You compose a small two-player game world, mapping any request onto the closest supported mode, biome and terrain.',
    TERRAIN_RULE,
    `x is east, z is north, metres, origin at the world centre. Islands are circles (radius ${L.island.minRadius} to ${L.island.maxRadius}, centres within plus or minus ${L.bounds.halfExtent - L.island.maxRadius - 2}) at least 1 m apart. A bridge joins two island ids, ${L.bridge.minLength} to ${L.bridge.maxLength} m rim to rim, one per pair, never crossing a third island. localPosition is an offset from its island centre, not a world position, within radius minus 1.5.`,
    `Exactly ${L.spawns} spawns, ${L.relics} relics and 1 gate. ${L.islands.min} to ${L.islands.max} islands. Decoration types ${DECORATION_TYPES.join(', ')}. Hazard: ${HAZARD_KINDS.join(' or ')}.`,
    'Both spawns on i0, a few metres apart. The gate on its own dead-end island (never i0) with exactly one bridge back toward i0 and no relic. Every relic island reachable from i0 without passing through the gate island. A ring layout: islands on a circle, bridges only between neighbours.',
    DRAFT_MODE_LINE,
    MODE_RULE,
    HONEST_MAPPING_RULE,
    DRAFT_SHAPE_RULE,
    ...(opts.streaming ? [STREAMING_BRIEF_RULE] : []),
    'Output only compact one-line JSON matching the schema, no line breaks.',
  ].join('\n');
}

export function patchDraftSystemPrompt(world: { spec: WorldSpec | null; summary: SessionSummary | null }): string {
  return [
    'You produce one bounded edit patch for an existing world. Change only what the request asks for.',
    CONVENTION,
    `Supported ops: ${PATCH_OP_NAMES.join(', ')}. add_bridge needs a new id plus from and to island ids (width optional, ${L.bridge.minWidth} to ${L.bridge.maxWidth}). remove_bridge, remove_decoration take an existing id. set_hazard takes kind (${HAZARD_KINDS.join(' or ')}). add_decoration takes id, type, islandId, localPosition. move_decoration and move_relic take id, islandId, localPosition. set_title takes title. set_mode takes mode {kind: ${GAME_MODES.join(' | ')}; optional timeLimitSec, holdSeconds, relicsRequired, orderedCheckpoints}: "make it a 60 second time trial" is {"op":"set_mode","mode":{"kind":"time_trial","timeLimitSec":60}}. set_biome takes biome (${BIOMES.join(', ')}): "make it snowy" is {"op":"set_biome","biome":"frost"}. set_movement takes speed ${M.movementSpeed.min} to ${M.movementSpeed.max} (default ${M.movementSpeed.default}): "faster players" is {"op":"set_movement","speed":6}, "slow the players down" is speed 3.5. set_terrain takes terrain (islands or ground): "put it on the ground" is {"op":"set_terrain","terrain":"ground"}. At most ${L.patchOps.max} ops.`,
    'Never remove a bridge that is the only route to a relic or to the gate. Never move a relic that is already collected. Resolve directions like north or east with the compass column and then use the island id from the id column.',
    'Current world:',
    describeWorld(world.spec, world.summary),
    'Output only JSON matching the schema. The summary is one short sentence for the director.',
  ].join('\n');
}

/** Compact world description: a fixed island table plus bridges, relics, gate, decorations. Never raw player positions. */
export function describeWorld(spec: WorldSpec | null, summary: SessionSummary | null): string {
  if (!spec) return 'No world is loaded.';
  const lines: string[] = [];
  lines.push(`title: ${spec.title}; version ${spec.worldVersion}; terrain ${spec.terrain ?? 'islands'}; hazard ${spec.hazard.kind}${spec.hazard.rise ? ' (rises)' : ''}; biome ${spec.biome}; mode ${describeMode(spec.mode)}; speed ${spec.movement?.speed ?? M.movementSpeed.default}`);
  const byIsland = new Map<string, string[]>();
  for (const b of spec.bridges) {
    for (const e of b.endpoints) {
      const arr = byIsland.get(e.islandId) ?? [];
      arr.push(b.id);
      byIsland.set(e.islandId, arr);
    }
  }
  lines.push('Islands (use ids exactly as listed in the id column):');
  lines.push('id | name | compass | bridges | centre | radius | holds');
  for (const [i, isl] of spec.islands.entries()) {
    const summaryIsland = summary?.islands.find((s) => s.id === isl.id);
    const compass = summaryIsland?.compass ?? compassName(isl.center);
    const name = isl.name ?? summaryIsland?.name ?? `${compass} island ${i}`;
    const holds: string[] = [];
    if (spec.gate.supportingSurfaceId === isl.id) holds.push('gate');
    if (spec.spawns.some((s) => s.supportingSurfaceId === isl.id)) holds.push('spawns');
    for (const r of spec.relics) if (r.supportingSurfaceId === isl.id) holds.push(r.id);
    lines.push(`${isl.id} | ${name} | ${compass} | ${(byIsland.get(isl.id) ?? []).join(', ') || 'none'} | (${isl.center.x}, ${isl.center.z}) | ${isl.radius} | ${holds.join(', ') || '-'}`);
  }
  lines.push('Bridges (id: from island id to island id, width):');
  for (const b of spec.bridges) lines.push(`${b.id}: ${b.endpoints[0].islandId} to ${b.endpoints[1].islandId}, width ${b.width}`);
  if (spec.bridges.length === 0) lines.push('none');
  const collected = new Set(summary?.collectedRelicIds ?? []);
  lines.push(`Relics: ${spec.relics.map((r) => `${r.id} on ${r.supportingSurfaceId}${collected.has(r.id) ? ' (collected)' : ''}`).join('; ')}`);
  lines.push(`Gate: ${spec.gate.id} on ${spec.gate.supportingSurfaceId}${summary?.gateUnlocked ? ' (unlocked)' : ' (locked)'}`);
  if (spec.decorations.length) lines.push(`Decorations: ${spec.decorations.slice(0, 40).map((d) => `${d.id} ${d.type} on ${d.supportingSurfaceId}`).join('; ')}`);
  if (summary) {
    const players = summary.players.map((p) => `${p.label} ${p.status}${p.onSurfaceId ? ' on ' + p.onSurfaceId : ''}`).join('; ');
    lines.push(`Players: ${players || 'none'}; score ${summary.score}`);
  }
  return lines.join('\n');
}

/** Compact mode text for the world description, e.g. "time_trial 60 s" or "relic_hunt (default)". */
export function describeMode(mode: WorldSpec['mode']): string {
  if (!mode) return 'relic_hunt (default)';
  const parts: string[] = [mode.kind];
  if (mode.timeLimitSec !== undefined) parts.push(`${mode.timeLimitSec} s`);
  if (mode.holdSeconds !== undefined) parts.push(`hold ${mode.holdSeconds} s`);
  if (mode.relicsRequired !== undefined) parts.push(`${mode.relicsRequired} relics`);
  if (mode.orderedCheckpoints !== undefined) parts.push(mode.orderedCheckpoints ? 'ordered' : 'any order');
  return parts.join(' ');
}

/** Valid ids for repair hints. */
export function validIds(spec: WorldSpec | null): { islandIds: string[]; relicIds: string[]; bridgeIds: string[]; decorationIds: string[] } {
  if (!spec) return { islandIds: [], relicIds: [], bridgeIds: [], decorationIds: [] };
  return { islandIds: spec.islands.map((i) => i.id), relicIds: spec.relics.map((r) => r.id), bridgeIds: spec.bridges.map((b) => b.id), decorationIds: spec.decorations.map((d) => d.id) };
}

export function briefUserPrompt(prompt: string): string {
  // Layout facts pulled out in code so the model does not have to infer them (costs a few input tokens, no output tokens).
  const h = briefHints(prompt);
  const extra: string[] = [];
  if (h.islandCount !== undefined) extra.push(`Use exactly ${h.islandCount} islands.`);
  if (h.ring) extra.push('Place the non-gate islands on a circle and bridge each to its neighbours, closing the ring.');
  if (h.modeKind) extra.push(`mode.kind is ${h.modeKind}.`);
  if (h.biome) extra.push(`biome is ${h.biome}.`);
  const terrain = terrainFromWords(prompt);
  if (terrain) extra.push(`terrain is ${terrain}.`);
  return `Brief from the director: ${prompt}${extra.length ? `\nConstraints: ${extra.join(' ')}` : ''}`;
}

export function editUserPrompt(prompt: string): string {
  return `Edit request from the director: ${prompt}`;
}

/** Repair instruction for a zod failure at the boundary: quotes the zod messages verbatim. */
export function schemaRepairPrompt(errorSummary: string): string {
  return `Your previous output was rejected before it reached the world. Fix exactly these problems and output the complete JSON again:\n${errorSummary}`;
}

/** Repair instruction for validator issues: codes, object ids and evidence, verbatim, plus id hints when the world is known. */
export function validatorRepairPrompt(issues: IssueList, world?: WorldSpec | null): string {
  const lines = issues.slice(0, 12).map((i) => {
    const ids = i.objectIds.length ? ` objects: ${i.objectIds.join(', ')}` : '';
    const ev = i.evidence ? ` evidence: ${JSON.stringify(i.evidence)}` : '';
    return `- ${i.code}: ${i.message}${ids}${ev}`;
  });
  const out = [
    'The world validator rejected the candidate. Nothing was changed. Fix every issue below and output the complete corrected JSON again.',
    ...lines,
    'Hints: DISCONNECTED_GOAL or UNREACHABLE_RELIC means add a bridge from a reachable island to the named island; players cannot walk through the gate island while the gate is locked, so when the relic island hangs off the gate island, move the relic to an island reachable from the spawns without crossing the gate island instead of adding a bridge. For time_trial or king_of_the_hill set relicsRequired only if the brief asks for relics. BRIDGE_ENDPOINT_GAP or BRIDGE_LENGTH means the islands are too far apart or too close; move an island or pick a closer pair. ISLAND_OVERLAP means move one island. BRIDGE_CROSSES_ISLAND means the straight bridge passes through a third island: connect a different pair or move the island aside. GATE_HIDES_RELIC means a relic sits on the gate island behind the locked gate: move that relic to another island. BRIDGE_DUPLICATE means a bridge between those two islands already exists on that line: connect the target island from a different island instead. OBJECT_NOT_ON_SURFACE means shrink the local offset (an offset from the island centre in metres, within radius minus 1.5). DUPLICATE_ID means rename the object. MODE_INVALID means relicsRequired exceeds the relics in the world (lower it, at most 3) or survival has no hazardRise (add hazardRise {afterSec, metersPerSec, maxElevation} in a brief; a patch cannot add it, so pick time_trial instead). INVALID_SCHEMA quotes the exact field path and limit to fix.',
  ];
  if (issues.some((i) => /^playability check|^route /.test(i.message))) {
    out.push('A playability failure means a player walking the route fell or could not arrive: make every bridge on that route width 3 or more and shorter, keep each named object within radius minus 3 of its island centre, and keep objects away from the bridge mouths.');
  }
  if (!world && issues.some((i) => i.code === 'INVALID_REFERENCE')) {
    out.push('INVALID_REFERENCE in a new world means the gate, a relic, a spawn, a decoration or a bridge names an island id that is not in the islands array: add that island to islands (with a bridge to it) or use an id that is already there.');
  }
  if (world && issues.some((i) => i.code === 'INVALID_REFERENCE' || i.code === 'INVALID_SCHEMA' || i.code === 'DUPLICATE_ID')) {
    const ids = validIds(world);
    out.push(`INVALID_REFERENCE means an id does not exist. Use ids exactly as listed. Valid island ids: ${ids.islandIds.join(', ')}. Valid relic ids: ${ids.relicIds.join(', ')}. Valid bridge ids: ${ids.bridgeIds.join(', ') || 'none'}. Valid decoration ids: ${ids.decorationIds.join(', ') || 'none'}.`);
  }
  return out.join('\n');
}

export function summarizeIssues(issues: IssueList): string {
  return issues.slice(0, 6).map((i) => `${i.code}${i.objectIds.length ? '[' + i.objectIds.slice(0, 4).join(',') + ']' : ''}`).join(', ');
}

/** Zod error summary, bounded, path plus message. */
export function zodSummary(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.slice(0, 6).map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ');
}

/**
 * Instruction prompt for the OpenClaw path. The model inside OpenClaw drives the seven tools itself.
 * Kept short: tool order, the request id and the director's text.
 */
export function openclawInstructionPrompt(args: { kind: 'brief' | 'edit'; requestId: string; prompt: string; model: string }): string {
  const common = [
    'You are Beetle, a local game-prototyping teammate. You change a running two-player island world only through the Beetle tools; never answer with prose before the tools are done. Beetle builds any requested game by mapping it onto the closest supported mode and biome.',
    `Request id: ${args.requestId}. Pass it as requestId to propose_world, propose_patch and publish_build_report.`,
    CONVENTION,
  ];
  if (args.kind === 'edit') {
    return [
      ...common,
      'Procedure for an edit request (three tool calls):',
      '1. Call read_world_state to get the island ids, names and compass directions.',
      `2. Call propose_patch with { summary, ops } using only these ops: ${PATCH_OP_NAMES.join(', ')}. set_mode takes mode {kind: ${GAME_MODES.join(' | ')}; optional timeLimitSec, holdSeconds, relicsRequired}, set_biome takes biome (${BIOMES.join(', ')}; snowy is frost), set_movement takes speed ${M.movementSpeed.min} to ${M.movementSpeed.max} (faster is 6), set_terrain takes terrain (islands or ground). Change only what the request asks for. The tool stages and validates the change. If accepted is false, read the issues (code, objectIds, evidence) and call propose_patch again with a corrected patch. At most 2 repairs.`,
      '3. When accepted is true, call commit_candidate with the candidateId and proofId it returned. If committed is false and retryable is true, call commit_candidate once more with the same values. The commit publishes the build report.',
      '4. Reply with one sentence for the director.',
      `Director's edit request: ${args.prompt}`,
    ].join('\n');
  }
  return [
    ...common,
    'Procedure for a new world brief (two tool calls):',
    `1. Call propose_world with { spec } where spec is a WorldDraft: title, islands (${L.islands.min} to ${L.islands.max}, id, name, center, radius), bridges (id, from, to, width), spawns (exactly ${L.spawns}, both on the central island), relics (exactly ${L.relics}), gate (on its own island with one bridge), hazard (${HAZARD_KINDS.join(' or ')}), decorations, biome (${BIOMES.join(', ')}), mode { kind: ${GAME_MODES.join(' | ')}; timeLimitSec, holdSeconds, relicsRequired when the brief implies them }, movementSpeed (${M.movementSpeed.min} to ${M.movementSpeed.max}), terrain (islands or ground), hazardRise {afterSec, metersPerSec, maxElevation} for survival. ${TERRAIN_RULE} ${MODE_RULE} ${HONEST_MAPPING_RULE}${briefWantsStreaming(args.prompt) ? ' ' + STREAMING_BRIEF_RULE : ''} The tool stages and validates the world. If accepted is false, fix the issues and call propose_world again. At most 2 repairs.`,
    '2. When accepted is true, call commit_candidate with the candidateId and proofId it returned. The commit publishes the build report.',
    '3. Reply with one sentence for the director.',
    `Director's brief: ${args.prompt}`,
  ].join('\n');
}

// ---------------- brief hints ----------------
// The small local model sometimes ignores what the director wrote (a desert brief committed as volcanic, a one relic brief
// needing all three). These deterministic hints read the director's own words and win over the model where the brief is explicit.

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, single: 1 };
const BRIEF_BIOMES: { biome: (typeof BIOMES)[number]; words: string[] }[] = [
  { biome: 'frost', words: ['frost', 'frosty', 'frozen', 'snow', 'snowy', 'ice', 'icy', 'winter', 'glacier', 'arctic', 'tundra'] },
  { biome: 'desert', words: ['desert', 'sand', 'sandy', 'dune', 'dunes', 'arid', 'oasis', 'canyon'] },
  { biome: 'night', words: ['night', 'dark', 'moon', 'moonlit', 'midnight', 'nocturnal', 'starry'] },
  { biome: 'garden', words: ['garden', 'grassy', 'meadow', 'forest', 'orchard'] },
  { biome: 'volcanic', words: ['volcanic', 'volcano', 'volcanoes', 'lava', 'magma', 'ember', 'inferno', 'fire', 'fiery'] },
];
/** Terrain words (the same lists as packages/world/src/normalize.ts). Island words win when both appear ("a frozen arena of four islands"). */
export const GROUND_WORDS = ['forest', 'forests', 'woods', 'woodland', 'field', 'fields', 'meadow', 'meadows', 'canyon', 'canyons', 'valley', 'valleys', 'park', 'street', 'streets', 'city', 'town', 'arena', 'battlefield', 'jungle', 'swamp', 'marsh', 'village', 'farm', 'farmland', 'ground', 'landmass'];
export const ISLAND_WORDS = ['floating', 'sky', 'skies', 'archipelago', 'island', 'islands', 'isle', 'isles', 'islet', 'islets', 'lagoon'];

/** Terrain implied by explicit words, or undefined when nothing implies either. */
export function terrainFromWords(text: string): 'islands' | 'ground' | undefined {
  const t = text.toLowerCase();
  const words = new Set(t.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean));
  if (ISLAND_WORDS.some((w) => words.has(w)) || /\blava sea\b|\bsea of lava\b/.test(t)) return 'islands';
  if (GROUND_WORDS.some((w) => words.has(w)) || /\bon the ground\b/.test(t)) return 'ground';
  return undefined;
}

const LAVA_WORDS = ['lava', 'magma', 'volcano', 'volcanoes', 'volcanic', 'fire', 'fiery', 'inferno', 'molten'];

export type BriefHints = {
  biome?: (typeof BIOMES)[number];
  modeKind?: (typeof GAME_MODES)[number];
  holdSeconds?: number;
  timeLimitSec?: number;
  relicsRequired?: number;
  islandCount?: number;
  ring?: boolean;
  lava: boolean;
};

function briefWords(brief: string): string[] {
  return brief.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').split(' ').filter(Boolean);
}

function numberBefore(text: string, unit: RegExp): number | undefined {
  // First number with that unit, skipping delays such as "rises after 30 seconds".
  const re = new RegExp(`(\\w+\\s+)?\\b(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})[ -]*${unit.source}`, 'g');
  for (const m of text.matchAll(re)) {
    if (m[1] && /^(after|every|each)\s/.test(m[1])) continue;
    const n = Number(m[2]);
    return Number.isFinite(n) ? n : NUMBER_WORDS[m[2]];
  }
  return undefined;
}

const CLOCK_WORDS = /\d+\s*(s|sec|secs|second|seconds)\b|\bseconds?\b|\bminutes?\b|\bclock\b|\btimer\b|time limit|time trial/;

/** Read the explicit biome, mode, numbers and hazard from the director's brief. Only explicit words count. */
export function briefHints(brief: string): BriefHints {
  const text = brief.toLowerCase();
  const words = new Set(briefWords(brief));
  const out: BriefHints = { lava: LAVA_WORDS.some((w) => words.has(w)) };
  for (const entry of BRIEF_BIOMES) if (entry.words.some((w) => words.has(w))) { out.biome = entry.biome; break; }
  const has = (re: RegExp) => re.test(text);
  if (has(/king of the hill|\bkoth\b|\btag\b|capture the|hold the (hill|zone|centre|center)/)) out.modeKind = 'king_of_the_hill';
  else if (has(/checkpoint/)) out.modeKind = 'checkpoint_race';
  else if (has(/time trial|against the clock|speedrun/)) out.modeKind = 'time_trial';
  else if (has(/\bsurviv|rising (water|lava|hazard)|\boutlast/)) out.modeKind = 'survival';
  else if (has(/\b(race|racing|laps?)\b/) && !has(/\d+\s*(s|sec|second|seconds)\b|minute/)) out.modeKind = 'checkpoint_race';
  else if (has(/relic hunt|treasure hunt/)) out.modeKind = 'relic_hunt';
  else if (!has(CLOCK_WORDS) && has(/\b(collect(ing)?|gather(ing)?|find(ing)?|steal(ing)?|grab(bing)?)\b[^.]*\brelics?\b|\bheist\b|\bpuzzle\b|plan the route|relics placed/)) out.modeKind = 'relic_hunt';
  const minutes = numberBefore(text, /minutes?\b/);
  const seconds = numberBefore(text, /(s|sec|secs|second|seconds)\b/);
  const secs = seconds ?? (minutes !== undefined ? minutes * 60 : undefined);
  if (secs !== undefined) {
    if (out.modeKind === 'king_of_the_hill') out.holdSeconds = secs;
    else out.timeLimitSec = secs;
  }
  const relics = numberBefore(text, /relics?\b/);
  const islands = numberBefore(text, /(\w+\s+)?islands\b/);
  if (islands !== undefined && islands >= WORLD_LIMITS.islands.min && islands <= WORLD_LIMITS.islands.max) out.islandCount = islands;
  if (has(/\b(ring|loop|circle)\b/)) out.ring = true;
  if (relics !== undefined && relics >= 1 && relics <= WORLD_LIMITS.relics && /(with|collect|collecting|need|needs|grab|grabbing|find|finding|gather|gathering|steal|stealing|holding|carrying)\s+(\w+\s+)?\w+\s+relics?\b/.test(text)) out.relicsRequired = relics;
  return out;
}

const clampTo = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));

/**
 * Apply brief hints to a model draft in place. Returns a list of what changed (empty when the model already matched).
 * Only fields the brief names explicitly are touched; numbers are clamped into MODE_LIMITS.
 */
export function applyBriefHints(draft: Record<string, unknown>, brief: string): string[] {
  const h = briefHints(brief);
  const changed: string[] = [];
  // Terrain words in the brief win; islands is the contract default, so an absent terrain already means islands.
  const wordTerrain = terrainFromWords(brief);
  if (wordTerrain === 'ground' && draft.terrain !== 'ground') { changed.push(`terrain ${String(draft.terrain)} -> ground`); draft.terrain = 'ground'; }
  if (wordTerrain === 'islands' && draft.terrain === 'ground') { changed.push('terrain ground -> islands'); draft.terrain = 'islands'; }
  if (h.biome && draft.biome !== h.biome) { changed.push(`biome ${String(draft.biome)} -> ${h.biome}`); draft.biome = h.biome; }
  if (!h.lava && draft.hazard === 'lava') { changed.push('hazard lava -> water'); draft.hazard = 'water'; }
  if (h.lava && draft.hazard !== 'lava' && /\blava\b|\bmagma\b|\bmolten\b/.test(brief.toLowerCase())) { changed.push(`hazard ${String(draft.hazard)} -> lava`); draft.hazard = 'lava'; }
  const rawMode = draft.mode;
  let mode: Record<string, unknown> | undefined = rawMode && typeof rawMode === 'object' ? (rawMode as Record<string, unknown>) : undefined;
  if (typeof rawMode === 'string') mode = { kind: rawMode };
  if (h.modeKind && (!mode || mode.kind !== h.modeKind)) {
    changed.push(`mode ${String(mode?.kind)} -> ${h.modeKind}`);
    mode = { kind: h.modeKind };
  }
  if (mode) {
    const kind = mode.kind;
    if (kind === 'king_of_the_hill' && h.holdSeconds !== undefined && mode.holdSeconds !== h.holdSeconds) { mode.holdSeconds = clampTo(h.holdSeconds, M.holdSeconds.min, M.holdSeconds.max); changed.push(`holdSeconds ${mode.holdSeconds}`); }
    if ((kind === 'time_trial' || kind === 'survival') && h.timeLimitSec !== undefined && mode.timeLimitSec !== h.timeLimitSec) { mode.timeLimitSec = clampTo(h.timeLimitSec, M.timeLimitSec.min, M.timeLimitSec.max); changed.push(`timeLimitSec ${mode.timeLimitSec}`); }
    if (h.relicsRequired !== undefined && mode.relicsRequired !== h.relicsRequired) { mode.relicsRequired = h.relicsRequired; changed.push(`relicsRequired ${h.relicsRequired}`); }
    if (kind === 'king_of_the_hill' && mode.relicsRequired !== undefined && h.relicsRequired === undefined) { delete mode.relicsRequired; changed.push('relicsRequired dropped for king_of_the_hill'); }
    draft.mode = mode;
    if (kind === 'survival' && (draft.hazardRise === undefined || draft.hazardRise === null)) { draft.hazardRise = { afterSec: 30, metersPerSec: 0.05, maxElevation: -1 }; changed.push('hazardRise default for survival'); }
  }
  // Honest mapping: the brief asks for a mechanic Beetle does not have and the title does not say so; append the
  // mapping in plain words, e.g. "Walking Trees Hunt (relic hunt, no shooting)", within the 60 character title limit.
  const mapped = honestMappingTitle(String(draft.title ?? ''), brief, (draft.mode as { kind?: string } | undefined)?.kind);
  if (mapped !== undefined) { changed.push(`title "${String(draft.title)}" -> "${mapped}"`); draft.title = mapped; }
  // Nothing in the brief implies a terrain and the model left it out: ground unless water or lava is part of the fun
  // (lava, survival), so directors do not always see islands. Title words are resolved later by the world normalizer.
  if (!wordTerrain && draft.terrain !== 'islands' && draft.terrain !== 'ground' && terrainFromWords(String(draft.title ?? '')) === undefined) {
    const kind = (draft.mode as { kind?: unknown } | undefined)?.kind;
    const terrain = draft.hazard === 'lava' || kind === 'survival' ? 'islands' : 'ground';
    changed.push(`terrain default ${terrain}`);
    draft.terrain = terrain;
  }
  return changed;
}

/** Mechanics the library does not have, with the plain word used in the title. Building means building things, not "build a world". */
const UNSUPPORTED_MECHANICS: { re: RegExp; word: string }[] = [
  { re: /\bshoot(s|ing|er|ers)?\b|\bguns?\b|\bfps\b|\bsniper|\bblast(er|ers|ing)?\b/, word: 'shooting' },
  { re: /\benem(y|ies)\b|\bmonsters?\b|\bzombies?\b|\bbosse?s?\b/, word: 'enemies' },
  { re: /\bcombat\b|\bfight(s|ing)?\b|\bbattles?\b|\bweapons?\b|\bswords?\b|\bpvp\b/, word: 'combat' },
  { re: /\bfirst[- ]person\b/, word: 'first-person view' },
  { re: /\bvehicles?\b|\bcars?\b|\bdriv(e|es|ing)\b|\btanks?\b|\bplanes?\b|\bkarts?\b/, word: 'vehicles' },
  { re: /\bcraft(ing)?\b|\bbuilding (blocks|bases|houses|things|structures)\b|\bbase building\b|\bplace blocks\b/, word: 'building' },
];

/** Unsupported mechanics the brief asks for, in plain words (empty when the request is fully supported). */
export function unsupportedMechanics(brief: string): string[] {
  const t = brief.toLowerCase();
  return UNSUPPORTED_MECHANICS.filter((m) => m.re.test(t)).map((m) => m.word);
}

/**
 * A title that names the mapping when the brief asks for unsupported mechanics, or undefined when nothing is needed
 * (supported request, or the title already says "no ..."). Fits WORLD_LIMITS.title.maxLength.
 */
export function honestMappingTitle(title: string, brief: string, modeKind: string | undefined): string | undefined {
  const missing = unsupportedMechanics(brief);
  if (missing.length === 0) return undefined;
  if (/\bno\s+\w/i.test(title)) return undefined;
  const base = title.replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Beetle World';
  const mode = (modeKind && (GAME_MODES as readonly string[]).includes(modeKind) ? modeKind : 'relic_hunt').replace(/_/g, ' ');
  const max = WORLD_LIMITS.title.maxLength;
  for (const words of [missing.slice(0, 2), missing.slice(0, 1)]) {
    const out = `${base} (${mode}, no ${words.join(' or ')})`;
    if (out.length <= max) return out;
  }
  const suffix = ` (${mode}, no ${missing[0]})`;
  return `${base.slice(0, Math.max(1, max - suffix.length)).trim()}${suffix}`;
}
