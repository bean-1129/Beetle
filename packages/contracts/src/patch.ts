import { z } from 'zod';
import { BIOMES, DECORATION_TYPES, GAME_MODES, HAZARD_KINDS, MODE_LIMITS, SCHEMA_VERSION, TERRAINS, WORLD_LIMITS } from './limits.ts';
import { IdSchema, Finite, LocalVec2Schema, ModeSchema, SafeText, Vec2Schema } from './world.ts';

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
  z.object({ op: z.literal('add_island'), id: IdSchema, name: SafeText(WORLD_LIMITS.name.maxLength).optional(), center: Vec2Schema, radius: Finite.min(WORLD_LIMITS.island.minRadius).max(WORLD_LIMITS.island.maxRadius), bridgeFrom: IdSchema.optional() }).strict(),
  z.object({ op: z.literal('remove_island'), id: IdSchema }).strict(),
  z.object({ op: z.literal('set_terrain'), terrain: z.enum(TERRAINS) }).strict(),
  z.object({ op: z.literal('set_mode'), mode: ModeSchema }).strict(),
  z.object({ op: z.literal('set_biome'), biome: z.enum(BIOMES) }).strict(),
  z.object({ op: z.literal('set_movement'), speed: Finite.min(MODE_LIMITS.movementSpeed.min).max(MODE_LIMITS.movementSpeed.max) }).strict(),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;
export const PATCH_OP_NAMES = ['add_bridge', 'remove_bridge', 'set_hazard', 'add_decoration', 'move_decoration', 'remove_decoration', 'move_relic', 'set_title', 'set_mode', 'set_biome', 'set_movement', 'add_island', 'remove_island', 'set_terrain'] as const;

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
          { type: 'object', additionalProperties: false, required: ['op', 'id', 'center', 'radius'], properties: { op: { const: 'add_island' }, id, name: { type: 'string', maxLength: WORLD_LIMITS.name.maxLength }, center: { type: 'object', additionalProperties: false, required: ['x', 'z'], properties: { x: { type: 'number', minimum: -60, maximum: 60 }, z: { type: 'number', minimum: -60, maximum: 60 } } }, radius: { type: 'number', minimum: WORLD_LIMITS.island.minRadius, maximum: WORLD_LIMITS.island.maxRadius }, bridgeFrom: { type: 'string' } } },
          { type: 'object', additionalProperties: false, required: ['op', 'id'], properties: { op: { const: 'remove_island' }, id: { type: 'string' } } },
          { type: 'object', additionalProperties: false, required: ['op', 'terrain'], properties: { op: { const: 'set_terrain' }, terrain: { type: 'string', enum: [...TERRAINS] } } },
          { type: 'object', additionalProperties: false, required: ['op', 'mode'], properties: { op: { const: 'set_mode' }, mode: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', enum: [...GAME_MODES] }, timeLimitSec: { type: 'integer', minimum: 20, maximum: 600 }, holdSeconds: { type: 'integer', minimum: 3, maximum: 60 }, relicsRequired: { type: 'integer', minimum: 1, maximum: 3 }, orderedCheckpoints: { type: 'boolean' } } } } },
          { type: 'object', additionalProperties: false, required: ['op', 'biome'], properties: { op: { const: 'set_biome' }, biome: { type: 'string', enum: [...BIOMES] } } },
          { type: 'object', additionalProperties: false, required: ['op', 'speed'], properties: { op: { const: 'set_movement' }, speed: { type: 'number', minimum: 3, maximum: 7 } } },
        ],
      },
    },
  },
} as const;
