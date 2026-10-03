import { z } from 'zod';
import {
  AVATARS, BIOMES, DECORATION_TYPES, GAME_MODES, HAZARD_KINDS, MODE_LIMITS, OBJECTIVE_RULES, SCHEMA_VERSION, MOVEMENT_RULES_VERSION, TERRAINS, WORLD_LIMITS,
} from './limits.ts';

const H = WORLD_LIMITS.bounds.halfExtent;
const L = WORLD_LIMITS.localOffset;

export const IdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'id must be lowercase slug, max 32 chars');
export const Finite = z.number().finite();
// Display-only text: no control characters. Never used as a path or code.
// Display-only text: no control characters, no bidi or zero-width characters (HUD spoofing). Never used as a path or code.
export const SafeText = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]*$/);

export const Vec2Schema = z.object({ x: Finite.min(-H).max(H), z: Finite.min(-H).max(H) }).strict();
export const LocalVec2Schema = z.object({ x: Finite.min(-L).max(L), z: Finite.min(-L).max(L) }).strict();

export const IslandSchema = z.object({
  id: IdSchema,
  name: SafeText(WORLD_LIMITS.name.maxLength).optional(),
  center: Vec2Schema,
  radius: Finite.min(WORLD_LIMITS.island.minRadius).max(WORLD_LIMITS.island.maxRadius),
  topElevation: z.literal(0),
}).strict();

export const BridgeEndpointSchema = z.object({ islandId: IdSchema, point: Vec2Schema }).strict();
export const BridgeSchema = z.object({
  id: IdSchema,
  endpoints: z.tuple([BridgeEndpointSchema, BridgeEndpointSchema]),
  width: Finite.min(WORLD_LIMITS.bridge.minWidth).max(WORLD_LIMITS.bridge.maxWidth),
}).strict();

export const SpawnSchema = z.object({
  id: IdSchema,
  supportingSurfaceId: IdSchema,
  localPosition: LocalVec2Schema,
  playerSlot: z.union([z.literal(0), z.literal(1)]),
}).strict();

export const RelicSchema = z.object({
  id: IdSchema,
  name: SafeText(WORLD_LIMITS.name.maxLength).optional(),
  supportingSurfaceId: IdSchema,
  localPosition: LocalVec2Schema,
}).strict();

export const GateSchema = z.object({
  id: IdSchema,
  supportingSurfaceId: IdSchema,
  localPosition: LocalVec2Schema,
  requiredRelicIds: z.array(IdSchema).min(1).max(WORLD_LIMITS.relics),
}).strict();

export const HazardRiseSchema = z.object({
  afterSec: z.number().int().min(MODE_LIMITS.hazardRise.afterSec.min).max(MODE_LIMITS.hazardRise.afterSec.max),
  metersPerSec: Finite.min(MODE_LIMITS.hazardRise.metersPerSec.min).max(MODE_LIMITS.hazardRise.metersPerSec.max),
  maxElevation: Finite.min(MODE_LIMITS.hazardRise.maxElevation.min).max(MODE_LIMITS.hazardRise.maxElevation.max),
}).strict();
export const HazardSchema = z.object({
  kind: z.enum(HAZARD_KINDS),
  planeElevation: Finite.min(-6).max(-1),
  policy: z.object({
    onContact: z.literal('respawn'),
    scorePenalty: z.number().int().min(0).max(10),
  }).strict(),
  /** Survival: the hazard plane rises after afterSec at metersPerSec until maxElevation; bridges below -1.0 m submerge. */
  rise: HazardRiseSchema.optional(),
}).strict();

/** Game mode. Omitted means relic_hunt with every relic required (the original game). */
export const ModeSchema = z.object({
  kind: z.enum(GAME_MODES),
  timeLimitSec: z.number().int().min(MODE_LIMITS.timeLimitSec.min).max(MODE_LIMITS.timeLimitSec.max).optional(),
  holdSeconds: z.number().int().min(MODE_LIMITS.holdSeconds.min).max(MODE_LIMITS.holdSeconds.max).optional(),
  relicsRequired: z.number().int().min(MODE_LIMITS.relicsRequired.min).max(MODE_LIMITS.relicsRequired.max).optional(),
  orderedCheckpoints: z.boolean().optional(),
}).strict();
export type Mode = z.infer<typeof ModeSchema>;
export const MovementSchema = z.object({
  speed: Finite.min(MODE_LIMITS.movementSpeed.min).max(MODE_LIMITS.movementSpeed.max),
}).strict();

export const DecorationSchema = z.object({
  id: IdSchema,
  type: z.enum(DECORATION_TYPES),
  supportingSurfaceId: IdSchema,
  localPosition: LocalVec2Schema,
  rotationDeg: Finite.min(0).max(360).default(0),
  scale: Finite.min(0.5).max(2).default(1),
}).strict();

export const WorldSpecSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  worldId: IdSchema,
  worldVersion: z.number().int().min(0),
  seed: z.number().int().min(0).max(2147483647),
  title: SafeText(WORLD_LIMITS.title.maxLength),
  biome: z.enum(BIOMES),
  bounds: z.object({ halfExtent: z.literal(H) }).strict(),
  movementRulesVersion: z.literal(MOVEMENT_RULES_VERSION),
  islands: z.array(IslandSchema).min(WORLD_LIMITS.islands.min).max(WORLD_LIMITS.islands.max),
  bridges: z.array(BridgeSchema).max(WORLD_LIMITS.bridges.max),
  spawns: z.array(SpawnSchema).length(WORLD_LIMITS.spawns),
  relics: z.array(RelicSchema).length(WORLD_LIMITS.relics),
  gate: GateSchema,
  hazard: HazardSchema,
  decorations: z.array(DecorationSchema).max(WORLD_LIMITS.decorations.max),
  objectiveRules: z.array(z.enum(OBJECTIVE_RULES)).min(1),
  mode: ModeSchema.optional(),
  movement: MovementSchema.optional(),
  /** Streaming generation on: the world grows ahead of players through automatic extension requests. */
  streaming: z.boolean().optional(),
  /** islands (default): platforms over a hazard; ground: one continuous landmass, zones are plateaus, crossings are paths, nothing to fall into. */
  terrain: z.enum(TERRAINS).optional(),
  /** Player characters: one for both players, or one per slot [slot0, slot1]. Default explorer. */
  avatar: z.union([z.enum(AVATARS), z.tuple([z.enum(AVATARS), z.enum(AVATARS)])]).optional(),
}).strict();

export function avatarFor(spec: { avatar?: string | [string, string] }, slot: 0 | 1): string {
  const a = spec.avatar;
  if (!a) return 'explorer';
  return Array.isArray(a) ? a[slot] : a;
}

export function effectiveTerrain(spec: { terrain?: 'islands' | 'ground' }): 'islands' | 'ground' {
  return spec.terrain ?? 'islands';
}

/** Effective mode with defaults applied (relic_hunt, all relics required, no timer). */
export function effectiveMode(spec: { mode?: Mode; relics: unknown[] }): Required<Pick<Mode, 'kind' | 'relicsRequired' | 'orderedCheckpoints'>> & { timeLimitSec: number | null; holdSeconds: number } {
  const m = spec.mode ?? { kind: 'relic_hunt' as const };
  const relicsRequired = Math.min(m.relicsRequired ?? spec.relics.length, spec.relics.length) || 1;
  const timeLimitSec = m.timeLimitSec ?? (m.kind === 'time_trial' || m.kind === 'survival' ? MODE_LIMITS.timeLimitSec.default : null);
  return { kind: m.kind, relicsRequired, orderedCheckpoints: m.orderedCheckpoints ?? m.kind === 'checkpoint_race', timeLimitSec, holdSeconds: m.holdSeconds ?? MODE_LIMITS.holdSeconds.default };
}
export function effectiveSpeed(spec: { movement?: { speed: number } }): number {
  return spec.movement?.speed ?? MODE_LIMITS.movementSpeed.default;
}

export type Island = z.infer<typeof IslandSchema>;
export type Bridge = z.infer<typeof BridgeSchema>;
export type BridgeEndpoint = z.infer<typeof BridgeEndpointSchema>;
export type Spawn = z.infer<typeof SpawnSchema>;
export type Relic = z.infer<typeof RelicSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type Hazard = z.infer<typeof HazardSchema>;
export type Decoration = z.infer<typeof DecorationSchema>;
export type WorldSpec = z.infer<typeof WorldSpecSchema>;

// ---- Model-facing draft (what the local model is asked to produce for a fresh brief) ----
// The server expands a draft into a full WorldSpec: derives bridge socket points, seed, ids, versions.
export const WorldDraftSchema = z.object({
  title: SafeText(WORLD_LIMITS.title.maxLength),
  islands: z.array(z.object({
    id: IdSchema,
    name: SafeText(WORLD_LIMITS.name.maxLength),
    center: Vec2Schema,
    radius: Finite.min(WORLD_LIMITS.island.minRadius).max(WORLD_LIMITS.island.maxRadius),
  }).strict()).min(WORLD_LIMITS.islands.min).max(WORLD_LIMITS.islands.max),
  bridges: z.array(z.object({
    id: IdSchema,
    from: IdSchema,
    to: IdSchema,
    width: Finite.min(WORLD_LIMITS.bridge.minWidth).max(WORLD_LIMITS.bridge.maxWidth),
  }).strict()).max(WORLD_LIMITS.bridges.max),
  spawns: z.array(z.object({ islandId: IdSchema, localPosition: LocalVec2Schema }).strict()).length(WORLD_LIMITS.spawns),
  relics: z.array(z.object({
    id: IdSchema, name: SafeText(WORLD_LIMITS.name.maxLength), islandId: IdSchema, localPosition: LocalVec2Schema,
  }).strict()).length(WORLD_LIMITS.relics),
  gate: z.object({ islandId: IdSchema, localPosition: LocalVec2Schema }).strict(),
  hazard: z.enum(HAZARD_KINDS),
  decorations: z.array(z.object({
    id: IdSchema, type: z.enum(DECORATION_TYPES), islandId: IdSchema, localPosition: LocalVec2Schema,
  }).strict()).max(WORLD_LIMITS.decorations.max),
  biome: z.enum(BIOMES).optional(),
  mode: ModeSchema.optional(),
  movementSpeed: Finite.min(MODE_LIMITS.movementSpeed.min).max(MODE_LIMITS.movementSpeed.max).optional(),
  hazardRise: HazardRiseSchema.optional(),
  streaming: z.boolean().optional(),
  terrain: z.enum(TERRAINS).optional(),
  avatar: z.union([z.enum(AVATARS), z.tuple([z.enum(AVATARS), z.enum(AVATARS)])]).optional(),
}).strict();
export type WorldDraft = z.infer<typeof WorldDraftSchema>;

/** JSON Schema for WorldDraft, hand-written and kept short for the Ollama `format` field. */
export const WORLD_DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'islands', 'bridges', 'spawns', 'relics', 'gate', 'hazard', 'decorations'],
  properties: {
    title: { type: 'string', maxLength: WORLD_LIMITS.title.maxLength },
    islands: {
      type: 'array', minItems: WORLD_LIMITS.islands.min, maxItems: WORLD_LIMITS.islands.max,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'name', 'center', 'radius'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
          name: { type: 'string', maxLength: WORLD_LIMITS.name.maxLength },
          center: { type: 'object', additionalProperties: false, required: ['x', 'z'], properties: { x: { type: 'number', minimum: -H, maximum: H }, z: { type: 'number', minimum: -H, maximum: H } } },
          radius: { type: 'number', minimum: WORLD_LIMITS.island.minRadius, maximum: WORLD_LIMITS.island.maxRadius },
        },
      },
    },
    bridges: {
      type: 'array', maxItems: WORLD_LIMITS.bridges.max,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'from', 'to', 'width'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
          from: { type: 'string' }, to: { type: 'string' },
          width: { type: 'number', minimum: WORLD_LIMITS.bridge.minWidth, maximum: WORLD_LIMITS.bridge.maxWidth },
        },
      },
    },
    spawns: {
      type: 'array', minItems: 2, maxItems: 2,
      items: { type: 'object', additionalProperties: false, required: ['islandId', 'localPosition'], properties: { islandId: { type: 'string' }, localPosition: { type: 'object', additionalProperties: false, required: ['x', 'z'], properties: { x: { type: 'number', minimum: -L, maximum: L }, z: { type: 'number', minimum: -L, maximum: L } } } } },
    },
    relics: {
      type: 'array', minItems: 3, maxItems: 3,
      items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'islandId', 'localPosition'], properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' }, name: { type: 'string', maxLength: WORLD_LIMITS.name.maxLength }, islandId: { type: 'string' }, localPosition: { type: 'object', additionalProperties: false, required: ['x', 'z'], properties: { x: { type: 'number', minimum: -L, maximum: L }, z: { type: 'number', minimum: -L, maximum: L } } } } },
    },
    gate: { type: 'object', additionalProperties: false, required: ['islandId', 'localPosition'], properties: { islandId: { type: 'string' }, localPosition: { type: 'object', additionalProperties: false, required: ['x', 'z'], properties: { x: { type: 'number', minimum: -L, maximum: L }, z: { type: 'number', minimum: -L, maximum: L } } } } },
    hazard: { type: 'string', enum: [...HAZARD_KINDS] },
    biome: { type: 'string', enum: [...BIOMES] },
    mode: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', enum: [...GAME_MODES] }, timeLimitSec: { type: 'integer', minimum: MODE_LIMITS.timeLimitSec.min, maximum: MODE_LIMITS.timeLimitSec.max }, holdSeconds: { type: 'integer', minimum: MODE_LIMITS.holdSeconds.min, maximum: MODE_LIMITS.holdSeconds.max }, relicsRequired: { type: 'integer', minimum: 1, maximum: 3 }, orderedCheckpoints: { type: 'boolean' } } },
    movementSpeed: { type: 'number', minimum: MODE_LIMITS.movementSpeed.min, maximum: MODE_LIMITS.movementSpeed.max },
    streaming: { type: 'boolean' },
    terrain: { type: 'string', enum: [...TERRAINS] },
    avatar: { type: 'string', enum: [...AVATARS] },
    hazardRise: { type: 'object', additionalProperties: false, required: ['afterSec', 'metersPerSec', 'maxElevation'], properties: { afterSec: { type: 'integer', minimum: 5, maximum: 300 }, metersPerSec: { type: 'number', minimum: 0.01, maximum: 0.5 }, maxElevation: { type: 'number', minimum: -2, maximum: -0.6 } } },
    decorations: {
      type: 'array', maxItems: WORLD_LIMITS.decorations.max,
      items: { type: 'object', additionalProperties: false, required: ['id', 'type', 'islandId', 'localPosition'], properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' }, type: { type: 'string', enum: [...DECORATION_TYPES] }, islandId: { type: 'string' }, localPosition: { type: 'object', additionalProperties: false, required: ['x', 'z'], properties: { x: { type: 'number', minimum: -L, maximum: L }, z: { type: 'number', minimum: -L, maximum: L } } } } },
    },
  },
} as const;
