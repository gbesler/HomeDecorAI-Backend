/**
 * Hand-edited — NOT produced by orval.
 *
 * GardenStyle enum for the garden design tool. Mirrors the iOS
 * `GardenStyle` enum (HomeDecorAI/Features/Wizard/Models/GardenStyle.swift).
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type GardenStyle = (typeof GardenStyle)[keyof typeof GardenStyle];

export const GardenStyle = {
  cozy: "cozy",
  englishCottage: "englishCottage",
  christmas: "christmas",
  french: "french",
  tropical: "tropical",
  japanese: "japanese",
  mediterranean: "mediterranean",
  modern: "modern",
  rustic: "rustic",
  wildflower: "wildflower",
} as const;
