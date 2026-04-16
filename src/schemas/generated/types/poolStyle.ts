/**
 * Hand-edited — NOT produced by orval.
 *
 * PoolStyle enum for the pool design tool. Mirrors the iOS
 * `PoolStyle` enum (HomeDecorAI/Features/Wizard/Models/PoolStyle.swift).
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type PoolStyle = (typeof PoolStyle)[keyof typeof PoolStyle];

export const PoolStyle = {
  poolSpa: "poolSpa",
  resort: "resort",
  waterfall: "waterfall",
  infinity: "infinity",
  lagoon: "lagoon",
  lapPool: "lapPool",
  mediterranean: "mediterranean",
  grotto: "grotto",
  beachEntry: "beachEntry",
  mosaicTile: "mosaicTile",
} as const;
