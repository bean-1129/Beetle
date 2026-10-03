import { z } from 'zod';
import { DECORATION_TYPES, HAZARD_KINDS, SCHEMA_VERSION, WORLD_LIMITS } from './limits.ts';
import { IdSchema, Finite, LocalVec2Schema, SafeText } from './world.ts';

const L = WORLD_LIMITS.localOffset;
const widthSchema = Finite.min(WORLD_LIMITS.bridge.minWidth).max(WORLD_LIMITS.bridge.maxWidth);

// Every supported structural operation. Unknown `op` values fail the discriminated union (INVALID_SCHEMA / UNKNOWN_OPERATION).
export const PatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_bridge'), id: IdSchema, from: IdSchema, to: IdSchema, width: widthSchema.optional() }).strict(),
  z.object({ op: z.literal('remove_bridge'), id: IdSchema }).strict(),
  z.object({ op: z.literal('set_hazard'), kind: z.enum(HAZARD_KINDS) }).strict(),
  z.object({ op: z.literal('add_decoration'), id: IdSchema, type: z.enum(DECORATION_TYPES), islandId: IdSchema, localPosition: LocalVec2Schema, rotationDeg: Finite.min(0).max(360).optional(), scale: Finite.min(0.5).max(2).optional() }).strict(),
  z.object({ op: z.literal('move_decoration'), id: IdSchema, islandId: IdSchema, localPosition: LocalVec2Schema }).strict(),
  z.object({ op: z.literal('remove_decoration'), id: IdSchema }).strict(),
  z.object({ op: z.literal('move_relic'), id: IdSchema, islandId: IdSchema, localPosition: LocalVec2Schema }).strict(),
  z.object({ op: z.literal('set_title'), title: SafeText(WORLD_LIMITS.title.maxLength) }).strict(),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;
export const PATCH_OP_NAMES = ['add_bridge', 'remove_bridge', 'set_hazard', 'add_decoration', 'move_decoration', 'remove_decoration', 'move_relic', 'set_title'] as const;

// Model-facing: what the model produces for an edit request.
export const PatchDraftSchema = z.object({
  summary: SafeText(WORLD_LIMITS.summary.maxLength),
  ops: z.array(PatchOpSchema).min(1).max(WORLD_LIMITS.patchOps.max),
}).strict();
export type PatchDraft = z.infer<typeof PatchDraftSchema>;

// Server-side bounded patch bound to a base version.
export const WorldPatchSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  patchId: IdSchema,
  requestId: IdSchema,
  baseWorldVersion: z.number().int().min(0),
  summary: SafeText(WORLD_LIMITS.summary.maxLength),
  ops: z.array(PatchOpSchema).min(1).max(WORLD_LIMITS.patchOps.max),
}).strict();
export type WorldPatch = z.infer<typeof WorldPatchSchema>;

const localPos = { type: 'object', additionalProperties: false, required: ['x', 'z'], properties: { x: { type: 'number', minimum: -L, maximum: L }, z: { type: 'number', minimum: -L, maximum: L } } } as const;
const id = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' } as const;

/** JSON Schema for PatchDraft, hand-written and short, for the Ollama `format` field. */
export const PATCH_DRAFT_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'ops'],
  properties: {
    summary: { type: 'string', maxLength: WORLD_LIMITS.summary.maxLength },
    ops: {
      type: 'array', minItems: 1, maxItems: WORLD_LIMITS.patchOps.max,
      items: {
        anyOf: [
          { type: 'object', additionalProperties: false, required: ['op', 'id', 'from', 'to'], properties: { op: { const: 'add_bridge' }, id, from: { type: 'string' }, to: { type: 'string' }, width: { type: 'number', minimum: WORLD_LIMITS.bridge.minWidth, maximum: WORLD_LIMITS.bridge.maxWidth } } },
          { type: 'object', additionalProperties: false, required: ['op', 'id'], properties: { op: { const: 'remove_bridge' }, id: { type: 'string' } } },
          { type: 'object', additionalProperties: false, required: ['op', 'kind'], properties: { op: { const: 'set_hazard' }, kind: { type: 'string', enum: [...HAZARD_KINDS] } } },
          { type: 'object', additionalProperties: false, required: ['op', 'id', 'type', 'islandId', 'localPosition'], properties: { op: { const: 'add_decoration' }, id, type: { type: 'string', enum: [...DECORATION_TYPES] }, islandId: { type: 'string' }, localPosition: localPos } },
          { type: 'object', additionalProperties: false, required: ['op', 'id', 'islandId', 'localPosition'], properties: { op: { const: 'move_decoration' }, id: { type: 'string' }, islandId: { type: 'string' }, localPosition: localPos } },
          { type: 'object', additionalProperties: false, required: ['op', 'id'], properties: { op: { const: 'remove_decoration' }, id: { type: 'string' } } },
          { type: 'object', additionalProperties: false, required: ['op', 'id', 'islandId', 'localPosition'], properties: { op: { const: 'move_relic' }, id: { type: 'string' }, islandId: { type: 'string' }, localPosition: localPos } },
          { type: 'object', additionalProperties: false, required: ['op', 'title'], properties: { op: { const: 'set_title' }, title: { type: 'string', maxLength: WORLD_LIMITS.title.maxLength } } },
        ],
      },
    },
  },
} as const;
