// Single typed configuration for every world limit and geometry constant.
export const SCHEMA_VERSION = 1 as const;
export const MOVEMENT_RULES_VERSION = 1 as const;
export const VALIDATOR_VERSION = 1 as const;
export const COMPILER_VERSION = 1 as const;
export const PROTOCOL_VERSION = 1 as const;

export const WORLD_LIMITS = {
  islands: { min: 4, max: 8 },
  bridges: { max: 16 },
  spawns: 2,
  relics: 3,
  gates: 1,
  decorations: { max: 40 },
  island: { minRadius: 4, maxRadius: 14 },
  bridge: { minWidth: 1.6, maxWidth: 4, minLength: 1, maxLength: 36 },
  bounds: { halfExtent: 60 },
  title: { maxLength: 60 },
  name: { maxLength: 40 },
  summary: { maxLength: 240 },
  patchOps: { max: 12 },
  localOffset: 20,
} as const;

// Coordinate convention: X/Z is the walk plane, Y is up. +Z is north, +X is east. Units are metres.
// Origin is the world centre. One common platform elevation (top surface at Y = 0).
export const GEOMETRY = {
  platformElevation: 0,
  platformThickness: 1.5,
  hazardPlaneElevation: -2.5,
  playerRadius: 0.45,
  playerSpeed: 4.5,
  navCell: 0.5,
  relicPickupRadius: 1.0,
  gateTriggerRadius: 2.0,
  gateBlockRadius: 1.1,
  socketTolerance: 0.35,
  fallDurationMs: 700,
  respawnDurationMs: 900,
} as const;

export const SIMULATION = {
  tickHz: 30,
  inputTimeoutMs: 600,
  inputRateLimitPerSec: 60,
  maxMessageBytes: 4096,
  displayAckTimeoutMs: 1500,
  commitDeferMaxMs: 3000,
  validationProofTtlMs: 60000,
} as const;

export const SCORING = {
  relic: 10,
  win: 50,
  lavaFallPenalty: 1,
} as const;

export const DECORATION_TYPES = ['tree', 'rock', 'lantern', 'pillar', 'bush', 'shrine', 'tower', 'ruin', 'crystal', 'mushroom', 'statue'] as const;
export type DecorationType = (typeof DECORATION_TYPES)[number];
export const DECORATION_RADIUS: Record<DecorationType, number> = {
  tree: 0.7,
  rock: 0.8,
  lantern: 0.3,
  pillar: 0.5,
  bush: 0.55,
  shrine: 1.0,
  tower: 1.3,
  ruin: 1.1,
  crystal: 0.6,
  mushroom: 0.5,
  statue: 0.7,
};

export const BIOMES = ['garden', 'volcanic', 'frost', 'desert', 'night'] as const;
export type Biome = (typeof BIOMES)[number];
/** Game modes the engine implements. The model maps any requested game onto the closest mode and says which. */
export const GAME_MODES = ['relic_hunt', 'time_trial', 'king_of_the_hill', 'checkpoint_race', 'survival'] as const;
export type GameMode = (typeof GAME_MODES)[number];
export const MODE_LIMITS = {
  timeLimitSec: { min: 20, max: 600, default: 120 },
  holdSeconds: { min: 3, max: 60, default: 10 },
  relicsRequired: { min: 1, max: 3 },
  movementSpeed: { min: 3, max: 7, default: 4.5 },
  hazardRise: { afterSec: { min: 5, max: 300 }, metersPerSec: { min: 0.01, max: 0.5 }, maxElevation: { min: -2, max: -0.6 } },
} as const;
export const HAZARD_KINDS = ['water', 'lava'] as const;
export type HazardKind = (typeof HAZARD_KINDS)[number];
export const OBJECTIVE_RULES = ['collect_all_relics_then_enter_gate'] as const;
export const PLAYER_COLORS = ['#ffb347', '#6ec6ff'] as const;
export const PLAYER_LABELS = ['Amber', 'Azure'] as const;
