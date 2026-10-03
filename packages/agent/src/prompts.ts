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
  'king_of_the_hill: reach the gate island (the hill) and stand on it for holdSeconds in total; tag or capture maps here.',
  'checkpoint_race: run through the relics as checkpoints in order (orderedCheckpoints true), then the gate; a race maps here.',
  'survival: the hazard rises after hazardRise.afterSec at metersPerSec up to maxElevation; stay out of it until timeLimitSec. survival requires hazardRise.',
].join(' ');

export const BIOME_LINE = `Biomes: ${BIOMES.join(', ')} (snow is frost, dark is night, sand is desert, lava is volcanic). movementSpeed is player speed in m/s, ${M.movementSpeed.min} to ${M.movementSpeed.max}, default ${M.movementSpeed.default} (fast 6, slow 3.5). timeLimitSec ${M.timeLimitSec.min} to ${M.timeLimitSec.max}, holdSeconds ${M.holdSeconds.min} to ${M.holdSeconds.max}, relicsRequired 1 to ${L.relics}.`;

export const MODE_RULE = 'Always set mode and biome explicitly. Set timeLimitSec, holdSeconds or relicsRequired whenever the request implies them (a 90 second limit is timeLimitSec 90). When the requested game is not an exact match, name the mapping in the title, e.g. "Tag Arena (king of the hill)".';

export function worldDraftSystemPrompt(): string {
  return [
    'You compose a small floating-island world for a two-player game. Beetle builds any requested game by mapping it onto the closest supported mode and biome.',
    CONVENTION,
    `Exactly ${L.spawns} spawns, ${L.relics} relics and 1 gate. ${L.islands.min} to ${L.islands.max} islands, at most ${L.bridges.max} bridges, 4 to 8 decorations (types: ${DECORATION_TYPES.join(', ')}). Hazard: ${HAZARD_KINDS.join(' or ')}.`,
    'Both spawns go on the same central island. Every relic and the gate must be reachable from the spawns over bridges. The gate sits on its own island with exactly one bridge and no relic (the locked gate would hide it). Give a wide safe route plus one optional narrow risky bridge; keep bridged islands within 30 m rim to rim, bridges clear of other islands, never two bridges between the same pair, decorations away from bridge mouths.',
    `Modes: ${MODE_LINES}`,
    BIOME_LINE,
    MODE_RULE,
    'Output only compact one-line JSON matching the schema.',
  ].join('\n');
}

export function patchDraftSystemPrompt(world: { spec: WorldSpec | null; summary: SessionSummary | null }): string {
  return [
    'You produce one bounded edit patch for an existing world. Change only what the request asks for.',
    CONVENTION,
    `Supported ops: ${PATCH_OP_NAMES.join(', ')}. add_bridge needs a new id plus from and to island ids (width optional, ${L.bridge.minWidth} to ${L.bridge.maxWidth}). remove_bridge, remove_decoration take an existing id. set_hazard takes kind (${HAZARD_KINDS.join(' or ')}). add_decoration takes id, type, islandId, localPosition. move_decoration and move_relic take id, islandId, localPosition. set_title takes title. set_mode takes mode {kind: ${GAME_MODES.join(' | ')}; optional timeLimitSec, holdSeconds, relicsRequired, orderedCheckpoints}: "make it a 60 second time trial" is {"op":"set_mode","mode":{"kind":"time_trial","timeLimitSec":60}}. set_biome takes biome (${BIOMES.join(', ')}): "make it snowy" is {"op":"set_biome","biome":"frost"}. set_movement takes speed ${M.movementSpeed.min} to ${M.movementSpeed.max} (default ${M.movementSpeed.default}): "faster players" is {"op":"set_movement","speed":6}, "slow the players down" is speed 3.5. At most ${L.patchOps.max} ops.`,
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
  lines.push(`title: ${spec.title}; version ${spec.worldVersion}; hazard ${spec.hazard.kind}${spec.hazard.rise ? ' (rises)' : ''}; biome ${spec.biome}; mode ${describeMode(spec.mode)}; speed ${spec.movement?.speed ?? M.movementSpeed.default}`);
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
  return `Brief from the director: ${prompt}`;
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
    'Hints: DISCONNECTED_GOAL or UNREACHABLE_RELIC means add a bridge from a reachable island to the named island. BRIDGE_ENDPOINT_GAP or BRIDGE_LENGTH means the islands are too far apart or too close; move an island or pick a closer pair. ISLAND_OVERLAP means move one island. BRIDGE_CROSSES_ISLAND means the straight bridge passes through a third island: connect a different pair or move the island aside. GATE_HIDES_RELIC means a relic sits on the gate island behind the locked gate: move that relic to another island. BRIDGE_DUPLICATE means a bridge between those two islands already exists on that line: connect the target island from a different island instead. OBJECT_NOT_ON_SURFACE means shrink the local offset (an offset from the island centre in metres, within radius minus 1.5). DUPLICATE_ID means rename the object. MODE_INVALID means relicsRequired exceeds the relics in the world (lower it, at most 3) or survival has no hazardRise (add hazardRise {afterSec, metersPerSec, maxElevation} in a brief; a patch cannot add it, so pick time_trial instead). INVALID_SCHEMA quotes the exact field path and limit to fix.',
  ];
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
      `2. Call propose_patch with { summary, ops } using only these ops: ${PATCH_OP_NAMES.join(', ')}. set_mode takes mode {kind: ${GAME_MODES.join(' | ')}; optional timeLimitSec, holdSeconds, relicsRequired}, set_biome takes biome (${BIOMES.join(', ')}; snowy is frost), set_movement takes speed ${M.movementSpeed.min} to ${M.movementSpeed.max} (faster is 6). Change only what the request asks for. The tool stages and validates the change. If accepted is false, read the issues (code, objectIds, evidence) and call propose_patch again with a corrected patch. At most 2 repairs.`,
      '3. When accepted is true, call commit_candidate with the candidateId and proofId it returned. If committed is false and retryable is true, call commit_candidate once more with the same values. The commit publishes the build report.',
      '4. Reply with one sentence for the director.',
      `Director's edit request: ${args.prompt}`,
    ].join('\n');
  }
  return [
    ...common,
    'Procedure for a new world brief (two tool calls):',
    `1. Call propose_world with { spec } where spec is a WorldDraft: title, islands (${L.islands.min} to ${L.islands.max}, id, name, center, radius), bridges (id, from, to, width), spawns (exactly ${L.spawns}, both on the central island), relics (exactly ${L.relics}), gate (on its own island with one bridge), hazard (${HAZARD_KINDS.join(' or ')}), decorations, biome (${BIOMES.join(', ')}), mode { kind: ${GAME_MODES.join(' | ')}; timeLimitSec, holdSeconds, relicsRequired when the brief implies them }, movementSpeed (${M.movementSpeed.min} to ${M.movementSpeed.max}), hazardRise {afterSec, metersPerSec, maxElevation} for survival. ${MODE_RULE} The tool stages and validates the world. If accepted is false, fix the issues and call propose_world again. At most 2 repairs.`,
    '2. When accepted is true, call commit_candidate with the candidateId and proofId it returned. The commit publishes the build report.',
    '3. Reply with one sentence for the director.',
    `Director's brief: ${args.prompt}`,
  ].join('\n');
}
