// System prompts for the local model. Short, convention-driven, no event-history replay.
import {
  COORDINATES,
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

export const CONVENTION = [
  `Coordinates: walk plane ${COORDINATES.walkPlane}, up is ${COORDINATES.up}, north is ${COORDINATES.north}, east is ${COORDINATES.east}, units ${COORDINATES.units}, origin at the ${COORDINATES.origin}.`,
  `Islands are circles (center, radius ${L.island.minRadius} to ${L.island.maxRadius}) that must keep a gap of at least 1 m from each other. Keep every centre within plus or minus ${L.bounds.halfExtent - L.island.maxRadius - 2}.`,
  `Bridges join two different islands by id, width ${L.bridge.minWidth} to ${L.bridge.maxWidth}, length ${L.bridge.minLength} to ${L.bridge.maxLength} m between the island rims, and must not cross a third island.`,
  `Objects (spawns, relics, gate, decorations) sit on an island; localPosition is an offset from that island centre in metres (not a world position) and must stay within the island radius minus 1.5.`,
  `Ids are lowercase slugs (letters, digits, dash, underscore, max 32 chars) and unique across the whole world.`,
].join('\n');

export function worldDraftSystemPrompt(): string {
  return [
    'You compose a small floating-garden world for a two-player cooperative relic hunt.',
    CONVENTION,
    `Exactly ${L.spawns} spawns, ${L.relics} relics and 1 gate. ${L.islands.min} to ${L.islands.max} islands, at most ${L.bridges.max} bridges, at most ${L.decorations.max} decorations (types: ${DECORATION_TYPES.join(', ')}). Hazard is one of: ${HAZARD_KINDS.join(', ')}.`,
    'Both spawns go on the same central island. Every relic and the gate must be reachable from the spawns by walking over bridges. Put the gate on its own island with exactly one bridge leading to it, so the locked gate guards that bridge mouth. Do not place a relic on the gate island.',
    'Give a wide safe route plus one optional narrow risky bridge. Keep decorations away from bridge mouths so they never block a route.',
    'An alternative route or new bridge must connect the target island from a different island than its existing bridges; never duplicate an existing bridge.',
    'Never place a relic on the gate island: the locked gate would hide it. Keep bridged islands within 30 m rim to rim and keep every bridge clear of other islands.',
    'Use between 4 and 8 decorations in total (more than 8 is wasteful and gets truncated). Output compact JSON on one line with no extra whitespace and no commentary.',
    'Output only JSON matching the schema. No commentary.',
  ].join('\n');
}

export function patchDraftSystemPrompt(world: { spec: WorldSpec | null; summary: SessionSummary | null }): string {
  return [
    'You produce one bounded edit patch for an existing world. Change only what the request asks for.',
    CONVENTION,
    `Supported ops: ${PATCH_OP_NAMES.join(', ')}. add_bridge needs a new id plus from and to island ids (width optional, ${L.bridge.minWidth} to ${L.bridge.maxWidth}). remove_bridge, remove_decoration take an existing id. set_hazard takes kind (${HAZARD_KINDS.join(' or ')}). add_decoration takes id, type, islandId, localPosition. move_decoration and move_relic take id, islandId, localPosition. set_title takes title. At most ${L.patchOps.max} ops.`,
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
  lines.push(`title: ${spec.title}; version ${spec.worldVersion}; hazard ${spec.hazard.kind}`);
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
    'Hints: DISCONNECTED_GOAL or UNREACHABLE_RELIC means add a bridge from a reachable island to the named island. BRIDGE_ENDPOINT_GAP or BRIDGE_LENGTH means the islands are too far apart or too close; move an island or pick a closer pair. ISLAND_OVERLAP means move one island. BRIDGE_CROSSES_ISLAND means the straight bridge passes through a third island: connect a different pair or move the island aside. GATE_HIDES_RELIC means a relic sits on the gate island behind the locked gate: move that relic to another island. BRIDGE_DUPLICATE means a bridge between those two islands already exists on that line: connect the target island from a different island instead. OBJECT_NOT_ON_SURFACE means shrink the local offset (an offset from the island centre in metres, within radius minus 1.5). DUPLICATE_ID means rename the object. INVALID_SCHEMA quotes the exact field path and limit to fix.',
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
    'You are Beetle, a local game-prototyping teammate. You change a running two-player relic-hunt world only through the Beetle tools; never answer with prose before the tools are done.',
    `Request id: ${args.requestId}. Pass it as requestId to propose_world, propose_patch and publish_build_report.`,
    CONVENTION,
  ];
  if (args.kind === 'edit') {
    return [
      ...common,
      'Procedure for an edit request (three tool calls):',
      '1. Call read_world_state to get the island ids, names and compass directions.',
      `2. Call propose_patch with { summary, ops } using only these ops: ${PATCH_OP_NAMES.join(', ')}. Change only what the request asks for. The tool stages and validates the change. If accepted is false, read the issues (code, objectIds, evidence) and call propose_patch again with a corrected patch. At most 2 repairs.`,
      '3. When accepted is true, call commit_candidate with the candidateId and proofId it returned. If committed is false and retryable is true, call commit_candidate once more with the same values. The commit publishes the build report.',
      '4. Reply with one sentence for the director.',
      `Director's edit request: ${args.prompt}`,
    ].join('\n');
  }
  return [
    ...common,
    'Procedure for a new world brief (two tool calls):',
    `1. Call propose_world with { spec } where spec is a WorldDraft: title, islands (${L.islands.min} to ${L.islands.max}, id, name, center, radius), bridges (id, from, to, width), spawns (exactly ${L.spawns}, both on the central island), relics (exactly ${L.relics}), gate (on its own island with one bridge), hazard (${HAZARD_KINDS.join(' or ')}), decorations. The tool stages and validates the world. If accepted is false, fix the issues and call propose_world again. At most 2 repairs.`,
    '2. When accepted is true, call commit_candidate with the candidateId and proofId it returned. The commit publishes the build report.',
    '3. Reply with one sentence for the director.',
    `Director's brief: ${args.prompt}`,
  ].join('\n');
}
